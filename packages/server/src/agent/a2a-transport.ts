// A2A Transport: structured agent-to-agent message delivery through deliverA2AMessage.
// send_to_agent, PM pokes, healer alerts and completion notifications all flow through it;
// it enforces the per-thread hop cap, semantic dedup and requires_response routing.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { liveAgentsNamed, liveAgentNamesNear, resolveAgentDisplayName } from './tool-helpers.js';
import { activeRuns } from './shared-state.js';
import { endedMidRun } from './ended-mid-run.js';
import { patienceFloorFor } from '../tracker/assignee-patience.js';
import {
  A2A_THREAD_SHORT_LENGTH, a2aThreadShort, a2aThreadShortLegacy, extractPayloadFromA2AMessage, OWNER_ALERT_DOJO_PREFIX,
} from '@dojo/shared';
import { postAgentNotice } from './agent-notice.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
import {
  deliveredResult, repliesSince, insertMessageIfAbsent, insertEngineEventIfAbsent, type EngineEventWork,
} from '../memory/message-store.js';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { a2aPayloadForModel } from '../tools/inbound-fences.js';
import { queueReply, recordDelivery } from './v2/deliveries.js';
import { replyAddressFor } from './v2/channel-sender.js';
import { resultForEndedRequest } from './v2/counterparty.js';
import { recordAtDoor, recordedId } from './v2/outbound.js';
import { asTurn } from './turn-context.js';
// The join lives in `work`; everything here is transport: it lands pieces and relays answers.
import {
  THREAD_HOP_CAP, isTerminal,
  findJoinChildByThread, findFailedJoinForThread, childrenForThread,
  landPiece, settlePieceWithoutResult, repointJoinPieceToHandOff,
  joinState, joinPieces, dueJoins, openJoins,
  dueJoinsUnderClosedParent,
  compilePendingJoins, failJoinClosed, clearJoinCompilePending,
  claimFailedJoinForLateAnswer, threadHopCountInWindow, bumpThreadHopCount, hopWindowLapsed,
  extendJoinTtl, JOIN_LIVENESS_MAX_TOTAL_MS,
  type JoinState, type JoinPiece,
} from '../work/store.js';
import { joinFailureNotice, joinFailureReason } from './join-failure-notice.js';
import { deferJoinRelay, takeDeferredJoinRelays } from './deferred-join-relay.js';
// The join's close is the settlement authority's, never this module's, as elsewhere.
import { settleAskOnJoin, priorEngineJoinRelay, replyInFlight } from '../work/ask-settlement.js';
// …and the grind-vs-tell ladder: how often the system comes back, and what it does when spent.
import {
  JOIN_DRIVE_ENTRY, JOIN_REDRIVE_BOUND, nextJoinDriveRung, recordJoinDrive,
  joinRedriveIsBlind, compileSteerText, everyPieceLandedWithContent, engineRelayPreface,
  type JoinDriveDecision,
} from '../work/join-drive.js';
import { joinWakeFooter } from './a2a-join-footer.js';
import { currentTurnNumber } from './v2/turn-record.js';
import { selfWakeStandDown } from '../work/work-reaper.js';
import { recordFloorGhost } from './v2/floor-ghost.js';
import { handInHeard } from '../work/done/effects.js';
import { latestHandIn } from '../work/done/record.js';
import { REPLY_NEEDED_INTENTS, type A2AIntent, type A2AEnvelope, type A2ADropReason, type ChannelKind, type InboundMeta } from '@dojo/shared';
import { resolveRecipientDisplay } from '../contacts/resolve-recipient.js';
import { compileAskerFromMeta } from '../work/compile-asker.js';
import { deliveryLabel } from './v2/turn-address.js';
import type { ReplyDestination } from './v2/reply-destination.js';
import { homeDir } from '../home.js';
import { servedRequestThreadFrom } from './a2a-own-turn.js';

const REPLY_INTENTS = new Set<A2AIntent>(['ANSWER', 'DELIVERABLE', 'COMPLETE', 'FAIL']);   // the answer-class intents

// Only FYI and STATUS are ambient no-wake. COMPLETE and FAIL must wake: the assigner has a next
// step, and a silent one stalls multi-step work. requires_response=false overrides per call.
const NO_WAKE_INTENTS = new Set<A2AIntent>(['FYI', 'STATUS']);

import { SEMANTIC_DEDUP_THRESHOLD as DEDUP_SIMILARITY_THRESHOLD } from '../memory/dedup-threshold.js';   // the one shared number
const DEDUP_LOOKBACK = 3;

function isNoWakeIntent(intent: A2AIntent): boolean { return NO_WAKE_INTENTS.has(intent); }
function isReopeningIntent(intent: A2AIntent): boolean { return REPLY_NEEDED_INTENTS.has(intent); }

export { isNoWakeIntent, type A2AIntent };

const logger = createLogger('a2a-transport');


function ensureThread(threadId: string, senderId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO a2a_threads (thread_id, hop_count, last_sender, created_at, updated_at)
    VALUES (?, 0, ?, datetime('now'), datetime('now'))
  `).run(threadId, senderId);
}

/** THE ONE CLOCK BOTH HOP STORES AGE AGAINST: `a2a_threads.updated_at`, written only by
 *  `ensureThread` and `recordThreadDelivery`; null for an absent row means lapsed. */
function threadLastDeliveryMs(threadId: string): number | null {
  const row = getDb().prepare(
    'SELECT unixepoch(updated_at) * 1000 AS updated_ms FROM a2a_threads WHERE thread_id = ?',
  ).get(threadId) as { updated_ms: number | null } | undefined;
  return row?.updated_ms ?? null;
}

/** The delegated thread's hop count lives on `work.hop_count`, seeded at delegation. */
function getThreadHopCount(threadId: string, lastDelivery: number | null): number {
  // ONE clock handed to BOTH stores, so the spine and the fallback never age against two clocks.
  const onSpine = threadHopCountInWindow(threadId, lastDelivery);
  if (onSpine !== null) return onSpine;
  // The fallback ages on the same rule, so the cap cannot mean two things on two stores.
  const row = getDb().prepare(
    'SELECT hop_count FROM a2a_threads WHERE thread_id = ?',
  ).get(threadId) as { hop_count: number } | undefined;
  if (!row) return 0;
  return hopWindowLapsed(lastDelivery) ? 0 : row.hop_count;
}

/** Captured ONCE before this delivery and threaded here, so the cap and restart decisions
 *  agree by construction: a re-read would see the stamp this call is about to write. */
function recordThreadDelivery(
  threadId: string, intent: A2AIntent, senderId: string, priorDeliveryMs: number | null,
): number {
  const db = getDb();
  const lapsedBeforeThisDelivery = hopWindowLapsed(priorDeliveryMs);
  // The durable record of who sent last, with what intent, when; that is all this write is.
  db.prepare(`
    UPDATE a2a_threads
    SET last_intent = ?,
        last_sender = ?,
        updated_at = datetime('now')
    WHERE thread_id = ?
  `).run(intent, senderId, threadId);

  const onSpine = bumpThreadHopCount(threadId, priorDeliveryMs);
  if (onSpine !== null) return onSpine;
  // The write-side half for the fallback store, on the same captured instant.
  db.prepare(
    lapsedBeforeThisDelivery
      ? 'UPDATE a2a_threads SET hop_count = 1 WHERE thread_id = ?'
      : 'UPDATE a2a_threads SET hop_count = hop_count + 1 WHERE thread_id = ?',
  ).run(threadId);
  return getThreadHopCount(threadId, threadLastDeliveryMs(threadId));
}


async function checkSemanticDedup(payload: string, threadId: string, fromAgent: string): Promise<boolean> {
  try {
    const { generateEmbedding } = await import('../memory/embeddings.js');

    // Last N messages FROM THE SAME SENDER only: the signal is one sender repeating, not an echo.
    const db = getDb();
    // Only RECENT messages participate: a deliberate re-ask minutes later is a legitimate wake.
    const recentMessages = db.prepare(`
      SELECT content FROM messages
      WHERE a2a_thread_id = ? AND source_agent_id = ?
        AND created_at >= (unixepoch('now', '-10 minutes') * 1000)
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(threadId, fromAgent, DEDUP_LOOKBACK) as Array<{ content: string }>;

    if (recentMessages.length === 0) return false;

    const newEmbedding = await generateEmbedding(payload, { agentId: fromAgent });

    for (const msg of recentMessages) {
      const msgPayload = extractPayloadFromA2AMessage(msg.content);
      if (!msgPayload || msgPayload.length < 10) continue;

      const existingEmbedding = await generateEmbedding(msgPayload, { agentId: fromAgent });
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
    // Dedup is a nice-to-have, not a gate: skip when embeddings are down; the latch still gates.
    logger.info('Semantic dedup skipped (embedding unavailable)', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// A re-ASSIGN that omits `thread_id` mints a fresh thread and task each time, invisible to
// per-thread dedup: check this sender's recent ASSIGNs across ALL threads; same 10-minute rule.
async function findRecentDuplicateAssignThread(
  senderId: string,
  receiverId: string,
  payload: string,
): Promise<string | null> {
  try {
    const db = getDb();
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
    const newEmbedding = await generateEmbedding(payload, { agentId: senderId });
    for (const msg of recent) {
      const msgPayload = extractPayloadFromA2AMessage(msg.content);
      if (!msgPayload || msgPayload.length < 10) continue;
      const existingEmbedding = await generateEmbedding(msgPayload, { agentId: senderId });
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

// Deliverable-shape detection: a URL alone says someone shipped a thing; without one, require a
// completion keyword AND an artefact reference, so "I'm working on it" stays put.
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


// AWAITING_REPLY is transport-local: intentionally NOT in the shared union, the tool renders it.
type A2ADropReasonLocal = A2ADropReason | 'AWAITING_REPLY' | 'SENDER_TERMINATED';

/** A drop is a RETURN most callers discard, so logDrops are loud; these two are exempt because
 * the sender is told synchronously in the tool result. Unknown future reasons land at warn. */
const DROPS_THE_SENDER_IS_TOLD_ABOUT: ReadonlySet<A2ADropReasonLocal> = new Set([
  'AWAITING_REPLY', 'SEMANTIC_DUPLICATE',
]);

function logDrop(envelope: A2AEnvelope, reason: A2ADropReasonLocal, extra: Record<string, unknown> = {}): void {
  const say = DROPS_THE_SENDER_IS_TOLD_ABOUT.has(reason)
    ? logger.info.bind(logger)
    : logger.warn.bind(logger);
  say('A2A message dropped', {
    threadId: envelope.threadId,
    from: envelope.fromAgent,
    to: envelope.toAgent,
    intent: envelope.intent,
    reason,
    payloadPreview: envelope.payload.slice(0, 200),
    ...extra,
  });
}

// Own-task evidence for validation QUESTIONs: additive text so the floor model answers without
// re-mining history. Fires narrowly: own tasks only, 8-char ids the prose names, dynamic imports.
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
      // GATE: only the recipient's OWN task; rendering another agent's record would leak it here.
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


export interface A2ADeliveryResult {
  delivered: boolean;
  reason?: A2ADropReasonLocal;
  threadId: string;
  messageId?: string;
  /** ASSIGN deliveries auto-create a tracker task for the receiver; this is that ID. */
  autoCreatedTaskId?: string;
  /** True when THIS delivery created the auto-task; false when an earlier ASSIGN's was reused. */
  autoTaskIsNew?: boolean;
  /** True when the engine reclassified the sender's FYI to deliverable-shaped DELIVERABLE. */
  autoPromotedFromFyi?: boolean;
  /** Present only when the sender passed `hands_off_thread`; `message` is the line their tool
   *  result carries. A refusal is never a hold: the reply still lands and settles as it would. */
  handOff?: { applied: boolean; message: string };
  answeredRequestOnThread?: boolean;   // threadless send: the reply went on the request it answers
}

/** The sender's declared hand-off, beside the envelope: a platform fact, not a message fact. */
export type A2ADeliveryOptions = A2AEnvelope & {
  handsOffThread?: string | null; work?: EngineEventWork | null;   // the work a wake belongs to, as the serve-boundary columns
  taskId?: string | null;   // an ASSIGN's given task, from engine state only (a spawn's transfer)
};

/** It must not hard-name a recipient or channel: the deliverable is owed to whoever asked, on their channel. */
export function deliverableArrivedNote(senderName: string): string {
  return `\n\n[Engine note: ${senderName} returned a deliverable on this thread. Whoever asked for this work is owed it, `
    + 'on the channel they asked on, unless a task, project, technique or live message names a channel.]';
}

export async function deliverA2AMessage(envelope: A2ADeliveryOptions): Promise<A2ADeliveryResult> {
  const db = getDb();

  if (!envelope.intent || !envelope.payload || !envelope.toAgent || !envelope.fromAgent) {
    logDrop(envelope, 'MALFORMED_ENVELOPE');
    return { delivered: false, reason: 'MALFORMED_ENVELOPE', threadId: envelope.threadId };
  }

  // A sender that ended mid-run delivers nothing, so nothing is relayed to anyone's owner.
  if (endedMidRun(envelope.fromAgent)) { logDrop(envelope, 'SENDER_TERMINATED'); return { delivered: false, reason: 'SENDER_TERMINATED', threadId: envelope.threadId }; }

  let target = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(envelope.toAgent) as
    | { id: string; name: string; status: string } | undefined;
  if (!target) {
    // A name matches case-insensitively; two live rows differing only by case resolve to the newest.
    target = liveAgentsNamed(envelope.toAgent)[0];
  }
  if (!target) {
    logDrop(envelope, 'AGENT_NOT_FOUND', { liveAgentsNearThatName: liveAgentNamesNear(envelope.toAgent) });
    return { delivered: false, reason: 'AGENT_NOT_FOUND', threadId: envelope.threadId };
  }
  if (target.status === 'terminated') {
    logDrop(envelope, 'AGENT_NOT_FOUND');
    return { delivered: false, reason: 'AGENT_NOT_FOUND', threadId: envelope.threadId };
  }

  // Terminal-vs-no-wake are independent (NO_WAKE_INTENTS above). A sub-agent's deliverable-shaped
  // FYI to the primary is a wrong-intent pick: promoting here keeps state, footer and routing.
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
      await (await import('./v2/classifiers/inbound-routing.js')).deliverableJudged(target.id, envelope.payload, payloadLooksDeliverable(envelope.payload))
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

  // An ASSIGN with no thread_id that repeats a recent one reuses that thread, so dedup drops it.
  let reusedAssignThreadId: string | null = null;
  if (effectiveIntent === 'ASSIGN' && !envelope.threadId && envelope.fromAgent !== 'system') {
    reusedAssignThreadId = await findRecentDuplicateAssignThread(envelope.fromAgent, target.id, envelope.payload);
    if (reusedAssignThreadId) {
      logger.info('A2A ASSIGN without thread_id matched a recent assignment, reusing its thread', {
        from: envelope.fromAgent, to: target.id, threadId: reusedAssignThreadId,
      }, envelope.fromAgent);
    }
  }
  const servedThreadId = !envelope.threadId && envelope.fromAgent !== 'system' && REPLY_INTENTS.has(effectiveIntent)
    ? servedRequestThreadFrom(envelope.fromAgent, target.id) : null;   // a threadless reply goes on the request it answers
  const threadId = envelope.threadId || reusedAssignThreadId || servedThreadId || uuidv4();
  // ⚠ READ BEFORE `ensureThread`, and the order is load-bearing: that insert stamps `datetime('now')`
  // when no row exists, so a later read would report a delivery that never happened.
  const lastDeliveryMs = threadLastDeliveryMs(threadId);
  ensureThread(threadId, envelope.fromAgent);

  // Loop protection comes from the semantic dedup and the hop cap, both below; no terminal gating.

  const currentHops = getThreadHopCount(threadId, lastDeliveryMs);
  if (currentHops >= THREAD_HOP_CAP) {
    logDrop(envelope, 'HOP_LIMIT_EXCEEDED');
    return { delivered: false, reason: 'HOP_LIMIT_EXCEEDED', threadId };
  }

  // A wake-intent re-ask whose last delivery was THIS sender's own unanswered wake-intent inside
  // the cooldown is an impatient re-ping: it drops with AWAITING_REPLY until the receiver replies.
  const AWAITING_REPLY_COOLDOWN_MS = 15 * 60_000;
  const isEngineEnvelope = envelope.fromAgent === 'system' || envelope.origin === 'engine';
  if (isReopeningIntent(effectiveIntent) && !isEngineEnvelope) {
    // The gate: last delivery was this sender's own wake-intent in the cooldown; the read confirms.
    const latchRow = db.prepare(`
      SELECT last_intent FROM a2a_threads
       WHERE thread_id = @threadId
         AND last_sender = @senderId
         AND updated_at >= datetime('now', @window)
    `).get({ threadId, senderId: envelope.fromAgent, window: `-${AWAITING_REPLY_COOLDOWN_MS / 1000} seconds` }) as
      | { last_intent: string | null }
      | undefined;
    const senderOwesReply =
      !!latchRow && !!latchRow.last_intent && isReopeningIntent(latchRow.last_intent as A2AIntent);
    if (senderOwesReply) {
      // Did the RECEIVER reply inside the cooldown? One table, so a reply cannot be missed.
      if (repliesSince(envelope.fromAgent, threadId, Date.now() - AWAITING_REPLY_COOLDOWN_MS).length === 0) {
        logDrop(envelope, 'AWAITING_REPLY');
        return { delivered: false, reason: 'AWAITING_REPLY', threadId };
      }
    }
  }

  // Completion intents skip dedup (checkpoints must land whatever the phrasing; dedup exists to
  // silence ack loops). System-origin skips too: every engine alert is a fresh condition.
  const senderIsSystem = envelope.fromAgent === 'system';
  if (!REPLY_INTENTS.has(effectiveIntent) && !senderIsSystem) {
    const isDuplicate = await checkSemanticDedup(envelope.payload, threadId, envelope.fromAgent);
    if (isDuplicate) {
      logDrop(envelope, 'SEMANTIC_DUPLICATE');
      return { delivered: false, reason: 'SEMANTIC_DUPLICATE', threadId };
    }
  }

  // And again, for a sender ended while the dedup above was awaiting.
  if (endedMidRun(envelope.fromAgent)) { logDrop(envelope, 'SENDER_TERMINATED'); return { delivered: false, reason: 'SENDER_TERMINATED', threadId }; }

  recordThreadDelivery(threadId, effectiveIntent, envelope.fromAgent, lastDeliveryMs);

  const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(envelope.fromAgent) as { name: string } | undefined;
  const senderName = senderRow?.name ?? envelope.fromAgent;

  // ASSIGN auto-creates a tracker task so the handoff is tracked, visible to both sides, and the
  // PM poke loop picks up stalled ones. An existing task on the thread is reused as clarification.
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
        taskId: envelope.taskId,
      });
    } catch (err) {
      logger.warn('A2A ASSIGN: auto-task creation failed, delivering message anyway', {
        threadId, error: err instanceof Error ? err.message : String(err),
      }, envelope.fromAgent);
    }
  }

  // The footer reflects the intent's reply rules in three states, so a closed-but-waking intent
  // never gets a "Reply expected" footer. The EIGHT come from the id's VARYING region, not the front.
  const threadShort = a2aThreadShort(threadId);
  let threadInfo: string;
  if (effectiveIntent === 'QUESTION' || effectiveIntent === 'ASSIGN' || effectiveIntent === 'BLOCK') {
    threadInfo = `\n\n[Thread ${threadShort} | Reply on this thread, use send_to_agent with thread_id="${threadId}" and an appropriate intent]`;
    if (effectiveIntent === 'ASSIGN' && autoTask) {
      // The tracker line tells the receiver the DOJO created the task; they update only on change.
      const taskShort = autoTask.taskId.slice(0, 8);
      threadInfo += autoTask.isNew
        ? `\n[Tracker: task ${taskShort} was auto-created when ${senderName} assigned this work to you. Hand it in with work_update(action="hand_in", task_id="${autoTask.taskId}", outcome="finished", proof=[...], note) when you finish so ${senderName} gets the completion notice.]`
        : `\n[Tracker: continuing work on task ${taskShort} (assigned earlier on this thread by ${senderName}). Update status with work_update(action="status") when state changes.]`;
    }
    if (effectiveIntent === 'ASSIGN') {
      // The decision-moment text: states the hand-off affordance and the honest alternative.
      threadInfo +=
        `\n[Handing this off? If another agent is going to do this instead of you, send it to `
        + `them FIRST, then reply here with hands_off_thread set to the thread id that send `
        + `returned — the assignment follows the work to them and their deliverable closes it. `
        + `A plain reply is read as YOUR finished work. If it cannot be done at all, reply `
        + `with intent FAIL.]`;
    }
  } else if (effectiveIntent === 'ANSWER' || effectiveIntent === 'DELIVERABLE') {
    // Terminal but wake: use the content; to keep talking, start a NEW thread (omit thread_id).
    threadInfo = `\n\n[Thread ${threadShort} | Closed, use the content above (do NOT reply on this thread). To start a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else if (effectiveIntent === 'COMPLETE' || effectiveIntent === 'FAIL') {
    // Terminal AND wake: the receiver initiated this work and almost always has a next step.
    const verb = effectiveIntent === 'COMPLETE' ? 'completion' : 'failure';
    threadInfo = `\n\n[Thread ${threadShort} | Closed, this is a ${verb} report on work you initiated. Do whatever the workflow requires next (forward to another agent, notify the owner, update tracker, decide a next step). If nothing further is needed, just end your turn. To restart a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else {
    // True no-wake intents: ambient context; act next time it wakes if the owner should know.
    threadInfo = `\n\n[Thread ${threadShort} | No reply expected on this thread. Ambient context, the sender used a no-wake intent (${effectiveIntent}). If the content is something the owner should know about, take action next time you wake (e.g. iMessage them).]`;
  }

  // A deliverable to the primary gets an owner-surface hint; ops senders and join-owned threads
  // are excluded: ops traffic is not user-facing, and the join already delivers "Heard back".
  let primaryDeliverableHint = '';
  // Read BEFORE the piece lands: landing settles the child, and this one lookup serves the hint and the join.
  const joinChild = findJoinChildByThread(target.id, threadId), joinHandlesDelivery = !!joinChild;
  // A result for a request the owner stopped is stored and starts nothing: no hint, no wake.
  const forEndedRequest = resultForEndedRequest(target.id, threadId);
  try {
    const { isPrimaryAgent, isPMAgent, isHealerAgent } = await import('../config/platform.js');
    const targetIsPrimary = isPrimaryAgent(target.id);
    const senderIsOps = isPMAgent(envelope.fromAgent) || isHealerAgent(envelope.fromAgent) || envelope.fromAgent === 'system';
    const isDeliverableShape =
      autoPromotedFromFyi ||
      (effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'ANSWER');
    if (targetIsPrimary && !senderIsOps && isDeliverableShape && !joinHandlesDelivery && !forEndedRequest) {
      primaryDeliverableHint = deliverableArrivedNote(senderName);
    }
  } catch { /* best effort */ }

  // A reply on a DELEGATED thread is landed on its join, which relays it or steers a compile; the
  // engine owns delivery there, so the hint above is suppressed. Any inbound counts, label or not.
  const isReplyIntent = REPLY_INTENTS.has(effectiveIntent);
  // The sender's declared hand-off outcome, surfaced to their tool result; undefined unless passed.
  let handOffReport: { applied: boolean; message: string } | undefined;
  if (isReplyIntent || joinHandlesDelivery) {
    try {
      const landed = await landReplyOnJoin({
        agentId: target.id, threadId, threadShort, payload: envelope.payload ?? '',
        fromAgent: envelope.fromAgent, intent: effectiveIntent, messageId: null, senderName,
        handsOffThread: envelope.handsOffThread ?? null,
      });
      handOffReport = landed.handOff;
    } catch (err) {
      // The join owns this thread, so if landing fails here NOBODY tells the owner; hence the
      // error tier. The row is named by `loudOnPieceAbort` in `work/store.ts`.
      logger.error('A2A close-the-loop delivery failed — the reply came back and was not landed on its join; the owner will not be told', {
        agentId: target.id, thread: threadShort, fromAgent: envelope.fromAgent,
        intent: effectiveIntent, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Composed AFTER the join landed the piece; what it says of the owner's copy is that landing's fact.
  threadInfo = (joinChild && joinWakeFooter({ agentId: target.id, parentId: joinChild.parentId, replyConversationId: joinChild.replyConversationId, intent: effectiveIntent, threadShort })) || threadInfo;
  const promotionTag = autoPromotedFromFyi
    ? ` (auto-promoted from FYI by the engine, payload looked deliverable-shaped)`
    : '';
  const theirReport = a2aPayloadForModel(target.id, envelope.fromAgent, isEngineEnvelope, senderName, envelope.payload);
  let contextMessage = `[A2A:${effectiveIntent} thread:${threadShort} from:${senderName}${promotionTag}] ${theirReport}${threadInfo}${primaryDeliverableHint}`;

  // Own-task evidence attaches AFTER the [Thread ...] footer, so marker parsers see only payload.
  if (effectiveIntent === 'QUESTION') {
    contextMessage += await renderOwnTaskEvidenceForQuestion(target.id, envelope.payload);
  }

  // Attachments are processed BEFORE the broadcast, so it goes out with them (one consistent pass).
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

      const recipientDir = path.join(homeDir(), '.dojo', 'uploads', target.id);
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
        // 1 GB cap matches the chat upload caps; attachments are paths, so it catches wrong inputs.
        if (stat.size > 1024 * 1024 * 1024) {
          logger.warn('A2A attachment too large, skipping', { srcPath, size: stat.size });
          continue;
        }

        const ext = path.extname(srcPath).toLowerCase();

        // A file the caller already placed in the recipient's dir is used as-is, never re-copied.
        const srcDir = path.dirname(srcPath);
        const alreadyInRecipientDir = path.resolve(srcDir) === path.resolve(recipientDir);

        let destPath: string;
        if (alreadyInRecipientDir) {
          destPath = srcPath;
        } else {
          const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
          const storedName = `a2a_${Date.now()}_${uuidv4().slice(0, 8)}_${safeName}`;
          destPath = path.join(recipientDir, storedName);
          fs.copyFileSync(srcPath, destPath);
        }

        const isImage = IMAGE_EXTS.includes(ext);
        const isAudio = AUDIO_EXTS.includes(ext);
        const isVideo = VIDEO_EXTS.includes(ext);
        // Only category 'pdf' becomes a document block for the model, so a PDF must be tagged pdf.
        const isPdf = ext === '.pdf';
        const category: UploadedFile['category'] = isImage
          ? 'image'
          : isAudio ? 'audio'
          : isVideo ? 'video'
          : isPdf ? 'pdf'
          : 'unknown';
        const mimeType = isImage
          ? (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`)
          : isAudio ? AUDIO_MIME[ext]
          : isVideo ? VIDEO_MIME[ext]
          : isPdf ? 'application/pdf'
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

  // The pipe is DUMB: the sender's message passes whole, no transform, no length cap; firehose
  // prevention is the sender's job, human-chat separation the assembler's and the dashboard's.
  // Engine-origin rows stamp origin_kind='engine' so they route as engine events, never as a peer
  // named "system"; origin_intent splits the modes; peer A2A keeps origin_kind NULL.
  const engineOrigin = envelope.origin === 'engine' || envelope.fromAgent === 'system';
  const originKind = engineOrigin ? 'engine' : null;
  const originIntent = engineOrigin ? (requiresResponse ? 'a2a_request' : 'system') : null;
  // Inbound rows land on lane='a2a' ('events' for engine), a CHECK column, not a view readers leak.
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
    taskId: envelope.work?.taskId ?? null, runId: envelope.work?.runId ?? null,
    rootKind: envelope.work?.rootKind ?? null, rootId: envelope.work?.rootId ?? null,
  });

  // The row is the SOLE delivery vehicle, so a skipped insert means it was never delivered.
  if (persisted === null) {
    logDrop(envelope, 'PERSIST_SKIPPED');
    return { delivered: false, reason: 'PERSIST_SKIPPED', threadId };
  }

  // ── 12. Broadcast to the dashboard's Inter-Agent lane (with attachments) ──
  // Inter-agent traffic leaves `chat:message` ENTIRELY: a peer (or engine-origin) A2A delivery
  // broadcasts on the dedicated `interagent:message` lane, never the human chat feed, so no
  // visibility tier is needed to hide it, the store separation makes it structural. The row
  // above is still the SOLE delivery vehicle; this broadcast is dashboard-only.
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
      // The lane styles engine vs peer off this; peer A2A keeps originKind null.
      originKind,
      attachments: attachmentsList.length > 0 ? attachmentsList : undefined,
    },
  });

  // ── 13. Route based on requires_response ──
  if (forEndedRequest) logger.info('A2A delivery: a result for a request the owner stopped; stored, no wake', { targetId: target.id, threadId });
  else if (requiresResponse) {
    // Wake-block is paused-only: re-waking an error agent is safe; paused is the error-loop signal, which the main agent and the Healer may lift.
    const targetIsLockedOut = target.status === 'paused';
    let senderCanWakeLockedOut = envelope.fromAgent === 'system';
    if (!senderCanWakeLockedOut && targetIsLockedOut) {
      try {
        const { isHealerAgent, isPrimaryAgent } = await import('../config/platform.js');
        senderCanWakeLockedOut = isHealerAgent(envelope.fromAgent) || isPrimaryAgent(envelope.fromAgent);
      } catch { /* */ }
    }

    if (targetIsLockedOut && !senderCanWakeLockedOut) {
      logger.info('A2A delivery: skipping handleMessage for paused agent (error loop)', {
        targetId: target.id,
        targetStatus: target.status,
        from: envelope.fromAgent,
      });
      // The message is persisted and broadcast; only the wake is skipped for a paused target.
    } else {
      // No preempt: an aborted turn already committed its side effects but never marked its work
      // served, so the restart would redo them. Delivery gives this inbound its own turn.

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
  // No wake: it becomes read-only context on the receiver's next natural turn; no tokens spent.

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
    handOff: handOffReport,
    answeredRequestOnThread: servedThreadId !== null,
  };
}

// The delegated JOIN: the owner's ask is the PARENT work row, each delegated thread a CHILD
// keyed on the full thread id; `remaining_children` decrements inside the one writer,
// `transition()`. This file is transport: it lands pieces, relays answers, fails stuck joins
// closed. The engine guarantees: a lone piece is relayed, a fan-out compiles at zero, the
// reaper sends one honest notice, a late answer still lands.

/** Give the steered compile a real chance before the engine relays the pieces itself. */
const COMPILE_GRACE_SECONDS = 60;
const JOIN_BOOT_BATCH = 50;

/** Short quote of the owner's ask for the fail-closed notice; leading markers stripped. */
function questionSnippet(content: string): string {
  const stripped = content.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  return stripped.length > 160 ? `${stripped.slice(0, 160).trimEnd()}...` : stripped;
}

/** The owner's inbound row behind a join: the parent ask's `root_id` IS that message id. */
function askRowForJoin(join: JoinState): { content: string; inbound_meta: string | null; created_at: number } | null {
  const r = getDb().prepare(
    'SELECT content, inbound_meta, created_at FROM messages WHERE id = ?',
  ).get(join.rootId) as { content: string; inbound_meta: string | null; created_at: number } | undefined;
  return r ?? null;
}

/** The files the helpers handed back with their pieces of this request (paths), in the order the pieces opened. */
export function pieceFiles(joinId: string): string[] {
  const rows = getDb().prepare(
    `SELECT m.attachments AS a FROM work p
       JOIN deliveries d ON d.id = p.result_delivery_id JOIN messages m ON m.id = d.message_id
      WHERE p.parent_id = ? AND m.attachments IS NOT NULL ORDER BY p.opened_at ASC, p.id ASC`,
  ).all(joinId) as Array<{ a: string }>;
  return rows.flatMap((r) => {
    try { return (JSON.parse(r.a) as Array<{ path?: string }>).flatMap((f) => (f.path ? [f.path] : [])); } catch { return []; }
  });
}

/** The hand-in a relay of the pieces reports: the newest piece's delivery. */
const newestPieceDelivery = (pieces: JoinPiece[]): string | null =>
  pieces.flatMap((p) => (p.resultDeliveryId ? [p.resultDeliveryId] : [])).at(-1) ?? null;

/** Pass a helper's `answer` (or, with none, a notice) back to whoever asked, in the Dojo's labelled voice, rooted in
 *  the request and in no turn. The labelled copy goes on the dashboard at once; a request by text also gets a queued
 *  reply on its own channel, and the request settles when that row is delivered. One row per join, tool and hand-in.
 *  Returns what the Dojo did, in one sentence for the agent. */
async function relayToAsker(
  join: JoinState, r: { tool: string; answer: string; frame: string; files: string[]; reports: string | null },
): Promise<string> {
  const asker = askerOf(join);
  if (r.reports !== null && getDb().prepare(
    `SELECT 1 FROM deliveries WHERE agent_id = ? AND tool = ? AND json_extract(payload_json, '$.joinId') = ?
        AND json_extract(payload_json, '$.reports') = ?`,
  ).get(join.agentId, r.tool, join.id, r.reports)) return `The Dojo had already passed this on to ${asker}.`;
  const text = `${OWNER_ALERT_DOJO_PREFIX} ${r.frame}${r.answer}`.trimEnd();
  let meta: Partial<InboundMeta> = {};
  try { meta = JSON.parse(askRowForJoin(join)?.inbound_meta ?? '{}') as Partial<InboundMeta>; } catch { /* no channel: the dashboard copy is the relay */ }
  const address = meta.channel ? replyAddressFor({ ...meta, channel: meta.channel }) : null;
  const root = { kind: 'ask' as const, id: join.rootId, sourceMessageId: join.rootId, conversationId: join.replyConversationId };
  return asTurn(join.agentId, { turnNumber: null, root, convKey: null }, async () => {
    // A helper's answer is the agent's own chat bubble, labelled; a notice is a system row.
    const copyId = uuidv4();
    const role = r.answer ? 'assistant' as const : 'system' as const;
    insertMessageIfAbsent({ id: copyId, agentId: join.agentId, role, content: text,
      ...(r.answer ? deliveredResult(join.replyConversationId, join.rootId) : {}) });
    if (!address) {
      recordDelivery({ agentId: join.agentId, tool: r.tool, channel: 'dashboard', recipientId: 'owner', messageId: copyId,
        conversationId: join.replyConversationId, outcome: 'delivered', payload: { joinId: join.id, reports: r.reports } });
    }
    broadcast({
      type: 'chat:message', agentId: join.agentId,
      message: { id: copyId, agentId: join.agentId, role, content: text, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
    });
    if (!address) return `The Dojo (not you) posted this in the dashboard chat for ${asker}: "${text}"`;
    const queued = await queueReply({ agentId: join.agentId, turnNumber: null, root, text, address,
      relay: { tool: r.tool, answer: r.answer, joinId: join.id, reports: r.reports }, files: r.files });
    if (queued?.held) return `The Dojo did NOT send ${asker} this notice, because ${asker} is another Dojo's agent; it is only in the dashboard chat: "${text}"`;
    return queued
      ? `The Dojo (not you) is sending ${asker} this on ${address.channel}: "${text}". If it cannot get through you will be told.`
      : `The Dojo could not queue this for ${asker} on ${address.channel}; it is only in the dashboard chat: "${text}"`;
  });
}

/** The honest "no answer" notice in the PLATFORM's voice; the AGENT is told separately.
 *  Exactly-once is the `work` transition before the send, not this text. */
function failClosedNotice(join: JoinState, askedNameHint?: string | null): string {
  // The wording lives in `join-failure-notice.ts`, which reads the pieces' own states.
  const ask = askRowForJoin(join);
  const pieces = joinPieces(join.id);
  const names = [...new Set(pieces.map((p) => resolveAgentDisplayName(p.assigneeAgent))
    .filter((n): n is string => Boolean(n)))];
  return joinFailureNotice({
    parentWorkId: join.id,
    pieces,
    names: names.length > 0 ? names : (askedNameHint ? [askedNameHint] : []),
    questionSnippet: ask ? questionSnippet(ask.content) : '',
  });
}

/** WHO IS SPEAKING, stamped into the bytes: an unlabelled engine imperative could ride
 *  inside the owner's words once `mergeConsecutiveRoles` joins the run into one message. */
const JOIN_STEER_LABEL = '[Engine]';

const askerOf = (join: JoinState): string => compileAskerFromMeta(askRowForJoin(join)?.inbound_meta ?? null, (ch, handle) => resolveRecipientDisplay(ch as ChannelKind, handle), (ch) => deliveryLabel(ch as ReplyDestination))?.name ?? 'the owner';
/** A Dojo notice about the request, with no helper's answer in it. */
const relayNotice = (join: JoinState, text: string): Promise<string> =>
  relayToAsker(join, { tool: 'a2a-join-failed', frame: text, answer: '', files: [], reports: null });
/** The agent is told exactly what the Dojo sent the asker, and where it really went. */
const tellAgentWhatTheRelaySent = (join: JoinState, told: string): void => {
  postAgentNotice({ toAgentId: join.agentId, fromName: 'Dojo message sent', selfIntro: false, brief: `${told} Do not repeat it or claim it as your own words.` });
};

/** The other half at this seam: THE AGENT IS TOLD and decides whether to speak. The platform
 *  states the fact because no model call exists here; the agent can add more on its next turn. */
function tellAgentTheJoinFailed(join: JoinState, what: string, outcome: string): void {
  const askerWords = askerOf(join);
  try {
    insertEngineEventIfAbsent({
      work: { taskId: join.id, runId: null, rootKind: 'ask', rootId: join.rootId },
      id: uuidv4(),
      agentId: join.agentId,
      content:
        `${JOIN_STEER_LABEL} A piece of work you delegated never came back: ${what} ${outcome} `
        + `If ${askerWords} should know more — what you were after, whether it is worth another try — WRITE it to them in `
        + `your own words on your next turn, as your written reply if that turn is talking to them, otherwise in an explicit send that names them.`,
      sourceAgentId: null,
      originIntent: 'fanout_join',
      turnNumber: null,
    });
  } catch { /* the agent's copy is best-effort */ }
}

/** A reply that ARRIVED but never landed on its piece. Bounded by created_at so the lookup
 *  rides the index, keyed on the FULL thread id. */
export function findUnlandedInboundReply(
  agentId: string, threadId: string, sinceMs: number,
): { payload: string; senderName: string; messageId: string; senderId: string | null } | null {
  const row = getDb().prepare(
    `SELECT id, content, source_agent_id FROM messages
      WHERE agent_id = ? AND role = 'user' AND source_agent_id IS NOT NULL
        AND source_agent_id != ? AND created_at >= ?
        AND a2a_thread_id IN (?, ?)
      ORDER BY (a2a_intent IN ('ANSWER','DELIVERABLE','COMPLETE','FAIL')) DESC, rowid DESC
      LIMIT 1`,
  ).get(agentId, agentId, sinceMs - 15 * 60_000, threadId, a2aThreadShortLegacy(threadId)) as
    | { id: string; content: string; source_agent_id: string | null } | undefined;
  if (!row) return null;
  // The stored row is envelope + payload + footer; relay just the payload the sender wrote.
  const payload = extractPayloadFromA2AMessage(row.content) ?? '';
  const fromTag = row.content.match(/^\[A2A:[A-Z]+\s+thread:\S+\s+from:([^\]]+)\]/);
  const senderName = resolveAgentDisplayName(row.source_agent_id) ?? fromTag?.[1]?.trim() ?? 'the other agent';
  return { payload, senderName, messageId: row.id, senderId: row.source_agent_id };
}

/** Record the A2A hand-back as a delivery: `work.done` needs one to point at. Inside a
 *  `send_to_agent` scope it folds into that scope's single row; outside, it stands alone. */
function recordPieceDelivery(p: {
  fromAgent: string; toAgent: string; messageId: string | null; intent: string;
}): string | null {
  return recordedId(recordAtDoor({
    outcome: 'delivered', channel: 'a2a',
    agentId: p.fromAgent, tool: 'send_to_agent',
    recipientId: p.toAgent, recipientDisplay: resolveAgentDisplayName(p.toAgent),
    messageId: p.messageId, detail: `A2A ${p.intent}`,
  }), 'a2a: piece delivery', { from: p.fromAgent, to: p.toAgent });
}

/** The compile steer: pieces are back, so the model gets their content VERBATIM and writes
 *  ONE combined reply with no tools: deliverables live outside the chat store it could query. */
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
  // The wording lives in `work/join-drive.ts`; the fresh tail prints it whole to the model.
  const steer = compileSteerText({
    // The relay delivers to the ASK's own sender, so the order names that person.
    asker: compileAskerFromMeta(
      askRowForJoin(join)?.inbound_meta ?? null,
      (ch, handle) => resolveRecipientDisplay(ch as ChannelKind, handle),
      (ch) => deliveryLabel(ch as ReplyDestination),
    ),
    total: join.total, pieces: rendered,
    attempt: rung?.attempt ?? null, bound: rung?.bound ?? JOIN_REDRIVE_BOUND,
  });
  // Rides the IMPERATIVE engine-steer channel, not the ambient NOTICE: kept out of the
  // pending-event pool so it never drives its OWN turn; the deliverable's wake carries it.
  insertEngineEventIfAbsent({
    work: null, id: uuidv4(), agentId: join.agentId, content: `${JOIN_STEER_LABEL} ${steer}`,
    sourceAgentId: null, originIntent: 'fanout_join',
  });
  logger.info('join complete: steered the model to compile the combined reply', {
    agentId: join.agentId, work: join.id, total: join.total,
    attempt: rung?.attempt ?? null, bound: rung?.bound ?? null,
  });
}

/** A terminal A2A reply landed on a delegated thread: advance the join. When the join owned
 *  the reply the caller suppresses the ordinary deliverable hint. */
async function landReplyOnJoin(p: {
  agentId: string; threadId: string; threadShort: string; payload: string;
  fromAgent: string; intent: A2AIntent; messageId: string | null; senderName: string;
  handsOffThread?: string | null;
}): Promise<{ handled: boolean; handOff?: { applied: boolean; message: string } }> {
  const child = findJoinChildByThread(p.agentId, p.threadId);
  if (!child) {
    const handled = await deliverLateAnswerIfJoinFailedClosed(p);
    return {
      handled,
      handOff: (p.handsOffThread ?? '').trim()
        ? {
          applied: false,
          message:
            `[Engine: no delegated assignment is tracked on thread ${p.threadShort}, so there `
            + 'was nothing to hand off. Your reply was delivered as sent.]',
        }
        : undefined,
    };
  }

  // The declared hand-off is evaluated BEFORE the piece settles; a refusal is not a hold:
  // the reply still settles, so a mis-declared hand-off never strands the asker.
  let handOff: { applied: boolean; message: string } | undefined;
  if ((p.handsOffThread ?? '').trim()) {
    handOff = applyDeclaredHandOff(child, p);
    if (handOff.applied) return { handled: true, handOff };
  }

  // An EMPTY terminal reply is not a deliverable. The refusal lives inside `landPiece` so no
  // caller can forget it; the piece stays outstanding for the real one or the TTL closes it.
  const deliveryId = recordPieceDelivery({
    fromAgent: p.fromAgent, toAgent: p.agentId, messageId: p.messageId, intent: p.intent,
  });
  let settle: ReturnType<typeof landPiece>;
  if (p.intent === 'FAIL') {
    // A terminal FAIL is a LANDED piece: "it failed" is an answer, but there is no result to deliver.
    settle = settlePieceWithoutResult(child.id, {
      to: 'failed', reason: `the peer replied FAIL on thread ${p.threadShort}`,
      content: p.payload, actorId: p.fromAgent,
    });
  } else if (!deliveryId) {
    logger.warn('join: the piece delivery could not be recorded; holding the piece rather than closing it unproven', {
      agentId: p.agentId, thread: p.threadShort,
    });
    return { handled: true, handOff };
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
    return { handled: true, handOff };
  }
  const join = settle.join;
  if (!join.complete) {
    logger.info('join: piece landed, holding for the rest', {
      agentId: p.agentId, thread: p.threadShort, landed: join.landed, total: join.total,
    });
    return { handled: true, handOff };
  }
  await resolveCompletedJoin(join, p.senderName);
  return { handled: true, handOff };
}

/** THE DECLARED HAND-OFF: the transport DERIVES who the work went to (STRUCTURALLY, like
 *  `delegation-exit.ts`, never a regex over reply prose), the spine WRITES behind its gates.
 *  A hand-off the sender cannot back with a real send of their own is refused. */
function applyDeclaredHandOff(
  child: { id: string; threadId: string },
  p: { threadShort: string; fromAgent: string; handsOffThread?: string | null },
): { applied: boolean; message: string } {
  const target = (p.handsOffThread ?? '').trim();
  const refused = (why: string): { applied: boolean; message: string } =>
    ({ applied: false, message: `[Engine: hand-off NOT applied — ${why}]` });

  // The named send must be one the SENDER made with a wake intent; its recipient is the new assignee.
  const sent = getDb().prepare(`
    SELECT agent_id FROM messages
     WHERE a2a_thread_id = ? AND source_agent_id = ?
       AND a2a_intent IN ('QUESTION','ASSIGN','BLOCK')
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(target, p.fromAgent) as { agent_id: string } | undefined;
  if (!sent) {
    return refused(
      `you have not sent work to anyone on thread ${target.slice(0, A2A_THREAD_SHORT_LENGTH)}. `
      + 'Send them the work first (QUESTION, ASSIGN or BLOCK), then reply here with the thread '
      + 'id that send returned. Your reply was delivered as sent',
    );
  }

  const out = repointJoinPieceToHandOff({
    childId: child.id, handOffSender: p.fromAgent, newThreadId: target,
    newAssignee: sent.agent_id,
  });
  if (out.kind === 'refused') {
    logger.info('a2a: declared hand-off refused', {
      thread: p.threadShort, fromAgent: p.fromAgent, target, reason: out.reason,
    });
    return refused(`${out.detail}. Your reply was delivered and settled as sent`);
  }

  const newName = resolveAgentDisplayName(out.newAssignee) ?? out.newAssignee ?? 'them';
  logger.info('a2a: declared hand-off applied; the join edge follows the work', {
    thread: p.threadShort, fromAgent: p.fromAgent, to: out.toThreadId,
    newAssignee: out.newAssignee, hopCount: out.hopCount,
  });
  return {
    applied: true,
    message:
      `[Engine: hand-off recorded. The assignment on thread ${p.threadShort} now follows `
      + `${newName} on thread ${out.toThreadId.slice(0, A2A_THREAD_SHORT_LENGTH)} — your reply `
      + `did NOT close it, and ${newName}'s deliverable will. You do not need to relay their `
      + 'answer; the engine closes the loop when it arrives.]',
  };
}

/** The countdown reached zero. ONE piece: the ENGINE relays it; MORE: steer the model to
 *  COMPILE, relaying a partial as THE answer is the fan-out bug. None: the fail-closed notice. */
async function resolveCompletedJoin(join: JoinState, senderNameHint?: string): Promise<void> {
  if (join.outcome === 'fail-closed') {
    const failReason = joinFailureReason(joinPieces(join.id));
    const claimed = failJoinClosed(join.id, { reason: failReason, expectedState: join.parentState });
    if (claimed.kind !== 'applied') return;
    tellAgentTheJoinFailed(join, `${failReason}.`, await relayNotice(join, failClosedNotice(join, senderNameHint)));
    return;
  }
  if (join.total === 1) {
    // Never while the delegating agent is still speaking; `releaseDeferredJoinRelays` sends it at turn end.
    if (activeRuns.has(join.agentId)) {
      deferJoinRelay(join.agentId, join.id, senderNameHint);
      logger.info('join relay: held until the delegating turn ends', { agentId: join.agentId, work: join.id });
      return;
    }
    await relayOnePieceJoin(join, senderNameHint);
    return;
  }
  steerModelToCompile(join);
}

async function relayOnePieceJoin(join: JoinState, senderNameHint?: string): Promise<void> {
  const piece = joinPieces(join.id)[0];
  const name = resolveAgentDisplayName(piece?.assigneeAgent) ?? senderNameHint ?? 'the other agent';
  const answer = (piece?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  // The labelled copy is in the agent's own conversation, so no second notice.
  await relayToAsker(join, { tool: 'a2a-join-relay', frame: `Heard back from ${name}: `, answer, files: pieceFiles(join.id), reports: piece?.resultDeliveryId ?? null });
}

/** The delegating turn ended: tell the owner what came back while it ran, unless already relayed. */
export async function releaseDeferredJoinRelays(agentId: string): Promise<void> {
  for (const { joinId, senderNameHint } of takeDeferredJoinRelays(agentId)) {
    try {
      const join = joinState(joinId);
      if (!join?.complete || join.total !== 1) continue;
      const already = priorEngineJoinRelay(join.id);
      if (already) noteSettlementRefusal(settleAskOnJoin(join.id, { agentId, deliveryId: already.id, reason: 'the engine had already relayed the delegated answer' }), 'a2a: join settled on the relay already sent', join.id);
      else await relayOnePieceJoin(join, senderNameHint);
    } catch (err) {
      logger.warn('deferred join relay failed; the join reaper and boot re-drain still find it', { agentId, joinId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** An answer arriving AFTER its join failed closed still reaches the owner, ONCE, as an
 *  update. The exactly-once guard is the `failed -> open` transition: a second finds `done`. */
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
  tellAgentWhatTheRelaySent(join, await relayToAsker(join, {
    tool: 'a2a-join-late', frame: `Update: ${p.senderName} answered after all. `, answer, files: pieceFiles(join.id), reports: evidence,
  }));
  return true;
}

/** What the compile drive did for one agent, so its caller can WAKE the agent it just
 *  steered. A steer nobody is woken for is the "written, never seen" shape. */
export interface CompileDriveResult {
  /** Rungs SPENT this pass (re-drives + stuck notices). */
  drives: number;
  /** The agent needs a turn to see what was just written. */
  wakeWanted: boolean;
}

/** A settlement refusal is a VALUE, not a silence: the same discipline the transition
 *  boundary keeps, applied to the authority's own outcome type. */
function noteSettlementRefusal(
  o: { verdict: string; detail: string }, where: string, workId: string,
): void {
  if (o.verdict === 'closed') return;
  logger.info(`join not settled: ${where}`, { work: workId, verdict: o.verdict, detail: o.detail });
}

/** THE COMPILE DRIVE: every compile-pending join of one agent, driven by the
 *  `work/join-drive.ts` ladder: real drive, a steer, then the platform watchdog; "answered"
 *  is the authority's call on a delivery that postdates the join's own `join_complete`. */
export async function resolveCompilePendingJoins(agentId: string): Promise<CompileDriveResult> {
  const db = getDb();
  const out: CompileDriveResult = { drives: 0, wakeWanted: false };
  for (const join of compilePendingJoins(agentId)) {
    try {
      // A relay on its way is neither stuck nor owed: the request settles when it goes, or fails if it never does.
      if (replyInFlight(join.id)) continue;
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

      // 2. IT HAS NOT. OWNER FIRST, ALWAYS, but the STEER still rides: the storm law is about
      // WAKES, not content, so the drive is written either way and only the WAKE stands down.
      const { standDown, humanAsksOpen } = selfWakeStandDown(agentId);

      // The pieces are read ONCE per pass and handed to every rung that needs them. One read, one truth.
      const piecesNow = joinPieces(join.id);
      const rung = nextJoinDriveRung(join.id, {
        // The one-piece world is `resolveCompletedJoin`'s; this rung is fenced off it.
        everyPieceLanded: join.total > 1 && everyPieceLandedWithContent(piecesNow),
      });
      if (rung.rung === 'redrive') {
        // A RUNG IS ONLY SPENT WHEN THE MODEL HAD A TURN TO SPEND IT ON: two drive passes can
        // land between two turns, so the steer still rides and only the free SPEND stands down.
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

      if (rung.rung === 'engine-relay') {
        // THE ENGINE SHIPS THE PIECES ITSELF: the drives are spent and every piece is back, so a
        // "could not do it" stuck notice would be false. It composes one preface line plus the
        // pieces VERBATIM; the "already told them?" read runs FIRST, no second telling.
        const already = priorEngineJoinRelay(join.id);
        if (already) {
          noteSettlementRefusal(settleAskOnJoin(join.id, {
            agentId, deliveryId: already.id, basis: 'engine-relay',
            reason: 'the engine had already relayed the delegated answer to the owner',
          }), 'a2a: the relay rung settled on the relay the owner already got', join.id);
          recordJoinDrive(join.id, JOIN_DRIVE_ENTRY.engineRelay, {
            attempt: rung.attempt, bound: rung.bound,
            note: 'the owner already held an engine relay of these pieces, so the rung settled on '
              + 'that delivery rather than sending a second one',
          });
          out.drives++;
          logger.info('compile drive: the owner already had these pieces; the relay rung settled on them', {
            agentId, work: join.id, deliveryId: already.id, tool: already.tool,
          });
          continue;
        }
        const body = piecesNow
          .map((p) => `From ${resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent'}:\n${
            (p.content ?? '').trim()}`)
          .join('\n\n');
        tellAgentWhatTheRelaySent(join, await relayToAsker(join, {
          tool: 'a2a-join-relay', frame: `${engineRelayPreface(piecesNow.length)}\n\n`, answer: body,
          files: pieceFiles(join.id), reports: newestPieceDelivery(piecesNow),
        }));
        recordJoinDrive(join.id, JOIN_DRIVE_ENTRY.engineRelay, {
          attempt: rung.attempt, bound: rung.bound,
          note: 'the drives were spent with every piece back, so the engine relayed the pieces to the owner verbatim',
        });
        // NO WAKE: the owner has the content; a wake would re-open the answered compile.
        out.drives++;
        logger.info('compile drive: the drives were spent and every piece was back, so the engine shipped them', {
          agentId, work: join.id, pieces: piecesNow.length,
          redrives: rung.redrives, humanAsksOpen,
        });
        continue;
      }

      if (rung.rung === 'stuck-notice') {
        // Drives spent: the asker is owed the truth, AND THE AGENT SAYS IT. The engine steers
        // and verifies on the ledger: any real delivery to them closes this out.
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

      // 3. THE AGENT IS NOT SPEAKING AT ALL: a PLATFORM fault, said on the platform's own
      //    health surface. One row, one note, one frame; not a new voice.
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

      // 3b. THE ENGINE DOES NOT SAY THE SAME THING TWICE: a refused settlement leaves the row
      //    `compile_pending`, so the ledger knows. An existing relay settles; the guard removes
      //    a SECOND telling, never the first.
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

      // 4. THE OWNER STILL GETS WHAT CAME BACK: last in the ladder, and only past the grace floor.
      const ans = db.prepare('SELECT created_at FROM messages WHERE id = ?')
        .get(join.rootId) as { created_at: number } | undefined;
      const ageSec = ans ? (Date.now() - ans.created_at) / 1000 : COMPILE_GRACE_SECONDS + 1;
      if (ageSec < COMPILE_GRACE_SECONDS) continue;
      const pieces = joinPieces(join.id).filter((x) => (x.content ?? '').trim().length > 0);
      const text = pieces.length > 0
        ? `All the delegated pieces are back; here they are directly:\n${
          pieces.map((x) => `From ${resolveAgentDisplayName(x.assigneeAgent) ?? 'a delegated agent'}: ${
            (x.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)}`).join('\n')}`
        : 'the delegated pieces came back, but no combined reply was put together in time.';
      if (pieces.length === 0) {
        const claimed = failJoinClosed(join.id, {
          reason: 'the compile never answered and no piece carried content',
          expectedState: join.parentState,
        });
        if (claimed.kind !== 'applied') continue;
        tellAgentWhatTheRelaySent(join, await relayNotice(join, text));
      } else {
        await relayToAsker(join, { tool: 'a2a-join-relay', frame: '', answer: text, files: pieceFiles(join.id), reports: newestPieceDelivery(joinPieces(join.id)) });
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

/** RUNG N+1: THE AGENT TELLS THE OWNER. The engine steers and verifies; the words are the
 *  agent's. It rides the engine-steer channel as a declared rider, never its own turn. */
function steerAgentToTellOwnerStuck(join: JoinState, rung: JoinDriveDecision): void {
  const askerWords = askerOf(join);
  const pieces = joinPieces(join.id);
  const back = pieces.filter((p) => (p.content ?? '').trim().length > 0).length;
  const steer =
    `${JOIN_STEER_LABEL} `
    + `${askerWords === 'the owner' ? 'The owner' : askerWords} is still waiting on the request you delegated, and the platform has brought you back to it `
    + `${rung.redrives} time(s) without a reply reaching them. ${back} of ${join.total} delegated piece(s) `
    + `came back. TELL ${askerWords.toUpperCase()} NOW, in your own words, as your written reply if this turn is talking to them, otherwise in an explicit send that names them: what you asked for, `
    + `what came back, and — plainly — that you have not finished it. If you can give them the combined `
    + `answer, give it. If you cannot, say so honestly rather than saying nothing. Do NOT call a send `
    + `tool when this turn is talking to them; the engine routes your written reply.`;
  insertEngineEventIfAbsent({
    work: { taskId: join.id, runId: null, rootKind: 'ask', rootId: join.rootId },
    id: uuidv4(), agentId: join.agentId, content: steer,
    sourceAgentId: null, originIntent: 'fanout_join',
  });
}

/** IS ANY AGENT THIS JOIN IS WAITING ON PROVABLY STILL WORKING? `activeRuns` is in-process
 *  truth; `agents.status` is the cross-restart fallback. The grant scales with the assignee's
 *  declared patience; a piece with no assignee is not counted. */
function liveAssigneeForJoin(join: JoinState): { agentId: string; grantMs: number; basis: string } | null {
  for (const piece of joinPieces(join.id)) {
    if (isTerminal(piece.state)) continue;
    const assignee = piece.assigneeAgent;
    if (!assignee) continue;
    let live = activeRuns.has(assignee);
    if (!live) {
      try {
        const row = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(assignee) as
          | { status: string } | undefined;
        live = row?.status === 'working';
      } catch { live = false; }
    }
    if (!live) continue;
    const floor = patienceFloorFor(assignee);
    return { agentId: assignee, grantMs: floor.floorSeconds * 1000, basis: floor.basis };
  }
  return null;
}

/** LAND a stranded reply before judging the join: the owner must not hear "no answer" while
 *  it sits unlanded on the child. Returns the join after the landing (null if gone). */
function landStrandedReplies(join: JoinState): JoinState | null {
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
  return state ?? joinState(join.id);
}

/** A helper that handed its piece's job in and never replied on the piece's thread is heard now, from its hand-in note. */
async function handInsNeverHeard(join: JoinState): Promise<void> {
  await Promise.all(joinPieces(join.id).filter((p) => !isTerminal(p.state) && p.assigneeAgent).map(async (piece) => {
    const task = getDb().prepare(
      `SELECT t.id FROM work t WHERE t.kind = 'task' AND t.agent_id = ? AND t.a2a_thread_id = ?
          AND t.state IN ('handed_in', 'done')`,
    ).get(piece.assigneeAgent, piece.threadId) as { id: string } | undefined;
    const h = task ? latestHandIn(task.id) : null;
    if (task && h) await handInHeard(task.id, h);
  }));
}

async function resolveOpenJoin(
  join: JoinState, opts: { failIfUnanswered: boolean; askedNameHint?: string | null },
): Promise<'relayed' | 'failed-closed' | 'left-open' | 'already-settled' | 'extended'> {
  await handInsNeverHeard(join);
  const state = landStrandedReplies(joinState(join.id) ?? join);
  if (!state) return 'already-settled';
  if (state.complete) {
    await resolveCompletedJoin(state, opts.askedNameHint ?? undefined);
    return 'relayed';
  }
  if (!opts.failIfUnanswered) return 'left-open';

  // THE DEADLINE YIELDS TO PROOF OF LIFE: one patience-scaled grant, the assignee's own
  // declared speed, bounded by `JOIN_LIVENESS_MAX_TOTAL_MS` so it cannot renew for ever.
  const alive = liveAssigneeForJoin(state);
  if (alive) {
    const granted = extendJoinTtl(state.id, { grantMs: alive.grantMs });
    if (granted.extended) {
      logger.info('a2a join past its deadline but its assignee is still WORKING — granting more time, not failing it', {
        joinId: state.id, assignee: alive.agentId, grantMs: alive.grantMs,
        patienceBasis: alive.basis, newTtlAt: granted.ttlAt,
        landed: state.landed, total: state.total,
      });
      return 'extended';
    }
    logger.warn('a2a join assignee still looks alive but the join hit its hard ceiling — failing closed', {
      joinId: state.id, assignee: alive.agentId, refusedBecause: granted.reason,
      ceilingMs: JOIN_LIVENESS_MAX_TOTAL_MS,
    });
  }

  const snapshot = joinPieces(state.id);   // before the settle: the notice names what landed and what did not
  const claimed = failJoinClosed(state.id, {
    reason: alive
      ? 'the delegated answer never came back, and the wait reached its hard ceiling'
      : 'the delegated answer never came back inside the deadline',
    expectedState: state.parentState,
  });
  if (claimed.kind !== 'applied') return 'already-settled';
  tellAgentTheJoinFailed(state, 'the delegated answer never came back inside the deadline.', await relayNotice(state, landedContentNotice(state, snapshot, false, opts.askedNameHint)));
  return 'failed-closed';
}

/** THE ONE NOTICE FOR A FAN-OUT OUT OF TIME WITH SOMETHING BACK, built from a snapshot taken
 *  BEFORE the settle: it names what arrived and who never did. Nothing back falls through to
 *  `failClosedNotice`, so one composer owns "I could not get an answer". */
function arrivedLine(p: JoinPiece): string {
  return `From ${resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent'}${p.state === 'failed' ? ' (it reported a failure)' : ''}: ${
    (p.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)}`;
}

function landedContentNotice(
  join: JoinState, snapshot: JoinPiece[], parentAnswered: boolean, askedNameHint?: string | null,
): string {
  const landed = snapshot.filter((p) => (p.state === 'done' || p.state === 'failed') && (p.content ?? '').trim().length > 0);
  if (landed.length === 0) return failClosedNotice(join, askedNameHint);
  const missing = snapshot.filter((p) => !isTerminal(p.state));
  const names = missing.map((p) => resolveAgentDisplayName(p.assigneeAgent) ?? askedNameHint ?? 'another agent');
  const who = names.length === 1 ? names[0] : `${names.length} of the agents it asked`;
  return `${parentAnswered ? 'following up on something your agent answered earlier' : 'your agent delegated this'}: ${who} never came back `
    + `inside the deadline. Here is what did arrive:\n${landed.map(arrivedLine).join('\n')}`;
}

/** THE SECOND TIMEOUT ARM: a join past its deadline whose parent has ALREADY CLOSED; see
 *  `dueJoinsUnderClosedParent` for why widening the first arm was refused. Same discipline:
 *  land stranded replies; relay if all landed; else settle children `abandoned`, ONE notice.
 *  The child transition IS the exactly-once guard; the PARENT is not transitioned at all. */
async function resolveJoinUnderClosedParent(
  join: JoinState, opts: { askedNameHint?: string | null } = {},
): Promise<'relayed' | 'noticed' | 'already-settled'> {
  const state = landStrandedReplies(join);
  if (!state) return 'already-settled';

  const snapshot = joinPieces(state.id);
  const outstanding = snapshot.filter((p) => !isTerminal(p.state));

  if (outstanding.length === 0) {
    // Everything is back after all: relay it. The parent is terminal, so there is no state
    // move to make; `compile_pending` is cleared so the ordinary drain cannot relay twice.
    const withContent = snapshot.filter((p) => (p.content ?? '').trim().length > 0);
    if (withContent.length === 0) return 'already-settled';
    const text = `All the delegated pieces are back; here they are directly:\n${withContent.map(arrivedLine).join('\n')}`;
    await relayToAsker(state, { tool: 'a2a-join-relay', frame: '', answer: text, files: pieceFiles(state.id), reports: newestPieceDelivery(snapshot) });
    if (state.compilePending) {
      clearJoinCompilePending(state.id, 'relayed the recorded pieces under a closed parent');
    }
    return 'relayed';
  }

  // Settle FIRST, deliver second: the guard has to be won before the send, exactly as the
  // first arm wins `failJoinClosed` before it delivers.
  let claimed = 0;
  for (const piece of outstanding) {
    const r = settlePieceWithoutResult(piece.childId, {
      to: 'abandoned', actorId: 'work-reaper',
      reason: 'the deadline passed and the ask it belonged to had already been answered',
    });
    if (r.result.kind === 'applied') claimed++;
  }
  // Defence in depth: the FINDER is the guard; this covers only the two-scanners-at-once race.
  if (claimed === 0) return 'already-settled';
  tellAgentTheJoinFailed(state, 'a delegated piece under an already-answered question ran out of time.', await relayNotice(state, landedContentNotice(state, snapshot, true, opts.askedNameHint)));
  return 'noticed';
}

/** The TTL sweep, keyed on `work.ttl_at` (scheduled in index.ts, every 10 minutes): land a
 *  stranded reply if one exists, else fail closed, exactly once per join (the transition IS
 *  the guard). `dueJoins` and `dueJoinsUnderClosedParent` are complementary arms on `state`. */
export async function sweepExpiredJoins(): Promise<{
  failedClosed: number; relayedReplies: number; noticedUnderClosedParent: number;
  compileDrives: number;
  /** Joins the reaper REFUSED to fail because their assignee was provably working. */
  extendedForLiveAssignee: number;
}> {
  const out = {
    failedClosed: 0, relayedReplies: 0, noticedUnderClosedParent: 0, compileDrives: 0,
    extendedForLiveAssignee: 0,
  };

  // THE COMPILE DRIVE, ON THE REAPER'S OWN CADENCE: population is `openJoins()` filtered to
  // compile-pending rows, no new finder and no new clock; each drive consults the storm law.
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
      else if (outcome === 'extended') out.extendedForLiveAssignee++;
      // Name the outcome: a join kept open is not a join closed.
      logger.info(outcome === 'extended'
        ? 'join TTL reaper: expired join KEPT OPEN — its assignee is still working'
        : 'join TTL reaper: closed expired join', {
        agentId: join.agentId, work: join.id, outcome,
      });
    } catch (err) {
      logger.warn('join TTL reaper: failed to close join', {
        agentId: join.agentId, work: join.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // The second arm: expired joins under an already-closed parent.
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

/** The boot re-drain, over ALL open joins (bounded): land stranded replies, fail closed when
 *  the asked agent terminated or the TTL passed. It never wakes an agent, so no boot storm. */
export async function resolveJoinsAtBoot(): Promise<{ relayedReplies: number; failedClosed: number; leftOpen: number }> {
  const out = { relayedReplies: 0, failedClosed: 0, leftOpen: 0 };
  const joins = openJoins(JOIN_BOOT_BATCH);
  for (const join of joins) {
    try {
      const pastTtl = join.ttlAt !== null && Date.now() > join.ttlAt;
      // A terminated asked agent can never reply: don't make the owner wait out the TTL.
      // The assignee is recorded on the child at delegation time.
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

/** When the engine gives up a request the asked agent never answered (its pickup past the budget), the asker
 *  may hold a delegated piece on that thread: settle the PIECE abandoned now, so a completed
 *  join tells the owner at once instead of waiting for its expiry. A piece
 *  abandoning does NOT fail the whole join; the others may land and the reaper owns the rest. */
export async function failJoinPieceForAbandonedAsk(
  inboundAskMessageId: string, threadShort: string, askedAgentId?: string,
  reason = `the request on thread ${threadShort} went unanswered for its budget of turns and was given up`,
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
        reason, actorId: askedAgentId ?? null,
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
