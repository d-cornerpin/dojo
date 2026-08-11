// ════════════════════════════════════════
// A2A Transport, Structured Agent-to-Agent Message Delivery
//
// Central delivery function for all inter-agent messages. Enforces:
//   - Terminal-thread gating (closed threads reject non-reopening intents)
//   - Hop counting (THREAD_HOP_CAP delivered messages per thread; the count lives on
//     `work.hop_count` for delegated threads — DECIDED D2)
//   - Semantic deduplication (cosine similarity > 0.85 against last 3)
//   - requires_response routing (false = no receiver generation)
//
// All inter-agent communication, send_to_agent, PM pokes, healer
// alerts, completion notifications, flows through deliverA2AMessage.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { A2A_THREAD_SHORT_LENGTH, OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
import { insertMessageIfAbsent, insertEngineEventIfAbsent } from '../memory/message-store.js';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { isSenderAuthorized } from './v2/channel-auth.js';
// SWEEP CORE-2 item 5: STATIC, because the relay's scope check runs on the synchronous
// path beside the compose branches. `config/platform.ts` imports only `db/connection.js`,
// so there is no cycle to buy with the dynamic form the older call sites in this file use.
import { isPrimaryAgent } from '../config/platform.js';
import { type DeliveryInput } from './v2/deliveries.js';
import { recordAtDoor, withOutboundAsync, recordedId } from './v2/outbound.js';
// PHASE-2 T4: the join lives in `work`. Everything below is transport — it lands pieces and
// relays answers; it computes no join state and it writes no state of its own.
import {
  JOIN_TTL_MINUTES, THREAD_HOP_CAP, isTerminal,
  findJoinChildByThread, findFailedJoinForThread, childrenForThread,
  landPiece, settlePieceWithoutResult, joinState, joinPieces, dueJoins, openJoins,
  dueJoinsUnderClosedParent,
  compilePendingJoins, failJoinClosed, clearJoinCompilePending,
  claimFailedJoinForLateAnswer, threadHopCount, bumpThreadHopCount,
  type JoinState, type JoinPiece,
} from '../work/store.js';
// SWEEP-A TB2: the join's close is the settlement authority's, not this module's — the same
// rule the delivery arm and the finalize adjudicator use, invoked from the relay.
import { settleAskOnJoin, priorEngineJoinRelay, joinDeliveryDetail } from '../work/ask-settlement.js';
// …and the grind-vs-tell ladder, which owns "how many times has the system come back for
// this, and what does it do when the drives are spent".
import {
  JOIN_DRIVE_ENTRY, JOIN_REDRIVE_BOUND, nextJoinDriveRung, recordJoinDrive,
  joinRedriveIsBlind, compileSteerText, type JoinDriveDecision,
} from '../work/join-drive.js';
import { currentTurnNumber } from './v2/turn-record.js';
import { selfWakeStandDown } from '../work/work-reaper.js';
import { recordFloorGhost } from './v2/floor-ghost.js';
// A2A protocol constants and helpers, inlined here to avoid runtime
// imports from @dojo/shared (which points at .ts source and can't be
// loaded by Node.js in production without a TS loader).
// Types are still imported from @dojo/shared as type-only (erased at compile time).
import type { A2AIntent, A2AEnvelope, A2ADropReason, ToolCall } from '@dojo/shared';
import type { ToolOutcome } from './tool-outcome.js';

// Terminal intents CLOSE the thread (prevent acknowledgement replies).
// But closing the thread and waking the receiver are INDEPENDENT concepts.
const TERMINAL_INTENTS = new Set<A2AIntent>(['DELIVERABLE', 'FYI', 'COMPLETE', 'FAIL', 'ANSWER']);
const REOPENING_INTENTS = new Set<A2AIntent>(['QUESTION', 'BLOCK', 'ASSIGN']);

// "No-wake" intents: terminal AND the receiver doesn't need to see it now.
// ANSWER and DELIVERABLE are terminal but DO wake, the receiver is waiting
// for the content to continue their work. The thread closure prevents
// acknowledgement loops separately.
//
// v2.5.32, COMPLETE and FAIL moved out of NO_WAKE. Pre-fix, when a sub-agent
// finished work and sent COMPLETE back to the assigner, the assigner did NOT
// wake, so multi-step workflows broke down silently because the follow-up
// (forward to the next agent, notify the user, decide next step) never
// triggered. Default is now: wake the receiver and let them decide.
//
// Only FYI and STATUS stay no-wake, those are explicitly ambient ("for
// awareness", "still working, 50% done"). Everything else wakes; the agent
// can override with requires_response=false on a per-call basis if they're
// certain the receiver has nothing to do.
const NO_WAKE_INTENTS = new Set<A2AIntent>(['FYI', 'STATUS']);

const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const DEDUP_LOOKBACK = 3;

function isTerminalIntent(intent: A2AIntent): boolean { return TERMINAL_INTENTS.has(intent); }
function isNoWakeIntent(intent: A2AIntent): boolean { return NO_WAKE_INTENTS.has(intent); }
function isReopeningIntent(intent: A2AIntent): boolean { return REOPENING_INTENTS.has(intent); }

// Re-export for callers that need these (tools.ts)
export { isTerminalIntent, isNoWakeIntent, isReopeningIntent, type A2AIntent };

const logger = createLogger('a2a-transport');

// ── Thread State Management ──

function ensureThread(threadId: string, senderId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO a2a_threads (thread_id, hop_count, last_sender, created_at, updated_at)
    VALUES (?, 0, ?, datetime('now'), datetime('now'))
  `).run(threadId, senderId);
}

/**
 * The thread's hop count — DECIDED D2's rekey.
 *
 * A thread the agent DELEGATED on has a `work` row, and the spine is where its count lives:
 * `work.hop_count`, on the child, seeded from this same reader at delegation time so the
 * count is continuous across the move. A thread nobody delegated on has no work row, and its
 * count stays on `a2a_threads` until that table dies (PHASE-2 T10 owns the drop; T7 is what
 * gives the remaining threads rows). The two are never both authoritative for one thread, and
 * the CAP is declared exactly once, on the spine, as `THREAD_HOP_CAP`.
 */
function getThreadHopCount(threadId: string): number {
  const onSpine = threadHopCount(threadId);
  if (onSpine !== null) return onSpine;
  const row = getDb().prepare('SELECT hop_count FROM a2a_threads WHERE thread_id = ?').get(threadId) as { hop_count: number } | undefined;
  return row?.hop_count ?? 0;
}

function recordThreadDelivery(threadId: string, intent: A2AIntent, senderId: string): number {
  const db = getDb();
  // The awaiting-reply latch's durable record (RC-14), and after PHASE-2 T10 that is ALL this
  // write is: who sent last, with what intent, when. The `is_terminal` flag that used to ride
  // along was dropped by migration `143` — positive enumeration found its only reader was a
  // branch whose only action was to clear the flag it had just read.
  db.prepare(`
    UPDATE a2a_threads
    SET last_intent = ?,
        last_sender = ?,
        updated_at = datetime('now')
    WHERE thread_id = ?
  `).run(intent, senderId, threadId);

  const onSpine = bumpThreadHopCount(threadId);
  if (onSpine !== null) return onSpine;
  db.prepare('UPDATE a2a_threads SET hop_count = hop_count + 1 WHERE thread_id = ?').run(threadId);
  return getThreadHopCount(threadId);
}

// ── Semantic Deduplication ──

async function checkSemanticDedup(payload: string, threadId: string, fromAgent: string): Promise<boolean> {
  try {
    const { generateEmbedding } = await import('../memory/embeddings.js');

    // Get last N messages on this thread FROM THE SAME SENDER. Pre-2026-04-30
    // dedup compared against messages from any sender on the thread, which
    // meant an agent's reply could be flagged as duplicate against the
    // receiver's earlier question (because the reply naturally repeats the
    // question's terms). The honest signal is "this sender is repeating
    // themselves", that's what we now check.
    const db = getDb();
    // Age guard (remediation Phase 4, matrix S7.2): dedup exists to damp
    // rapid ack/repeat loops, so only RECENT messages participate. A similar
    // message re-sent minutes later (a deliberate re-ask after no response,
    // the next step of a slow collaboration) is a legitimate wake, not spam.
    const recentMessages = db.prepare(`
      SELECT content FROM messages
      WHERE a2a_thread_id = ? AND source_agent_id = ?
        AND created_at >= (unixepoch('now', '-10 minutes') * 1000)
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(threadId, fromAgent, DEDUP_LOOKBACK) as Array<{ content: string }>;

    if (recentMessages.length === 0) return false;

    // Generate embedding for the new payload
    const newEmbedding = await generateEmbedding(payload);

    // Compare against each recent message
    for (const msg of recentMessages) {
      // Extract payload from the tagged message format
      const msgPayload = extractPayloadFromA2AMessage(msg.content);
      if (!msgPayload || msgPayload.length < 10) continue;

      const existingEmbedding = await generateEmbedding(msgPayload);
      const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

      if (similarity > DEDUP_SIMILARITY_THRESHOLD) {
        logger.info('Semantic dedup: sender is repeating themselves on thread', {
          threadId,
          fromAgent,
          similarity: similarity.toFixed(3),
          threshold: DEDUP_SIMILARITY_THRESHOLD,
        });
        return true; // Duplicate detected
      }
    }

    return false;
  } catch (err) {
    // Embedding service unavailable, skip dedup, deliver the message.
    // Dedup is a nice-to-have, not a gate.
    // RC-14: raised from debug to info. An embedding outage silently disables a
    // real loop guard (this is one of the documented dedup holes), so the skip
    // must be visible in the operational log, not buried at debug. The
    // deterministic awaiting-reply latch below does NOT depend on embeddings, so
    // wake-intent re-asks stay gated even while this is degraded.
    logger.info('Semantic dedup skipped (embedding unavailable)', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// W3-4 follow-up (behavioral run bmr59ix4lsg): per-thread dedup could not see
// an impatient sender re-ASSIGNing the same work with thread_id OMITTED, each
// re-send opened a FRESH thread and auto-created another tracker task (three
// near-identical ASSIGNs -> three threads -> three tasks in one turn, while
// the tool result had already told the sender the reply is asynchronous).
// Before minting a new thread for an ASSIGN, check the receiver's recent
// inbound ASSIGNs from this sender across ALL threads; a semantic duplicate
// resolves to the existing thread so the normal dedup/reuse machinery (and
// autoCreateAssignTask's per-thread reuse) applies. Same 10-minute window and
// threshold as checkSemanticDedup; a deliberate re-ask later is a legit wake.
async function findRecentDuplicateAssignThread(
  senderId: string,
  receiverId: string,
  payload: string,
): Promise<string | null> {
  try {
    const db = getDb();
    // T6: one table. The W3-4 bug this guard exists to prevent (a re-sent ASSIGN
    // opening a fresh thread + tracker task each time, because the dedup read one
    // store while the writer wrote the other) cannot recur when there is one store.
    const recent = db.prepare(`
      SELECT content, a2a_thread_id FROM messages
       WHERE agent_id = @receiverId AND source_agent_id = @senderId AND a2a_intent = 'ASSIGN'
         AND a2a_thread_id IS NOT NULL
         AND created_at >= (unixepoch('now', '-10 minutes') * 1000)
      ORDER BY rowid DESC
      LIMIT @lookback
    `).all({ receiverId, senderId, lookback: DEDUP_LOOKBACK }) as Array<{ content: string; a2a_thread_id: string }>;
    if (recent.length === 0) return null;

    const { generateEmbedding } = await import('../memory/embeddings.js');
    const newEmbedding = await generateEmbedding(payload);
    for (const msg of recent) {
      const msgPayload = extractPayloadFromA2AMessage(msg.content);
      if (!msgPayload || msgPayload.length < 10) continue;
      const existingEmbedding = await generateEmbedding(msgPayload);
      if (cosineSimilarity(newEmbedding, existingEmbedding) > DEDUP_SIMILARITY_THRESHOLD) {
        return msg.a2a_thread_id;
      }
    }
    return null;
  } catch (err) {
    logger.debug('Cross-thread ASSIGN dedup skipped (embedding unavailable)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function extractPayloadFromA2AMessage(content: string): string | null {
  // New format: [A2A:INTENT thread:xxx from:Name] payload
  const a2aMatch = content.match(/^\[A2A:\w+ thread:\S+ from:[^\]]+\]\s*([\s\S]*?)(\n\n\[Thread|$)/);
  if (a2aMatch) return a2aMatch[1].trim();

  // Legacy format: [SOURCE: AGENT MESSAGE FROM ...] payload
  const legacyMatch = content.match(/^\[SOURCE: (?:AGENT MESSAGE|PM AGENT POKE|GROUP BROADCAST) FROM [^\]]+\]\s*([\s\S]*?)(\n\n\[(?:To reply|Reply via)|$)/);
  if (legacyMatch) return legacyMatch[1].trim();

  return content.trim();
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ── Deliverable-shape detection (v2.3.17) ──
//
// A sub-agent that says "draft #21 is ready, https://…" is almost always
// announcing a deliverable, not just chatting, but pre-2026-05-10 they
// often picked intent=FYI, leaving the primary agent idle and the user
// in the dark. We promote those to DELIVERABLE so the primary wakes.
//
// Signal model: a URL on its own is enough (someone shipped a thing). If
// no URL, require a completion keyword AND an artefact reference (an ID,
// a draft #, a title in quotes, "Post ID:", "PR #", etc.). Both halves
// matter, "I'm working on it" alone shouldn't promote.
const COMPLETION_KEYWORDS = [
  'ready', 'done', 'finished', 'complete', 'completed', 'shipped',
  'published', 'live', 'merged', 'drafted', 'wrapped', 'delivered',
];
const ARTEFACT_PATTERNS = [
  /\bdraft\s*#?\d+/i,
  /\b(?:post|task|pr|ticket|issue|order|invoice|file|doc(?:ument)?)\s*(?:id\s*[:#]?\s*)?\d+/i,
  /\bPR\s*#\d+/i,
  /"[^"]{4,}"/,                // a quoted title with at least 4 chars
  /\b\d{3,}\b/,                // bare longish numeric ID (e.g. Post ID: 4253)
];
const URL_RE = /\bhttps?:\/\/\S+/i;

export function payloadLooksDeliverable(payload: string): boolean {
  if (!payload || payload.length < 5) return false;
  if (URL_RE.test(payload)) return true;
  const lower = payload.toLowerCase();
  const hasCompletion = COMPLETION_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasCompletion) return false;
  const hasArtefact = ARTEFACT_PATTERNS.some((re) => re.test(payload));
  return hasArtefact;
}

// ── Logging ──

// RC-14: AWAITING_REPLY is a transport-local drop reason for the deterministic
// awaiting-reply latch below. It is intentionally NOT added to the shared
// A2ADropReason union here (that type lives in @dojo/shared and is edited
// separately); we widen locally so the transport is self-contained and the send
// tool renders the refusal text. The tools.ts default drop branch already
// surfaces any unrecognised reason, so the latch works before a dedicated render
// lands.
type A2ADropReasonLocal = A2ADropReason | 'AWAITING_REPLY';

function logDrop(envelope: A2AEnvelope, reason: A2ADropReasonLocal): void {
  logger.info('A2A message dropped', {
    threadId: envelope.threadId,
    from: envelope.fromAgent,
    to: envelope.toAgent,
    intent: envelope.intent,
    reason,
    payloadPreview: envelope.payload.slice(0, 200),
  });
}

// ── ND-3: own-task evidence for validation QUESTIONs ──
//
// behav-sig: pm-validation-history-spin-floor. When the PM (or any agent)
// cross-examines an agent about a task THAT AGENT completed, the floor model
// otherwise spins through dozens of history searches trying to reconstruct
// evidence it already recorded. Rendering that stored evidence (result +
// evidence array + a compact verified-receipt summary) straight into the inbound
// lets the model answer in 1-2 calls instead of re-mining its own history.
//
// Compose-time CONTENT enrichment ONLY: additive to the delivered string, never
// a per-turn tool budget or a loop cap (the model may still search if it wants).
// Fires narrowly: only for QUESTION intent (gated by the caller), only for the
// 8-char task-id prefixes the question prose actually references, and only for
// tasks assigned to THIS recipient (never another agent's record). The A2A wire
// carries no structured task_id (A2AEnvelope has none, the messages table has no
// task_id column), so the prefixes are parsed from the payload prose the way the
// PM reject/retask questions emit them. Dynamic imports mirror the ASSIGN
// auto-task path below (tracker/schema pulls a2a-transport transitively).
async function renderOwnTaskEvidenceForQuestion(recipientId: string, payload: string): Promise<string> {
  try {
    const tokens = payload.match(/\b[0-9a-f]{8}\b/g);
    if (!tokens || tokens.length === 0) return '';

    const { resolveTaskId, getTask } = await import('../tracker/schema.js');
    const { getReceiptsForTask } = await import('../receipts/store.js');

    const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
    const PER_TASK_CAP = 700; // hard bound per task so the enriched inbound can't balloon
    const MAX_TASKS = 3;

    const seen = new Set<string>();
    const blocks: string[] = [];

    for (const token of tokens) {
      if (blocks.length >= MAX_TASKS) break;
      const resolved = resolveTaskId(token);
      if (!resolved.ok || seen.has(resolved.id)) continue;
      seen.add(resolved.id);
      const task = getTask(resolved.id);
      if (!task) continue;
      // GATE: only the recipient's OWN task. A question about a task assigned to
      // someone else carries no evidence this recipient can answer from, and
      // rendering it would leak another agent's record onto this lane.
      if (task.assignedTo !== recipientId) continue;

      const lines: string[] = [`• ${task.title} (${task.id.slice(0, 8)}) | status: ${task.status}`];
      if (task.result) lines.push(`  Result: ${clip(task.result, 300)}`);
      if (task.evidence.length > 0) {
        const ev = task.evidence.slice(0, 5).map((e, i) => {
          const claim = typeof e.claim === 'string' ? e.claim : '';
          const pointer = typeof e.pointer === 'string' ? e.pointer : '';
          return `    ${i + 1}. [${e.kind ?? '?'}] ${claim}${pointer ? ` @ ${pointer}` : ''}`;
        });
        lines.push(`  Evidence:\n${ev.join('\n')}`);
      }
      const receipts = getReceiptsForTask(task.id).slice(0, 5);
      if (receipts.length > 0) {
        const rl = receipts.map((r) =>
          `    - ${r.tool} ${r.verified ? 'verified' : 'unverified'} (${r.basis})` +
          `${r.recipient ? ` → ${r.recipient}` : ''} @ ${r.created_at}`);
        lines.push(`  Receipts:\n${rl.join('\n')}`);
      }

      blocks.push(clip(lines.join('\n'), PER_TASK_CAP));
    }

    if (blocks.length === 0) return '';
    return `\n\n[Your record for the referenced task(s), so you can answer without re-mining history:]\n${blocks.join('\n')}`;
  } catch (err) {
    logger.debug('ND-3 own-task evidence render skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

// ── Core Delivery Function ──

export interface A2ADeliveryResult {
  delivered: boolean;
  reason?: A2ADropReasonLocal;
  threadId: string;
  messageId?: string;
  /**
   * For ASSIGN-intent deliveries, the engine auto-creates a tracker task
   * for the receiver. The ID is returned here so the sender's tool result
   * can surface it ("Task 9f2c1a04 created and assigned to Maddy").
   * Undefined for non-ASSIGN intents and for ASSIGN messages that reused
   * an existing thread's task.
   */
  autoCreatedTaskId?: string;
  /**
   * True when the auto-task was just created by THIS delivery; false when
   * we reused a task from an earlier ASSIGN on the same thread.
   */
  autoTaskIsNew?: boolean;
  /**
   * v2.3.17, true when the engine reclassified the sender's FYI to
   * DELIVERABLE because the payload looked deliverable-shaped (sub-agent
   * → primary, URL or completion-keyword + artefact reference). Surfaced
   * to send_to_agent's tool result so the sender knows their receiver
   * was actually woken.
   */
  autoPromotedFromFyi?: boolean;
}

/**
 * Central delivery point for ALL inter-agent messages. Enforces the full
 * A2A protocol: envelope validation, terminal-thread gating, semantic
 * dedup, hop counting, and requires_response routing.
 *
 * Returns a result indicating whether the message was delivered or dropped.
 */
export async function deliverA2AMessage(envelope: A2AEnvelope): Promise<A2ADeliveryResult> {
  const db = getDb();

  // ── 1. Validate envelope ──
  if (!envelope.intent || !envelope.payload || !envelope.toAgent || !envelope.fromAgent) {
    logDrop(envelope, 'MALFORMED_ENVELOPE');
    return { delivered: false, reason: 'MALFORMED_ENVELOPE', threadId: envelope.threadId };
  }

  // ── 2. Resolve target agent ──
  let target = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(envelope.toAgent) as
    | { id: string; name: string; status: string } | undefined;
  if (!target) {
    target = db.prepare("SELECT id, name, status FROM agents WHERE name = ? AND status != 'terminated' ORDER BY created_at DESC LIMIT 1")
      .get(envelope.toAgent) as { id: string; name: string; status: string } | undefined;
  }
  if (!target) {
    logDrop(envelope, 'AGENT_NOT_FOUND');
    return { delivered: false, reason: 'AGENT_NOT_FOUND', threadId: envelope.threadId };
  }
  if (target.status === 'terminated') {
    logDrop(envelope, 'AGENT_NOT_FOUND');
    return { delivered: false, reason: 'AGENT_NOT_FOUND', threadId: envelope.threadId };
  }

  // ── 3. Enforce intent rules ──
  // Two independent concepts:
  //   - Terminal: closes the thread (prevents acknowledgement replies)
  //   - No-wake: receiver is NOT woken (message is read-only context)
  //
  // ANSWER, DELIVERABLE, COMPLETE, FAIL are all terminal (close thread)
  // AND wake, the receiver either asked for this content (ANSWER/
  // DELIVERABLE) or assigned the work that just completed/failed
  // (COMPLETE/FAIL) and needs to react. Only FYI and STATUS are no-wake;
  // those are ambient context the agent shouldn't be interrupted for.
  //
  // v2.3.17 auto-promote: a sub-agent sending FYI to the primary agent
  // about a deliverable (URL or ID/title + completion keyword) is almost
  // always a wrong-intent pick, they meant DELIVERABLE. Without promotion,
  // the primary sits idle until the user pings, then re-asks the sub-agent
  // for content the engine already delivered. We override intent here so
  // downstream thread state, footer, and wake routing all stay consistent.
  let effectiveIntent: A2AIntent = envelope.intent;
  let autoPromotedFromFyi = false;
  try {
    const { isPrimaryAgent } = await import('../config/platform.js');
    const targetIsPrimary = isPrimaryAgent(target.id);
    const senderIsPM = (await import('../config/platform.js')).isPMAgent(envelope.fromAgent);
    const senderIsHealer = (await import('../config/platform.js')).isHealerAgent(envelope.fromAgent);
    const senderIsPrimary = isPrimaryAgent(envelope.fromAgent);
    const senderIsSubAgent = !senderIsPrimary && !senderIsPM && !senderIsHealer && envelope.fromAgent !== 'system';
    if (
      envelope.intent === 'FYI' &&
      targetIsPrimary &&
      senderIsSubAgent &&
      payloadLooksDeliverable(envelope.payload)
    ) {
      effectiveIntent = 'DELIVERABLE';
      autoPromotedFromFyi = true;
      logger.info('A2A FYI auto-promoted to DELIVERABLE (sub-agent → primary, deliverable-shaped payload)', {
        from: envelope.fromAgent,
        to: target.id,
        threadId: envelope.threadId,
        payloadPreview: envelope.payload.slice(0, 120),
      });
    }
  } catch { /* best effort, fall back to raw intent */ }

  let requiresResponse = envelope.requiresResponse;
  if (isNoWakeIntent(effectiveIntent)) {
    requiresResponse = false; // Force, these intents never wake the receiver
  } else if (autoPromotedFromFyi) {
    requiresResponse = true; // Promoted DELIVERABLE wakes the receiver
  }

  // ── 4. Thread state checks ──
  // W3-4 follow-up: an ASSIGN without a thread_id that semantically repeats a
  // recent ASSIGN from the same sender to the same receiver is a re-send, not
  // new work. Route it onto the existing thread instead of minting a new one
  // (which would auto-create a duplicate tracker task); the per-thread dedup
  // below then drops it and the sender gets the "you are repeating yourself"
  // guidance with the original thread id.
  let reusedAssignThreadId: string | null = null;
  if (effectiveIntent === 'ASSIGN' && !envelope.threadId && envelope.fromAgent !== 'system') {
    reusedAssignThreadId = await findRecentDuplicateAssignThread(envelope.fromAgent, target.id, envelope.payload);
    if (reusedAssignThreadId) {
      logger.info('A2A ASSIGN without thread_id matched a recent assignment, reusing its thread', {
        from: envelope.fromAgent, to: target.id, threadId: reusedAssignThreadId,
      }, envelope.fromAgent);
    }
  }
  const threadId = envelope.threadId || reusedAssignThreadId || uuidv4();
  ensureThread(threadId, envelope.fromAgent);

  // v2.5.34 removed the TERMINAL_THREAD_CLOSED rejection. Pre-fix, a thread that received any
  // terminal intent (ANSWER/DELIVERABLE/COMPLETE/FAIL/FYI) was marked terminal, and any
  // subsequent non-reopening intent — which was every intent EXCEPT QUESTION/BLOCK/ASSIGN —
  // got silently dropped. That broke legitimate follow-ups: an agent delivering work, spotting
  // a problem, and sending a corrected DELIVERABLE on the same thread had the second message
  // silently discarded. LOOP PROTECTION COMES FROM SEMANTIC DEDUP + THE HOP LIMIT, both of
  // which still run below, and that is the sentence worth keeping.
  //
  // PHASE-2 T10 (RULING 8c): the flag itself is gone (migration `143`). What stood here was
  // `if (isThreadTerminal(t)) { UPDATE ... SET is_terminal = 0 }` — kept in 2.5.34 only "so
  // the marker stays consistent for diagnostic queries", and in the years since, no diagnostic
  // query was ever written. Positive enumeration across both repos found the flag's entire
  // lifecycle to be: set on a terminal intent, read here, immediately cleared here. Nothing
  // ever branched on it.

  // ── 5. Hop counter ──
  const currentHops = getThreadHopCount(threadId);
  if (currentHops >= THREAD_HOP_CAP) {
    logDrop(envelope, 'HOP_LIMIT_EXCEEDED');
    return { delivered: false, reason: 'HOP_LIMIT_EXCEEDED', threadId };
  }

  // ── 5.5. Awaiting-reply latch (RC-14) ──
  // A wake-intent re-ask (QUESTION/ASSIGN/BLOCK) on a thread whose most recent
  // delivery was THIS sender's own, still-unanswered wake-intent is almost always
  // an impatient re-ping ("did you get my question?"), not new signal. The prose
  // "do not message X again" the send tool appends is advisory only, nothing
  // engine-side keys on it; the per-recipient cap resets every turn (each wake
  // send force-ends the turn) and semantic dedup has documented holes (embedding
  // outage, rewording under the 0.85 threshold, exempt intents), so neither
  // reliably catches the re-ask. This deterministic, embedding-free latch does:
  // while the receiver still owes a reply and we are inside a short cooldown, the
  // re-ask is dropped with AWAITING_REPLY and the sender is told to wait. The
  // engine already solves the identical problem for duplicate ASSIGNs; QUESTION
  // and BLOCK now share the discipline.
  //
  // Carve-outs: STATUS/FYI and the answer-class intents (ANSWER/DELIVERABLE/
  // COMPLETE/FAIL) are not reopening intents, so they never enter this branch;
  // system/engine envelopes bypass entirely (operational traffic, every event is
  // a fresh condition the receiver must see); and any message from the receiver
  // back on this thread inside the window releases the latch at once
  // (receiver-has-replied).
  const AWAITING_REPLY_COOLDOWN = '-15 minutes';
  const isEngineEnvelope = envelope.fromAgent === 'system' || envelope.origin === 'engine';
  if (isReopeningIntent(effectiveIntent) && !isEngineEnvelope) {
    // Cheap gate: this thread's last recorded delivery was from THIS sender, it
    // was itself a wake-intent, and it landed inside the cooldown. recordDelivery
    // flips last_sender to the receiver the moment they reply, so this already
    // implies "receiver has not answered"; the merged read below confirms it
    // authoritatively and covers any thread-state drift.
    const latchRow = db.prepare(`
      SELECT last_intent FROM a2a_threads
       WHERE thread_id = @threadId
         AND last_sender = @senderId
         AND updated_at >= datetime('now', @window)
    `).get({ threadId, senderId: envelope.fromAgent, window: AWAITING_REPLY_COOLDOWN }) as
      | { last_intent: string | null }
      | undefined;
    const senderOwesReply =
      !!latchRow && !!latchRow.last_intent && isReopeningIntent(latchRow.last_intent as A2AIntent);
    if (senderOwesReply) {
      // Has the RECEIVER posted anything back to this sender on this thread inside
      // the cooldown? One table, so the latch cannot stay closed because the reply
      // landed in the store the check did not read.
      const receiverReplied = db.prepare(`
        SELECT 1 AS hit FROM messages
         WHERE agent_id = @senderId AND source_agent_id = @receiverId
           AND a2a_thread_id = @threadId
           AND created_at >= (unixepoch('now', @window) * 1000)
        LIMIT 1
      `).get({ senderId: envelope.fromAgent, receiverId: target.id, threadId, window: AWAITING_REPLY_COOLDOWN }) as
        | { hit: number }
        | undefined;
      if (!receiverReplied) {
        logDrop(envelope, 'AWAITING_REPLY');
        return { delivered: false, reason: 'AWAITING_REPLY', threadId };
      }
    }
  }

  // ── 6. Semantic dedup ──
  // Skip for completion intents (ANSWER, DELIVERABLE, COMPLETE, FAIL).
  // Those are work-finished announcements, meaningful checkpoints that
  // need to land regardless of phrasing similarity. Dedup was meant to
  // silence acknowledgement loops ("thanks!" / "you're welcome!"), not
  // completion notices. FYI keeps dedup because it's the prime culprit
  // for back-and-forth ack loops between agents.
  //
  // v2.3.19, also skip dedup for system-originated messages. Engine
  // alerts (injury notifications, scheduler pokes, system health
  // signals) are operational, every fresh event represents a new
  // condition the receiver needs to know about. Pre-spec, a repeated
  // injury for the same agent kept getting dropped as "duplicate"
  // because the payload phrasing was similar, and the Healer never
  // saw any of them.
  const COMPLETION_INTENTS_SKIP_DEDUP = new Set<A2AIntent>(['ANSWER', 'DELIVERABLE', 'COMPLETE', 'FAIL']);
  const senderIsSystem = envelope.fromAgent === 'system';
  if (!COMPLETION_INTENTS_SKIP_DEDUP.has(effectiveIntent) && !senderIsSystem) {
    const isDuplicate = await checkSemanticDedup(envelope.payload, threadId, envelope.fromAgent);
    if (isDuplicate) {
      logDrop(envelope, 'SEMANTIC_DUPLICATE');
      return { delivered: false, reason: 'SEMANTIC_DUPLICATE', threadId };
    }
  }

  // ── 7. Record delivery in thread state ──
  recordThreadDelivery(threadId, effectiveIntent, envelope.fromAgent);

  // ── 8. Resolve sender name ──
  const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(envelope.fromAgent) as { name: string } | undefined;
  const senderName = senderRow?.name ?? envelope.fromAgent;

  // ── 8.5. Engine-driven auto-task on ASSIGN ──
  // Cross-agent task discipline: when an agent uses intent=ASSIGN, the
  // engine auto-creates a tracker task on their behalf so the assignment
  // is structurally tracked from the moment of the handoff. Both sides
  // see the task ID in their respective views (sender via tool result,
  // receiver via the threadInfo footer below). PM's existing poke loop
  // then picks up stalled ASSIGN tasks for free.
  //
  // Reuses an existing task if one already exists for this thread, so
  // multiple ASSIGN messages on the same thread are clarifications, not
  // duplicate assignments.
  // P1 lineage spine: mint the delivery message id up front so the auto-created
  // ASSIGN task can carry it as source_message_id (the row itself persists below).
  const msgId = uuidv4();
  let autoTask: { taskId: string; isNew: boolean } | null = null;
  if (effectiveIntent === 'ASSIGN') {
    try {
      const { autoCreateAssignTask } = await import('../tracker/schema.js');
      autoTask = autoCreateAssignTask({
        senderId: envelope.fromAgent,
        receiverId: target.id,
        payload: envelope.payload,
        threadId,
        assignMessageId: msgId,
      });
    } catch (err) {
      logger.warn('A2A ASSIGN: auto-task creation failed, delivering message anyway', {
        threadId, error: err instanceof Error ? err.message : String(err),
      }, envelope.fromAgent);
    }
  }

  // ── 9. Build the message content with structured tag ──
  // The footer must accurately reflect the intent's reply rules. Pre-2026-04-30
  // it branched on `requiresResponse`, which collapsed terminal-wake intents
  // (ANSWER/DELIVERABLE, wake but thread is closed) into the same footer as
  // open-thread intents (QUESTION/ASSIGN/BLOCK, wake AND reply). The result:
  // a DELIVERABLE message body said "do not reply" while the footer said
  // "Reply expected, use send_to_agent". Receiving agents read both and
  // got confused. Now there are three honest states, one per intent group.
  // PHASE-3 T5: the 8 is the MARKER's shape, not this function's opinion.
  const threadShort = threadId.slice(0, A2A_THREAD_SHORT_LENGTH);
  let threadInfo: string;
  if (effectiveIntent === 'QUESTION' || effectiveIntent === 'ASSIGN' || effectiveIntent === 'BLOCK') {
    // Open-thread reply intents, receiver should reply on the same thread.
    threadInfo = `\n\n[Thread ${threadShort} | Reply on this thread, use send_to_agent with thread_id="${threadId}" and an appropriate intent]`;
    if (effectiveIntent === 'ASSIGN' && autoTask) {
      // Receiver-visible tracker line. The DOJO created the task for them,
      // so they don't need to call work_open(kind="task"), they just need
      // to call work_update(action="status") when done so the sender gets the
      // completion notification automatically.
      const taskShort = autoTask.taskId.slice(0, 8);
      threadInfo += autoTask.isNew
        ? `\n[Tracker: task ${taskShort} was auto-created when ${senderName} assigned this work to you. Call work_update(action="status", task_id="${autoTask.taskId}", status="completed", notes="…") when you finish so ${senderName} gets the completion notice.]`
        : `\n[Tracker: continuing work on task ${taskShort} (assigned earlier on this thread by ${senderName}). Update status with work_update(action="status") when state changes.]`;
    }
  } else if (effectiveIntent === 'ANSWER' || effectiveIntent === 'DELIVERABLE') {
    // Terminal but wake, receiver should USE the content (relay to user,
    // act on it) but the thread is closed; replying on it will fail with
    // TERMINAL_THREAD_CLOSED. To continue with the sender, start a NEW
    // thread (omit thread_id) with a reopening intent.
    threadInfo = `\n\n[Thread ${threadShort} | Closed, use the content above (do NOT reply on this thread). To start a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else if (effectiveIntent === 'COMPLETE' || effectiveIntent === 'FAIL') {
    // v2.5.32, Terminal AND wake. The receiver assigned (or otherwise
    // initiated) this work and almost always needs to do something next:
    // forward the deliverable to another agent, notify the user, mark a
    // tracker task complete, decide a next step. Pre-fix these were
    // no-wake, which meant entire multi-step workflows silently stalled
    // when a sub-agent finished work, the assigner never woke to handle
    // the completion.
    const verb = effectiveIntent === 'COMPLETE' ? 'completion' : 'failure';
    threadInfo = `\n\n[Thread ${threadShort} | Closed, this is a ${verb} report on work you initiated. Do whatever the workflow requires next (forward to another agent, notify the user, update tracker, decide a next step). If nothing further is needed, just end your turn. To restart a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else {
    // True no-wake intents (FYI/STATUS), ambient context only. If the
    // content is genuinely something the user/owner cares about, the
    // receiver can still act on it next time they wake (e.g. iMessage
    // the owner during their next turn). Sender should have used a wake
    // intent if action is actually required.
    threadInfo = `\n\n[Thread ${threadShort} | No reply expected on this thread. Ambient context, the sender used a no-wake intent (${effectiveIntent}). If the content is something the user should know about, take action next time you wake (e.g. iMessage them).]`;
  }

  // Engine-injected hint for the primary agent when a sub-agent ships a
  // deliverable: explicitly tell the primary to surface this to the owner.
  // Fires for DELIVERABLE/ANSWER from sub-agents, and for any FYI we just
  // auto-promoted. Does NOT fire for PM/Healer/system messages, those are
  // operational, not user-facing artefacts.
  let primaryDeliverableHint = '';
  // C21: if this ANSWER/DELIVERABLE answers a DELEGATED question, the join below already
  // delivers "Heard back from X" on the owner's channel (single piece) or steers the model
  // to compile (fan-out). Appending the deliverable hint too would make the woken primary
  // ALSO send the gist (explicit tool calls aren't suppressed on a background turn) → the
  // owner gets it twice, seconds apart, or gets a PARTIAL piece surfaced as the answer.
  // ONE lookup now covers both cases: the engine owns delivery on any joined thread. It is
  // read HERE, before the piece lands, because landing it settles the child.
  const joinHandlesDelivery = !!findJoinChildByThread(target.id, threadId);
  try {
    const { isPrimaryAgent, isPMAgent, isHealerAgent, getOwnerName } = await import('../config/platform.js');
    const targetIsPrimary = isPrimaryAgent(target.id);
    const senderIsOps = isPMAgent(envelope.fromAgent) || isHealerAgent(envelope.fromAgent) || envelope.fromAgent === 'system';
    const isDeliverableShape =
      autoPromotedFromFyi ||
      (effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'ANSWER');
    if (targetIsPrimary && !senderIsOps && isDeliverableShape && !joinHandlesDelivery) {
      const ownerName = getOwnerName();
      // v2.9.21, Engine hint, not Engine order. The previous wording
      // ("[Engine: Send ... unless they're already actively in this
      // conversation]") was read by the model as a system-level
      // override of explicit user instructions (task/technique/vault
      // saying "always deliver via iMessage" got ignored because the
      // bracketed Engine string felt more authoritative). The
      // "actively in this conversation" carve-out was intended to
      // mean "this very deliverable's topic is already live in
      // dashboard chat" - i.e., don't yank a real conversation onto
      // another channel - but the agent read it as "any dashboard
      // chatting at all wins over the iMessage rule." Reworded to
      // make the precedence explicit and the carve-out specific.
      primaryDeliverableHint =
        `\n\n[Engine hint: ${senderName} just shipped a deliverable for ${ownerName}. ` +
        `If a task, project, technique, vault entry, or live user message specifies a delivery channel, follow that. ` +
        `Otherwise the engine's default suggestion is: send ${ownerName} an iMessage with the gist (title + link if present) so it doesn't get lost in dashboard scroll. ` +
        `Skip the iMessage only if you and ${ownerName} are actively going back and forth in dashboard chat about THIS specific deliverable right now (in which case dashboard is the natural place to surface it).]`;
    }
  } catch { /* best effort */ }

  const promotionTag = autoPromotedFromFyi
    ? ` (auto-promoted from FYI by the engine, payload looked deliverable-shaped)`
    : '';
  let contextMessage = `[A2A:${effectiveIntent} thread:${threadShort} from:${senderName}${promotionTag}] ${envelope.payload}${threadInfo}${primaryDeliverableHint}`;

  // ── ND-3: attach the recipient's OWN task evidence to a validation QUESTION ──
  // A QUESTION cross-examining an agent about a task IT completed otherwise makes
  // the floor model spin through dozens of history searches to reconstruct evidence
  // it already recorded. We render that stored evidence into the inbound so it can
  // answer in 1-2 calls. Purely additive to CONTENT, appended AFTER the [Thread ...]
  // footer (see helper), so dedup's payload extractor and the [A2A:...] marker
  // parsers, which read only the leading payload, are untouched. No tool budget, no
  // loop cap; the model is still free to search.
  if (effectiveIntent === 'QUESTION') {
    contextMessage += await renderOwnTaskEvidenceForQuestion(target.id, envelope.payload);
  }

  // ── Close-the-loop: the ENGINE delivers the delegated answer to the owner ──
  // When the recipient earlier asked someone on the owner's behalf, the owner's question was
  // DELEGATED on this thread and a child `work` row was opened for it (loop.ts). This delivery
  // is the reply. We do NOT re-fire the owner's question for the model to handle: that proved
  // flaky (the weak model re-reads "ask X" and re-asks — an ask→delegate→answer→re-ask LOOP).
  // The join lands the piece and, when the countdown reaches zero, either relays the answer
  // itself (one piece) or steers the model to compile (fan-out). Deterministic: the owner
  // always gets something, regardless of what the model does next.
  //
  // D13: the join takes ANY inbound reply on a delegated thread, not only the reply-intent
  // whitelist. The weak model routinely mislabels a real answer as STATUS/FYI, and gating on
  // the intent label left delegated questions open forever. (A rare interim STATUS on a
  // delegated thread now closes it early; that is strictly better than never closing, and the
  // payload is still relayed to the owner.)
  const isReplyIntent =
    effectiveIntent === 'ANSWER' || effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'COMPLETE' || effectiveIntent === 'FAIL';
  let handledByJoin = false;
  if (isReplyIntent || joinHandlesDelivery) {
    try {
      handledByJoin = await landReplyOnJoin({
        agentId: target.id, threadId, threadShort, payload: envelope.payload ?? '',
        fromAgent: envelope.fromAgent, intent: effectiveIntent, messageId: null, senderName,
      });
    } catch (err) {
      // RULING 7 rider (b), PHASE-2 T10. This was a `warn` with the error string and nothing
      // else, and it is where the six-hour phantom-trigger incident hid: the join owns this
      // thread, so the ordinary "surface this deliverable" hint above is suppressed (C21) —
      // if the landing fails here, NOBODY tells the owner. The row itself is named by
      // `loudOnPieceAbort` in `work/store.ts`; this is the second half, at the tier that
      // matches the consequence.
      logger.error('A2A close-the-loop delivery failed — the reply came back and was not landed on its join; the owner will not be told', {
        agentId: target.id, thread: threadShort, fromAgent: envelope.fromAgent,
        intent: effectiveIntent, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  void handledByJoin;

  // Owner ruling (2026-07-19): a terminal SUCCESS reply from the assignee on
  // its assignment thread files the worker's Key-1 close request from the
  // receipt itself (the weakest model delivers the work, then skips the
  // tracker form). Success intents only; FAIL leaves the task open for the PM
  // chase. Key 2 stays entirely with the PM.
  if (effectiveIntent === 'ANSWER' || effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'COMPLETE') {
    try {
      const { fileAssignDeliverableCloseRequest } = await import('../tracker/tools.js');
      await fileAssignDeliverableCloseRequest(envelope.fromAgent, threadId, envelope.payload ?? '');
    } catch (err) {
      logger.warn('assign-deliverable close request failed (non-fatal)', {
        threadId: threadShort, error: err instanceof Error ? err.message : String(err),
      });
    }
  }


  // ── 10. Process attachments BEFORE persist+broadcast ──
  // Pre-2026-04-30: attachments were processed AFTER the message was inserted
  // and the broadcast went out, so the dashboard's chat feed got the message
  // with no attachments. The image only appeared on page refresh (which loads
  // from the persisted DB row). Now we copy and build the attachments list
  // first, then persist and broadcast in one consistent pass.
  interface UploadedFile {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    category: 'unknown' | 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'video';
  }
  let attachmentsList: UploadedFile[] = [];
  if (envelope.attachPaths && envelope.attachPaths.length > 0) {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');

      const recipientDir = path.join(os.homedir(), '.dojo', 'uploads', target.id);
      if (!fs.existsSync(recipientDir)) {
        fs.mkdirSync(recipientDir, { recursive: true });
      }

      const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
      const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm'];
      const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.avi'];
      const AUDIO_MIME: Record<string, string> = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
        '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
        '.flac': 'audio/flac', '.webm': 'audio/webm',
      };
      const VIDEO_MIME: Record<string, string> = {
        '.mp4': 'video/mp4', '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
      };

      for (const srcPath of envelope.attachPaths) {
        if (!fs.existsSync(srcPath)) {
          logger.warn('A2A attachment source missing, skipping', { srcPath });
          continue;
        }
        const stat = fs.statSync(srcPath);
        // 1 GB cap aligns with the chat upload + URL fetch caps. Single-
        // user local install, A2A attachments are file paths, not
        // network requests, so there's no per-request body limit to
        // worry about here. Cap exists to catch obviously-wrong inputs.
        if (stat.size > 1024 * 1024 * 1024) {
          logger.warn('A2A attachment too large, skipping', { srcPath, size: stat.size });
          continue;
        }

        const ext = path.extname(srcPath).toLowerCase();

        // If the caller already placed the file in the recipient's uploads
        // dir (e.g., image_create pre-copies to a deterministic path so it
        // can include that path in the message text), skip the re-copy.
        // Otherwise we'd end up with two identical files and the agent
        // would not know which one to use.
        const srcDir = path.dirname(srcPath);
        const alreadyInRecipientDir = path.resolve(srcDir) === path.resolve(recipientDir);

        let destPath: string;
        if (alreadyInRecipientDir) {
          destPath = srcPath;
        } else {
          const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
          const storedName = `a2a_${Date.now()}_${safeName}`;
          destPath = path.join(recipientDir, storedName);
          fs.copyFileSync(srcPath, destPath);
        }

        const isImage = IMAGE_EXTS.includes(ext);
        const isAudio = AUDIO_EXTS.includes(ext);
        const isVideo = VIDEO_EXTS.includes(ext);
        const category: UploadedFile['category'] = isImage
          ? 'image'
          : isAudio ? 'audio'
          : isVideo ? 'video'
          : 'unknown';
        const mimeType = isImage
          ? `image/${ext.slice(1)}`
          : isAudio ? AUDIO_MIME[ext]
          : isVideo ? VIDEO_MIME[ext]
          : 'application/octet-stream';

        attachmentsList.push({
          fileId: uuidv4(),
          filename: path.basename(srcPath),
          mimeType,
          size: stat.size,
          path: destPath,
          category,
        });
      }
    } catch (err) {
      logger.warn('A2A attachment processing failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      attachmentsList = [];
    }
  }
  const attachmentsJson = attachmentsList.length > 0 ? JSON.stringify(attachmentsList) : null;

  // ── 11. Persist to messages table (with attachments) ──
  // C25 (revised): the a2a pipe is DUMB, it carries the sender's real message faithfully,
  // no transform and no length cap. A genuinely large, needed handoff must pass through
  // whole. Firehose PREVENTION is the SENDER's job (a helper messages the primary only when
  // there's a real actionable reason, not its full internal state on a timer). Keeping a2a
  // out of the primary's HUMAN conversation (so it isn't confused about who it's talking to)
  // is the ASSEMBLER's job, done structurally by origin.kind, not by rewriting the message
  // here. Visibility to the user is the dashboard's job: a2a is the 'agent-only' tier
  // (server-classified), hidden in regular chat, shown in wordy mode.
  // Engine-origin stamping (interagent-separation): a message that ORIGINATES
  // from the platform (Healer/PM/scheduler/destructive-gate/distillation, all via
  // the reserved fromAgent='system' sentinel, or an explicit envelope.origin flag)
  // is NOT a peer agent named "system". Stamp origin_kind='engine' so deriveOrigin
  // (@dojo/shared) classifies it as an engine event: the dashboard treats it as an
  // engine notice, the assembler lifts it into the EVENTS/awareness lane, and the
  // receiver's turn is framed as an engine directive (act via the tool the payload
  // names) instead of being told to "reply via send_to_agent" to a non-existent
  // agent. origin_intent splits the two response modes: an action-required message
  // (requiresResponse) carries a DELIVERABLE engine-intent ('a2a_request') so it can
  // drive a dedicated engine turn and be answered; a no-wake notice carries the
  // excluded 'system' intent so it stays pure awareness. Peer A2A (a real
  // source_agent_id, no engine signal) is untouched: origin_kind stays NULL.
  const engineOrigin = envelope.origin === 'engine' || envelope.fromAgent === 'system';
  const originKind = engineOrigin ? 'engine' : null;
  const originIntent = engineOrigin ? (requiresResponse ? 'a2a_request' : 'system') : null;
  // D-A (owner decision, 2026-07-05) gave ALL inter-agent inbound its own PHYSICAL
  // store so a forgetful downstream filter could not leak it into human chat. Phase 1
  // keeps that requirement and moves it into the schema: the row lands in `messages` on
  // `lane='a2a'` (or `'events'` for engine-origin A2A), and the fail-closed
  // `chat_messages` view — `WHERE lane='owner'` — is what a forgetful reader now hits.
  // A CHECK-constrained column is stronger than a table a reader could forget to
  // exclude. The FA-C4 PERSIST_SKIPPED drop guard below is unchanged: the persisted row is
  // the sole delivery vehicle (runtime.handleMessage re-reads it), so a skipped insert was
  // never delivered.
  //
  // T10: the shim `memory/interagent.ts` is gone and this is the same write, stated in the
  // writer module's own vocabulary. Three things the shim did are now visible at the site
  // instead of hidden one call away: `originKind === 'engine'` WAS the lane and now says so
  // (T3-0b §1 maps the two value for value); a peer A2A thread is a conversation like any
  // other (P5), resolved here from the thread root; and the shim's `{ changes: 0 }` return
  // becomes the `null` that `insertMessageIfAbsent` already means by name.
  const conversationId = threadId
    ? resolveOrCreateConversation(target.id, {
        channel: 'a2a', provider: null, counterpartyId: envelope.fromAgent, threadRoot: threadId,
      })
    : null;
  const persisted = insertMessageIfAbsent({
    id: msgId,
    agentId: target.id,
    role: 'user',
    lane: originKind === 'engine' ? 'events' : 'a2a',
    content: contextMessage,
    sourceAgentId: envelope.fromAgent,
    a2aThreadId: threadId,
    a2aIntent: effectiveIntent,
    a2aRequiresResponse: requiresResponse,
    attachments: attachmentsJson,
    originIntent,
    conversationId,
  });

  // ── 11b. Confirm the row actually persisted (FA-C4) ──
  // The persisted messages row is the SOLE delivery vehicle: runtime.handleMessage
  // ignores its content arg and re-reads this row, so a message that never landed in
  // the store was never delivered. Treat a skip as a drop rather than returning
  // delivered:true blind. The IDEMPOTENT form is kept deliberately: the only path to a
  // skip is an id collision, which cannot happen today (msgId is a fresh uuidv4), so this
  // is future-proofing. It degrades that (unreachable) collision to a clean drop instead
  // of a throw that fire-and-forget callers (PM poke, scheduler) would not catch — while
  // a NOT NULL or CHECK violation still THROWS, which raw `INSERT OR IGNORE` swallowed
  // and `insertMessageIfAbsent` deliberately does not (T4, R1). Genuine DB faults
  // (BUSY/FULL/IO) are not constraint violations and throw either way.
  if (persisted === null) {
    logDrop(envelope, 'PERSIST_SKIPPED');
    return { delivered: false, reason: 'PERSIST_SKIPPED', threadId };
  }

  // ── 12. Broadcast to the dashboard's Inter-Agent lane (with attachments so
  // the live UI shows the image immediately, not just on page refresh). ──
  // D-A step 5: inter-agent traffic leaves `chat:message` ENTIRELY. A peer (or
  // engine-origin) A2A delivery is broadcast on the dedicated `interagent:message`
  // lane, never the human chat feed, so the dashboard no longer needs the old
  // 'a2a' visibility tier to hide it from chat; the store separation makes that
  // structural. The persisted store row is still the SOLE delivery vehicle (the
  // FA-C4 guard above); this broadcast is dashboard-only and never gates delivery.
  // @dojo/shared is imported type-only here (packaged-runtime import trap), so the
  // payload is built from raw fields, no runtime deriveOrigin call.
  broadcast({
    type: 'interagent:message',
    agentId: target.id,
    message: {
      id: msgId,
      agentId: target.id,
      role: 'user',
      content: contextMessage,
      createdAt: new Date().toISOString(),
      sourceAgentId: envelope.fromAgent,
      senderName: resolveAgentDisplayName(envelope.fromAgent) ?? envelope.fromAgent,
      recipientName: target.name ?? null,
      threadId,
      intent: effectiveIntent,
      requiresResponse,
      // engineOrigin (computed above) tags Healer/PM/scheduler/gate-origin A2A;
      // peer A2A keeps originKind null. The lane styles engine vs peer off this.
      originKind,
      attachments: attachmentsList.length > 0 ? attachmentsList : undefined,
    },
  });

  // ── 13. Route based on requires_response ──
  if (requiresResponse) {
    // Wake-block for paused-only. Pre-2026-04-29 we also blocked waking
    // agents in `error` status, meant to prevent compound failures, but
    // it caused injured agents to silently ignore PM/peer messages, leaving
    // them stuck until the Healer's grace timer expired. With the in-loop
    // error recovery added in v1.15.76 (capability mismatch / 4xx → system
    // note → adapt), re-waking an injured agent is safe: worst case it
    // re-injures and the Healer takes over, best case it transiently
    // recovers or self-corrects. `paused` (error-loop signal) keeps the
    // block, re-waking there would just compound.
    const targetIsLockedOut = target.status === 'paused';
    let senderCanWakeLockedOut = envelope.fromAgent === 'system';
    if (!senderCanWakeLockedOut && targetIsLockedOut) {
      try {
        const { isHealerAgent } = await import('../config/platform.js');
        senderCanWakeLockedOut = isHealerAgent(envelope.fromAgent);
      } catch { /* */ }
    }

    if (targetIsLockedOut && !senderCanWakeLockedOut) {
      logger.info('A2A delivery: skipping handleMessage for paused agent (error loop)', {
        targetId: target.id,
        targetStatus: target.status,
        from: envelope.fromAgent,
      });
      // Message persisted and broadcast (steps 10-12 above), but the agent
      // is not woken. Healer or system can still wake them.
    } else {
      // ── Wake-intent preempt (v2.5.38) ──
      // Any wake-intent A2A delivery (we're already inside the
      // requiresResponse branch, so non-wake FYI/STATUS doesn't reach
      // here) preempts the receiver's current turn so they can respond
      // promptly instead of waiting up to 15 min for their current
      // turn to end. Subject to a 30s throttle per receiver to prevent
      // interrupt storms; system/PM/Healer bypass the throttle as
      // genuinely-urgent operational traffic.
      //
      // The receiver gets a context-note marker on the first assembly
      // after preempt (set in agent.config, picked up by the
      // assembler, same pattern as stopMarkerPending) explaining what
      // happened, suggesting they respond to the new ask, warning that
      // any in-flight tool may have been orphaned, and noting the
      // recent preempt count so they can self-throttle if A and B are
      // ping-ponging.
      // (duplicate-work root fix) We deliberately do NOT preempt the receiver's
      // in-flight turn for an inbound wake-intent A2A. This is the same root cause
      // as the chat path (gateway/routes/chat.ts): preempting aborts a multi-step
      // turn AFTER it has committed side effects (created a tracker project, written
      // a deliverable file) and BEFORE it marks its work served, so the re-triggered
      // turn redoes that work, duplicate projects, the plan delivered twice, the
      // same question answered twice. Confirmed via per-turn LOOP-START markers: an
      // urgent PM QUESTION preempted the primary agent mid-turn and the turn restarted under the
      // same turn_number. The message is still delivered + persisted, and the
      // end-of-turn A2A re-trigger (runtime.ts finally) gives this inbound its OWN
      // dedicated turn right after the current one finishes, so the PM gets answered
      // without interrupted-and-redone work. Genuine emergency interrupts (stop)
      // still use the explicit stop control, the correct place for that.

      const runtime = getAgentRuntime();
      runtime.handleMessage(target.id, contextMessage).catch(err => {
        logger.error('A2A delivery: failed to wake receiver', {
          targetId: target!.id,
          threadId,
          error: err instanceof Error ? err.message : String(err),
        }, envelope.fromAgent);
      });
    }
  }
  // If requires_response is false: message is persisted and broadcast
  // but the receiver is NOT woken. It becomes read-only context on
  // their next natural turn. No tokens spent on the receiver's side.

  logger.info('A2A message delivered', {
    messageId: msgId,
    threadId,
    from: envelope.fromAgent,
    fromName: senderName,
    to: target.id,
    toName: target.name,
    intent: effectiveIntent,
    originalIntent: envelope.intent,
    autoPromotedFromFyi,
    requiresResponse,
    hopCount: currentHops + 1,
    payloadLength: envelope.payload.length,
  }, envelope.fromAgent);

  return {
    delivered: true,
    threadId,
    messageId: msgId,
    autoCreatedTaskId: autoTask?.taskId,
    autoTaskIsNew: autoTask?.isNew,
    autoPromotedFromFyi,
  };
}

// ════════════════════════════════════════
// The delegated JOIN: parent/child work rows with an atomic countdown (PHASE-2 T4)
//
// WHAT THIS REPLACES. One owner ask delegated to N agents used to be held by rewriting the
// owner message's `conv_key` into `park:~<t1>|<t2>|<t3>#<remaining>` and shrinking the text
// after the '#' as pieces came back: the join state was a string, the countdown was string
// arithmetic, and the column it lived in was the same column that carries the conversation's
// IDENTITY — so parking an ask destroyed the record of where it came from and the channel had
// to be recovered from an `inbound_meta` JSON blob (research 07 §3, "worst coupling").
//
// The join now lives in `work`: the owner's ask is the PARENT (OR1's one ID space, not a
// second record), each delegated thread is a CHILD keyed on the FULL thread id, and
// `remaining_children` is decremented inside `transition()` — the ONE writer — in the same
// transaction as the child's own state change. Everything below is transport: it lands
// pieces, relays answers, and fails stuck joins closed. It computes no join state of its own.
//
// requirement preserved, one line each:
//   * an owner question delegated to a peer is answered even if the model never speaks again
//     -> the engine relays the single-piece answer itself, exactly as before (D13);
//   * a fan-out never relays ONE piece as THE answer                -> the countdown holds
//     until zero and only then steers the model to compile;
//   * a join that never completes still reaches the owner            -> `work.ttl_at` + the
//     reaper below, one honest notice, exactly once;
//   * an answer arriving after that notice is never silently dropped -> the late-answer path;
//   * a park could not be matched back from an 8-char token          -> gone: `root_id` is
//     the full thread id and it is matched exactly (3j).
// ════════════════════════════════════════

/** How long an unanswered join may stay open before the engine fails it closed. */
const JOIN_TTL_MS = JOIN_TTL_MINUTES * 60_000;
/** Give the steered compile a real chance before the engine relays the pieces itself. */
const COMPILE_GRACE_SECONDS = 60;
const JOIN_BOOT_BATCH = 50;

/** Display name for an agent id; historical rows sometimes stored a display name
 *  in source_agent_id, so a non-UUID value is usable as-is. */
function resolveAgentDisplayName(idOrName: string | null | undefined): string | null {
  if (!idOrName) return null;
  try {
    const row = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(idOrName) as { name?: string } | undefined;
    if (row?.name) return row.name;
  } catch { /* best effort */ }
  return /^[0-9a-f-]{32,}$/i.test(idOrName) ? null : idOrName;
}

/** Short quote of the owner's original question for the fail-closed notice
 *  (leading channel/SOURCE markers stripped, whitespace squashed). */
function questionSnippet(content: string): string {
  const stripped = content.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  return stripped.length > 160 ? `${stripped.slice(0, 160).trimEnd()}...` : stripped;
}

/** The owner's original inbound row behind a join. The parent ask's `root_id` IS that message
 *  id (recorded at creation — origin is required on the spine), so this is a lookup rather
 *  than the timestamp-bounded scan the string machine needed. */
function askRowForJoin(join: JoinState): { content: string; inbound_meta: string | null; created_at: number } | null {
  const r = getDb().prepare(
    'SELECT content, inbound_meta, created_at FROM messages WHERE id = ?',
  ).get(join.rootId) as { content: string; inbound_meta: string | null; created_at: number } | undefined;
  return r ?? null;
}

// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 5 (SWEEP-A's INBOUND of 2026-08-04) — THE COMPOSE PATH AND THE WALL
// AGREE, AND A REFUSAL IS NEVER SILENT AGAIN.
//
// PHASE-6 T0-KIT measured it and named the owner: this relay composed owner-channel replies
// on ANY agent, while each channel handler refuses a non-primary one — and the refusal was
// SILENT. The relay read `r.kind === 'applied'` and nothing else, so "the platform refused
// this agent that door" and "this channel does not apply" arrived as the same fact and both
// produced the same quiet dashboard fallback. Nobody was told the owner's channel reply did
// not go out.
//
// ── ONE PREDICATE, NOT A COPY OF THE RULE ──
// `isPrimaryAgent` is the function all four doors already ask:
//     teams_send_message / outlook_reply -> `provider/microsoft.ts` `outlook_send`
//     gmail_reply                        -> `provider/google.ts`    `gmail_send`
//     sms_send                           -> `cat/comms.ts`          `sms_send`
//     imessage_send                      -> gate ladder row 7 (`tools/gates.ts`)
// This asks the same one. A second spelling of "who may send on the owner's channels" is the
// disagreement the task exists to end, so no new set, no new config, no new grant.
//
// ⚠ REFUSAL: NEVER CLOSED BY WIDENING THE WALL. A non-primary agent gaining owner-channel
// send is a capability the owner has not granted, and this function grants nothing — it only
// declines to compose a message it can already tell will be refused, and says so out loud.
//
// ⚠ AND IT REACHES THE iMESSAGE BRANCH TOO, WHICH IS THE SHARPEST OF THE FOUR. That branch
// calls `sendResponseViaIMessage` directly rather than through `executeTool`, so it crossed
// NO wall at all while the `imessage_send` TOOL is refused to a non-primary agent by gate
// ladder row 7 — the compose path and the wall disagreeing in the loudest possible way.
// Bringing it inside the scope check is a NARROWING (the block's own first option), and it is
// measured rather than assumed safe: every inbound channel producer on this box files its
// message — and therefore its ask, and therefore any join rooted on it — to the PRIMARY agent
// (`services/imessage-bridge.ts`, `teams-watcher.ts`, `gmail-watcher.ts`, `outlook-watcher.ts`
// and `twilio/sms-inbound.ts` all resolve `primaryId` before they insert), so in production
// this refuses nothing that used to succeed. What it refuses is the harness shape T0-KIT drove
// — and that refusal is the finding, not a regression.
export interface OwnerChannelRelayRefusal {
  /** The channel the ask arrived on, so the owner is told which door stayed shut. */
  channel: string;
  /** The door that would have been crossed — a tool name, or the bridge function. */
  tool: string;
  /** Why, in a sentence the owner can act on. */
  why: string;
}

/**
 * Would the wall refuse this agent an owner-channel send? Returns the refusal, or `null` when
 * the relay may compose. Exported so the agreement is a thing a test can read, rather than a
 * property of two files that happen to agree today.
 */
export function ownerChannelRelayRefusal(
  agentId: string, channel: string, tool: string,
): OwnerChannelRelayRefusal | null {
  if (isPrimaryAgent(agentId)) return null;
  return {
    channel, tool,
    why: 'only the primary agent may send on the owner\'s channels, and this join belongs to '
      + 'another agent',
  };
}

/** The door each channel's relay branch crosses — written once so the refusal names the same
 *  thing the branch would have called, and a channel added to one and not the other is
 *  visible rather than silently unnamed. */
const RELAY_DOOR: Readonly<Record<string, string>> = {
  imessage: 'imessage-bridge',
  teams: 'teams_send_message',
  email: 'gmail_reply/outlook_reply',
  sms: 'sms_send',
};

/**
 * The origins that have NO outbound door of their own — the dashboard IS the delivery, and a
 * voice call is over by the time a join lands.
 *
 * UX-REPAIR ROUND 7 T29 — THE ARM'S OWN ⚠ COMMENT WAS THE SPEC, AND THE CODE HAD DRIFTED OFF
 * IT. That comment says "a dashboard-origin ask has no channel meta at all and there is
 * nothing to report". That premise is false and was false when it was written: `InboundMeta`
 * declares `channel: ChannelKind | 'dashboard' | 'voice'` and 3,310 of the 3,669 stamped rows
 * on the worn-in body carry `'dashboard'` — the single most common value. So the seed's
 * `meta.channel == null` test caught almost none of the joins the comment describes, and on
 * 2026-08-11 the arm told the owner "I could not send that answer back on dashboard, so it is
 * here on the dashboard instead" about an answer that had delivered fine. An alert that fires
 * on the ordinary case is the noise that makes the real one invisible — which is what the
 * comment predicted about itself.
 *
 * Written as a named set rather than by inverting `RELAY_DOOR`, so a fifth channel added to
 * the delivery branches and forgotten in that table still ALERTS (loudly, under its own name)
 * instead of falling silent.
 */
const NON_RELAYABLE_ORIGINS: ReadonlySet<string> = new Set(['dashboard', 'voice']);

/** Is there a channel here that could have refused anything? Exported so the law is a value a
 *  test can read, exactly as `ownerChannelRelayRefusal` is. */
export function originHasNoRelayDoor(channel: string | null | undefined): boolean {
  return channel == null || NON_RELAYABLE_ORIGINS.has(channel);
}

/** What the door said, STRUCTURALLY. `ToolOutcome`'s own arms — never the prose, which is the
 *  line PHASE-4 T1 drew and this reader keeps: `refused` means the platform said no, `failed`
 *  means the tool broke, and the two are different things to tell the owner. */
function relayDoorDetail(r: ToolOutcome): string {
  if (r.kind === 'refused') return `the door refused it (${r.reason})`;
  if (r.kind === 'failed') return `the send failed (${r.reason})`;
  return 'the send did not complete';
}

/**
 * Deliver a join's result to the owner on the channel their question arrived on, falling
 * back to the dashboard so they ALWAYS see it somewhere, and RECORD the delivery.
 *
 * Returns the delivery row id, or null when nothing could be recorded. The caller has already
 * won the right to deliver — the exactly-once guard is the `work` transition that precedes
 * this call, never a flag this function sets.
 *
 * (Channel-aware delivery is carried over verbatim from `consumeParkAndDeliver`: iMessage /
 * Teams / email / SMS, with the C18 group-chat and re-validation guards and the B-2
 * multi-account reply-from, because each of those is an incident with a name.)
 */
async function deliverJoinResultToOwner(
  join: JoinState, deliveryText: string, opts?: { tool?: string; voice?: 'agent' | 'platform' },
): Promise<string | null> {
  // PHASE-2 T5 — THE T4 COLLISION, RESOLVED BY ROUTING RATHER THAN DUPLICATING.
  // T4 recorded this relay with its own `recordDelivery` call. T5 puts a recorder on the
  // dashboard, iMessage, SMS and provider doors this function pushes through, so leaving both
  // in place would have produced TWO rows for one relay. The relay now DECLARES the identity
  // and every door it crosses folds into that one row — including the dashboard fallback's
  // own bubble, which is the same physical delivery, not a second one.
  return withOutboundAsync(
    {
      agentId: join.agentId,
      tool: opts?.tool ?? 'a2a-join-relay',
      // Declared as dashboard because that is the guaranteed floor; the channel branch below
      // reports what it actually used through the door observation.
      channel: 'dashboard',
      conversationId: join.replyConversationId,
    },
    () => deliverJoinResultToOwnerInner(join, deliveryText, opts),
  );
}

async function deliverJoinResultToOwnerInner(
  join: JoinState, deliveryText: string, opts?: { tool?: string; voice?: 'agent' | 'platform' },
): Promise<string | null> {
  // PHASE-4 T4 (OR2). Two different things travel through this one door and they are not the
  // same kind of statement, so they no longer wear the same face:
  //   * `voice: 'agent'`   — a RELAY of a peer agent's own words to the person who asked. The
  //     content is somebody's actual answer and the engine is the courier; D13 owns this
  //     relay deliberately (a weak model re-read "ask X" and re-asked, the ask→park→answer→
  //     re-ask LOOP), and taking it away would re-open that recorded incident.
  //   * `voice: 'platform'` — a NOTICE about what the platform observed: a delegated piece
  //     never came back. That is not the agent's sentence and it stops being written as one.
  //     It carries the owner-alert prefix on every channel, and the dashboard fallback writes
  //     a `role='system'` row instead of an assistant bubble.
  const platformVoice = opts?.voice === 'platform';
  const deliveryBody = platformVoice
    ? `${OWNER_ALERT_HEADS_UP_PREFIX} ${deliveryText}`
    : deliveryText;
  const ask = askRowForJoin(join);
  let meta: {
    channel?: string; sender?: string; chatId?: string; chatType?: string; emailMessageId?: string;
    emailService?: string; emailAccount?: string; smsFromNumber?: string; smsToNumber?: string;
  } = {};
  try { meta = ask?.inbound_meta ? JSON.parse(ask.inbound_meta) as typeof meta : {}; } catch { meta = {}; }
  const tool = opts?.tool ?? 'a2a-join-relay';
  let delivered = false;
  let channel: DeliveryInput['channel'] = 'dashboard';
  let recipientId: string | null = null;
  // ── SWEEP CORE-2 item 5 — THE SCOPE CHECK, RESOLVED ONCE, ABOVE EVERY BRANCH ──
  // Above them deliberately: a fifth channel added later cannot be added outside it, which is
  // how the iMessage branch came to be the one door that crossed no wall at all.
  // `meta.channel` is the ask's own OR4 ingest stamp, so the door named in the refusal is the
  // door the owner actually used.
  let relayRefusal: OwnerChannelRelayRefusal | null =
    originHasNoRelayDoor(meta.channel)
      ? null   // no channel to be refused FROM: the dashboard fallback IS the delivery
      : ownerChannelRelayRefusal(join.agentId, meta.channel!, RELAY_DOOR[meta.channel!] ?? meta.channel!);
  /** A handler that refuses AFTER the scope check let the call through — the wall moving
   *  underneath the relay must not make the failure silent again. */
  const noteRelayRefusal = (ch: string, door: string, detail: string): void => {
    relayRefusal ??= { channel: ch, tool: door, why: detail };
  };
  try {
    if (relayRefusal) {
      // Composed nothing. The answer is not lost — it goes to the dashboard below, exactly as
      // it did for every other unhandled channel, and the owner is TOLD which door stayed shut.
    } else if (meta.channel === 'imessage' && meta.sender) {
      const { sendResponseViaIMessage } = await import('../services/imessage-bridge.js');
      delivered = !!sendResponseViaIMessage(deliveryBody, join.agentId, meta.sender);
      channel = 'imessage'; recipientId = meta.sender;
      if (!delivered) noteRelayRefusal('imessage', 'imessage-bridge', 'the iMessage bridge did not send it');
    } else if (
      meta.channel === 'teams' && meta.chatId &&
      // C18: never relay into a GROUP chat (the owner's private "Heard back from X" would go
      // to the whole group), and re-validate the sender at relay time (they may have been
      // removed from the safe list mid-conversation). Either condition fails → the guaranteed
      // dashboard fallback below.
      meta.chatType !== 'group' && isSenderAuthorized('teams', meta.sender ?? '', 'agent')
    ) {
      const { executeTool } = await import('./tools/index.js');
      const tc: ToolCall = { id: uuidv4(), name: 'teams_send_message', arguments: { chat_id: meta.chatId, message: deliveryBody } };
      const r = await executeTool(join.agentId, tc);
      delivered = r.kind === 'applied'; channel = 'teams'; recipientId = meta.chatId;
      if (!delivered) noteRelayRefusal('teams', 'teams_send_message', relayDoorDetail(r));
    } else if (
      meta.channel === 'email' && meta.emailMessageId &&
      // C18: re-validate the email sender at relay time; a removed sender must not get the
      // relayed answer (falls through to the dashboard fallback).
      isSenderAuthorized('email', meta.sender ?? '', 'agent', { emailService: meta.emailService === 'outlook' ? 'outlook' : 'gmail' })
    ) {
      const { executeTool } = await import('./tools/index.js');
      const toolName = meta.emailService === 'gmail' ? 'gmail_reply' : 'outlook_reply';
      const tc: ToolCall = {
        id: uuidv4(), name: toolName,
        // B-2 (comms-audit): reply FROM the mailbox that received the owner's original
        // question (multi-account), not an ambiguous default.
        arguments: { message_id: meta.emailMessageId, body: deliveryBody, ...(meta.emailAccount ? { account: meta.emailAccount } : {}) },
      };
      const r = await executeTool(join.agentId, tc);
      delivered = r.kind === 'applied'; channel = 'email'; recipientId = meta.sender ?? null;
      if (!delivered) noteRelayRefusal('email', toolName, relayDoorDetail(r));
    } else if (meta.channel === 'sms' && (meta.smsFromNumber || meta.sender)) {
      // BUG-3 (comms-audit): the owner can ask via SMS; route via the sms_send tool (like the
      // teams/email branches) so the same executor, its safe-sender revalidation and the
      // harness capture all apply, and text the original from-number back.
      const { executeTool } = await import('./tools/index.js');
      const to = meta.smsFromNumber ?? meta.sender!;
      const tc: ToolCall = { id: uuidv4(), name: 'sms_send', arguments: { to, body: deliveryBody } };
      const r = await executeTool(join.agentId, tc);
      delivered = r.kind === 'applied'; channel = 'sms'; recipientId = to;
      if (!delivered) noteRelayRefusal('sms', 'sms_send', relayDoorDetail(r));
    }
  } catch (err) {
    logger.warn('join relay: channel delivery failed, falling back to dashboard', {
      agentId: join.agentId, work: join.id, channel: meta.channel,
      error: err instanceof Error ? err.message : String(err),
    });
    if (meta.channel) {
      noteRelayRefusal(meta.channel, RELAY_DOOR[meta.channel] ?? meta.channel,
        err instanceof Error ? err.message : String(err));
    }
    delivered = false;
  }
  let messageId: string | null = null;
  if (!delivered) {
    // Dashboard (or unhandled/failed channel): surface it as the agent's own chat message so
    // it renders in their conversation. Always reaches them, so the text is never lost.
    // Owner lane deliberately: this is the relay TO THE PERSON who asked.
    messageId = uuidv4();
    // OR2: a platform notice is a `role='system'` row on the owner-alert allowlist, never an
    // assistant bubble. A relay of a peer's own answer stays an assistant row, because that is
    // what it is — the agent's delegated work coming back to the person who asked.
    const role = platformVoice ? 'system' as const : 'assistant' as const;
    insertMessageIfAbsent({ id: messageId, agentId: join.agentId, role, content: deliveryBody });
    broadcast({
      type: 'chat:message', agentId: join.agentId,
      message: { id: messageId, agentId: join.agentId, role, content: deliveryBody, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
    });
    channel = 'dashboard'; recipientId = 'owner';
  }
  // ── SWEEP CORE-2 item 5 — THE REFUSAL SURFACES LOUDLY, TO BOTH AUDIENCES ──
  //
  // The answer has already gone to the dashboard above — the owner never loses it, which is
  // the 2026-08-05 governing priority. What was missing is that anybody KNOWS the channel
  // reply did not go out. Two records, one for each audience:
  //
  //   * the PLATFORM, at ERROR level, naming the agent, the channel and the door, so a
  //     wall/compose disagreement is greppable rather than inferable from a missing text;
  //   * the OWNER, in words, through the ONE announce door — `role='system'` plus the shared
  //     owner-alert prefix, written and put on the wire in the same breath, exactly as
  //     `floor-ghost.ts` does it since SWEEP-A TB4. An alert nobody reads is a silenced alarm,
  //     and `owner-alert-announce-census.test.ts` is what keeps this site honest.
  //
  // ⚠ CONDITIONAL ON A REFUSAL, never on the fallback. A dashboard-origin ask has no channel
  // meta at all and there is nothing to report; an alert on every ordinary relay would be the
  // noise that makes the real one invisible.
  if (relayRefusal) {
    logger.error('join relay: the owner\'s channel reply was REFUSED; it went to the dashboard instead', {
      agentId: join.agentId, work: join.id, channel: relayRefusal.channel,
      tool: relayRefusal.tool, why: relayRefusal.why,
    });
    const noticeId = uuidv4();
    const notice = `${OWNER_ALERT_HEADS_UP_PREFIX} I could not send that answer back on `
      + `${relayRefusal.channel}, so it is here on the dashboard instead. ${relayRefusal.why}.`;
    try {
      const persisted = insertMessageIfAbsent({
        id: noticeId, agentId: join.agentId, role: 'system', content: notice,
      });
      // Announced only when a row was actually written: a frame with no row behind it is the
      // other half of the same defect (live-only, gone on refresh).
      if (persisted) {
        broadcast({
          type: 'chat:message', agentId: join.agentId,
          message: {
            id: noticeId, agentId: join.agentId, role: 'system', content: notice,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: persisted.createdAt,
          },
        });
      }
    } catch (err) {
      logger.warn('join relay: the refusal notice could not be written (non-fatal)', {
        agentId: join.agentId, work: join.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // PHASE-2 T4: the relay is a real outbound to a real person and it now RECORDS one — this
  // is the row `work.done` points at. PINNED §8 lists the park relay among the paths that
  // record nothing; T5 owns the doors and must route this through the same single writer
  // rather than adding a second row beside it.
  const deliveryId = recordedId(recordAtDoor({
    outcome: 'delivered', channel,
    agentId: join.agentId, tool,
    recipientId, messageId,
    // ONE derivation of "which join was this?" (SWEEP-A TB13): the guard that stops the engine
    // relaying twice reads this same string through `joinDeliveryDetail`, so writer and reader
    // cannot drift.
    detail: joinDeliveryDetail(join.id),
  }), 'a2a: join relay to the owner', { work: join.id, channel });
  logger.info('join relay: engine delivered to owner', {
    agentId: join.agentId, work: join.id, channel, viaChannel: delivered, deliveryId,
  });
  return deliveryId;
}

/** The honest "you did not get an answer" notice, composed from the join itself.
 *
 *  ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02). This was an engine-composed line in the
 *  AGENT's first person — *"I asked Ana about this but could not get an answer."* — delivered
 *  as an assistant message on the owner's lane. It says the same fact in the PLATFORM's voice
 *  now ("your agent asked…", third person), it travels with the owner-alert prefix, and the
 *  dashboard fallback writes it as a `role='system'` row (`voice: 'platform'` at every call
 *  site). The AGENT is told separately and decides what to say in its own words
 *  (`tellAgentTheJoinFailed`), which is the 2026-07-30 owner ruling's shape.
 *
 *  What was never provisional, and is untouched: the exactly-once property is machine-enforced
 *  by the `work` transition that precedes the send, not by this text. */
function failClosedNotice(join: JoinState, askedNameHint?: string | null): string {
  const ask = askRowForJoin(join);
  const snippet = ask ? questionSnippet(ask.content) : '';
  const pieces = joinPieces(join.id);
  const outstanding = pieces.filter((p) => !isTerminal(p.state));
  const body = join.total > 1
    ? `your agent split this across several agents and could not get all the pieces back in time, so there is no complete answer for you.`
    : (() => {
      const name = resolveAgentDisplayName(outstanding[0]?.assigneeAgent ?? pieces[0]?.assigneeAgent)
        ?? askedNameHint ?? 'another agent';
      return `your agent asked ${name} about this and could not get an answer.`;
    })();
  return body + (snippet ? ` (Your question was: "${snippet}")` : '');
}

/**
 * OR2's other half at this seam: THE AGENT IS TOLD, and decides whether to speak.
 *
 * The platform states the fact to the person (above) because a person who asked a question is
 * owed the truth that no answer is coming, and no model call is available here — this runs in a
 * reaper sweep, not inside a turn, so a steer written now would be exactly the "written, never
 * seen" shape T3 deleted. What CAN reach the model is the events lane, on its next turn, and it
 * carries the 2026-07-30 ruling's nudge verbatim: if the user should know more, tell them.
 */
function tellAgentTheJoinFailed(join: JoinState, what: string): void {
  try {
    insertEngineEventIfAbsent({
      work: { taskId: join.id, runId: null, rootKind: 'ask', rootId: join.rootId },
      id: uuidv4(),
      agentId: join.agentId,
      content:
        `[System] A piece of work you delegated never came back: ${what} The platform has told the `
        + `user that plainly, in its own voice, so they are not left waiting. If the user should `
        + `know more — what you were after, whether it is worth another try — WRITE it to them in `
        + `your own words on your next turn, directly in the conversation.`,
      sourceAgentId: null,
      originIntent: 'fanout_join',
      turnNumber: null,
    });
  } catch { /* the person has been told; the agent's copy is best-effort */ }
}

/**
 * A reply that ARRIVED but never landed on its piece (a crash between the A2A persist and the
 * countdown). Bounded by created_at so the lookup rides idx_messages_agent_created, and keyed
 * on the FULL thread id — the length-sniffing `parkThreadCondition` is gone with the 8-char
 * tokens that forced it.
 */
function findUnlandedInboundReply(
  agentId: string, threadId: string, sinceMs: number,
): { payload: string; senderName: string; messageId: string; senderId: string | null } | null {
  const row = getDb().prepare(
    `SELECT id, content, source_agent_id FROM messages
      WHERE agent_id = ? AND role = 'user' AND source_agent_id IS NOT NULL
        AND source_agent_id != ? AND created_at >= ?
        AND a2a_thread_id IN (?, ?)
      ORDER BY (a2a_intent IN ('ANSWER','DELIVERABLE','COMPLETE','FAIL')) DESC, rowid DESC
      LIMIT 1`,
  ).get(agentId, agentId, sinceMs - 15 * 60_000, threadId, threadId.slice(0, 8)) as
    | { id: string; content: string; source_agent_id: string | null } | undefined;
  if (!row) return null;
  // The stored row is the full context message: [A2A:...] envelope + payload + [Thread ...]
  // footer (+ optional engine hint). Relay just the payload.
  const payload = row.content.replace(/^\[A2A:[^\]]*\]\s*/, '').split('\n\n[Thread ')[0];
  const fromTag = row.content.match(/^\[A2A:[A-Z]+\s+thread:\S+\s+from:([^\]]+)\]/);
  const senderName = resolveAgentDisplayName(row.source_agent_id) ?? fromTag?.[1]?.trim() ?? 'the other agent';
  return { payload, senderName, messageId: row.id, senderId: row.source_agent_id };
}

/** Record the A2A hand-back itself as a delivery: the piece IS something the platform
 *  delivered, and `work.done` requires a delivery to point at (3h/3i). PINNED §8 names
 *  `send_to_agent` as one of the ten unrecorded paths T5 closes AT THE DOOR — when it does,
 *  this call becomes that door's, not a second row beside it. */
function recordPieceDelivery(p: {
  fromAgent: string; toAgent: string; messageId: string | null; intent: string;
}): string | null {
  // PHASE-2 T5: routed through the door recorder, NOT duplicated. Inside a `send_to_agent`
  // scope this folds into that scope's single row (and picks up its receipt link); outside
  // one it stands alone exactly as T4 wrote it.
  return recordedId(recordAtDoor({
    outcome: 'delivered', channel: 'a2a',
    agentId: p.fromAgent, tool: 'send_to_agent',
    recipientId: p.toAgent, recipientDisplay: resolveAgentDisplayName(p.toAgent),
    messageId: p.messageId, detail: `A2A ${p.intent}`,
  }), 'a2a: piece delivery', { from: p.fromAgent, to: p.toAgent });
}

/**
 * The compile steer: all pieces are back, so hand the model their delivered content VERBATIM
 * and ask for ONE combined reply.
 *
 * The receipts principle and the exact wording are carried over unchanged, because both are
 * incident-derived: the separate-lane architecture keeps A2A deliverables out of the chat
 * store, so "read the messages above" pointed at content the model could not reach (run
 * bmrpxzuhxvh: four empty history_search calls and no compile), and an earlier wording that
 * said "verify each piece's ACTUAL content" made the floor model exec a blocked loop over the
 * staged files and spin 45 tool calls (run bmrplgdg33l). The content is quoted; tools are
 * forbidden. What CHANGED is only where the quotes come from: the children's own recorded
 * results instead of a `join-piece:` conv_key namespace that could come up empty.
 */
function steerModelToCompile(join: JoinState, rung?: { attempt: number; bound: number }): void {
  const PIECE_CAP = 1200;
  const rendered = joinPieces(join.id).map((p, i) => {
    const name = resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent';
    const raw = (p.content ?? '').replace(/\s+/g, ' ').trim();
    const body = raw.length > 0
      ? (raw.length > PIECE_CAP ? `${raw.slice(0, PIECE_CAP)} [truncated]` : raw)
      : `(no content came back — this piece ${p.state === 'abandoned' ? 'was abandoned' : 'failed'})`;
    return `Piece ${i + 1} (from ${name}, thread ${p.threadId.slice(0, 8)}): "${body}"`;
  });
  // The wording lives in `work/join-drive.ts` beside the ladder that spends it, so a test can
  // read it without driving a turn (the shape `run-deliver-drive.ts` already uses). T10 also
  // moved the ORDER ahead of the quotes — the events lane renders this row as a 400-char gist,
  // and the instruction used to sit past the cut. Byte-identical re-sends were the other half:
  // the model was never told this was attempt 2 or 3 (measured, PC2).
  const steer = compileSteerText({
    total: join.total, pieces: rendered,
    attempt: rung?.attempt ?? null, bound: rung?.bound ?? JOIN_REDRIVE_BOUND,
  });
  // Owner option B (2026-07-18): ride the IMPERATIVE engine-steer channel, not the ambient
  // awareness NOTICE — an origin_kind='engine' row on the 'engine-steer' sentinel, kept out of
  // the pending-event pool so it never drives its OWN turn; the deliverable's own wake carries
  // it to the model. T10 made the second half of that sentence true on an A2A wake as well
  // (`memory/assembler.ts` scopeToA2AThread's one exemption).
  insertEngineEventIfAbsent({
    work: null, id: uuidv4(), agentId: join.agentId, content: steer,
    sourceAgentId: null, originIntent: 'fanout_join',
  });
  logger.info('join complete: steered the model to compile the combined reply', {
    agentId: join.agentId, work: join.id, total: join.total,
    attempt: rung?.attempt ?? null, bound: rung?.bound ?? null,
  });
}

/**
 * A terminal A2A reply landed on a thread this agent delegated on. Advance the join.
 *
 * Returns true when the join owned this reply (so the caller suppresses the ordinary
 * deliverable hint — the engine owns delivery on a joined thread; C21).
 */
async function landReplyOnJoin(p: {
  agentId: string; threadId: string; threadShort: string; payload: string;
  fromAgent: string; intent: A2AIntent; messageId: string | null; senderName: string;
}): Promise<boolean> {
  const child = findJoinChildByThread(p.agentId, p.threadId);
  if (!child) return await deliverLateAnswerIfJoinFailedClosed(p);

  // Join hygiene (2026-07-23, run bmrwsrsi9gl): an EMPTY terminal reply is not a deliverable.
  // Advancing on one shipped "(no delivered content found)" into the compile steer 18 seconds
  // after the ASSIGNs went out. The refusal is inside `landPiece` so no caller can forget it;
  // the piece stays outstanding for the real deliverable, or the TTL fails it closed.
  const deliveryId = recordPieceDelivery({
    fromAgent: p.fromAgent, toAgent: p.agentId, messageId: p.messageId, intent: p.intent,
  });
  let settle: ReturnType<typeof landPiece>;
  if (p.intent === 'FAIL') {
    // A terminal FAIL is a LANDED piece: the peer came back, and "it failed" is an answer the
    // owner is entitled to. It does not get a result delivery — there is no result.
    settle = settlePieceWithoutResult(child.id, {
      to: 'failed', reason: `the peer replied FAIL on thread ${p.threadShort}`,
      content: p.payload, actorId: p.fromAgent,
    });
  } else if (!deliveryId) {
    logger.warn('join: the piece delivery could not be recorded; holding the piece rather than closing it unproven', {
      agentId: p.agentId, thread: p.threadShort,
    });
    return true;
  } else {
    settle = landPiece(child.id, {
      deliveryId, content: p.payload, messageId: p.messageId, actorId: p.fromAgent,
    });
  }
  if (settle.result.kind === 'refused') {
    logger.info('join: piece not advanced', {
      agentId: p.agentId, thread: p.threadShort, result: settle.result.kind,
      detail: settle.result.reason,
    });
    return true;
  }
  const join = settle.join;
  if (!join.complete) {
    logger.info('join: piece landed, holding for the rest', {
      agentId: p.agentId, thread: p.threadShort, landed: join.landed, total: join.total,
    });
    return true;
  }
  await resolveCompletedJoin(join, p.senderName);
  return true;
}

/**
 * The countdown reached zero. Two outcomes and no third:
 *   * ONE piece, and it landed  -> the ENGINE relays the answer to the owner itself. This is
 *     D13's deterministic delivery and it is why an owner question delegated to one agent is
 *     answered even when the model ghosts: the weak model re-read "ask X" and re-asked, an
 *     ask→park→answer→re-ask LOOP, so the engine owns this one.
 *   * MORE than one piece         -> steer the model to COMPILE. Relaying a partial as THE
 *     answer IS the fan-out bug; the join stays `compile_pending` until the answer is
 *     delivered, so a ghosted compile is still caught by the drain and the reaper.
 * Nothing landed at all -> there is nothing to relay, and the honest thing is the fail-closed
 * notice (3e).
 */
async function resolveCompletedJoin(join: JoinState, senderNameHint?: string): Promise<void> {
  if (join.outcome === 'fail-closed') {
    const claimed = failJoinClosed(join.id, {
      reason: 'every delegated piece came back empty, failed or abandoned',
      expectedState: join.parentState,
    });
    if (claimed.kind !== 'applied') return;
    await deliverJoinResultToOwner(join, failClosedNotice(join, senderNameHint), { tool: 'a2a-join-failed', voice: 'platform' });
    tellAgentTheJoinFailed(join, 'every delegated piece came back empty, failed or abandoned.');
    return;
  }
  if (join.total === 1) {
    const piece = joinPieces(join.id)[0];
    const name = resolveAgentDisplayName(piece?.assigneeAgent) ?? senderNameHint ?? 'the other agent';
    const answer = (piece?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    const deliveryId = await deliverJoinResultToOwner(join, `Heard back from ${name}: ${answer}`);
    if (deliveryId) noteSettlementRefusal(settleAskOnJoin(join.id, { agentId: join.agentId, deliveryId, reason: 'the engine relayed the delegated answer' }), 'a2a: join settled on relay', join.id);
    return;
  }
  steerModelToCompile(join);
}

/**
 * AUDIT-FIX (late answers), rekeyed. The join may already have failed closed — the owner got
 * "could not get an answer" and the row is terminal. An answer arriving AFTER that must still
 * reach them, ONCE, as an update, never be silently dropped.
 *
 * The exactly-once guard is the `failed -> open` transition: the winner delivers, and a second
 * late answer finds the join already `done` and gets `conflict`.
 */
async function deliverLateAnswerIfJoinFailedClosed(p: {
  agentId: string; threadId: string; threadShort: string; payload: string;
  fromAgent: string; intent: A2AIntent; messageId: string | null; senderName: string;
}): Promise<boolean> {
  const failed = findFailedJoinForThread(p.agentId, p.threadId);
  if (!failed) return false;
  const join = joinState(failed.parentId);
  if (!join) return false;
  const evidence = recordPieceDelivery({
    fromAgent: p.fromAgent, toAgent: p.agentId, messageId: p.messageId, intent: p.intent,
  });
  if (!evidence) return false;
  const claimed = claimFailedJoinForLateAnswer(join.id, evidence, `${p.senderName} answered after all`);
  if (claimed.kind !== 'applied') return true;
  const answer = String(p.payload).replace(/\s+/g, ' ').trim().slice(0, 1200);
  const deliveryId = await deliverJoinResultToOwner(
    join, `Update: ${p.senderName} answered after all. ${answer}`, { tool: 'a2a-join-late' },
  );
  if (deliveryId) noteSettlementRefusal(settleAskOnJoin(join.id, { agentId: join.agentId, deliveryId, reason: 'a late answer reached the owner', basis: 'late-answer' }), 'a2a: join settled on late answer', join.id);
  return true;
}

/** What the compile drive did for one agent, so its caller can WAKE the agent it just
 *  steered. A steer nobody is woken for is the "written, never seen" shape T3 deleted. */
export interface CompileDriveResult {
  /** Rungs SPENT this pass (re-drives + stuck notices). */
  drives: number;
  /** The agent needs a turn to see what was just written. */
  wakeWanted: boolean;
}

/** A settlement refusal is a VALUE, not a silence — the same discipline `noteUnsettled` gives
 *  the transition boundary, for the authority's own outcome type. */
function noteSettlementRefusal(
  o: { verdict: string; detail: string }, where: string, workId: string,
): void {
  if (o.verdict === 'closed') return;
  logger.info(`join not settled: ${where}`, { work: workId, verdict: o.verdict, detail: o.detail });
}

/**
 * THE COMPILE DRIVE — every compile-pending join of one agent, driven toward completion.
 *
 * ── WHAT THIS USED TO DO, AND WHY IT COULD NOT WORK (SWEEP-A TB2) ──
 * It asked `answerReceiptForAsk(join.rootId)` — "does the owner ask record an answer?" — and
 * quietly cleared the flag when it did. That reads TRUE the instant the delegating turn's
 * finalize stamps `messages.answer_message_id`, which on every recorded red run was seconds
 * after the delegation and long before any piece came back. So the compile was never driven,
 * and `compile_resolved` had been written 0 times ever against 70 flag-carrying rows. The
 * question is the same; the EVIDENCE is now the authority's, and it is strictly narrower — a
 * delivered, non-chip delivery that POSTDATES the join's own `join_complete`.
 *
 * ── AND THE SYSTEM NOW COMES BACK (owner ruling 2026-08-05, DESIGN §2) ──
 * The engine owns this job's convergence. Each pass that finds the answer still missing spends
 * one rung of `work/join-drive.ts`'s ladder: a REAL DRIVE (re-issue the compile order with the
 * pieces quoted, and ask for a wakeup so the model actually gets a turn), then — the drives
 * spent — a steer asking THE AGENT to tell the owner it is stuck, then the platform's own
 * watchdog surface. The deterministic relay the engine has always had is unchanged and sits at
 * the END of the ladder, where it belongs: the agent gets every chance to speak first, and the
 * platform only acts once the agent is proven silent.
 *
 * Called from the runtime's turn-end drain and from the join reaper.
 */
export async function resolveCompilePendingJoins(agentId: string): Promise<CompileDriveResult> {
  const db = getDb();
  const out: CompileDriveResult = { drives: 0, wakeWanted: false };
  for (const join of compilePendingJoins(agentId)) {
    try {
      // ── 1. HAS THE COMPILED ANSWER LANDED? The authority decides, on the ledger. ──
      const settled = settleAskOnJoin(join.id, {
        agentId, reason: 'the compiled answer reached the owner',
      });
      if (settled.verdict === 'closed') {
        logger.info('compile drive: the owner has their answer; the join is settled on it', {
          agentId, work: join.id, deliveryId: settled.deliveryId,
        });
        continue;
      }

      // ── 2. IT HAS NOT. OWNER FIRST, ALWAYS — but the STEER still rides. ──
      // The storm law (2026-07-23, the owner pleaded "stop" and the self-wake machinery kept
      // the agent busy) is about WAKES: while a human is waiting, the platform queues none.
      // It is not about content. The compile order and the stuck notice are RIDERS — content
      // that must be SEEN on a turn that is happening anyway — and the turn serving the
      // waiting human IS that turn. So the drive is written either way and only the WAKE
      // stands down, which is the law obeyed rather than the drive abandoned.
      const { standDown, humanAsksOpen } = selfWakeStandDown(agentId);

      const rung = nextJoinDriveRung(join.id);
      if (rung.rung === 'redrive') {
        // A REAL DRIVE: the owed step, with the join's own results in front of the model.
        //
        // ── AND A RUNG IS ONLY SPENT WHEN THE MODEL HAD A TURN TO SPEND IT ON (T10) ──
        // Two drive passes can land between two turns — the 10-minute reaper mid-turn and the
        // turn-end drain of that same turn (measured on S4: 06:17:10 and 06:18:01, two of
        // three rungs, with no turn in between either). The steer still rides, because the
        // recorded contract is that the engine puts the owed step back in front of the agent;
        // what stops is the free SPEND. `selfWakeStandDown`'s burn is covered by the same
        // rule: standing the wake down means no turn happens, so the key does not move.
        const turnKey = currentTurnNumber(agentId);
        const blind = joinRedriveIsBlind(join.id, turnKey);
        steerModelToCompile(join, rung);
        recordJoinDrive(join.id, blind ? JOIN_DRIVE_ENTRY.redriveDeferred : JOIN_DRIVE_ENTRY.redrive, {
          attempt: rung.attempt, bound: rung.bound, turnNumber: turnKey,
          note: blind
            ? 'the owed compile was put back in front of the agent, but a rung was already spent on this '
              + 'turn — the model has not run since the last steer, so this pass is not a chance and does not count'
            : 'the engine put the owed compile back in front of the agent with the pieces quoted',
        });
        out.drives++; out.wakeWanted ||= !standDown;
        logger.info('compile drive: re-drove the agent to the owed compile', {
          agentId, work: join.id, attempt: rung.attempt, bound: rung.bound,
          turnNumber: turnKey, rungSpent: !blind,
          wakeQueued: !standDown, humanAsksOpen,
        });
        continue;
      }

      if (rung.rung === 'stuck-notice') {
        // The drives are spent. The person who asked is owed the truth — AND THE AGENT SAYS
        // IT. The engine only steers and then verifies on the ledger (the next pass's step 1
        // is that verification: any real delivery to them closes this out).
        steerAgentToTellOwnerStuck(join, rung);
        recordJoinDrive(join.id, JOIN_DRIVE_ENTRY.stuckNotice, {
          attempt: rung.attempt, bound: rung.bound,
          note: 'the engine asked the agent to tell the owner the job is stuck, in its own words',
        });
        out.drives++; out.wakeWanted ||= !standDown;
        logger.warn('compile drive: drives spent; steered the agent to tell the owner it is stuck', {
          agentId, work: join.id, attempt: rung.attempt, bound: rung.bound, redrives: rung.redrives,
          wakeQueued: !standDown, humanAsksOpen,
        });
        continue;
      }

      // ── 3. THE AGENT IS NOT SPEAKING AT ALL. That is a PLATFORM fault, and the platform's
      //    OWN watchdog/health surface is what says so — never the engine wearing the agent's
      //    face (OR2's last clause, and the owner's 2026-08-05 correction). One row, one
      //    system note, one health frame; the existing surface, driven, not a new voice.
      if (joinDriveCountOnce(join.id)) {
        recordFloorGhost({
          agentId, turnNumber: null, floor: 'delegated-job-stuck', workId: join.id,
          attempts: rung.redrives + rung.stuckNotices,
          ownerLine:
            'your agent delegated part of a request, the pieces came back, and it has not been able to '
            + 'finish or report on it — the platform steered it several times and got no reply.',
          detail: { redrives: rung.redrives, stuck_notices: rung.stuckNotices },
        }, { broadcast });
        recordJoinDrive(join.id, JOIN_DRIVE_ENTRY.ghosted, {
          attempt: 1, bound: 1,
          note: 'the agent did not speak after every drive and every notice; the platform surface was told',
        });
      }

      // ── 3b. …AND THE ENGINE DOES NOT SAY THE SAME THING TWICE (SWEEP-A TB13).
      //
      // MEASURED, battery `bmshcidpw8d`, `ask:f8da81b2`: a ONE-PIECE join was relayed by
      // `resolveCompletedJoin` at 10:33:04 (delivery `bc839833`) and, because the settlement
      // that follows that relay was REFUSED, the row stayed `compile_pending` and this rung
      // relayed the same single piece again at 10:33:56 (`2fc0347e`). The owner was told the
      // same codeword twice, 52 s apart, in two different wordings.
      //
      // The relay's own contract says "the exactly-once guard is the `work` transition that
      // precedes this call" — and this is exactly the case where that transition never
      // happened, so there was no guard at all. The durable ledger is what knows: an engine
      // relay for THIS join that postdates its own `join_complete` means the owner ALREADY has
      // the delegated answer. There is nothing left to send them, only a row to settle — and
      // it settles on the delivery they actually got, named, never on a new one invented to
      // make the state reachable.
      //
      // This narrows nothing else: with no prior relay the reader returns null and the relay
      // below runs exactly as before. That is the owner's governing priority kept intact — the
      // guard removes a SECOND telling, never the first.
      const alreadyRelayed = priorEngineJoinRelay(join.id);
      if (alreadyRelayed) {
        logger.info('compile drive: the engine had ALREADY relayed this join to the owner; not relaying twice', {
          agentId, work: join.id, deliveryId: alreadyRelayed.id, tool: alreadyRelayed.tool,
        });
        noteSettlementRefusal(settleAskOnJoin(join.id, {
          agentId, deliveryId: alreadyRelayed.id,
          reason: 'the engine had already relayed the delegated answer to the owner',
        }), 'a2a: join settled on the relay the owner already got', join.id);
        continue;
      }

      // ── 4. AND THE OWNER STILL GETS WHAT CAME BACK. The deterministic relay, unchanged:
      //    same grace floor, same two shapes, same exactly-once guards. It is LAST rather than
      //    first now, which is the only thing about it that moved.
      const ans = db.prepare('SELECT created_at FROM messages WHERE id = ?')
        .get(join.rootId) as { created_at: number } | undefined;
      const ageSec = ans ? (Date.now() - ans.created_at) / 1000 : COMPILE_GRACE_SECONDS + 1;
      if (ageSec < COMPILE_GRACE_SECONDS) continue;
      const pieces = joinPieces(join.id).filter((x) => (x.content ?? '').trim().length > 0);
      const text = pieces.length > 0
        ? `All the delegated pieces are back; here they are directly:\n${
          pieces.map((x) => `From ${resolveAgentDisplayName(x.assigneeAgent) ?? 'a delegated agent'}: ${
            (x.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)}`).join('\n')}`
        : 'The delegated pieces came back, but I could not assemble a combined reply in time.';
      if (pieces.length === 0) {
        const claimed = failJoinClosed(join.id, {
          reason: 'the compile never answered and no piece carried content',
          expectedState: join.parentState,
        });
        if (claimed.kind !== 'applied') continue;
        await deliverJoinResultToOwner(join, text, { tool: 'a2a-join-failed' });
      } else {
        const deliveryId = await deliverJoinResultToOwner(join, text, { tool: 'a2a-join-relay' });
        if (deliveryId) {
          noteSettlementRefusal(settleAskOnJoin(join.id, {
            agentId, deliveryId, reason: 'the engine relayed the recorded pieces',
          }), 'a2a: join settled on compile relay', join.id);
        } else clearJoinCompilePending(join.id, 'relayed the recorded pieces (delivery not recorded)');
      }
      logger.info('compile-pending join resolved: the engine relayed the recorded pieces (the steered compile never answered the owner)', {
        agentId, work: join.id, pieces: pieces.length,
      });
    } catch (err) {
      logger.warn('compile-pending join resolution failed (left for the reaper)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** The ghost surface fires ONCE per row: `recordFloorGhost` writes an owner-visible note, and
 *  a sweep that repeated it every ten minutes would be the noise the ladder exists to bound. */
function joinDriveCountOnce(workId: string): boolean {
  return (getDb().prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?`,
  ).get(workId, JOIN_DRIVE_ENTRY.ghosted) as { n: number }).n === 0;
}

/**
 * RUNG N+1 — THE AGENT TELLS THE OWNER. The engine's part is the steer and the verification;
 * the words are the agent's.
 *
 * It rides the SAME imperative engine-steer channel the compile order rides (`fanout_join`, a
 * declared rider — content that must be SEEN on a turn that is happening anyway and must never
 * BE a turn of its own). Nothing here is composed for the owner: the platform does not tell the
 * user things, the agent does (owner correction, 2026-08-05).
 */
function steerAgentToTellOwnerStuck(join: JoinState, rung: JoinDriveDecision): void {
  const pieces = joinPieces(join.id);
  const back = pieces.filter((p) => (p.content ?? '').trim().length > 0).length;
  const steer =
    `The owner is still waiting on the request you delegated, and the platform has brought you back to it `
    + `${rung.redrives} time(s) without a reply reaching them. ${back} of ${join.total} delegated piece(s) `
    + `came back. TELL THE OWNER NOW, in your own words, directly in this conversation: what you asked for, `
    + `what came back, and — plainly — that you have not finished it. If you can give them the combined `
    + `answer, give it. If you cannot, say so honestly rather than saying nothing. Do NOT call any send `
    + `tool; the engine routes your reply.`;
  insertEngineEventIfAbsent({
    work: { taskId: join.id, runId: null, rootKind: 'ask', rootId: join.rootId },
    id: uuidv4(), agentId: join.agentId, content: steer,
    sourceAgentId: null, originIntent: 'fanout_join',
  });
}

/**
 * Resolve ONE join deterministically:
 *   1. If a reply already arrived but never landed (a crash between the A2A persist and the
 *      countdown), land it — relay the REAL answer, never a false failure notice.
 *   2. Otherwise, when the caller says the wait is over (past TTL, or the asked agent is
 *      terminated), fail CLOSED: the owner gets an explicit "could not get an answer" notice
 *      on the join's own channel, exactly once, and the join is terminal so it cannot fire again.
 *   3. Otherwise leave it for the next pass.
 */
async function resolveOpenJoin(
  join: JoinState, opts: { failIfUnanswered: boolean; askedNameHint?: string | null },
): Promise<'relayed' | 'failed-closed' | 'left-open' | 'already-settled'> {
  const ask = askRowForJoin(join);
  let state: JoinState | null = join;
  for (const piece of joinPieces(join.id)) {
    if (isTerminal(piece.state)) continue;
    const stranded = findUnlandedInboundReply(join.agentId, piece.threadId, ask?.created_at ?? Date.now());
    if (!stranded) continue;
    const deliveryId = recordPieceDelivery({
      fromAgent: stranded.senderId ?? 'unknown', toAgent: join.agentId,
      messageId: stranded.messageId, intent: 'DELIVERABLE',
    });
    if (!deliveryId) continue;
    const settled = landPiece(piece.childId, {
      deliveryId, content: stranded.payload, messageId: stranded.messageId, actorId: stranded.senderId,
    });
    state = settled.result.kind === 'applied' ? settled.join : joinState(join.id);
  }
  state = state ?? joinState(join.id);
  if (!state) return 'already-settled';
  if (state.complete) {
    await resolveCompletedJoin(state, opts.askedNameHint ?? undefined);
    return 'relayed';
  }
  if (!opts.failIfUnanswered) return 'left-open';
  const claimed = failJoinClosed(state.id, {
    reason: 'the delegated answer never came back inside the deadline',
    expectedState: state.parentState,
  });
  if (claimed.kind !== 'applied') return 'already-settled';
  await deliverJoinResultToOwner(state, failClosedNotice(state, opts.askedNameHint), { tool: 'a2a-join-failed', voice: 'platform' });
  tellAgentTheJoinFailed(state, 'the delegated answer never came back inside the deadline.');
  return 'failed-closed';
}

/**
 * The notice for a join whose PARENT already closed (issues-log #19). Built from a snapshot of
 * the pieces taken BEFORE they are settled, because after the settle nothing is outstanding and
 * the sentence would have nobody to name.
 *
 * Two shapes, and the split is the honesty requirement, not decoration:
 *   * nothing came back  -> the existing `failClosedNotice`, verbatim. One composer for "I could
 *     not get an answer", not two that can drift.
 *   * something came back -> say what arrived AND who never did. Sending only "I could not get a
 *     complete answer" while a real piece sits recorded on the child is the same class of lie
 *     requirement 3e refuses when it forbids compiling an answer out of nothing.
 */
function closedParentNotice(
  join: JoinState, snapshot: JoinPiece[], askedNameHint?: string | null,
): string {
  const landed = snapshot.filter((p) => p.state === 'done' && (p.content ?? '').trim().length > 0);
  if (landed.length === 0) return failClosedNotice(join, askedNameHint);
  const missing = snapshot.filter((p) => !isTerminal(p.state));
  const names = missing.map((p) => resolveAgentDisplayName(p.assigneeAgent) ?? askedNameHint ?? 'another agent');
  const who = names.length === 1 ? names[0] : `${names.length} of the agents it asked`;
  const back = landed
    .map((p) => `From ${resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent'}: ${
      (p.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)}`)
    .join('\n');
  return `following up on something your agent answered earlier: ${who} never came back inside the `
    + `deadline. Here is what did arrive:\n${back}`;
}

/**
 * THE SECOND TIMEOUT ARM — a join past its deadline whose parent has ALREADY CLOSED
 * (issues-log #19, PHASE-2 T13). See `dueJoinsUnderClosedParent` for why this population is the
 * normal product of every delegating turn and why widening the first arm was refused.
 *
 * The order is the same discipline the first arm uses, for the same reason:
 *   1. LAND a stranded reply first. Telling the owner "I could not get an answer" while the
 *      answer sits unlanded on the child is the failure mode `resolveOpenJoin` step 1 exists to
 *      prevent, and it does not stop mattering because the parent closed.
 *   2. If that leaves nothing outstanding, RELAY what came back. The compile path cannot do it
 *      (`compilePendingJoins` excludes a terminal parent, and its settle moves the PARENT), so
 *      this arm relays the recorded pieces itself — the sanctioned engine relay, reading the
 *      children.
 *   3. Otherwise settle the outstanding CHILDREN `abandoned` and send ONE notice. The child
 *      transition IS the exactly-once guard: a second pass finds the countdown at zero and the
 *      finder no longer yields the row. The PARENT is not transitioned at all — its state,
 *      `result_delivery_id` and `closed_at` are exactly what the delivered answer left.
 */
async function resolveJoinUnderClosedParent(
  join: JoinState, opts: { askedNameHint?: string | null } = {},
): Promise<'relayed' | 'noticed' | 'already-settled'> {
  const ask = askRowForJoin(join);
  let state: JoinState | null = join;
  for (const piece of joinPieces(join.id)) {
    if (isTerminal(piece.state)) continue;
    const stranded = findUnlandedInboundReply(join.agentId, piece.threadId, ask?.created_at ?? Date.now());
    if (!stranded) continue;
    const deliveryId = recordPieceDelivery({
      fromAgent: stranded.senderId ?? 'unknown', toAgent: join.agentId,
      messageId: stranded.messageId, intent: 'DELIVERABLE',
    });
    if (!deliveryId) continue;
    const settled = landPiece(piece.childId, {
      deliveryId, content: stranded.payload, messageId: stranded.messageId, actorId: stranded.senderId,
    });
    state = settled.result.kind === 'applied' ? settled.join : joinState(join.id);
  }
  state = state ?? joinState(join.id);
  if (!state) return 'already-settled';

  const snapshot = joinPieces(state.id);
  const outstanding = snapshot.filter((p) => !isTerminal(p.state));

  if (outstanding.length === 0) {
    // Everything is back after all. Relay it; the parent is already terminal so there is no
    // state move to make and nothing to guard beyond `compile_pending`, which is cleared so the
    // ordinary drain cannot relay a second time if the parent is ever reopened.
    const withContent = snapshot.filter((p) => (p.content ?? '').trim().length > 0);
    if (withContent.length === 0) return 'already-settled';
    const text = `All the delegated pieces are back; here they are directly:\n${
      withContent.map((p) => `From ${resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent'}: ${
        (p.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)}`).join('\n')}`;
    await deliverJoinResultToOwner(state, text, { tool: 'a2a-join-relay' });
    if (state.compilePending) {
      clearJoinCompilePending(state.id, 'relayed the recorded pieces under a closed parent');
    }
    return 'relayed';
  }

  // Settle FIRST, deliver second — the guard has to be won before the send, exactly as the
  // first arm wins `failJoinClosed` before it delivers.
  let claimed = 0;
  for (const piece of outstanding) {
    const r = settlePieceWithoutResult(piece.childId, {
      to: 'abandoned', actorId: 'work-reaper',
      reason: 'the deadline passed and the ask it belonged to had already been answered',
    });
    if (r.result.kind === 'applied') claimed++;
  }
  // Defence in depth, and stated as such rather than claimed as the guard: the FINDER is what
  // makes this exactly-once (after the settle the countdown is at zero and
  // `dueJoinsUnderClosedParent` no longer yields the row — proven by the second-sweep clause).
  // This line covers only the two-scanners-at-once race, which a single-process 10-minute reaper
  // cannot produce in a test, so it is deliberately WITHOUT a planted-fault proof — removing it
  // changed no test, and that was measured rather than assumed. Its transition-level twin IS
  // bite-proven (`fanout-join.test.ts`, the double-settle clause).
  if (claimed === 0) return 'already-settled';
  await deliverJoinResultToOwner(
    state, closedParentNotice(state, snapshot, opts.askedNameHint),
    { tool: 'a2a-join-failed', voice: 'platform' },
  );
  tellAgentTheJoinFailed(state, 'a delegated piece under an already-answered question ran out of time.');
  return 'noticed';
}

/**
 * D13's TTL sweep, rekeyed onto `work.ttl_at` (scheduled in index.ts, every 10 minutes).
 * Any join past its deadline has waited long enough: land a stranded reply if one exists,
 * otherwise fail closed with the owner notice. Exactly once per join (the transition IS the
 * guard), bounded per pass, age-capped by `dueJoins`.
 *
 * TWO ARMS since PHASE-2 T13 (issues-log #19). The first reads `dueJoins` (live parent) and the
 * second `dueJoinsUnderClosedParent` (the parent already delivered its answer). They are disjoint
 * by construction — the predicates are complementary on `state` — so no join is handled twice.
 */
export async function sweepExpiredJoins(): Promise<{
  failedClosed: number; relayedReplies: number; noticedUnderClosedParent: number;
  compileDrives: number;
}> {
  const out = { failedClosed: 0, relayedReplies: 0, noticedUnderClosedParent: 0, compileDrives: 0 };

  // ── THE COMPILE DRIVE, ON THE REAPER'S OWN CADENCE (SWEEP-A TB2) ──
  // The turn-end drain drives a compile-pending join whenever the agent is taking turns. An
  // agent that has gone idle takes none, and before this arm the only other look was
  // `dueJoins`, which is gated on `ttl_at` — SIXTY minutes away. So a job whose agent went
  // quiet sat undriven for an hour, which is the "the system stopped driving" hole the owner's
  // thesis forbids. Population is `openJoins()`, an EXISTING finder (the boot re-drain's own),
  // filtered to the compile-pending rows; no new finder and no new clock. It cannot storm: the
  // ladder is bounded per ROW at three drives plus two notices for the row's whole life, and
  // every drive consults the storm law first.
  try {
    const agents = new Set(openJoins().filter((j) => j.compilePending).map((j) => j.agentId));
    for (const agentId of agents) {
      const drive = await resolveCompilePendingJoins(agentId);
      out.compileDrives += drive.drives;
      if (drive.wakeWanted) {
        const { getAgentRuntime } = await import('./runtime.js');
        getAgentRuntime().handleMessage(agentId, '').catch((err) => {
          logger.warn('compile drive: the wake for a re-driven join failed', {
            agentId, error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  } catch (err) {
    logger.warn('join reaper: the compile drive pass failed (the TTL arms still run)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let joins: JoinState[] = [];
  try {
    joins = dueJoins(Date.now());
  } catch (err) {
    logger.warn('join TTL reaper: scan failed', { error: err instanceof Error ? err.message : String(err) });
    return out;
  }
  for (const join of joins) {
    try {
      if (join.compilePending) {
        await resolveCompilePendingJoins(join.agentId);
        continue;
      }
      const outcome = await resolveOpenJoin(join, { failIfUnanswered: true });
      if (outcome === 'relayed') out.relayedReplies++;
      else if (outcome === 'failed-closed') out.failedClosed++;
      logger.info('join TTL reaper: closed expired join', {
        agentId: join.agentId, work: join.id, outcome,
      });
    } catch (err) {
      logger.warn('join TTL reaper: failed to close join', {
        agentId: join.agentId, work: join.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // ── The second arm ──
  let orphaned: JoinState[] = [];
  try {
    orphaned = dueJoinsUnderClosedParent(Date.now());
  } catch (err) {
    logger.warn('join TTL reaper: closed-parent scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return out;
  }
  for (const join of orphaned) {
    try {
      const outcome = await resolveJoinUnderClosedParent(join);
      if (outcome === 'relayed') out.relayedReplies++;
      else if (outcome === 'noticed') out.noticedUnderClosedParent++;
      logger.info('join TTL reaper: expired join under an already-closed parent', {
        agentId: join.agentId, work: join.id, parentState: join.parentState,
        remaining: join.remaining, landed: join.landed, outcome,
      });
    } catch (err) {
      logger.warn('join TTL reaper: failed to resolve join under a closed parent', {
        agentId: join.agentId, work: join.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * D13's boot re-drain, rekeyed. Scans ALL open joins (bounded), not just recent ones: a
 * restart used to strand every parked owner question because the only re-drive was the
 * in-memory close-the-loop. Lands stranded replies, fails closed when the asked agent is
 * terminated or the join is past TTL, and leaves fresh joins for the periodic reaper. It only
 * relays or settles rows, NEVER wakes an agent, so it cannot start a boot storm and needs no
 * wake-budget accounting.
 */
export async function resolveJoinsAtBoot(): Promise<{ relayedReplies: number; failedClosed: number; leftOpen: number }> {
  const out = { relayedReplies: 0, failedClosed: 0, leftOpen: 0 };
  const joins = openJoins(JOIN_BOOT_BATCH);
  for (const join of joins) {
    try {
      const pastTtl = join.ttlAt !== null && Date.now() > join.ttlAt;
      // A terminated asked agent can never reply — don't make the owner wait out the TTL.
      // The assignee is recorded on the child at delegation time; the string machine had to
      // reconstruct it by scanning messages around the park's timestamp.
      const askedTerminated = !pastTtl && joinPieces(join.id).some((piece) => {
        if (isTerminal(piece.state) || !piece.assigneeAgent) return false;
        const row = getDb().prepare('SELECT status FROM agents WHERE id = ?')
          .get(piece.assigneeAgent) as { status?: string } | undefined;
        return row?.status === 'terminated';
      });
      const outcome = await resolveOpenJoin(join, { failIfUnanswered: pastTtl || askedTerminated });
      if (outcome === 'relayed') out.relayedReplies++;
      else if (outcome === 'failed-closed') out.failedClosed++;
      else if (outcome === 'left-open') out.leftOpen++;
      if (outcome !== 'left-open') {
        logger.info('boot join re-drain: resolved join', { agentId: join.agentId, work: join.id, outcome });
      }
    } catch (err) {
      logger.warn('boot join re-drain: failed to resolve join', {
        agentId: join.agentId, work: join.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * D13: when the runtime gives up on getting a real reply out of the asked agent (synthetic
 * ABANDONED, runtime.ts), the asker may hold a delegated piece on that thread. Settle the
 * PIECE abandoned now — the countdown moves like any other landing (3e) — and if that
 * completes the join with nothing to compile, the owner is told immediately instead of the
 * enforcer being silenced in private.
 *
 * A fan-out piece abandoning does NOT fail the whole join: the others may still land, and the
 * reaper owns the stuck case. That is the same tradeoff the string machine made, now visible
 * as a countdown rather than implied by which key strings could not match.
 */
export async function failJoinPieceForAbandonedAsk(
  inboundAskMessageId: string, threadShort: string, askedAgentId?: string,
): Promise<void> {
  try {
    const db = getDb();
    const full = (db.prepare('SELECT a2a_thread_id FROM messages WHERE id = ?')
      .get(inboundAskMessageId) as { a2a_thread_id: string | null } | undefined)?.a2a_thread_id ?? null;
    if (!full) return;
    const children = childrenForThread(full);
    for (const child of children) {
      if (isTerminal(child.state)) continue;
      const settled = settlePieceWithoutResult(child.id, {
        to: 'abandoned',
        reason: `the asked agent gave up on thread ${threadShort} (synthetic ABANDONED)`,
        actorId: askedAgentId ?? null,
      });
      if (settled.result.kind !== 'applied') continue;
      if (settled.join.complete) {
        await resolveCompletedJoin(settled.join, resolveAgentDisplayName(askedAgentId) ?? undefined);
      }
      logger.info('A2A ABANDONED: delegated piece settled abandoned', {
        agentId: child.agentId, work: child.id, complete: settled.join.complete,
      });
    }
  } catch (err) {
    logger.warn('A2A ABANDONED: join fail-closed hook failed', {
      inboundAskMessageId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
/**
 * Helper to build a thread ID from a contextual seed.
 * Consistent thread IDs for the same context (e.g., task pokes)
 * keep related messages grouped together.
 */
export // CAUTION (FA-C2 class): the id shape is 'thread-' + base36 hash + '-' + seed,
// so ANY 8-char prefix is 'thread-' plus ONE hash character (~36 buckets) and
// collides heavily. Matchers must compare the FULL id; never substr(...,1,8).
// (conversationKey C-2, parkThreadCondition, and a2a-replies all learned this.)
function makeThreadId(seed: string): string {
  // Simple deterministic hash, same seed always produces the same thread ID
  // This lets us group e.g. all pokes for a task into one thread
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `thread-${Math.abs(hash).toString(36)}-${seed.slice(0, 8)}`;
}
