// Teardown, the turn record: write how the turn ended, then everything that reads it in the same span.

import { createLogger } from '../../../../logger.js';
import { markServedByRowid, releaseEngineEventByRowid, setAnswerMessageId, sweepByRowid } from '../../../../memory/message-store.js';
import { clearUntrackedWorkAcrossTurnsForConversation, continuationContext } from '../../../turn-state.js';
import { isStopFenced } from '../../../shared-state.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { appendWorkEvent, claimingTurnOf, joinState } from '../../../../work/store.js';
import { settleAsksAtTurnFinalize, type TurnEnd } from '../../../../work/ask-settlement.js';
import { assembledContextAsks, recordEngineEventDeliveryFailure } from '../../counterparty.js';
import { serveLater } from '../../serve-later.js';
import { handBackCauseOf } from '../../../../work/exit-attribution.js';
import { inboundAsksNothing } from '../../classifiers/inbound-routing.js';
import {
  pauseDriveWorkWaitingOnOwner, stillClaimedWork, terminalDeliveryForTurn,
} from '../../answered-edge.js';
import { finalizeTurn, type TurnExitReason } from '../../turn-record.js';
import { turnParkedTheJob } from '../../engine-exit.js';
import type { AgentTurnState } from '../../state.js';
import type { TeardownContext } from './index.js';

const logger = createLogger('v2-loop');

export async function finalizeTurnRecord(
  state: AgentTurnState,
  ctx: TeardownContext,
): Promise<void> {
  const {
    agentId, turnCtx, turnNumber, chosenConvKey, chosenConversationId, lastAssembledAtIso,
    terminalAnswerRowId, triggerWorkId, claimedEngineEvent,
    toolPhaseEndedBySpinBrake, counterparty, isA2ATurn, isEngineTurn, turnStartedAt,
    db,
  } = ctx;

  // Turns that threw before reaching this `finally` are closed by the runtime recovery site.
  try {
    // Answered means a genuine user-facing reply was delivered, as recorded at the delivery sites.
    const answerRow = terminalAnswerRowId ? { id: terminalAnswerRowId } : undefined;
    // The deliveries row proving it left; logged beside the key so a missing receipt is visible.
    const terminalDeliveryId = answerRow
      ? terminalDeliveryForTurn(agentId, turnNumber, turnCtx.root?.conversationId ?? null)
      : null;
    // Parked: the trigger ask has a join. Read once so the exit reason and disposition cannot disagree.
    const delegatedThisTurn = triggerWorkId ? joinState(triggerWorkId) !== null : false;
    const parkedRow = !answerRow && delegatedThisTurn ? { parked: 1 } : undefined;
    // A handoff wrote to the a2a lane; inbound peer rows (role='user') are not a handoff.
    const handoffRow = !answerRow && !parkedRow ? db.prepare(
      `SELECT 1 FROM messages WHERE agent_id = ? AND turn_number = ? AND lane = 'a2a'
          AND role IN ('assistant','tool') LIMIT 1`,
    ).get(agentId, turnNumber) : undefined;
    // ORDER IS THE GUARD (coerced-reply-not-a-delivery.test.ts): `brake` and the engine's own cut come
    // before `answerRow` because they are why the turn ended (delivery is the separate `answered` column);
    // `identical_call` is last since it is not the ending event. Meanings: work/exit-attribution.ts.
    const exitReason: TurnExitReason = toolPhaseEndedBySpinBrake ? 'brake'
      : state.engineCutExit ? state.engineCutExit
      : answerRow ? 'answered'
      : parkedRow ? 'park'
      : handoffRow ? 'handoff'
      : state.identicalCallRefusedThisTurn ? 'identical_call'
      : 'no_reply_intended';
    const outcome = exitReason;
    if (answerRow && !terminalDeliveryId) {
      logger.warn('v2: the turn recorded an ANSWER with no delivery receipt behind it — the answered edge has only one of its two halves for this turn', {
        agentId, turnNumber, answerMessageId: answerRow.id, exitReason,
      }, agentId);
    }
    finalizeTurn(
      agentId, turnNumber, exitReason, answerRow !== undefined, answerRow?.id ?? null,
      // Persisted: the claim may be reverted only with no answer and zero non-idempotent calls.
      state.nonIdempotentCallsThisTurn,
    );
    // Work-classified but nothing effectful: the pause side does not park its work on the owner
    // (a misclassification only leaves a task unpaused).
    const startLineOnly = turnCtx.inboundClassifiedAsWork && state.nonIdempotentCallsThisTurn === 0;
    // `claimed_by_turn` is NULLed when an answered ask leaves `claimed` mid-turn; claim_turn is the record.
    const triggerAsk = triggerWorkId
      ? db.prepare('SELECT kind, requester FROM work WHERE id = ?').get(triggerWorkId) as
        { kind: string; requester: string } | undefined
      : undefined;
    const triggerAskClaimingTurn = triggerWorkId ? claimingTurnOf(triggerWorkId) : null;
    // How the turn ended, as the exit table reads it (`work/exit-attribution.ts`); the asks and the event share it.
    const turnEnd: TurnEnd = {
      retryAt: turnCtx.retryAt, paidBeforeLimit: turnCtx.retryAt !== null && state.loopCount > 1,
      parkedTheJob: turnParkedTheJob(agentId),
    };
    // The engine queued this turn's own continuation, so settlement does not take its opening line as
    // the answer. Same expression as queuedOwnContinuation below.
    const continuing = turnEnd.parkedTheJob || (!isStopFenced(agentId) && continuationContext.has(agentId));
    // Settle every ask this turn claimed or assembled (work/ask-settlement.ts). Must precede the answer
    // stamp below, which keys on the served_by_turn the settlement writes.
    try {
      const assembled = (chosenConvKey && chosenConversationId && lastAssembledAtIso)
        ? assembledContextAsks(agentId, chosenConvKey, lastAssembledAtIso)
        : [];
      const askedNothing = triggerWorkId && await inboundAsksNothing(turnCtx) ? triggerWorkId : null;
      settleAsksAtTurnFinalize({ agentId, turnNumber, assembled, continuing, askedNothing, ...turnEnd });
    } catch (err) {
      logger.warn('v2: the turn-finalize ask adjudication FAILED — an owner ask may be left mid-flight', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    const cause = handBackCauseOf(exitReason, turnEnd);
    // Another agent's request this turn served is marked served here, and only here. When the provider's limit
    // met the turn's first call, nothing was served: its serve is given back and it waits for the reset.
    const request = turnCtx.servedRequest;
    if (request && cause === 'wait') serveLater({ kind: 'row', agentId, rowid: request.rowid, attempts: request.attempts }, turnCtx.retryAt, 'the provider asked to wait; the request is served at its reset');
    else if (request) markServedByRowid(request.rowid, turnNumber);
    // The engine event this turn claimed: swept on Stop; released after an abort or a counted cut that made no
    // side effect, to wait for the provider's reset when the limit met the first call; otherwise it stays served.
    if (claimedEngineEvent) {
      try {
        const { rowid } = claimedEngineEvent;
        if (exitReason === 'stop') {
          sweepByRowid({ rowid, agentId });
        } else if ((turnCtx.abortHandBack || cause === 'cut') && state.nonIdempotentCallsThisTurn === 0
            && releaseEngineEventByRowid({ rowid, agentId, turnNumber: claimedEngineEvent.turnNumber }) > 0) {
          if (cause === 'wait') serveLater({ kind: 'row', agentId, rowid }, turnCtx.retryAt, 'the provider asked to wait; the event is served at its reset');
          else recordEngineEventDeliveryFailure(agentId, rowid, turnCtx.retryAt);
        }
      } catch (err) {
        logger.warn('v2: the engine event hand-back at finalize failed; the event stays served', {
          agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    // Closeout: warn when an unanswered turn leaves work claimed, and hand work back to the owner when a
    // user turn talked but did not act. Records only, no prose; the rules live in answered-edge.ts.
    try {
      const claimedAtTurnEnd = stillClaimedWork(agentId, { turnNumber });
      if (claimedAtTurnEnd.length > 0 && !answerRow) {
        logger.warn('v2 closeout miss: the turn ended without delivering, and work is still claimed', {
          agentId, turnNumber, exitReason,
          claimed: claimedAtTurnEnd.map((w) => ({ id: w.workId, kind: w.kind, conversation: w.conversationId })),
        }, agentId);
      }
      if (counterparty.kind === 'user' && !isA2ATurn && !isEngineTurn) {
        pauseDriveWorkWaitingOnOwner(agentId, turnNumber, {
          transitionedThisTurn: state.trackerStatusUpdatedThisTurn,
          conversationId: turnCtx.root?.conversationId ?? null,
          // A delegating turn waits on the delegated pieces, not on the owner.
          delegatedThisTurn,
          startLineOnly,
          trackerWriteThisTurn: state.trackerWriteThisTurn,
          servedSourceMessageId: turnCtx.root?.sourceMessageId ?? null,
          queuedOwnContinuation: continuing,
          // Only work this turn touched; untouched backlog belongs to the poke ladder.
          touchedSince: turnStartedAt,
        });
      }
    } catch (err) {
      logger.warn('v2: turn-end obligation disposition failed (non-fatal)', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Answered and delivered: clear this conversation's untracked-work debt; a turn that did not keeps it.
    if (answerRow && terminalDeliveryId && chosenConvKey) {
      try {
        clearUntrackedWorkAcrossTurnsForConversation(agentId, chosenConvKey);
      } catch { /* in-memory map; best effort like the rest of this arm */ }
    }
    // Audit: an ack owed and never delivered, logged plus a marker on the trigger ask. Gated on a tool
    // having started (the start-ack's own work condition), or every quick chat reply would count.
    if ((turnCtx.startAckSteerRequested || turnCtx.startAckSteerArmedThisTurn)
        && !turnCtx.engineStartAckDeliveredThisTurn && turnCtx.anyToolStartedThisTurn) {
      const owedVia = turnCtx.startAckSteerArmedThisTurn ? 'steer-armed' : 'threshold-owed';
      const channel = counterparty.kind === 'user' ? counterparty.channel : null;
      logger.warn('v2: the turn ended owing this person an acknowledgment and never delivered one — they waited and heard nothing from the agent until (if ever) the answer', {
        agentId, turnNumber, owedVia, channel, exitReason,
        answered: answerRow !== undefined, steersInjected: turnCtx.startAckSteersInjected,
        askId: triggerWorkId,
      }, agentId);
      if (triggerWorkId) {
        try {
          appendWorkEvent(triggerWorkId, 'audit', 'start-ack', {
            marker: 'start_ack_owed_undelivered',
            turn_number: turnNumber, owed_via: owedVia, channel,
            exit_reason: exitReason, answered: answerRow !== undefined,
            steers_injected: turnCtx.startAckSteersInjected,
            reason: 'the start-ack threshold passed with nothing heard, and the turn ended '
              + 'without the agent ever addressing the person. Recorded here so this class '
              + 'is countable instead of invisible.',
          });
        } catch { /* best effort, like every arm of this boundary */ }
      }
    }
    // Audit only (steers and blocks nothing): a fresh owner ask answered with zero tool calls. Clauses are
    // records, never the ask's text, so plain chat counts too and the count is an upper bound.
    if (triggerWorkId && triggerAsk?.kind === 'ask' && triggerAsk.requester === 'owner'
        && triggerAskClaimingTurn === turnNumber
        && counterparty.kind === 'user' && !isA2ATurn && !isEngineTurn
        && !turnCtx.anyToolStartedThisTurn && state.toolCallsExecutedThisTurn === 0
        && answerRow !== undefined) {
      logger.info('v2: a fresh owner ask was answered with nothing consulted — the agent made no tool call this turn (T61 measurement marker; not a fault, not a block)', {
        agentId, turnNumber, askId: triggerWorkId,
        channel: counterparty.channel ?? null, exitReason,
        deliveredReceipt: terminalDeliveryId !== null,
        recallLaneReached: state.recallLaneReachedModelThisTurn,
      }, agentId);
      try {
        appendWorkEvent(triggerWorkId, 'audit', 'unsourced-specifics', {
          marker: 'answered_with_no_sources_consulted',
          turn_number: turnNumber,
          channel: counterparty.channel ?? null,
          exit_reason: exitReason,
          delivered_receipt: terminalDeliveryId !== null,
          // The engine's unasked recall push, recorded rather than counted as consulting.
          recall_lane_reached: state.recallLaneReachedModelThisTurn,
          reason: 'this turn answered a fresh owner ask having made no tool call at all, so '
            + "every specific in the reply came from the model's own weights or from whatever "
            + 'the engine pushed at it unasked. Recorded so the class is countable instead of '
            + 'invisible; it is a measurement, not a fault — the answer may well be correct.',
        });
      } catch { /* best effort, like every arm of this boundary */ }
    }
    // Audit: steers filed this turn that never reached the model; only the boundary sees pending-at-end.
    const steerQueue = state.steerQueue;
    const deliveredSeqs = new Set(steerQueue.delivered.map((e) => e.seq));
    const undelivered = steerQueue.fired.filter((e) => !deliveredSeqs.has(e.seq));
    if (undelivered.length > 0) {
      // The abandoned copy carries the attempt count; the fired copy is the entry as written.
      const abandonedBySeq = new Map(steerQueue.abandoned.map((e) => [e.seq, e]));
      const steers = undelivered.map((e) => ({
        floor: e.floor,
        priority: e.priority,
        at_loop: e.atLoop,
        attempts: abandonedBySeq.get(e.seq)?.attempts ?? e.attempts,
        how: abandonedBySeq.has(e.seq) ? 'abandoned' : 'pending-at-turn-end',
      }));
      logger.warn('v2: steers were written this turn and never reached the model — the queue held them, the turn ran out of model calls or gave up, and nobody would have been able to count this', {
        agentId, turnNumber, exitReason, undelivered: undelivered.length,
        delivered: steerQueue.delivered.length, steers, askId: triggerWorkId,
      }, agentId);
      if (triggerWorkId) {
        try {
          appendWorkEvent(triggerWorkId, 'audit', 'steer-queue', {
            marker: 'steer_written_never_delivered',
            turn_number: turnNumber, exit_reason: exitReason,
            undelivered: undelivered.length, delivered: steerQueue.delivered.length,
            steers,
            reason: 'these engine steers were filed this turn and confirmed in no model '
              + 'request. HL3 records every injection; this is its mirror, so the class is '
              + 'countable instead of invisible.',
          });
        } catch { /* best effort, like every arm of this boundary */ }
      }
    }
    // The one task-stamping point: what the engine observed goes onto every task this root touched.
    try {
      const { stampTasksAtTurnFinalize } = await import('../../../../tracker/task-stamps.js');
      const stampRoot = turnCtx.root;
      stampTasksAtTurnFinalize({
        agentId, turnNumber, outcome,
        answerMessageId: answerRow?.id ?? null,
        rootSourceMessageId: stampRoot?.sourceMessageId ?? null,
        convKey: chosenConvKey ?? null,
        servedTaskId: turnCtx.servedWork?.taskId ?? null,
      });
    } catch (err) {
      logger.warn('v2: ticket stamps at turn finalize failed (non-fatal, the turn record is already written)', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Engine hand-in for a task opened and delivered this turn that it can count as finished (a charged
    // file, or its measure at 0): delivered work is never steered back to the model.
    if (answerRow && terminalDeliveryForTurn(agentId, turnNumber)) {
      try {
        const { engineHandIn } = await import('../../../../work/done/hand-in.js');
        const { engineProof } = await import('../../../../work/done/proof.js');
        const sameTurnOpen = db.prepare(
          `SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.origin_turn = ? AND w.state = 'claimed' AND w.is_paused = 0`,
        ).all(agentId, turnNumber) as Array<{ id: string }>;
        for (const t of sameTurnOpen) {
          const counted = engineProof(t.id).map(({ kind, ref }) => ({ kind, ref }));
          if (counted.length > 0) engineHandIn(t.id, `turn ${turnNumber} opened this task and delivered it`, { outcome: 'finished', items: counted });
        }
      } catch { /* best effort; the ladder remains the backup */ }
    }
    // Per-ask outcome: every row this turn served records the reply that answered it.
    if (answerRow) {
      setAnswerMessageId({ agentId, servedByTurn: turnNumber, answerMessageId: answerRow.id });
    }
  } catch { /* best effort, turn teardown must not throw */ }
}
