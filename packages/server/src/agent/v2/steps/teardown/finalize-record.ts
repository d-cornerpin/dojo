// ════════════════════════════════════════
// PHASE-6 T9b — teardown, part 2 of 3: THE TURN RECORD.
//
// The P4 turn-record finalize and everything that hangs off it — the closeout
// disposition, the ONE ticket-stamping point, the strike-0 receipt close, the
// phone reply binding and the per-ask answer stamp. Relocated verbatim from
// `agent/v2/loop.ts` (`:9438`–`:9618` at `1cbe8bb`).
//
// ⚠ THIS FILE IS WHERE T13's "PER-TURN TRANSITION RECORD" ACTUALLY LIVES, and
// it is the honest half of this tranche's `TurnPhase` answer. `finalizeTurn`
// writes `turns.exit_reason` and `turns.answered`; the closeout enumeration and
// the waiting-on-owner disposition READ them one statement later. That is a
// recorded transition with a decision reading it — R-0's finding, paid at
// PHASE-2 T6. What is still NOT true is that anything but the loop head reads
// `state.phase`; see the entry point's header.
//
// The exit-reason ternary's ORDER is the guard, not a style: `brake` is tested
// BEFORE `answerRow`, so a braked turn that also persisted text never reads as
// 'answered' (d54cd1f's class). `tracker/__tests__/coerced-reply-not-a-delivery.test.ts`
// asserts it, and its scan follows the code here.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { setAnswerMessageId } from '../../../../memory/message-store.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { setTrackerStatus, patchWork } from '../../../../work/tracker-store.js';
import { joinState, noteUnsettled } from '../../../../work/store.js';
import { settleAsksAtTurnFinalize } from '../../../../work/ask-settlement.js';
import { assembledContextAsks } from '../../counterparty.js';
import {
  pauseDriveWorkWaitingOnOwner, stillClaimedWork, terminalDeliveryForTurn,
} from '../../answered-edge.js';
import { finalizeTurn, type TurnExitReason } from '../../turn-record.js';
import type { AgentTurnState } from '../../state.js';
import type { TeardownContext } from './index.js';

const logger = createLogger('v2-loop');

export async function finalizeTurnRecord(
  state: AgentTurnState,
  ctx: TeardownContext,
): Promise<void> {
  const {
    agentId, turnCtx, turnNumber, chosenConvKey, chosenConversationId, lastAssembledAtIso,
    terminalAnswerRowId, triggerWorkId,
    toolPhaseEndedBySpinBrake, counterparty, isA2ATurn, isEngineTurn, turnStartedAt,
    inboundChannel, inboundContext, db,
  } = ctx;

  // ── P4 turn record finalize: how this turn ENDED, on every exit path ──
  // Outcome from durable facts + turn-local flags; answer id = this turn's
  // plain assistant reply row. The runtime recovery site covers turns that
  // threw before reaching this finally (outcome='error').
  try {
    // Truthful answer key (2026-07-22): outcome='answered' means a genuine
    // user-facing reply was DELIVERED this turn, recorded at the delivery
    // sites themselves. The old SELECT here counted ANY non-JSON assistant
    // text (mid-turn captions, narration), which marked silent-ending turns
    // answered: asks got stamped, the completion ack stood down (the
    // silent-completion defect), and ticket stamps inflated.
    const answerRow = terminalAnswerRowId ? { id: terminalAnswerRowId } : undefined;
    // 1g: the RECEIPT the key points at. `terminalAnswerRowId` names the message row;
    // `terminalDeliveryForTurn` names the `deliveries` row that proves it left the
    // building — `result_delivery_id`, the thing the key was an embryo of. Recorded on
    // the finalize log so the two halves of the answered edge are readable together,
    // and a missing receipt beside a set key is a visible fact rather than a silence.
    const terminalDeliveryId = answerRow
      ? terminalDeliveryForTurn(agentId, turnNumber, turnCtx.root?.conversationId ?? null)
      : null;
    // PHASE-2 T4: "did this turn park?" was a LIKE over a conv_key namespace, which is why
    // it had to be time-bounded and could match another turn's park. The same fact is now a
    // row: the trigger's own ticket has a join under it. `exitReason` semantics unchanged.
    // SWEEP-A TB2: the same ROW fact the disposition below needs — "did this turn delegate
    // the ask it was serving?" — read once and used twice, so the exit reason and the
    // waiting-on-owner disposition can never disagree about it.
    const delegatedThisTurn = triggerWorkId ? joinState(triggerWorkId) !== null : false;
    const parkedRow = !answerRow && delegatedThisTurn ? { parked: 1 } : undefined;
    // T6: "did this turn hand off to a peer instead of answering?" was a probe of the
    // second physical table — being IN that table WAS the handoff signal. The equivalent
    // fact on one table is the a2a lane, and it must exclude this agent's inbound peer
    // traffic (role='user'), which was never in the probe's reach either.
    const handoffRow = !answerRow && !parkedRow ? db.prepare(
      `SELECT 1 FROM messages WHERE agent_id = ? AND turn_number = ? AND lane = 'a2a'
          AND role IN ('assistant','tool') LIMIT 1`,
    ).get(agentId, turnNumber) : undefined;
    // PHASE-2 T2: the ONE column that meant two things is now two columns that each mean
    // one. `exitReason` is why the turn ended (17-value enum, CHECKed in the DB);
    // `answered` is whether a genuine user-facing reply was DELIVERED — the truthful-answer
    // key, which is `terminalAnswerRowId` and nothing else. A turn can end 'brake' having
    // answered, and that pair is now representable instead of being flattened to one word.
    const exitReason: TurnExitReason = toolPhaseEndedBySpinBrake ? 'brake'
      : answerRow ? 'answered'
      : parkedRow ? 'park'
      : handoffRow ? 'handoff'
      : 'no_reply_intended';
    const outcome = exitReason;
    if (answerRow && !terminalDeliveryId) {
      logger.warn('v2: the turn recorded an ANSWER with no delivery receipt behind it — the answered edge has only one of its two halves for this turn', {
        agentId, turnNumber, answerMessageId: answerRow.id, exitReason,
      }, agentId);
    }
    finalizeTurn(
      agentId, turnNumber, exitReason, answerRow !== undefined, answerRow?.id ?? null,
      // P3/P6b's counted input, persisted instead of inferred: the claim may be reverted
      // only when the turn produced no answer AND executed zero non-idempotent calls.
      state.nonIdempotentCallsThisTurn,
    );
    // ── SWEEP-A TB1 — THE FINAL ADJUDICATOR OF EVERY OWNER ASK THIS TURN TOUCHED ──
    //
    // Invocation (b) of the settlement authority (`work/ask-settlement.ts`), and the moment
    // the structural invariant is made true: NO ASK REMAINS `claimed` BY A FINALIZED TURN.
    // Its subject is every ask the turn CLAIMED plus every ask that entered its ASSEMBLED
    // CONTEXT — the set the F9 batch-claim used to write to, now read and handed over. Each
    // one is closed against the delivery that answered it, HELD when delegated work is still
    // outstanding, or handed back `open` because the person is still waiting.
    //
    // IT RUNS HERE, BEFORE THE ANSWER STAMP BELOW, and the order is load-bearing:
    // `setAnswerMessageId` keys on `served_by_turn`, and the settlement is what writes that
    // column for the assembled rows. Adjudicating afterwards would leave those asks with a
    // receipt on the ticket and no answer stamp on the message.
    //
    // Best-effort like everything else on this arm — the turn record is already written — but
    // LOUD: a failure here is a person's ask left in whatever state the turn abandoned it in.
    try {
      const assembled = (chosenConvKey && chosenConversationId && lastAssembledAtIso)
        ? assembledContextAsks(agentId, chosenConvKey, lastAssembledAtIso)
        : [];
      settleAsksAtTurnFinalize({ agentId, turnNumber, assembled });
    } catch (err) {
      logger.warn('v2: the turn-finalize ask adjudication FAILED — an owner ask may be left mid-flight', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // ── PHASE-2 T6 (C3) — THE TURN RECORD'S FIRST READER, AND THE DISPOSITION ──
    // R-0's finding paid: `finalizeTurn` has always written the true outcome and nothing
    // read it. Read here, one statement after it is written. 1c enumerates what is still
    // claimed (with the identity to escalate); the disposition hands the ball back to the
    // owner when this turn TALKED and did not ACT. Every input is a record and no prose is
    // read — the argument, the four keys and the P2 reconciliation are in answered-edge.ts.
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
          // A turn that delegated did not hand the ball back to the owner; the work is
          // waiting on the delegated pieces. See the refusal in `answered-edge.ts`.
          delegatedThisTurn,
          // SCOPE: only work THIS TURN touched. A backlog item nobody moved belongs to
          // the poke ladder ("an in_progress task does not EVER just get ignored"), and
          // this window is what keeps the disposition from ever reaching it.
          touchedSince: turnStartedAt,
        });
      }
    } catch (err) {
      logger.warn('v2: turn-end obligation disposition failed (non-fatal)', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Ticket stamps (owner design 2026-07-22): the ONE stamping point. The
    // engine writes what it observed onto every ticket this turn's root
    // touches, so the model reads state instead of guessing it.
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
      // PHASE-6 T1: was a BARE `catch {}`. The call used to be handed two nulls, so it
      // had nothing to fail at; it does real work now. Best-effort decides whether to
      // CONTINUE, never whether to be findable.
      logger.warn('v2: ticket stamps at turn finalize failed (non-fatal, the turn record is already written)', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Strike-0 receipt close (2026-07-22, the boundary wrap-up in its final
    // form): a task CREATED THIS TURN whose turn is ending answered with a
    // TANGIBLE delivery on record is finished work whose bookkeeping the
    // model forgot; the no-re-prompt rule (v3.1.10) forbids steering it
    // back, so the ENGINE does the mechanical close right here with the
    // receipt basis, exactly the strike-2 close without the wait. Scope is
    // deliberately narrow: origin_turn = THIS turn only (multi-turn tasks
    // ride the ladder), answered outcome, recorded handover, still open.
    // complete_validated stays 0: the validation key still turns.
    if (answerRow) {
      try {
        const { composeTurnDeliverySummary } = await import('../../../../tracker/task-stamps.js');
        const strike0Summary = composeTurnDeliverySummary(agentId, turnNumber);
        if (strike0Summary.length > 0) {
          const sameTurnOpen = db.prepare(
            `SELECT w.id AS id, w.title AS title FROM work w
              WHERE ${taskScope('w')} AND w.agent_id = ? AND w.origin_turn = ?
                AND w.state = 'claimed' AND w.is_paused = 0`,
          ).all(agentId, turnNumber) as Array<{ id: string; title: string }>;
          // The receipt this close is made of — the same delivery `composeTurnDeliverySummary`
          // just described — is what G7 requires, so the engine's strike-0 close points at
          // the thing the person actually received.
          const strike0Delivery = terminalDeliveryForTurn(agentId, turnNumber);
          for (const t of sameTurnOpen) {
            const r0 = setTrackerStatus(t.id, 'complete', {
              by: strike0Delivery ? 'engine' : 'agent', actorId: agentId,
              evidenceRef: strike0Delivery,
              resultDeliveryId: strike0Delivery,
              expectedState: 'claimed',
              reason: 'delivery-receipt close (strike 0, same-turn boundary)',
            });
            if (r0.kind !== 'applied') {
              logger.warn('strike-0 receipt close refused by the work gate', { taskId: t.id, result: r0 }, agentId);
              continue;
            }
            // `result` only when the row does not already carry one — the old statement's
            // COALESCE(NULLIF(result, ''), ?), kept as a read-then-patch because the patch
            // API takes values, not expressions.
            const cur = db.prepare('SELECT result FROM work WHERE id = ?').get(t.id) as { result: string | null } | undefined;
            if (!cur?.result) {
              noteUnsettled(patchWork(t.id, { result: `Delivered (engine-recorded at the turn boundary): ${strike0Summary}` }), 'engine: strike-0 delivery recorded at the turn boundary', { taskId: t.id });
            }
            void import('../../../../tracker/task-log.js').then(({ writeTaskLog }) => writeTaskLog({
              taskId: t.id,
              fromEntity: 'engine',
              entryKind: 'observation',
              fromStatus: 'in_progress',
              toStatus: 'complete',
              actionTaken: 'delivery-receipt close (strike 0, same-turn boundary)',
              reason: `turn ${turnNumber} created this task, answered, and delivered (${strike0Summary}); closed at the boundary on the engine's own receipts`,
            }));
            logger.info('strike-0 receipt close: same-turn task closed at the boundary on delivery receipts', {
              agentId, turnNumber, taskId: t.id, title: t.title.slice(0, 80),
            }, agentId);
          }
        }
      } catch { /* best effort; the ladder remains the backup */ }
    }
    // P8 reply binding for the PHONE lane, riding the P4 answer stamp: the
    // spoken reply row is bound by id to its voice session with speaker
    // 'agent' (the dashboard-voice equivalent happens at the TTS burst's
    // markAssistantMessageVoiced; a call has no burst-side message hook, so
    // the finalize stamp is its binding point).
    if (answerRow && inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
      try {
        const { getVoiceSessionIdForCall, stampSpokenMessage } = await import('../../../../voice/session-record.js');
        stampSpokenMessage(answerRow.id, 'agent', getVoiceSessionIdForCall(inboundContext.phoneCallSid));
      } catch { /* best effort */ }
    }
    // Per-ask outcome: every row this turn served records the reply that answered
    // it (sibling rows were stamped served_by_turn by the settlement authority above, as
    // part of closing them — see the adjudication block and its ordering note).
    // T6: one call — this was two, once per physical store.
    if (answerRow) {
      setAnswerMessageId({ agentId, servedByTurn: turnNumber, answerMessageId: answerRow.id });
    }
  } catch { /* best effort, turn teardown must not throw */ }
}
