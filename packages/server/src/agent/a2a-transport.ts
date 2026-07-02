// ════════════════════════════════════════
// A2A Transport — Structured Agent-to-Agent Message Delivery
//
// Central delivery function for all inter-agent messages. Enforces:
//   - Terminal-thread gating (closed threads reject non-reopening intents)
//   - Hop counting (max 8 delivered messages per thread)
//   - Semantic deduplication (cosine similarity > 0.85 against last 3)
//   - requires_response routing (false = no receiver generation)
//
// All inter-agent communication — send_to_agent, PM pokes, healer
// alerts, completion notifications — flows through deliverA2AMessage.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
import { isSenderAuthorized } from './v2/channel-auth.js';
// A2A protocol constants and helpers — inlined here to avoid runtime
// imports from @dojo/shared (which points at .ts source and can't be
// loaded by Node.js in production without a TS loader).
// Types are still imported from @dojo/shared as type-only (erased at compile time).
import type { A2AIntent, A2AEnvelope, A2ADropReason, ToolCall } from '@dojo/shared';

// Terminal intents CLOSE the thread (prevent acknowledgement replies).
// But closing the thread and waking the receiver are INDEPENDENT concepts.
const TERMINAL_INTENTS = new Set<A2AIntent>(['DELIVERABLE', 'FYI', 'COMPLETE', 'FAIL', 'ANSWER']);
const REOPENING_INTENTS = new Set<A2AIntent>(['QUESTION', 'BLOCK', 'ASSIGN']);

// "No-wake" intents: terminal AND the receiver doesn't need to see it now.
// ANSWER and DELIVERABLE are terminal but DO wake — the receiver is waiting
// for the content to continue their work. The thread closure prevents
// acknowledgement loops separately.
//
// v2.5.32 — COMPLETE and FAIL moved out of NO_WAKE. Pre-fix, when a sub-agent
// finished work and sent COMPLETE back to the assigner, the assigner did NOT
// wake — so multi-step workflows broke down silently because the follow-up
// (forward to the next agent, notify the user, decide next step) never
// triggered. Default is now: wake the receiver and let them decide.
//
// Only FYI and STATUS stay no-wake — those are explicitly ambient ("for
// awareness", "still working, 50% done"). Everything else wakes; the agent
// can override with requires_response=false on a per-call basis if they're
// certain the receiver has nothing to do.
const NO_WAKE_INTENTS = new Set<A2AIntent>(['FYI', 'STATUS']);

const MAX_HOPS_PER_THREAD = 8;
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

function isThreadTerminal(threadId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT is_terminal FROM a2a_threads WHERE thread_id = ?').get(threadId) as { is_terminal: number } | undefined;
  return row?.is_terminal === 1;
}

function getThreadHopCount(threadId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT hop_count FROM a2a_threads WHERE thread_id = ?').get(threadId) as { hop_count: number } | undefined;
  return row?.hop_count ?? 0;
}

function recordDelivery(threadId: string, intent: A2AIntent, senderId: string): number {
  const db = getDb();
  const terminal = isTerminalIntent(intent) ? 1 : 0;
  db.prepare(`
    UPDATE a2a_threads
    SET hop_count = hop_count + 1,
        last_intent = ?,
        last_sender = ?,
        is_terminal = CASE WHEN ? = 1 THEN 1 ELSE is_terminal END,
        updated_at = datetime('now')
    WHERE thread_id = ?
  `).run(intent, senderId, terminal, threadId);

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
    // themselves" — that's what we now check.
    const db = getDb();
    // Age guard (remediation Phase 4, matrix S7.2): dedup exists to damp
    // rapid ack/repeat loops, so only RECENT messages participate. A similar
    // message re-sent minutes later (a deliberate re-ask after no response,
    // the next step of a slow collaboration) is a legitimate wake, not spam.
    const recentMessages = db.prepare(`
      SELECT content FROM messages
      WHERE a2a_thread_id = ? AND source_agent_id = ?
        AND created_at >= datetime('now', '-10 minutes')
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
    // Embedding service unavailable — skip dedup, deliver the message.
    // Dedup is a nice-to-have, not a gate.
    logger.debug('Semantic dedup skipped (embedding unavailable)', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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
// announcing a deliverable, not just chatting — but pre-2026-05-10 they
// often picked intent=FYI, leaving the primary agent idle and the user
// in the dark. We promote those to DELIVERABLE so the primary wakes.
//
// Signal model: a URL on its own is enough (someone shipped a thing). If
// no URL, require a completion keyword AND an artefact reference (an ID,
// a draft #, a title in quotes, "Post ID:", "PR #", etc.). Both halves
// matter — "I'm working on it" alone shouldn't promote.
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

function logDrop(envelope: A2AEnvelope, reason: A2ADropReason): void {
  logger.info('A2A message dropped', {
    threadId: envelope.threadId,
    from: envelope.fromAgent,
    to: envelope.toAgent,
    intent: envelope.intent,
    reason,
    payloadPreview: envelope.payload.slice(0, 200),
  });
}

// ── Core Delivery Function ──

export interface A2ADeliveryResult {
  delivered: boolean;
  reason?: A2ADropReason;
  threadId: string;
  messageId?: string;
  /**
   * For ASSIGN-intent deliveries, the engine auto-creates a tracker task
   * for the receiver. The ID is returned here so the sender's tool result
   * can surface it ("Task tracker_xyz created and assigned to Maddy").
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
   * v2.3.17 — true when the engine reclassified the sender's FYI to
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
  // AND wake — the receiver either asked for this content (ANSWER/
  // DELIVERABLE) or assigned the work that just completed/failed
  // (COMPLETE/FAIL) and needs to react. Only FYI and STATUS are no-wake;
  // those are ambient context the agent shouldn't be interrupted for.
  //
  // v2.3.17 auto-promote: a sub-agent sending FYI to the primary agent
  // about a deliverable (URL or ID/title + completion keyword) is almost
  // always a wrong-intent pick — they meant DELIVERABLE. Without promotion,
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
  } catch { /* best effort — fall back to raw intent */ }

  let requiresResponse = envelope.requiresResponse;
  if (isNoWakeIntent(effectiveIntent)) {
    requiresResponse = false; // Force — these intents never wake the receiver
  } else if (autoPromotedFromFyi) {
    requiresResponse = true; // Promoted DELIVERABLE wakes the receiver
  }

  // ── 4. Thread state checks ──
  const threadId = envelope.threadId || uuidv4();
  ensureThread(threadId, envelope.fromAgent);

  // v2.5.34 — Removed the TERMINAL_THREAD_CLOSED rejection. Pre-fix, a
  // thread that received any terminal intent (ANSWER/DELIVERABLE/COMPLETE/
  // FAIL/FYI) was marked terminal, and any subsequent non-reopening intent
  // (which was every intent EXCEPT QUESTION/BLOCK/ASSIGN) got silently
  // dropped with reason TERMINAL_THREAD_CLOSED. That broke legitimate
  // follow-ups: Maddy delivering work, finding an issue, and sending a
  // corrected DELIVERABLE on the same thread had her second message
  // silently dropped. Loop protection comes from semantic dedup + the
  // hop limit, not from thread closure — both of those still run below.
  // We still flip the terminal flag back off when a new message lands so
  // the marker stays consistent for diagnostic queries.
  if (isThreadTerminal(threadId)) {
    db.prepare('UPDATE a2a_threads SET is_terminal = 0, updated_at = datetime(\'now\') WHERE thread_id = ?').run(threadId);
  }

  // ── 5. Hop counter ──
  const currentHops = getThreadHopCount(threadId);
  if (currentHops >= MAX_HOPS_PER_THREAD) {
    logDrop(envelope, 'HOP_LIMIT_EXCEEDED');
    return { delivered: false, reason: 'HOP_LIMIT_EXCEEDED', threadId };
  }

  // ── 6. Semantic dedup ──
  // Skip for completion intents (ANSWER, DELIVERABLE, COMPLETE, FAIL).
  // Those are work-finished announcements — meaningful checkpoints that
  // need to land regardless of phrasing similarity. Dedup was meant to
  // silence acknowledgement loops ("thanks!" / "you're welcome!"), not
  // completion notices. FYI keeps dedup because it's the prime culprit
  // for back-and-forth ack loops between agents.
  //
  // v2.3.19 — also skip dedup for system-originated messages. Engine
  // alerts (injury notifications, scheduler pokes, system health
  // signals) are operational — every fresh event represents a new
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
  recordDelivery(threadId, effectiveIntent, envelope.fromAgent);

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
  let autoTask: { taskId: string; isNew: boolean } | null = null;
  if (effectiveIntent === 'ASSIGN') {
    try {
      const { autoCreateAssignTask } = await import('../tracker/schema.js');
      autoTask = autoCreateAssignTask({
        senderId: envelope.fromAgent,
        receiverId: target.id,
        payload: envelope.payload,
        threadId,
      });
    } catch (err) {
      logger.warn('A2A ASSIGN: auto-task creation failed — delivering message anyway', {
        threadId, error: err instanceof Error ? err.message : String(err),
      }, envelope.fromAgent);
    }
  }

  // ── 9. Build the message content with structured tag ──
  // The footer must accurately reflect the intent's reply rules. Pre-2026-04-30
  // it branched on `requiresResponse`, which collapsed terminal-wake intents
  // (ANSWER/DELIVERABLE — wake but thread is closed) into the same footer as
  // open-thread intents (QUESTION/ASSIGN/BLOCK — wake AND reply). The result:
  // a DELIVERABLE message body said "do not reply" while the footer said
  // "Reply expected — use send_to_agent". Receiving agents read both and
  // got confused. Now there are three honest states, one per intent group.
  const threadShort = threadId.slice(0, 8);
  let threadInfo: string;
  if (effectiveIntent === 'QUESTION' || effectiveIntent === 'ASSIGN' || effectiveIntent === 'BLOCK') {
    // Open-thread reply intents — receiver should reply on the same thread.
    threadInfo = `\n\n[Thread ${threadShort} | Reply on this thread — use send_to_agent with thread_id="${threadId}" and an appropriate intent]`;
    if (effectiveIntent === 'ASSIGN' && autoTask) {
      // Receiver-visible tracker line. The DOJO created the task for them,
      // so they don't need to call tracker_create_task — they just need
      // to call tracker_update_status when done so the sender gets the
      // completion notification automatically.
      const taskShort = autoTask.taskId.slice(0, 8);
      threadInfo += autoTask.isNew
        ? `\n[Tracker: task ${taskShort} was auto-created when ${senderName} assigned this work to you. Call tracker_update_status(task_id="${autoTask.taskId}", status="completed", notes="…") when you finish so ${senderName} gets the completion notice.]`
        : `\n[Tracker: continuing work on task ${taskShort} (assigned earlier on this thread by ${senderName}). Update status with tracker_update_status when state changes.]`;
    }
  } else if (effectiveIntent === 'ANSWER' || effectiveIntent === 'DELIVERABLE') {
    // Terminal but wake — receiver should USE the content (relay to user,
    // act on it) but the thread is closed; replying on it will fail with
    // TERMINAL_THREAD_CLOSED. To continue with the sender, start a NEW
    // thread (omit thread_id) with a reopening intent.
    threadInfo = `\n\n[Thread ${threadShort} | Closed — use the content above (do NOT reply on this thread). To start a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else if (effectiveIntent === 'COMPLETE' || effectiveIntent === 'FAIL') {
    // v2.5.32 — Terminal AND wake. The receiver assigned (or otherwise
    // initiated) this work and almost always needs to do something next:
    // forward the deliverable to another agent, notify the user, mark a
    // tracker task complete, decide a next step. Pre-fix these were
    // no-wake, which meant entire multi-step workflows silently stalled
    // when a sub-agent finished work — the assigner never woke to handle
    // the completion.
    const verb = effectiveIntent === 'COMPLETE' ? 'completion' : 'failure';
    threadInfo = `\n\n[Thread ${threadShort} | Closed — this is a ${verb} report on work you initiated. Do whatever the workflow requires next (forward to another agent, notify the user, update tracker, decide a next step). If nothing further is needed, just end your turn. To restart a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else {
    // True no-wake intents (FYI/STATUS) — ambient context only. If the
    // content is genuinely something the user/owner cares about, the
    // receiver can still act on it next time they wake (e.g. iMessage
    // the owner during their next turn). Sender should have used a wake
    // intent if action is actually required.
    threadInfo = `\n\n[Thread ${threadShort} | No reply expected on this thread. Ambient context — the sender used a no-wake intent (${effectiveIntent}). If the content is something the user should know about, take action next time you wake (e.g. iMessage them).]`;
  }

  // Engine-injected hint for the primary agent when a sub-agent ships a
  // deliverable: explicitly tell the primary to surface this to the owner.
  // Fires for DELIVERABLE/ANSWER from sub-agents, and for any FYI we just
  // auto-promoted. Does NOT fire for PM/Healer/system messages — those are
  // operational, not user-facing artefacts.
  let primaryDeliverableHint = '';
  try {
    const { isPrimaryAgent, isPMAgent, isHealerAgent, getOwnerName } = await import('../config/platform.js');
    const targetIsPrimary = isPrimaryAgent(target.id);
    const senderIsOps = isPMAgent(envelope.fromAgent) || isHealerAgent(envelope.fromAgent) || envelope.fromAgent === 'system';
    const isDeliverableShape =
      autoPromotedFromFyi ||
      (effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'ANSWER');
    // C21: if this ANSWER/DELIVERABLE matches a PARKED owner question, the close-the-loop
    // relay below already delivers "Heard back from X" on the owner's channel. Appending
    // the deliverable hint too would make the woken primary ALSO send the gist (explicit
    // tool calls aren't suppressed on a background turn) → the owner gets it twice, seconds
    // apart. Suppress the hint when a park row exists; the engine owns delivery on that thread.
    const parkHandlesDelivery = !!db.prepare(
      `SELECT 1 FROM messages WHERE agent_id = ? AND role = 'user' AND conv_key IN (?, ?) LIMIT 1`,
    ).get(target.id, `park:${threadId}`, `park:${threadShort}`);
    if (targetIsPrimary && !senderIsOps && isDeliverableShape && !parkHandlesDelivery) {
      const ownerName = getOwnerName();
      // v2.9.21 — Engine hint, not Engine order. The previous wording
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
    ? ` (auto-promoted from FYI by the engine — payload looked deliverable-shaped)`
    : '';
  const contextMessage = `[A2A:${effectiveIntent} thread:${threadShort} from:${senderName}${promotionTag}] ${envelope.payload}${threadInfo}${primaryDeliverableHint}`;

  // ── Close-the-loop: ENGINE delivers the answer to the owner ──
  // When the recipient earlier asked someone on the owner's behalf, the owner's
  // question was PARKED on this thread (conv_key='park:<thread>', see loop.ts).
  // This delivery is the reply. We do NOT re-fire the owner's question for the
  // model to handle — that proved flaky (the weak model re-reads "ask X" and
  // re-asks instead of answering, an ask→park→answer→re-ask LOOP). Instead the
  // ENGINE delivers the answer straight to the owner on their own channel and
  // marks the question relayed (served, never re-fires). Deterministic — the
  // owner ALWAYS gets the answer, regardless of what the model does next. Only
  // reply intents (the asker is waiting on them) close the loop.
  if (effectiveIntent === 'ANSWER' || effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'COMPLETE' || effectiveIntent === 'FAIL') {
    try {
      // BUG-4 (comms-audit): read the FULL-id park key first (loop.ts now parks under the
      // full thread id via the structural path — collision-free), then fall back to the
      // 8-char key for the rare regex-fallback park (whose source prose carries only 8
      // chars). Mark relayed under the SAME key space that matched so the idempotency guard
      // still fires. This removes the prefix-collision wrong-answer/drop while staying
      // compatible with any question parked under the short key.
      const parkLookup = db.prepare(
        `SELECT rowid, content, inbound_meta FROM messages WHERE agent_id = ? AND conv_key = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`,
      );
      let matchedParkKey = `park:${threadId}`;
      let parked = parkLookup.get(target.id, matchedParkKey) as { rowid: number; content: string; inbound_meta: string | null } | undefined;
      if (!parked) {
        matchedParkKey = `park:${threadShort}`;
        parked = parkLookup.get(target.id, matchedParkKey) as { rowid: number; content: string; inbound_meta: string | null } | undefined;
      }
      if (parked) {
        // Mark relayed FIRST (idempotent): a duplicate ANSWER on this thread
        // won't match `park:` again, so the owner can't be double-delivered.
        // C24 (documented, not fixed — low probability): marking BEFORE delivery trades a
        // double-deliver risk (worse) for a lost-answer-on-crash risk (rarer). If the
        // process dies in the window between this UPDATE and the send below, the park is
        // consumed but the owner never got the answer. A durable fix would add a
        // `delivered_at` column and mark-after-deliver with an idempotent send; deferred as
        // the crash window is a few milliseconds and single-process.
        const relayedKey = matchedParkKey.replace('park:', 'relayed:');
        db.prepare(`UPDATE messages SET conv_key = ? WHERE agent_id = ? AND rowid = ?`).run(relayedKey, target.id, parked.rowid);
        const answer = String(envelope.payload).replace(/\s+/g, ' ').trim().slice(0, 1200);
        const deliveryText = `Heard back from ${senderName}: ${answer}`;
        // Resolve the owner's reply channel from the parked question's STRUCTURED
        // inbound_meta (not by regex-scraping the SOURCE marker — that text varies
        // and the dev harness omits the address). Reply-to is meta.sender, the
        // same value loop.ts uses as imRecipient (counterparty.senderId).
        let meta: { channel?: string; sender?: string; chatId?: string; chatType?: string; emailMessageId?: string; emailService?: string; emailAccount?: string; smsFromNumber?: string; smsToNumber?: string } = {};
        try { meta = parked.inbound_meta ? JSON.parse(parked.inbound_meta) : {}; } catch { meta = {}; }
        // Channel-aware delivery (comms-audit O-1): the owner's parked question may
        // have arrived on ANY channel — deliver the relayed answer back on THAT
        // channel, mirroring loop.ts's direct reply router (iMessage / Teams / email),
        // not a binary iMessage-or-dashboard split. The earlier version sent every
        // non-iMessage owner's relayed answer to the dashboard (the gap O-1 closes).
        // Anything unhandled or failed falls back to the dashboard so the owner ALWAYS
        // gets the answer somewhere. (phone: the call is over by relay time, so it uses
        // the dashboard fallback; sms now has its own lane below — BUG-3.)
        let delivered = false;
        try {
          if (meta.channel === 'imessage' && meta.sender) {
            const { sendResponseViaIMessage } = await import('../services/imessage-bridge.js');
            delivered = !!sendResponseViaIMessage(deliveryText, target.id, meta.sender);
          } else if (
            meta.channel === 'teams' && meta.chatId &&
            // C18: never relay into a GROUP chat (the owner's private "Heard back from X"
            // would go to the whole group), and re-validate the sender at relay time (they
            // may have been removed from the safe list mid-conversation). Either condition
            // fails → fall through to the guaranteed dashboard fallback below.
            meta.chatType !== 'group' && isSenderAuthorized('teams', meta.sender ?? '', 'agent')
          ) {
            const { executeTool } = await import('./tools.js');
            const tc: ToolCall = { id: uuidv4(), name: 'teams_send_message', arguments: { chat_id: meta.chatId, message: deliveryText } };
            const r = await executeTool(target.id, tc);
            delivered = !r.isError;
          } else if (
            meta.channel === 'email' && meta.emailMessageId &&
            // C18: re-validate the email sender at relay time; a removed sender must not
            // get the relayed answer (falls through to the dashboard fallback).
            isSenderAuthorized('email', meta.sender ?? '', 'agent', { emailService: meta.emailService === 'outlook' ? 'outlook' : 'gmail' })
          ) {
            const { executeTool } = await import('./tools.js');
            const toolName = meta.emailService === 'gmail' ? 'gmail_reply' : 'outlook_reply';
            const tc: ToolCall = {
              id: uuidv4(), name: toolName,
              // B-2 (comms-audit): reply FROM the mailbox that received the owner's
              // original question (multi-account), not an ambiguous default.
              arguments: { message_id: meta.emailMessageId, body: deliveryText, ...(meta.emailAccount ? { account: meta.emailAccount } : {}) },
            };
            const r = await executeTool(target.id, tc);
            delivered = !r.isError;
          } else if (meta.channel === 'sms' && (meta.smsFromNumber || meta.sender)) {
            // BUG-3 (comms-audit): the owner can ask via SMS, and the inbound SMS path
            // stamps channel='sms' + smsFromNumber/smsToNumber into inbound_meta. The
            // earlier O-1 relay had no SMS lane, so an SMS-origin owner's relayed answer
            // was dumped to a dashboard they may never open. Route via the sms_send tool
            // (like the teams/email branches above), not a raw client call: same executor,
            // its safe-sender revalidation, and harness-capturable — text the original
            // from-number back so the thread stays continuous on the owner's phone.
            const { executeTool } = await import('./tools.js');
            const to = meta.smsFromNumber ?? meta.sender!;
            const tc: ToolCall = { id: uuidv4(), name: 'sms_send', arguments: { to, body: deliveryText } };
            const r = await executeTool(target.id, tc);
            delivered = !r.isError;
          }
        } catch (err) {
          logger.warn('A2A close-the-loop channel delivery failed, falling back to dashboard', {
            agentId: target.id, channel: meta.channel, error: err instanceof Error ? err.message : String(err),
          });
        }
        if (delivered) {
          logger.info('A2A close-the-loop: engine delivered answer to owner on their channel', {
            agentId: target.id, thread: threadShort, channel: meta.channel,
          });
        } else {
          // Dashboard (or unhandled/failed channel) owner — surface it as the agent's
          // own chat message so it renders in their dashboard conversation. Always
          // reaches them, so the answer is never lost even on an unsupported channel.
          const msgId = uuidv4();
          db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, datetime('now'))`).run(msgId, target.id, deliveryText);
          broadcast({
            type: 'chat:message', agentId: target.id,
            message: { id: msgId, agentId: target.id, role: 'assistant' as const, content: deliveryText, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
          });
          logger.info('A2A close-the-loop: engine delivered answer to owner (dashboard fallback)', {
            agentId: target.id, thread: threadShort, channel: meta.channel ?? 'none',
          });
        }
      }
    } catch (err) {
      logger.warn('A2A close-the-loop delivery failed', { error: err instanceof Error ? err.message : String(err) });
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
          logger.warn('A2A attachment source missing — skipping', { srcPath });
          continue;
        }
        const stat = fs.statSync(srcPath);
        // 1 GB cap aligns with the chat upload + URL fetch caps. Single-
        // user local install — A2A attachments are file paths, not
        // network requests, so there's no per-request body limit to
        // worry about here. Cap exists to catch obviously-wrong inputs.
        if (stat.size > 1024 * 1024 * 1024) {
          logger.warn('A2A attachment too large — skipping', { srcPath, size: stat.size });
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
  // C25 (revised): the a2a pipe is DUMB — it carries the sender's real message faithfully,
  // no transform and no length cap. A genuinely large, needed handoff must pass through
  // whole. Firehose PREVENTION is the SENDER's job (a helper messages the primary only when
  // there's a real actionable reason, not its full internal state on a timer). Keeping a2a
  // out of the primary's HUMAN conversation (so it isn't confused about who it's talking to)
  // is the ASSEMBLER's job, done structurally by origin.kind — not by rewriting the message
  // here. Visibility to the user is the dashboard's job: a2a is the 'agent-only' tier
  // (server-classified), hidden in regular chat, shown in wordy mode.
  const msgId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, attachments, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(msgId, target.id, contextMessage, envelope.fromAgent, threadId, effectiveIntent, requiresResponse ? 1 : 0, attachmentsJson);

  // ── 12. Broadcast to dashboard (with attachments so the live UI shows the
  // image immediately, not just on page refresh). The a2a row is the 'agent-only'
  // visibility tier (visibility.ts, from structured origin) — the dashboard hides it in
  // regular chat and shows it in wordy mode. Nothing here decides visibility. ──
  broadcast({
    type: 'chat:message',
    agentId: target.id,
    message: {
      id: msgId,
      agentId: target.id,
      role: 'user' as const,
      content: contextMessage,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
      attachments: attachmentsList.length > 0 ? attachmentsList : undefined,
      // Carry the structured A2A attribution so the origin-stamp seam (ws.ts)
      // derives kind:'agent' from data, not from re-parsing the [A2A:…] marker.
      // Without these, an inbound A2A classified as kind:'user' and leaked into
      // the dashboard chat even with wordy mode off.
      sourceAgentId: envelope.fromAgent,
      a2aThreadId: threadId,
      a2aIntent: effectiveIntent,
      a2aRequiresResponse: requiresResponse ? 1 : 0,
    },
  });

  // ── 13. Route based on requires_response ──
  if (requiresResponse) {
    // Wake-block for paused-only. Pre-2026-04-29 we also blocked waking
    // agents in `error` status — meant to prevent compound failures, but
    // it caused injured agents to silently ignore PM/peer messages, leaving
    // them stuck until the Healer's grace timer expired. With the in-loop
    // error recovery added in v1.15.76 (capability mismatch / 4xx → system
    // note → adapt), re-waking an injured agent is safe: worst case it
    // re-injures and the Healer takes over, best case it transiently
    // recovers or self-corrects. `paused` (error-loop signal) keeps the
    // block — re-waking there would just compound.
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
      // assembler — same pattern as stopMarkerPending) explaining what
      // happened, suggesting they respond to the new ask, warning that
      // any in-flight tool may have been orphaned, and noting the
      // recent preempt count so they can self-throttle if A and B are
      // ping-ponging.
      // (duplicate-work root fix) We deliberately do NOT preempt the receiver's
      // in-flight turn for an inbound wake-intent A2A. This is the same root cause
      // as the chat path (gateway/routes/chat.ts): preempting aborts a multi-step
      // turn AFTER it has committed side effects (created a tracker project, written
      // a deliverable file) and BEFORE it marks its work served, so the re-triggered
      // turn redoes that work — duplicate projects, the plan delivered twice, the
      // same question answered twice. Confirmed via per-turn LOOP-START markers: an
      // urgent PM QUESTION preempted the primary agent mid-turn and the turn restarted under the
      // same turn_number. The message is still delivered + persisted, and the
      // end-of-turn A2A re-trigger (runtime.ts finally) gives this inbound its OWN
      // dedicated turn right after the current one finishes — so the PM gets answered
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

/**
 * Helper to build a thread ID from a contextual seed.
 * Consistent thread IDs for the same context (e.g., task pokes)
 * keep related messages grouped together.
 */
export function makeThreadId(seed: string): string {
  // Simple deterministic hash — same seed always produces the same thread ID
  // This lets us group e.g. all pokes for a task into one thread
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `thread-${Math.abs(hash).toString(36)}-${seed.slice(0, 8)}`;
}
