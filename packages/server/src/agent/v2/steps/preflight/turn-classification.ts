// Classifies the turn (A2A, engine event or notification); a waiting human always wins the turn.
// Abandons when the engine event was already served by another process.

import type { Database } from 'better-sqlite3';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { isRowUnserved, sweepByRowid } from '../../../../memory/message-store.js';
import { messageIdAtSeq } from '../../../../memory/served-ask.js';
import type { TurnContext } from '../../../turn-context.js';
import { parseA2ATrigger } from '../../classifiers/a2a.js';
import type { WaitingConversation } from '../../counterparty.js';
import { nextOwed, type AgentRequest, type OwedItem } from '../../owed.js';
import { spendServe } from '../../serve-later.js';
import { a2aRetryBudgetFor } from '../../../a2a-patience.js';
import { resolveServedWork } from '../../stale-work-ids.js';
import { engineEventRoot } from '../../work-lineage.js';
import { a2aJobOrigin } from '../../../../work/job-origin.js';
import { preflightAbandon, preflightProceed, type PreflightOutcome } from '../step-outcome.js';
import type { PreflightContext, PreflightScratch } from './index.js';

const logger = createLogger('v2-loop');

export interface TurnClassificationInputs {
  readonly db: Database;
  readonly waitingConvs: WaitingConversation[];
  readonly openHumanWorkAtTurnStart: boolean;
  readonly item: OwedItem | undefined;
  readonly triggerRow: WaitingConversation['latest'];
  readonly chosenConvKey: string;
  readonly lastUserMessageContent: string;
}

export interface TurnClassificationOutputs {
  readonly mostRecentInbound: {
    rowid: number; content: string; lane: string; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; served_by_turn: number | null;
  } | undefined;
  readonly mostRecentIsA2A: boolean;
  readonly terminalWakeA2A: { intent: string; threadShort: string; threadId: string; fromName: string; rowid: number } | null;
  readonly hasUnansweredUser: boolean;
  readonly isA2ATurn: boolean;
  readonly terminalWakeDrivesTurn: boolean;
  readonly pendingEngineEvent: { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null } | null;
  readonly isEngineTurn: boolean;
  readonly settledContextWakeTurn: boolean;
  readonly isNotificationTurn: boolean;
  readonly a2aReplyContext: { intent: string; threadShort: string; fromName: string } | null;
  readonly a2aReplyAssignMessageId: string | null;
  readonly a2aCounterpartyIdentity: { intent: string; threadShort: string; fromName: string } | null;
  /** Another agent's request this turn serves, when it is the first thing owed. */
  readonly unrepliedAssign: AgentRequest | null;
}

/** Another agent's request spends a serve when a turn picks it up. Past its budget of turns it is given up and the
 *  asker's join piece settled, so the asker is told; true then, and the turn serves the next item. */
function givenUp(agentId: string, item: OwedItem | undefined): boolean {
  const r = item?.kind === 'agentRequest' ? item.request : undefined;
  if (!r || !spendServe(agentId, r.rowid, a2aRetryBudgetFor(agentId).turns + 1)) return false;
  sweepByRowid({ rowid: r.rowid, agentId });
  logger.warn('v2: another agent\'s request went unanswered for its budget of turns; given up', { agentId, from: r.fromName, thread: r.threadShort }, agentId);
  void import('../../../a2a-transport.js').then((m) => m.failJoinPieceForAbandonedAsk(r.messageId, r.threadShort, agentId))
    .catch(() => { /* the join's own expiry backstops */ });
  return true;
}

/** The helper's result at `rowid`, named for the turn's header. */
function terminalWakeAt(db: Database, rowid: number): TurnClassificationOutputs['terminalWakeA2A'] {
  const b = db.prepare('SELECT a2a_intent, a2a_thread_id, source_agent_id FROM messages WHERE rowid = ?')
    .get(rowid) as { a2a_intent: string; a2a_thread_id: string; source_agent_id: string | null } | undefined;
  if (!b) return null;
  const sender = b.source_agent_id
    ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(b.source_agent_id) as { name?: string } | undefined)
    : undefined;
  return {
    intent: b.a2a_intent, threadShort: b.a2a_thread_id.slice(0, 8), threadId: b.a2a_thread_id,
    fromName: sender?.name ?? b.source_agent_id ?? 'another agent', rowid,
  };
}

export async function runTurnClassification(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: TurnClassificationInputs,
): Promise<PreflightOutcome<TurnClassificationOutputs>> {
  const { agentId, setAgentStatus } = ctx;
  const {
    db, waitingConvs, openHumanWorkAtTurnStart, triggerRow, chosenConvKey, lastUserMessageContent,
  } = input;
  let item = input.item;
  if (givenUp(agentId, item)) {
    item = nextOwed(agentId)[0];
    if (givenUp(agentId, item)) item = undefined;
    // Nothing left to serve: the turn ends here, as a lost pickup claim does, with no model call.
    if (!item && !chosenConvKey && !a2aJobOrigin(agentId)) { setAgentStatus(agentId, 'idle'); return preflightAbandon('request-given-up'); }
  }
  // The most-recent inbound over every lane.
  const mostRecentInbound = db.prepare(`
    SELECT seq AS rowid, content, lane, origin_intent, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, served_by_turn
      FROM messages
     WHERE agent_id = @agentId AND role = 'user'
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get({ agentId }) as {
    rowid: number; content: string; lane: string; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; served_by_turn: number | null;
  } | undefined;
  // Engine-origin rows (lane 'events') are not peer A2A: they drive an engine turn instead.
  const mostRecentIsA2A =
    mostRecentInbound?.lane !== 'events' &&
    parseA2ATrigger(mostRecentInbound?.content ?? null) !== null;
  // A helper's result (an unserved peer DELIVERABLE/ANSWER/COMPLETE/FAIL) is the turn's subject when it is the first
  // thing owed. It needs no reply, but the turn must scope to it, or the deliverable is stripped from context.
  const terminalWakeA2A = item?.kind === 'agentResult' ? terminalWakeAt(db, Number(item.ref)) : null;
  // Another agent's request is the turn's subject when it is the first thing owed. On other turns A2A stays out
  // of context, so inter-agent traffic cannot bleed into a user-facing reply.
  const unrepliedAssign = item?.kind === 'agentRequest' ? (item.request ?? null) : null;
  // The user always wins: a waiting human conversation makes this a user turn and any pending A2A
  // defers to its own turn. Engine events and A2A are never human conversations.
  const hasUnansweredUser = waitingConvs.length > 0;
  // Both A2A shapes scope the live tail to the A2A thread so the agent sees the message.
  const a2aWakeTurn = !hasUnansweredUser && (unrepliedAssign !== null || terminalWakeA2A !== null);
  if (a2aWakeTurn) turnCtx.servedRequest = unrepliedAssign;
  const terminalWakeDrivesTurn = a2aWakeTurn && terminalWakeA2A !== null;
  // The driving wake is claimed by its serve edge (`served_by_turn`, stamped in counterparty-and-record),
  // so it drives exactly one turn and is never re-relayed.
  if (terminalWakeDrivesTurn && terminalWakeA2A) {
    // An A2A wake turn's root is its thread.
    if (terminalWakeA2A.threadId) turnCtx.root = { kind: 'a2a', id: terminalWakeA2A.threadId, sourceMessageId: null };
    turnCtx.triggerMessageId = messageIdAtSeq(db, agentId, terminalWakeA2A.rowid);
  }

  // Engine turn: only when no human waits and it is not an A2A turn; the assembler then scopes the tail to
  // the event. A pending event is used, not the most-recent inbound, so a human message cannot starve it.
  const pendingEngineEvent = (!a2aWakeTurn && !hasUnansweredUser && item?.kind === 'clock') ? (item.event ?? null) : null;
  const isEngineTurn = !a2aWakeTurn && !hasUnansweredUser && pendingEngineEvent != null;
  const jobA2A = !a2aWakeTurn && !hasUnansweredUser && !isEngineTurn && !chosenConvKey ? a2aJobOrigin(agentId) : null;
  if (jobA2A) turnCtx.root = { kind: 'a2a', id: jobA2A.threadId, sourceMessageId: null };
  const isA2ATurn = a2aWakeTurn || jobA2A !== null;
  // Settled-context wake: no human ask was open at turn start, so every visible conversation is answered;
  // the reply's channel push is held in the dashboard, logged, and counted toward the proactive-send backoff.
  const settledContextWakeTurn = !openHumanWorkAtTurnStart;
  // Notification turn: no trigger row, not A2A or engine, and the newest inbound is an unauthorized
  // notice. It gets its own header telling the model not to message the user unless it matters.
  const isNotificationTurn =
    !triggerRow &&
    !isA2ATurn &&
    !isEngineTurn &&
    mostRecentInbound != null &&
    mostRecentInbound.lane !== 'events' &&
    !mostRecentInbound.a2a_thread_id &&
    deriveOrigin({
      role: 'user',
      content: mostRecentInbound.content,
      ...legacyOriginInputs(mostRecentInbound.lane, null),
      sourceAgentId: mostRecentInbound.source_agent_id,
      a2aThreadId: mostRecentInbound.a2a_thread_id,
      a2aIntent: mostRecentInbound.a2a_intent,
      a2aRequiresResponse: mostRecentInbound.a2a_requires_response,
      inboundMeta: mostRecentInbound.inbound_meta,
      originIntent: mostRecentInbound.origin_intent,
    }).authorized === false;
  // A cheap read of the serve edge bails the stray-process case early; the atomic claim (a CAS) runs
  // once the turn number exists, in counterparty-and-record.
  if (isEngineTurn && pendingEngineEvent) {
    let engineClaimed = true;
    try {
      engineClaimed = isRowUnserved(pendingEngineEvent.rowid, agentId);
    } catch { /* best effort: the CAS below is the authoritative answer */ }
    // Only the intent is recorded here; `claimedEngineEvent` is set once the CAS wins.
    if (engineClaimed) sc.pendingEngineClaim = { rowid: pendingEngineEvent.rowid };
    // The turn's root is the event's run or task when it carries one, and the served work is published
    // so lanes such as reminder delivery know what this turn's output belongs to.
    if (engineClaimed) {
      turnCtx.root = engineEventRoot(pendingEngineEvent);   // a wake carrying its work's lineage is rooted in that work
      turnCtx.triggerMessageId = pendingEngineEvent.id;
      if (pendingEngineEvent.taskId) {
        try {
          // Published only when the task row exists, never a dead id.
          const served = resolveServedWork(pendingEngineEvent.taskId, pendingEngineEvent.runId);
          if (served) turnCtx.servedWork = served;
          else {
            logger.warn('v2: the engine event names a task row that is not there; serving no work this turn', {
              agentId, taskId: pendingEngineEvent.taskId,
            }, agentId);
          }
        } catch { /* best effort; the lane simply stays inactive */ }
      }
    }
    if (!engineClaimed) {
      // Already served: another process (a stray dev watcher on the one DB) claimed it, so bail
      // instead of running a duplicate engine turn.
      logger.warn('v2: engine event already served, another process claimed it; skipping to avoid a duplicate engine turn', { agentId, rowid: pendingEngineEvent.rowid }, agentId);
      setAgentStatus(agentId, 'idle');
      return preflightAbandon('engine-event-claim-lost');
    }
  }

  // Re-broadcast the working status with the turn kind so the composer can stay quiet on A2A turns.
  turnCtx.kind = isA2ATurn ? 'a2a' : 'user';
  broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: isA2ATurn ? 'a2a' : 'user', userFacing: !!chosenConvKey });

  // The reply enforcer arms only for reply-needed A2A; a terminal wake leaves a2aReplyContext null.
  const a2aReplyContext = a2aWakeTurn
    ? (unrepliedAssign
        ? { intent: unrepliedAssign.intent, threadShort: unrepliedAssign.threadShort, fromName: unrepliedAssign.fromName }
        : parseA2ATrigger(lastUserMessageContent))
    : null;
  const a2aReplyAssignMessageId = a2aWakeTurn ? (unrepliedAssign?.messageId ?? null) : null;
  // The thread identity for the header and tail scoping; a terminal wake falls back to its own message,
  // or the counterparty would carry a null thread and the deliverable would be dropped.
  const a2aCounterpartyIdentity = a2aReplyContext
    ?? (terminalWakeA2A
        ? { intent: terminalWakeA2A.intent, threadShort: terminalWakeA2A.threadShort, fromName: terminalWakeA2A.fromName }
        : jobA2A);

  return preflightProceed({
    mostRecentInbound, mostRecentIsA2A, terminalWakeA2A, hasUnansweredUser, isA2ATurn,
    terminalWakeDrivesTurn, pendingEngineEvent, isEngineTurn, settledContextWakeTurn,
    isNotificationTurn, a2aReplyContext, a2aReplyAssignMessageId, a2aCounterpartyIdentity, unrepliedAssign,
  });
}
