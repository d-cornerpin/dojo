// Resolves who the turn addresses and where its reply goes, allocates the turn's identity in the
// `turns` table, stamps the serve edges, and creates the state with `initState`. The state goes on the
// bag (`turnCtx.state`) rather than being returned, because closures read it live.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { claimEngineEventByRowid, markServedByRowid } from '../../../../memory/message-store.js';
import { appendWorkEvent, askIdForMessage, firstServedAt, stampClaimingTurn } from '../../../../work/store.js';
import { liftStandDowns } from '../../../../work/ask-settlement.js';
import { originOfTasks } from '../../../../work/job-origin.js';
import { turnBoundary } from '../../../turn-state.js';
import type { TurnContext } from '../../../turn-context.js';
import { initState } from '../../state.js';
import type { ChannelInboundContext } from '../../state.js';
import type { InboundChannel } from '../../inbound-channel.js';
import { resolveTurnCounterparty, type TurnCounterparty, type WaitingConversation } from '../../counterparty.js';
import { computeTurnAddress } from '../../turn-address.js';
import { resetProactiveSendStreak } from '../../proactive-budget.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { startTurn } from '../../turn-record.js';
import { declaredPatienceHonestFailTurn } from '../../../shared-state.js';
import type { PreflightContext, PreflightScratch } from './index.js';

const logger = createLogger('v2-loop');

export interface CounterpartyAndRecordInputs {
  readonly isHumanContinuation: boolean;
  readonly jobRow: WaitingConversation['latest'] | undefined;
  readonly a2aCounterpartyIdentity: { intent: string; threadShort: string; fromName: string } | null;
  readonly lastUserMessageContent: string;
  readonly lastUserMessageId: string | null;
  readonly triggerRow: WaitingConversation['latest'];
  readonly triggerWorkId: string | null;
  readonly chosenConvKey: string;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  readonly latestUserSource: 'voice' | 'text' | null;
  readonly triggeredByIMessage: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly terminalWakeA2A: { intent: string; threadShort: string; threadId: string; fromName: string; rowid: number } | null;
  readonly terminalWakeDrivesTurn: boolean;
  readonly pendingEngineEvent: { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null } | null;
  readonly a2aReplyContext: { intent: string; threadShort: string; fromName: string } | null;
  readonly contextWindow: number;
  readonly isAutoRouted: boolean;
  readonly configuredModelId: string;
  readonly isNotificationTurn?: boolean;
  readonly settledContextWakeTurn?: boolean;
  readonly notificationTriggerRowid: number | null;  // a notice wake's own reason (messages.seq)
}

/** Handed to later sections; the state is not among them, it goes on the bag. */
export interface CounterpartyAndRecordOutputs {
  readonly counterparty: TurnCounterparty;
  readonly turnNumber: number;
  readonly turnStartedAt: string;
}

export async function runCounterpartyAndRecord(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: CounterpartyAndRecordInputs,
): Promise<CounterpartyAndRecordOutputs> {
  const { agentId } = ctx;
  const {
    isHumanContinuation, jobRow, a2aCounterpartyIdentity, lastUserMessageContent,
    lastUserMessageId, triggerRow, triggerWorkId, chosenConvKey, inboundChannel,
    inboundContext, latestUserSource, triggeredByIMessage, isA2ATurn, isEngineTurn,
    terminalWakeA2A, terminalWakeDrivesTurn, pendingEngineEvent, a2aReplyContext,
    contextWindow, isAutoRouted, configuredModelId,
  } = input;
  // The one entity this turn addresses, from structured origin. A job turn has no fresh inbound, so it is read
  // from the job's request row and the answer reaches that conversation's real channel.
  const row = triggerRow ?? jobRow;
  const counterparty: TurnCounterparty = resolveTurnCounterparty({
    isA2ATurn,
    a2aFromName: a2aCounterpartyIdentity?.fromName ?? null,
    a2aThreadShort: a2aCounterpartyIdentity?.threadShort ?? null,
    triggerContent: lastUserMessageContent ?? row?.content ?? null,
    triggerLane: row?.lane ?? null,
    triggerChannel: row?.channel ?? null,
    triggerInboundMeta: row?.inbound_meta ?? null,
    inboundChannel,
  });

  // An authorized owner inbound resets the proactive-send backoff; a settled-context wake has no
  // trigger row, so only a real owner message clears the streak.
  if (triggerRow && counterparty.kind === 'user' && counterparty.relation === 'owner') {
    resetProactiveSendStreak(agentId);
  }

  turnCtx.address = computeTurnAddress({
    counterparty, isEngineTurn, isNotificationTurn: input.isNotificationTurn ?? false,
    inboundChannel, inboundContext, autoRoutes: isPrimaryAgent(agentId),
    settledContextWakeTurn: input.settledContextWakeTurn,
  });

  // The turn number is allocated by the `turns` table in-transaction, never derived from `messages`,
  // which restarts when history is cleared while `turns` keeps climbing (per-agent, monotonic).
  const turnNumber: number = (() => {
    const root = turnCtx.root ?? null;
    const kind: 'user' | 'a2a' | 'engine' | null =
      isEngineTurn ? 'engine' : ((isA2ATurn || terminalWakeA2A) ? 'a2a' : (chosenConvKey ? 'user' : null));
    const subjectKind = isEngineTurn ? 'engine_event' as const
      : (isA2ATurn || terminalWakeA2A) ? 'a2a_thread' as const
      : chosenConvKey ? 'conv' as const
      : isHumanContinuation ? 'continuation' as const
      : 'none' as const;
    const subjectId = isEngineTurn ? (pendingEngineEvent?.id ?? null)
      : terminalWakeA2A ? terminalWakeA2A.threadId
      : isA2ATurn ? (turnCtx.root?.kind === 'a2a' ? turnCtx.root.id : null)   // a request's turn and a job's continuation name their thread
      : chosenConvKey;
    turnCtx.modelRequestId = `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    return startTurn({
      agentId, kind, subjectKind, subjectId,
      lane: latestUserSource === 'voice' ? 'voice' : inboundChannel === 'phone' ? 'phone' : null,
      rootKind: root?.kind ?? null, rootId: root?.id ?? null,
      // A notice wake records its own notice, so its work is labelled with that email.
      sourceMessageId: root?.sourceMessageId ?? (input.notificationTriggerRowid == null ? null : ((getDb().prepare(
        'SELECT id FROM messages WHERE seq = ?').get(input.notificationTriggerRowid) as { id: string } | undefined)?.id ?? null)),
      convKey: chosenConvKey,
    });
  })();
  // Published so writeToolReceipt can stamp turn_number on engine receipts without threading it through.
  turnCtx.turnNumber = turnNumber;
  // Independent of `runtime.ts`'s identity check on this marker (see its doc in `shared-state.ts`):
  // every new turn starts with no declared-patience marker.
  declaredPatienceHonestFailTurn.delete(agentId);
  // Restart rehydration of session tools, once per agent per process, at the turn and never in the
  // assembly read path, where a mutation would break the cached tools prefix.
  try {
    const { rehydrateSessionToolsFromHistory } = await import('../../../../tools/tool-docs.js');
    rehydrateSessionToolsFromHistory(agentId);
  } catch { /* best effort; never break a turn over a cache warm-up */ }
  // Forward links: the work item's `claimed_by_turn` (read by delivery close and boot reconciliation)
  // and the message's `served_by_turn`. Stamped here, not at the claim, since the number exists only now.
  try {
    if (triggerWorkId) {
      const wroteAgain = firstServedAt(triggerWorkId) === null;
      stampClaimingTurn(triggerWorkId, turnNumber);
      if (wroteAgain) liftStandDowns(agentId, triggerWorkId, turnNumber);   // a request of theirs that stood down is served with it
    }
    // A turn serving a job marks the job's task, and holds the request its job started from, claimed at its pickup.
    if (turnCtx.servedJob) appendWorkEvent(turnCtx.servedJob, 'claim_turn', 'engine', { turn_number: turnNumber, agent_id: agentId, how: 'job' });
    const jobOrigin = turnCtx.servedJob ? originOfTasks(agentId, [turnCtx.servedJob]) : null;
    if (jobOrigin?.kind === 'ask') stampClaimingTurn(askIdForMessage(jobOrigin.messageId), turnNumber);
    if (triggerRow) {
      markServedByRowid(triggerRow.rowid, turnNumber);
    }
    // The engine event's atomic claim: a CAS on `served_by_turn IS NULL`. A lost claim means another
    // process took the event; the turn continues without owning it, so nothing is reverted or recorded.
    if (sc.pendingEngineClaim) {
      const won = claimEngineEventByRowid({ rowid: sc.pendingEngineClaim.rowid, agentId, turnNumber }) > 0;
      if (won) {
        sc.claimedEngineEvent = { rowid: sc.pendingEngineClaim.rowid, turnNumber };
      } else {
        logger.warn('v2: engine-event claim lost at the serve edge; this turn does not own the event', {
          agentId, rowid: sc.pendingEngineClaim.rowid, turnNumber,
        }, agentId);
      }
    }
    // Stamp a terminal wake only when it drives the turn: one that lost the turn must stay unserved
    // for its own later turn, since `served_by_turn` is the finder's own predicate.
    if (terminalWakeA2A && terminalWakeDrivesTurn) {
      markServedByRowid(terminalWakeA2A.rowid, turnNumber);
    }
  } catch { /* best effort */ }

  // Snapshot turn boundary so context assembly excludes mid-run user messages
  const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  turnBoundary.set(agentId, turnStartedAt);

  turnCtx.state = initState({
    agentId,
    contextWindow,
    isAutoRouted,
    configuredModelId,
    turnNumber,
    triggeredByIMessage,
    triggeredByA2AReplyIntent: a2aReplyContext,
    lastUserMessageContent,
    lastUserMessageId,
    // A continuation has no trigger row; the address restored the original's.
    inboundChannel: turnCtx.address?.boundChannel ?? inboundChannel,
    inboundContext: turnCtx.address?.inboundContext ?? inboundContext,
  });

  return { counterparty, turnNumber, turnStartedAt };
}
