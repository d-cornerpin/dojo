// A2A Transport: structured agent-to-agent message delivery through deliverA2AMessage.
// send_to_agent, PM pokes, healer alerts and completion notifications all flow through it;
// it enforces the per-thread hop cap, semantic dedup and requires_response routing.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { liveAgentsNamed, liveAgentNamesNear, resolveAgentDisplayName } from './tool-helpers.js';
import { endedMidRun } from './ended-mid-run.js';
import {
  A2A_THREAD_SHORT_LENGTH, a2aThreadShort, a2aThreadShortLegacy, a2aThreadTokenMatchesSql, extractPayloadFromA2AMessage, OWNER_ALERT_DOJO_PREFIX,
} from '@dojo/shared';
import { postAgentNotice } from './agent-notice.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime, stopAgent } from './runtime.js';
import {
  deliveredResult, insertMessageIfAbsent, insertEngineEventIfAbsent, type EngineEventWork,
} from '../memory/message-store.js';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { a2aPayloadForModel } from '../tools/inbound-fences.js';
import { queueReply, recordDelivery } from './v2/deliveries.js';
import { replyAddressFor } from './v2/channel-sender.js';
import { resultForEndedRequest } from './v2/counterparty.js';
import { recordAtDoor, recordedId } from './v2/outbound.js';
import { asTurn, turnContext } from './turn-context.js';
// The join lives in `work`; everything here is transport: it lands pieces and relays answers.
import {
  THREAD_HOP_CAP, isTerminal,
  findJoinChildByThread, findFailedJoinForThread, childrenForThread,
  landPiece, settlePieceWithoutResult, repointJoinPieceToHandOff, transition, appendWorkEvent,
  joinState, joinPieces, dueJoins, openJoins,
  dueJoinsUnderClosedParent,
  failJoinClosed, clearJoinCompilePending,
  claimFailedJoinForLateAnswer, threadHopCountInWindow, bumpThreadHopCount, hopWindowLapsed,
  extendJoinTtl,
  type JoinState, type JoinPiece, type PieceSettleResult,
} from '../work/store.js';
import { joinFailureNotice, joinFailureReason } from './join-failure-notice.js';
// The join's close is the settlement authority's, never this module's, as elsewhere.
import { settleAskOnJoin, priorEngineJoinRelay, handBackAsk, newestPutBack, mediaJobs, type PutBackKind } from '../work/ask-settlement.js';
import { endPiece } from '../work/call-off.js';
import { servedBy } from '../work/task-turns.js';
import { compileSteerText, engineRelayPreface } from '../work/join-drive.js';
import { afterCommit, withUnit } from '../db/unit.js';
import { serveLater } from './v2/serve-later.js';
import { agentTurnWindow } from '../router/router-window.js';
import { renderTokens } from '../memory/lanes.js';
import { handInHeard } from '../work/done/effects.js';
import { latestHandIn } from '../work/done/record.js';
import { openPieces } from '../tracker/liveness.js';
import { FINAL_REPLY_INTENTS, FINAL_REPLY_SQL, REPLY_NEEDED_INTENTS, type A2AIntent, type A2AEnvelope, type A2ADropReason, type ChannelKind, type InboundMeta } from '@dojo/shared';
import { resolveRecipientDisplay } from '../contacts/resolve-recipient.js';
import { compileAskerFromMeta } from '../work/compile-asker.js';
import { deliveryLabel } from './v2/turn-address.js';
import type { ReplyDestination } from './v2/reply-destination.js';
import { homeDir } from '../home.js';
import { servedRequestThreadFrom } from './a2a-own-turn.js';


// Only FYI and STATUS are ambient no-wake. COMPLETE and FAIL must wake: the assigner has a next
// step, and a silent one stalls multi-step work. requires_response=false overrides per call.
const NO_WAKE_INTENTS = new Set<A2AIntent>(['FYI', 'STATUS']);

import { SEMANTIC_DEDUP_THRESHOLD as DEDUP_SIMILARITY_THRESHOLD } from '../memory/dedup-threshold.js';   // the one shared number
const DEDUP_LOOKBACK = 3;

function isNoWakeIntent(intent: A2AIntent): boolean { return NO_WAKE_INTENTS.has(intent); }

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


// SENDER_TERMINATED and REQUEST_ENDED are transport-local: intentionally NOT in the shared union.
type A2ADropReasonLocal = A2ADropReason | 'SENDER_TERMINATED' | 'REQUEST_ENDED';

/** A drop is a RETURN most callers discard, so logDrops are loud; a semantic duplicate is exempt because
 * the sender is told synchronously in the tool result. Unknown future reasons land at warn. */
const DROPS_THE_SENDER_IS_TOLD_ABOUT: ReadonlySet<A2ADropReasonLocal> = new Set(['SEMANTIC_DUPLICATE', 'REQUEST_ENDED']);

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
export type A2ADeliveryOptions = A2AEnvelope & { handsOffThread?: string | null; work?: EngineEventWork | null;
  taskId?: string | null };   // `work`: the serve-boundary columns of a wake; `taskId`: a spawn's transferred task, engine state only

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

  const servedThreadId = !envelope.threadId && envelope.fromAgent !== 'system' && FINAL_REPLY_INTENTS.has(effectiveIntent)
    ? servedRequestThreadFrom(envelope.fromAgent, target.id) : null;   // a threadless reply goes on the request it answers
  // A named thread is stored under the full id the two agents' stores hold for its token, the exact id first.
  const tok = envelope.threadId && envelope.threadId.length > A2A_THREAD_SHORT_LENGTH ? a2aThreadShort(envelope.threadId) : envelope.threadId;
  const named = tok ? (getDb().prepare(
    `SELECT a2a_thread_id AS t FROM messages WHERE agent_id IN (?, ?) AND length(a2a_thread_id) > ${A2A_THREAD_SHORT_LENGTH}
       AND ${a2aThreadTokenMatchesSql('a2a_thread_id')} ORDER BY a2a_thread_id = ? DESC, rowid DESC LIMIT 1`,
  ).get(envelope.fromAgent, target.id, tok, tok, envelope.threadId) as { t: string } | undefined)?.t : undefined;
  const threadId = named || envelope.threadId || servedThreadId || uuidv4();
  // ⚠ READ BEFORE `ensureThread`, and the order is load-bearing: that insert stamps `datetime('now')`
  // when no row exists, so a later read would report a delivery that never happened.
  // On a request that was called off a result is refused (it is never passed on as news); anything else wakes nobody.
  const forEndedRequest = resultForEndedRequest(target.id, threadId);
  if (forEndedRequest && FINAL_REPLY_INTENTS.has(effectiveIntent)) { logDrop(envelope, 'REQUEST_ENDED'); return { delivered: false, reason: 'REQUEST_ENDED', threadId }; }
  const lastDeliveryMs = threadLastDeliveryMs(threadId);
  ensureThread(threadId, envelope.fromAgent);

  // Loop protection comes from the semantic dedup and the hop cap, both below; no terminal gating.

  const currentHops = getThreadHopCount(threadId, lastDeliveryMs);
  if (currentHops >= THREAD_HOP_CAP) {
    logDrop(envelope, 'HOP_LIMIT_EXCEEDED');
    return { delivered: false, reason: 'HOP_LIMIT_EXCEEDED', threadId };
  }

  const isEngineEnvelope = envelope.fromAgent === 'system' || envelope.origin === 'engine';

  // Dedup silences ack loops, so only notes (FYI, STATUS) take it: a request or a final reply always lands
  // whatever the phrasing. System-origin skips too: every engine alert is a fresh condition.
  const senderIsSystem = envelope.fromAgent === 'system';
  if (!FINAL_REPLY_INTENTS.has(effectiveIntent) && !REPLY_NEEDED_INTENTS.has(effectiveIntent) && !senderIsSystem) {
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
      // The tracker line names the task and how the receiver's reply hands it in.
      const taskShort = autoTask.taskId.slice(0, 8);
      threadInfo += autoTask.isNew
        ? `\n[Tracker: task ${taskShort} is this work's task. When you finish, reply on this thread with the result (COMPLETE, or FAIL if it cannot be done); that reply hands the task in.]`
        : `\n[Tracker: this is more about task ${taskShort}, which you already hold.]`;
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
  // are excluded: ops traffic is not user-facing, and the join puts its answer back itself.
  let primaryDeliverableHint = '';
  // Read BEFORE the piece lands below: landing settles the child.
  const joinChild = findJoinChildByThread(target.id, threadId);
  try {
    const { isPrimaryAgent, isPMAgent, isHealerAgent } = await import('../config/platform.js');
    const targetIsPrimary = isPrimaryAgent(target.id);
    const senderIsOps = isPMAgent(envelope.fromAgent) || isHealerAgent(envelope.fromAgent) || envelope.fromAgent === 'system';
    const isDeliverableShape =
      autoPromotedFromFyi ||
      (effectiveIntent === 'DELIVERABLE' || effectiveIntent === 'ANSWER');
    if (targetIsPrimary && !senderIsOps && isDeliverableShape && !joinChild && !findFailedJoinForThread(target.id, threadId)
      && !sentBackPiece(target.id, threadId, envelope.fromAgent)) {
      primaryDeliverableHint = deliverableArrivedNote(senderName);
    }
  } catch { /* best effort */ }

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

  // Only an answer on a DELEGATED thread lands on its join, once its row and files are saved; a reply the join
  // owns wakes nobody (its request is the wake). A question or a note reaches the agent as itself.
  let handOffReport: { applied: boolean; message: string } | undefined;
  if (FINAL_REPLY_INTENTS.has(effectiveIntent)) {
    try {
      const landed = await landReplyOnJoin({
        agentId: target.id, threadId, threadShort, payload: envelope.payload ?? '',
        fromAgent: envelope.fromAgent, intent: effectiveIntent, messageId: msgId, senderName,
        handsOffThread: envelope.handsOffThread ?? null,
      });
      if (landed.handled) requiresResponse = false;
      handOffReport = landed.handOff;
    } catch (err) {
      // The join owns this thread, so if landing fails here NOBODY tells the owner; hence the error tier.
      logger.error('A2A close-the-loop delivery failed — the reply came back and was not landed on its join; the owner will not be told', {
        agentId: target.id, thread: threadShort, fromAgent: envelope.fromAgent,
        intent: effectiveIntent, error: err instanceof Error ? err.message : String(err),
      });
    }
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
  if (forEndedRequest) logger.info('A2A delivery: a message on a request that was called off; stored, no wake', { targetId: target.id, threadId });
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
// `transition()`. This file is transport: it lands pieces, puts the answer back in the person's
// queue, relays it when the agent does not answer, fails stuck joins closed. A late answer still lands.

const JOIN_BOOT_BATCH = 50;

/** The person's request as they wrote it, its leading markers stripped. */
const stripMarkers = (content: string): string => content.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').trim();

/** Short quote of the owner's ask for the fail-closed notice. */
function questionSnippet(content: string): string {
  const stripped = stripMarkers(content).replace(/\s+/g, ' ');
  return stripped.length > 160 ? `${stripped.slice(0, 160).trimEnd()}...` : stripped;
}

/** The helper whose piece carries delivery `evidence`, else the first piece's. */
const helperOf = (pieces: JoinPiece[], evidence: string | null): string =>
  resolveAgentDisplayName((pieces.find((p) => p.resultDeliveryId === evidence) ?? pieces[0])?.assigneeAgent) ?? 'the helper';

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
function failClosedNotice(join: JoinState, askedNameHint?: string | null, pieces = joinPieces(join.id)): string {
  // The wording lives in `join-failure-notice.ts`, which reads the pieces' states (before the fail, when given).
  const ask = askRowForJoin(join);
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
): { payload: string; senderName: string; messageId: string; senderId: string | null; intent: A2AIntent } | null {
  const row = getDb().prepare(
    `SELECT id, content, source_agent_id, a2a_intent FROM messages
      WHERE agent_id = ? AND role = 'user' AND source_agent_id IS NOT NULL
        AND source_agent_id != ? AND created_at >= ?
        AND a2a_thread_id IN (?, ?) AND a2a_intent IN (${FINAL_REPLY_SQL})
      ORDER BY rowid DESC LIMIT 1`,
  ).get(agentId, agentId, sinceMs - 15 * 60_000, threadId, a2aThreadShortLegacy(threadId)) as
    | { id: string; content: string; source_agent_id: string | null; a2a_intent: A2AIntent } | undefined;
  if (!row) return null;
  // The stored row is envelope + payload + footer; relay just the payload the sender wrote.
  const payload = extractPayloadFromA2AMessage(row.content) ?? '';
  const fromTag = row.content.match(/^\[A2A:[A-Z]+\s+thread:\S+\s+from:([^\]]+)\]/);
  const senderName = resolveAgentDisplayName(row.source_agent_id) ?? fromTag?.[1]?.trim() ?? 'the other agent';
  return { payload, senderName, messageId: row.id, senderId: row.source_agent_id, intent: row.a2a_intent };
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

/** The order handed to the turn serving the request: what it asked, the files, every piece quoted whole. */
function orderText(join: JoinState, kind: PutBackKind, evidence: string | null): string {
  const ask = askRowForJoin(join);
  const asker = compileAskerFromMeta(ask?.inbound_meta ?? null, (ch, handle) => resolveRecipientDisplay(ch as ChannelKind, handle), (ch) => deliveryLabel(ch as ReplyDestination));
  const pieces = joinPieces(join.id);
  return compileSteerText({
    kind, asker, request: stripMarkers(ask?.content ?? ''), files: pieceFiles(join.id),
    helper: helperOf(pieces, evidence),
    pieces: pieces.map((p, i) => {
      const body = (p.content ?? '').trim() || `(no content came back: this piece ${p.state === 'abandoned' ? 'was abandoned' : 'failed'})`;
      return `Piece ${i + 1} (from ${resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent'}, thread ${p.threadId.slice(0, 8)}): "${body}"`;
    }),
  });
}

/** The order for the turn serving request `askId`, from its newest put-back; null when its answer is not back. */
export function joinOrderFor(askId: string): { putBackId: number; text: string; firstLine: string } | null {
  const putBack = newestPutBack(askId);
  const join = putBack ? joinState(askId) : null;
  if (!putBack || !join) return null;
  const text = orderText(join, putBack.kind, putBack.evidence);
  return { putBackId: putBack.id, text: `${JOIN_STEER_LABEL} ${text}`, firstLine: text.split('\n')[0] };
}

interface LandInput {
  agentId: string; threadId: string; threadShort: string; payload: string;
  fromAgent: string; intent: A2AIntent; messageId: string | null; senderName: string;
  handsOffThread?: string | null;
}

/** A terminal A2A reply on a delegated thread: advance the join. A reply the join handles wakes nobody: its row's
 *  wake is cleared before any await, and the caller suppresses the ordinary deliverable hint. */
async function landReplyOnJoin(p: LandInput): Promise<{ handled: boolean; handOff?: { applied: boolean; message: string } }> {
  const child = findJoinChildByThread(p.agentId, p.threadId);
  const handled = child !== null || deliverLateAnswerIfJoinFailedClosed(p) || updateAfterSendBack(p);
  if (handled && p.messageId) getDb().prepare('UPDATE messages SET a2a_requires_response = 0 WHERE id = ?').run(p.messageId);
  if (!child) {
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
  // caller can forget it; the piece stays outstanding for the real one, or ends once its helper's work has stopped.
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
  if (!joinState(child.parentId)) return { handled: false, handOff };   // a piece under a task: the answer wakes its agent
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

/** The countdown reached zero and it was not all called off by the owner (`endPiece`): nothing came back, the
 *  fail-closed notice; else the answer goes back to the agent. */
export async function resolveCompletedJoin(join: JoinState, senderNameHint?: string): Promise<void> {
  if (join.outcome === 'fail-closed') {
    if (mediaJobs(join.rootId).out > 0) return;   // its pictures or songs still work: the request goes on with them
    const failReason = joinFailureReason(joinPieces(join.id));
    const claimed = failJoinClosed(join.id, { reason: failReason, expectedState: join.parentState });
    if (claimed.kind !== 'applied') return;
    tellAgentTheJoinFailed(join, `${failReason}.`, await relayNotice(join, failClosedNotice(join, senderNameHint)));
    return;
  }
  answerBackInView(join, 'compile', newestPieceDelivery(joinPieces(join.id)));
}

/** A helper's answer for a person's request goes back to the agent, once: the request back in their queue, due now,
 *  and a put-back record the steer reads. A request answered or failed before is re-opened on the helper's own
 *  delivery; one too old or too big to put back is relayed instead. */
function answerBackInView(join: JoinState, kind: PutBackKind, evidence: string | null): void {
  const relayInstead = withUnit((): boolean => {
    const instead = tooOldOrBigToPutBack(join, kind, evidence);
    if (kind === 'compile') {
      // Only the pass that clears the flag goes on; a Dojo relay on its way, or one already sent, settles the request.
      const relayed = priorEngineJoinRelay(join.id) !== null;
      if (clearJoinCompilePending(join.id, 'its delegated work is back', instead || relayed ? undefined : { kind, evidence }) === 0) return false;
      if (relayed && settledOnPriorRelay(join.id)) return false;
    } else if (!instead) appendWorkEvent(join.id, 'compile_resolved', 'engine', { reason: kind === 'late' ? 'its helper answered after all' : 'its helper corrected its work', kind, evidence });
    if (instead) return true;
    const state = joinState(join.id)?.parentState;
    const reason = 'its delegated work is back';
    if (state === 'blocked') handBackAsk(join.id, { agentId: join.agentId, turnNumber: null, cause: 'free', actorId: 'a2a-join', reason });
    else if ((state === 'done' || state === 'failed') && evidence) {
      transition(join.id, { to: 'open', by: 'engine', actorId: 'a2a-join', evidenceRef: evidence, clearResultDelivery: true, reason });
    }
    serveLater({ kind: 'ask', id: join.id }, Date.now(), reason);
    return false;
  });
  if (relayInstead) afterCommit(() => void relayPiecesWhole(join.id, kind, evidence));
}

/** A first answer the Dojo already relayed: the request settles on that relay. */
function settledOnPriorRelay(joinId: string): boolean {
  const prior = priorEngineJoinRelay(joinId);
  if (prior) settleAskOnJoin(joinId, { deliveryId: prior.id, basis: 'engine-relay', reason: 'the engine had already relayed the delegated answer' });
  return prior !== null;
}

/** Too old to hand back (a day, or from before its agent's New Session), or its order over 40% of the agent's window. */
function tooOldOrBigToPutBack(join: JoinState, kind: PutBackKind, evidence: string | null): boolean {
  const r = getDb().prepare(
    `SELECT w.opened_at AS opened, unixepoch(a.session_started_at) * 1000 AS session, a.model_id AS model
       FROM work w JOIN agents a ON a.id = w.agent_id WHERE w.id = ?`,
  ).get(join.id) as { opened: number; session: number | null; model: string | null } | undefined;
  if (!r) return false;
  if (Date.now() - r.opened > 24 * 3_600_000 || (r.session !== null && r.opened < r.session)) return true;
  return r.model !== null
    && renderTokens([{ role: 'user', content: orderText(join, kind, evidence) }]) > 0.4 * agentTurnWindow(join.agentId, r.model);
}

/** THE ONE RELAY of a delegated answer: the Dojo sends every piece whole, labelled as its own, and tells the agent.
 *  Its delivery settles the request; a first answer the Dojo already relayed settles on that relay instead. */
export async function relayPiecesWhole(joinId: string, kind: PutBackKind, evidence: string | null): Promise<void> {
  const join = joinState(joinId);
  if (!join || (kind === 'compile' && settledOnPriorRelay(join.id))) return;
  const pieces = joinPieces(join.id);
  // One piece goes as delivered (to another Dojo's agent that is the whole message); several are each named.
  const answer = pieces.length === 1 ? (pieces[0].content ?? '').trim() : pieces.map(arrivedLine).join('\n\n');
  const frame = kind === 'compile' ? `${engineRelayPreface(pieces.length)}\n\n`
    : `Update: ${helperOf(pieces, evidence)} ${kind === 'late' ? 'answered after all' : 'corrected its work after review'}. `;
  tellAgentWhatTheRelaySent(join, await relayToAsker(join, {
    tool: kind === 'compile' ? 'a2a-join-relay' : 'a2a-join-late', frame, answer,
    files: pieceFiles(join.id), reports: kind === 'compile' ? newestPieceDelivery(pieces) : evidence,
  }));
}

/** An answer after its request failed for want of one takes the one late road, in one unit that rolls back when the
 *  landing is refused: the request and its piece re-open on that answer, the piece lands, the answer goes back.
 *  True when the reply belonged to such a request, landed or not. */
function deliverLateAnswerIfJoinFailedClosed(p: LandInput): boolean {
  const failed = findFailedJoinForThread(p.agentId, p.threadId);
  const join = failed ? joinState(failed.parentId) : null;
  const evidence = failed && join
    ? recordPieceDelivery({ fromAgent: p.fromAgent, toAgent: p.agentId, messageId: p.messageId, intent: p.intent }) : null;
  if (!failed || !join || !evidence) return false;
  try {
    withUnit(() => {
      if (join.parentState === 'failed' && claimFailedJoinForLateAnswer(join.id, evidence, `${p.senderName} answered after all`).kind !== 'applied') return;
      transition(failed.childId, {
        to: 'open', by: 'engine', actorId: 'a2a-join', evidenceRef: evidence, reason: `late answer: ${p.senderName} answered after all`,
      });
      const landed = landPiece(failed.childId, { deliveryId: evidence, content: p.payload, messageId: p.messageId, actorId: p.fromAgent });
      if (landed.result.kind !== 'applied') throw new Error(`the late answer did not land (${landed.result.kind})`);
      answerBackInView(join, 'late', evidence);
    });
  } catch (err) {
    logger.info('a late answer was not landed; nothing changed', {
      agentId: p.agentId, thread: p.threadShort, error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

/** The landed piece of an answered request on this thread whose helper's job was sent back since it landed. */
function sentBackPiece(agentId: string, threadId: string, helperId: string): { pieceId: string; joinId: string } | undefined {
  return getDb().prepare(
    `SELECT c.id AS pieceId, c.parent_id AS joinId FROM work c JOIN work a ON a.id = c.parent_id
      WHERE c.agent_id = ? AND c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.root_id = ? AND c.state = 'done' AND a.state = 'done'
        AND EXISTS (SELECT 1 FROM work t JOIN work_events e ON e.work_id = t.id AND e.kind = 'decided'
                     WHERE t.kind = 'task' AND t.agent_id = ? AND t.a2a_thread_id = c.root_id
                       AND json_extract(e.payload, '$.verdict') = 'send_back' AND e.created_at > c.closed_at)
      ORDER BY c.opened_at DESC LIMIT 1`,
  ).get(agentId, threadId, helperId) as { pieceId: string; joinId: string } | undefined;
}

/** Corrected work for a request already answered: the helper's job was sent back after its piece landed. The piece
 *  takes the corrected text and delivery, and the request goes back to its person; false when this is not that. */
function updateAfterSendBack(p: LandInput): boolean {
  if (p.intent === 'FAIL' || !p.payload.trim()) return false;
  const r = sentBackPiece(p.agentId, p.threadId, p.fromAgent);
  const join = r ? joinState(r.joinId) : null;
  const evidence = r && join ? recordPieceDelivery({ fromAgent: p.fromAgent, toAgent: p.agentId, messageId: p.messageId, intent: p.intent }) : null;
  if (!r || !join || !evidence) return false;
  withUnit(() => {
    // The piece closes again on the correction, so only a newer send-back makes the next reply an Update.
    getDb().prepare('UPDATE work SET notes = ?, result_delivery_id = ?, closed_at = ?, updated_at = ? WHERE id = ?')
      .run(p.payload, evidence, Date.now(), Date.now(), r.pieceId);
    answerBackInView(join, 'update', evidence);
  });
  return true;
}

/** LAND a stranded reply before judging the join, through the one landing: the owner must not hear "no answer"
 *  while it sits unlanded on the child. Returns the join after the landing (null if gone). */
async function landStrandedReplies(join: JoinState): Promise<JoinState | null> {
  const ask = askRowForJoin(join);
  for (const piece of joinPieces(join.id)) {
    if (isTerminal(piece.state)) continue;
    const s = findUnlandedInboundReply(join.agentId, piece.threadId, ask?.created_at ?? Date.now());
    if (!s) continue;
    await landReplyOnJoin({
      agentId: join.agentId, threadId: piece.threadId, threadShort: a2aThreadShort(piece.threadId), payload: s.payload,
      fromAgent: s.senderId ?? 'unknown', intent: s.intent, messageId: s.messageId, senderName: s.senderName,
    });
  }
  return joinState(join.id);
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

/** Judge an open request: land what came back, end each piece whose helper's work has stopped, and answer or tell
 *  once the last piece is settled. Work still alive is never ended for time: its next look moves on. */
async function resolveOpenJoin(join: JoinState): Promise<'relayed' | 'failed-closed' | 'left-open' | 'already-settled'> {
  await handInsNeverHeard(join);
  const landed = await landStrandedReplies(joinState(join.id) ?? join);
  if (!landed) return 'already-settled';
  if (landed.complete) {
    await resolveCompletedJoin(landed);
    return 'relayed';
  }
  for (const p of openPieces(landed.id)) if (!p.alive) await abandonPiece(p.childId, 'its helper\'s work on it has stopped', 'work-reaper');
  const state = joinState(landed.id);
  if (!state || state.complete) return state?.parentState === 'failed' ? 'failed-closed' : 'already-settled';
  extendJoinTtl(state.id);
  return 'left-open';
}

/** One piece for the person: who sent it, a failure or a missing answer said as what it was, the text whole. */
function arrivedLine(p: JoinPiece): string {
  const text = (p.content ?? '').trim();
  const label = p.state === 'done' ? '' : p.state !== 'failed' ? ' (it never answered)' : ' (it reported a failure)';
  return `From ${resolveAgentDisplayName(p.assigneeAgent) ?? 'a delegated agent'}${label}: ${text}`;
}

/** THE ONE NOTICE FOR A PIECE UNDER AN ANSWERED REQUEST THAT NEVER CAME BACK, built from a snapshot taken
 *  BEFORE the settle: it names what arrived and who never did. Nothing back falls through to
 *  `failClosedNotice`, so one composer owns "I could not get an answer". */
function landedContentNotice(join: JoinState, snapshot: JoinPiece[]): string {
  const landed = snapshot.filter((p) => (p.state === 'done' || p.state === 'failed') && (p.content ?? '').trim().length > 0);
  if (landed.length === 0) return failClosedNotice(join, null, snapshot);
  const missing = snapshot.filter((p) => !isTerminal(p.state));
  const names = missing.map((p) => resolveAgentDisplayName(p.assigneeAgent) ?? 'another agent');
  const who = names.length === 1 ? names[0] : `${names.length} of the agents it asked`;
  return `following up on something your agent answered earlier: ${who} never came back. `
    + `Here is what did arrive:\n${landed.map(arrivedLine).join('\n')}`;
}

/** THE SECOND ARM: a join due a look whose parent has ALREADY CLOSED; see `dueJoinsUnderClosedParent` for why
 *  widening the first arm was refused. Same discipline: land stranded replies; relay if all landed; else, once
 *  nothing on it is alive, settle children `abandoned`, ONE notice.
 *  The child transition IS the exactly-once guard; the PARENT is not transitioned at all. */
async function resolveJoinUnderClosedParent(join: JoinState): Promise<'noticed' | 'already-settled'> {
  const state = await landStrandedReplies(join);
  if (!state) return 'already-settled';

  const snapshot = joinPieces(state.id);
  const outstanding = snapshot.filter((p) => !isTerminal(p.state));
  // Everything is back after all: the landing that completed the join already put the answer back.
  if (outstanding.length === 0) return 'already-settled';
  if (openPieces(state.id).some((p) => p.alive)) { extendJoinTtl(state.id); return 'already-settled'; }

  // Settle FIRST, deliver second: the guard has to be won before the send, exactly as the
  // first arm wins `failJoinClosed` before it delivers.
  let claimed = 0;
  for (const piece of outstanding) {
    const r = await abandonPiece(piece.childId, 'its helper\'s work on it stopped after the ask it belonged to was answered', 'work-reaper');
    if (r.result.kind === 'applied') claimed++;
  }
  // Defence in depth: the FINDER is the guard; this covers only the two-scanners-at-once race.
  if (claimed === 0) return 'already-settled';
  tellAgentTheJoinFailed(state, 'a delegated piece under an already-answered question never came back.', await relayNotice(state, landedContentNotice(state, snapshot)));
  return 'noticed';
}

/** The TTL sweep, keyed on `work.ttl_at` (scheduled in index.ts, every 10 minutes): a deadline is when to look.
 *  It lands a stranded reply, ends stopped pieces, and tells exactly once per join (the transition IS
 *  the guard). `dueJoins` and `dueJoinsUnderClosedParent` are complementary arms on `state`. */
export async function sweepExpiredJoins(): Promise<{ failedClosed: number; relayedReplies: number; noticedUnderClosedParent: number }> {
  const out = { failedClosed: 0, relayedReplies: 0, noticedUnderClosedParent: 0 };

  let joins: JoinState[] = [];
  try {
    joins = dueJoins(Date.now());
  } catch (err) {
    logger.warn('join TTL reaper: scan failed', { error: err instanceof Error ? err.message : String(err) });
    return out;
  }
  for (const join of joins) {
    try {
      const outcome = await resolveOpenJoin(join);
      if (outcome === 'relayed') out.relayedReplies++;
      else if (outcome === 'failed-closed') out.failedClosed++;
      logger.info('join TTL reaper: looked at an expired join', { agentId: join.agentId, work: join.id, outcome });
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
      if (outcome === 'noticed') out.noticedUnderClosedParent++;
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

/** The boot re-drain, over the open joins looked at in the last week (bounded): land stranded replies and end stopped
 *  pieces, telling once. It never wakes an agent, so no boot storm. */
export async function resolveJoinsAtBoot(): Promise<{ relayedReplies: number; failedClosed: number; leftOpen: number }> {
  const out = { relayedReplies: 0, failedClosed: 0, leftOpen: 0 };
  const joins = openJoins(JOIN_BOOT_BATCH);
  for (const join of joins) {
    try {
      const outcome = await resolveOpenJoin(join);
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

/** After an end commits, a live turn still serving the ended work stops: a piece's helper on that thread or job, and
 *  a request's asker when the owner ended it (never the turn that relayed his words). */
export function endTheWorkUnder(workId: string, byOwner: boolean, actorId: string): void {
  const w = getDb().prepare('SELECT kind, agent_id AS asker, assignee_agent AS helper, root_id AS root FROM work WHERE id = ?')
    .get(workId) as { kind: string; asker: string; helper: string | null; root: string } | undefined;
  const serving = (agentId: string, ids: string[]): boolean => {
    const live = turnContext(agentId)?.turnNumber;
    return live !== undefined && servedBy(agentId, live).some((s) => ids.includes(s.id));
  };
  if (w?.kind === 'ask' && byOwner && actorId !== w.asker && serving(w.asker, [workId])) stopAgent(w.asker);
  if (w?.kind === 'ask' || !w?.helper) return;
  const jobs = (getDb().prepare("SELECT id FROM work WHERE kind = 'task' AND root_kind <> 'a2a_thread' AND agent_id = ? AND a2a_thread_id = ?")
    .all(w.helper, w.root) as Array<{ id: string }>).map((t) => t.id);
  if (turnContext(w.helper)?.root?.id === w.root || serving(w.helper, jobs)) stopAgent(w.helper);
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
    for (const child of childrenForThread(full)) {
      if (isTerminal(child.state)) continue;
      const settled = await abandonPiece(child.id, reason, askedAgentId ?? null);
      if (settled.result.kind === 'applied') logger.info('A2A ABANDONED: delegated piece settled abandoned', { agentId: child.agentId, work: child.id, complete: settled.join.complete });
    }
  } catch (err) {
    logger.warn('A2A ABANDONED: join fail-closed hook failed', {
      inboundAskMessageId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The engine gives a piece up (no answer came; a late one keeps the late road), and judges its request now. */
async function abandonPiece(childId: string, reason: string, actorId: string | null): Promise<PieceSettleResult> {
  const s = endPiece(childId, reason, 'scheduler', actorId ?? 'work-reaper');
  if (!s.judged) await resolveCompletedJoin(s.join, resolveAgentDisplayName(actorId) ?? undefined);
  return s;
}

/** A helper's work changed (its task ended, the owner was carded, the helper ended): judge now every open request with a
 *  piece assigned to it or on that thread. The agent or thread bounds it: no age floor, no row limit. */
export async function judgeKeptRequests(agentId: string, threadId: string | null = null): Promise<void> {
  try {
    const pieces = getDb().prepare(`SELECT parent_id AS ask FROM work WHERE kind = 'task' AND root_kind = 'a2a_thread'
        AND parent_id IS NOT NULL AND state IN ('open', 'claimed', 'blocked') AND (assignee_agent = ? OR root_id = ?)`).all(agentId, threadId) as Array<{ ask: string }>;
    for (const id of new Set(pieces.map((p) => p.ask))) {
      const j = joinState(id);
      if (j && !isTerminal(j.parentState)) await resolveOpenJoin(j);
    }
  } catch (err) {   // an event's judge never breaks the event; the sweep and the boot pass look again from rows
    logger.warn('kept requests could not be judged at the event', { agentId, error: err instanceof Error ? err.message : String(err) });
  }
}
