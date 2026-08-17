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
import { clearUntrackedWorkAcrossTurnsForConversation } from '../../../turn-state.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { setTrackerStatus, patchWork } from '../../../../work/tracker-store.js';
import { appendWorkEvent, claimingTurnOf, joinState, noteUnsettled } from '../../../../work/store.js';
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
    // ── UX-REPAIR ROUND 13 T61(b), READ 1 of 2 — THE TRIGGER ASK ──
    // Two columns and no judgment, for the marker below.
    //
    // ⚠ T64 — `claimed_by_turn` IS NOT READ HERE, AND THAT WAS THE OTHER HALF OF THE ZERO.
    // The original read took the column from this row and placed itself one statement above
    // `settleAsksAtTurnFinalize` to beat the NULLing that authority does. It was beaten
    // already: `transition()` NULLs the column on EVERY move out of `claimed`, and an
    // ordinary answered ask takes `claimed -> done` MID-TURN, the moment its reply is
    // delivered — long before teardown. Driven at HEAD (W47, 2026-08-17, probe on t4996):
    // `claimedByTurn: null` against `turnNumber: 4996`, on the exact shape the marker is for.
    // The freshness clause therefore failed on every turn that ever ran, alongside the recall
    // clause below — two independent zeroes, either one of them fatal.
    // The immutable record is the `claim_turn` EVENT, and `store.ts`'s `claimingTurnOf` is its
    // one reader (two other modules had already discovered the same thing and each kept a
    // private copy of that SELECT; there is now one).
    const triggerAsk = triggerWorkId
      ? db.prepare('SELECT kind, requester FROM work WHERE id = ?').get(triggerWorkId) as
        { kind: string; requester: string } | undefined
      : undefined;
    const triggerAskClaimingTurn = triggerWorkId ? claimingTurnOf(triggerWorkId) : null;
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
    // ── UX-REPAIR T1 — AN ANSWERED, DELIVERED TURN PAYS OFF ITS UNTRACKED-WORK DEBT ──
    //
    // The >=6 engine floor keys on the CROSS-TURN untracked-work total (RC-19 item 3), whose
    // only clears were a tracker write, a new session, and the floor's own firing. None of
    // them is "the turn ended and the person got their answer", so finished, delivered work
    // stayed on the ledger forever and the 6th call opened a phantom task on whatever trivial
    // turn came next. Measured: 10 of 35 firings in the current design era reported a
    // per-turn count BELOW the threshold, which is only reachable via inherited debt.
    //
    // RC-19'S REQUIREMENT SURVIVES VERBATIM. Its subject is a turn BREAK — the A2A dodge that
    // exits WITHOUT answering — and this clear cannot reach that shape, because it demands
    // BOTH halves of the answered edge: the truthful-answer key AND the delivery receipt that
    // proves the reply left the building. A turn that talked and delivered nothing keeps its
    // debt; a turn that broke early to a peer keeps its debt.
    //
    // Two RECORDS and no prose, the same doctrine as the disposition above. Scoped to the
    // conversation that was answered (`answered-edge.ts`'s own narrowing: an email to a third
    // party is not the owner's answer), so a different conversation's running total is left
    // exactly where it was.
    if (answerRow && terminalDeliveryId && chosenConvKey) {
      try {
        clearUntrackedWorkAcrossTurnsForConversation(agentId, chosenConvKey);
      } catch { /* in-memory map; best effort like the rest of this arm */ }
    }
    // ── UX-REPAIR T41 (the observability rider) — "THE PERSON WAITED AND HEARD NOTHING" ──
    //
    // The mechanism could not report its own failure. "Threshold passed" and "steer injected"
    // are logged; a turn ENDING with the ack still owed and undelivered — the owner's
    // 2026-08-12 incident — wrote nothing, so three minutes of dead air on his phone was
    // diagnosable only from his pasted transcript and countable by nobody.
    //
    // Asked of flags that already carry it and nothing else: the ack was OWED (threshold
    // passed with nothing heard, or a steer armed for it), never DELIVERED, and the turn was
    // WORK — `anyToolStartedThisTurn` is the F10 gate's own condition ("the ack exists for
    // WORK, not conversation", `preflight/start-ack.ts`), reused rather than re-invented.
    // Without that third clause every quick chat reply on a routed channel counts, because
    // T41's door arms before anyone can know whether the turn will use tools: driven
    // 2026-08-13, "Hey dude!" answered in 3.0 s wrote a row saying the person heard nothing.
    //
    // The durable half rides the person's own ask as an `audit` MARKER — the shape
    // `work/ask-settlement.ts` already uses for machine-readable observations, so no new event
    // kind, table or migration. A turn with no ask keeps the log line alone, inventing no row.
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
    // ── UX-REPAIR ROUND 13 T61(b) — "ANSWERED WITH NOTHING CONSULTED" BECOMES COUNTABLE ──
    //
    // Round-13 S1: a fresh owner ask answered in 5.2 seconds with ZERO tool calls, seven
    // factual specifics in the reply (elevation, two distances, a pass requirement, a land
    // manager, $30/year, $10/day) and — recorder-proven across `messages`, `summaries`,
    // `vault_entries`, `briefings` and every uploaded file — no source for any of them
    // anywhere on the box. The turn's own reasoning hedged wider than the reply did and the
    // two prices appear in neither the reasoning nor any source.
    //
    // T61(a) is the conduct sentence, and the plan records honestly that it is the WEAK
    // surface. THIS is the half that survives being ignored: the class becomes COUNTABLE, so
    // a later round measures whether it persists instead of re-discovering it from a
    // transcript. It STEERS NOTHING AND BLOCKS NOTHING — no refusal, no re-prompt, no
    // change to what the model receives or what the person gets. Measurement only.
    //
    // THE SIGNATURE IS STRUCTURAL, EVERY CLAUSE A RECORD, and it must be: classifying "this
    // ask needed sources" from the ask's text is the standing prose ban, so the engine counts
    // shapes and never judges content.
    //   1. an OWNER ASK on a person's turn — `kind='ask'`, `requester='owner'`, a `user`
    //      counterparty, not a2a and not an engine wake;
    //   2. FRESH — the ask's `claim_turn` event names THIS turn, i.e. this turn is the one
    //      that picked the ask up. A redrive of somebody else's ask is a different animal and
    //      is not counted;
    //   3. ZERO TOOL ROWS — the F10 first-tool latch never flipped AND the executed-call
    //      count is 0. Both, because they are written by different spans and a marker that
    //      disagreed with either would be measuring its own bookkeeping;
    //   4. ANSWERED — the truthful-answer key, so a silent turn is never counted.
    // Together: the person asked something new, the agent consulted nothing at all, and
    // answered. Whether the answer was RIGHT is not knowable here and is not claimed.
    //
    // ── UX-REPAIR ROUND 14 / T64 — THE FIFTH CLAUSE IS GONE, AND WHY ─────────────────────
    // This counter wrote ZERO ROWS EVER, round-14 S1 included — the exact shape it was built
    // for. The clause that killed it read `!state.recallLaneReachedModelThisTurn` ("no
    // recalled memory reached the model"), and the defect is a MISATTRIBUTION, not a
    // threshold: `msg.relevant-memory` is an UNCONDITIONAL ENGINE PUSH. Nothing consults it.
    // It is retrieved against a 500-char blob of the recent human rows and injected on every
    // counterparty (`steps/call-llm/pre-call-injections.ts`, the recall-lane block), so "the
    // lane reached the model" is very nearly a constant — and the clause vetoed the marker on
    // the ENGINE'S act while claiming to measure the AGENT'S.
    //
    // DRIVEN AT HEAD (W47, 2026-08-17, dev box, receipts on for the drive): t4992 "what year
    // did the Alaskan Way Viaduct come down…" and t4993 "how tall is the Space Needle…" —
    // both `kind='user'`, `exit_reason='answered'`, `effectful_calls=0`, each on a fresh owner
    // ask claimed by that very turn. Zero markers. Both iterations of both turns carried
    // `msg.relevant-memory` ADMITTED at 725 tokens, and in `full` mode its body was three of
    // the agent's OWN previously-answered questions plus four vault notes — an airport parking
    // spot, a gym locker code, a phrase to remember, a hosting decision — and the obligations
    // snapshot. None of it could be the source of the Space Needle's height, and the engine
    // MAY NOT read prose to say so (the standing ban), which is exactly why no narrower
    // version of this clause is honest either.
    //
    // So the agent's own consulting is its TOOL CALLS — clause 3, already exact — and the
    // engine's push becomes a PAYLOAD FIELD (`recall_lane_reached`) instead of a veto: the
    // fact stays countable and sliceable by a later round, which is this marker's whole
    // charter, rather than silently holding the class at zero. Nothing else moves: no steer,
    // no block, no change to what the model receives or what the person gets.
    //
    // ⚠ HONEST BOUND, MEASURED THE HOUR THIS LANDED. The class now includes ORDINARY CHAT:
    // driven t4998, "Quick one — say hi.", wrote a marker, because a greeting answered with no
    // tool call has exactly this shape. Telling a greeting from a factual ask means reading the
    // ask, which is the standing prose ban, and no length or word threshold would be anything
    // but invented (#14). So the count is an UPPER BOUND on the unsourced-specifics class and
    // must be read as one; the reply text sits on the answer row for a human to slice by hand.
    // The T41 rider two blocks up faced the same problem from the other side and solved it with
    // `anyToolStartedThisTurn` — the discriminator this marker must have inverted, so it cannot
    // borrow the same escape.
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
          // T64: the engine's own recall push, RECORDED rather than vetoed on. It is what the
          // engine placed in front of the model unasked, not something the agent consulted;
          // a later round can slice the class on it without this marker having to pretend it
          // knows whether the model used it.
          recall_lane_reached: state.recallLaneReachedModelThisTurn,
          reason: 'this turn answered a fresh owner ask having made no tool call at all, so '
            + "every specific in the reply came from the model's own weights or from whatever "
            + 'the engine pushed at it unasked. Recorded so the class is countable instead of '
            + 'invisible; it is a measurement, not a fault — the answer may well be correct.',
        });
      } catch { /* best effort, like every arm of this boundary */ }
    }
    // ── HL4 STEP 2 — "WRITTEN, NEVER SEEN BY THE MODEL" IS A FACT THE PLATFORM RECORDS ──
    //
    // W27's census, finding 4: *"`abandoned` has no reader. The queue records 'written,
    // never delivered' and nothing reads it. HL3 gave every steer a durable row at
    // INJECTION; non-delivery is still in-memory-only and dies with the turn state."*
    //
    // The queue has known the fact all along — `fired` minus `delivered` is exactly the
    // thing its own header says the single slot destroyed. What it never had was anywhere
    // to say it, so every hard investigation this month began by inferring from thinking
    // dumps which steers had actually landed. This is HL3's mirror, in the same shape as
    // the T41 rider immediately above: one WARN line, plus a durable `audit` marker on the
    // person's own ask when there is one. No new event kind, no table, no schema change,
    // and no second mechanism — this is a READER of state the queue already keeps.
    //
    // WHY THE BOUNDARY AND NOT THE DROP SITES. An entry leaves `pending` undelivered three
    // ways: the delivery-attempt cap abandons it, a give-up rung's family-scoped clear
    // abandons it, or the turn simply ends with it still waiting at the one-per-call drain
    // — and the third is the largest class and the one no drop site can observe. One reader
    // here catches all three and tells them apart; three readers at the drop sites would
    // catch two and be three copies of one sentence.
    const steerQueue = state.steerQueue;
    const deliveredSeqs = new Set(steerQueue.delivered.map((e) => e.seq));
    const undelivered = steerQueue.fired.filter((e) => !deliveredSeqs.has(e.seq));
    if (undelivered.length > 0) {
      // The abandoned COPY carries the attempt count (the `fired` copy is the entry as it
      // was written), so "how" and "attempts" are both read from wherever the truth is.
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
    // ── UX-REPAIR ROUND 4 T19 (D3) — THE DELIVER LADDER'S MISSING DRIVE TICK ──
    //
    // A scheduled run that owes a person a message is steered by the RETURN VALUE of the
    // model's own close attempt, so the ladder's count only ever moved when the model came
    // back to the tool. It counts DISTINCT TURNS — measured, and that rule stays — but a model
    // that stops calling the tool freezes it wherever it stands. The owner's box, 2026-08-10:
    // three steers, all inside turn 4602, ledger reading `1 of 3`, `2 of 3`, `2 of 3`. The
    // stand-down never ran, `RUN_STATUS_UNDELIVERED` was never written, and a generic idle
    // reaper closed the run thirty minutes later with a sentence about the AGENT.
    //
    // A rung is a DRIVE — "a separate attempt, with a turn in between for the agent to act on
    // the steer" — and a turn that ENDED having been told, and delivered nothing, IS that
    // attempt. So the boundary spends it. Every refusal that keeps it honest lives with the
    // authority (`work/occurrences.ts:advanceRunDeliverLadderAtTurnEnd`): an unsteered run
    // never burns, a delivered turn never burns, and a turn already on the ledger records
    // nothing. When the bound is reached the close goes through the ORDINARY run-complete
    // flow, so the stand-down, the UNDELIVERED word, the owner surface and the schedule
    // advance are the same ones every other close produces.
    //
    // It runs HERE, after `finalizeTurn`, because the delivery receipts this reads are written
    // by the finalize step that has already run — the turn boundary is where a fact about a
    // turn becomes readable (CT0's doctrine, carried).
    if (turnCtx.root?.kind === 'occurrence') {
      try {
        const occurrenceId = turnCtx.root.id;
        const { advanceRunDeliverLadderAtTurnEnd } = await import('../../../../work/occurrences.js');
        const ladder = advanceRunDeliverLadderAtTurnEnd(occurrenceId, turnNumber);
        if (ladder.spent) {
          logger.info('v2: a run that owed a message ended a turn with nothing delivered; the deliver ladder spent a drive at the boundary', {
            agentId, turnNumber, occurrenceId, standDownDue: ladder.standDownDue,
          }, agentId);
        }
        if (ladder.standDownDue && ladder.taskId) {
          const { onTaskRunComplete } = await import('../../../../scheduler/runner.js');
          await onTaskRunComplete(
            ladder.taskId, 'complete',
            'the deliver ladder was spent across separate turns and nothing reached the person',
          );
        }
      } catch (err) {
        logger.warn('v2: the run-deliver ladder\'s turn-boundary advance failed (non-fatal)', {
          agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
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
        const { composeTurnDeliverySummary, isTangibleDeliverySummary } = await import('../../../../tracker/task-stamps.js');
        const strike0Summary = composeTurnDeliverySummary(agentId, turnNumber);
        // T19 (D7): "a TANGIBLE delivery on record" is asked of the ONE helper. The summary
        // now also NAMES a dashboard-only bubble (so the model's state line stops lying), and
        // that is deliberately NOT a handover: this close's narrow scope is unchanged.
        if (isTangibleDeliverySummary(strike0Summary)) {
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
