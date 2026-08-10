// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE PROMISE FLOOR, moved byte-faithfully out of `loop.ts`'s
// `postCallClassify` span. The last member of the fall-asleep family, observed live
// 2026-07-08: a turn whose ENTIRE deliverable is a promise to start ("I'll get on
// that") and which then ends, having done nothing. The floor hands the model one more
// round to actually do the work.
//
// `MAX_TOOL_LOOPS` is PASSED rather than moved (readers outside this span);
// `argsForResult` MOVED with the code, measured `out=0` first.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { classifyTool } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { CLOSING_WORK_OPS, toolOpKey } from '../../../../tools/work-verbs.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { isForwardPromiseReply } from '../../ack-copy.js';
import { argsForResult } from './args-for-result.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The promise floor: a turn that only promised gets one more round to deliver. */
export function runPromiseFloor(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const { agentId, chosenConvKey, counterparty, db, isEngineTurn, maxToolLoops, turnNumber } = ctx;
  const MAX_TOOL_LOOPS = maxToolLoops;
  const { persistedContent } = sc;
  // ── Promise floor: a turn whose entire deliverable is a promise to start ──
  // The last member of the fall-asleep family. Observed live 2026-07-08: the
  // owner asked for a calendars-to-markdown job, the ack fired, one
  // load_tool_docs round ran, then the model emitted TEXT ("On it. Let me pull
  // up all your calendars.") with NO tool calls, and the loop took that promise
  // as the turn's reply and ended clean. Every existing floor (task closeout,
  // going-idle, completion ack) keys on tasks or deliveries; NONE catches a
  // reply whose whole content is a promise to begin.
  //
  // Sequenced AFTER the F3 owed-interrupt block so that answering an owed
  // mid-turn ask takes priority (F3 continues before we reach here). Guards
  // mirror F3 (real user turn, non-empty reply, a human conv_key, and the same
  // MAX_TOOL_LOOPS proximity skip so it can neither spin nor push past the cap)
  // plus two more, deliberately conservative because the action is a re-prompt:
  // (2) the reply must LOOK like a forward promise at its END
  // (isForwardPromiseReply, unit-tested), and (3) the turn must have done
  // NEGLIGIBLE work, no successful effectful-action tool result AND no task
  // transitioned/closed this turn (same classifyTool === 'effectful-action'
  // derivation the closeout machinery uses at countsAsTaskWork; retrieval /
  // bookkeeping reads like load_tool_docs do NOT count, so the live case still
  // qualifies). One-shot: if the model ends AGAIN with a promise after the
  // steer, log the tripwire and let the turn end rather than spin.
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    persistedContent && persistedContent.trim().length > 0 &&
    state.loopCount < MAX_TOOL_LOOPS &&
    chosenConvKey &&
    chosenConvKey !== 'engine' &&
    isForwardPromiseReply(persistedContent)
  ) {
    const didEffectfulWorkThisTurn = state.toolResults.some(
      (tr) => !tr.isError && !!tr.name && classifyTool(tr.name, argsForResult(state.toolCalls, tr)) === 'effectful-action',
    );
    const transitionedATaskThisTurn = state.toolResults.some(
      (tr) => !tr.isError && CLOSING_WORK_OPS.has(toolOpKey(tr.name, argsForResult(state.toolCalls, tr))),
    );
    // ── THE THIRD EXEMPTION (UX-REPAIR round 5 T22): the promise the SCHEDULER is
    //    keeping. Round-5 S1: "In 15 minutes, look up whether the Mariners played today
    //    and message me the score." The turn opened a task with `scheduled_start` fifteen
    //    minutes out and said so — and because `work_open` classifies as BOOKKEEPING, the
    //    two predicates above read the turn as a promise with nothing behind it and this
    //    floor steered *"Do the work NOW"*, against the user's own explicit timing. The
    //    model nearly obeyed in the worst way (its thinking: do the lookup now, deliver
    //    now, cancel the scheduled task).
    //
    //    This floor's subject is a promise with NOTHING BEHIND IT — its header's 2026-07-08
    //    case, pinned red in the tests. A promise backed by a tracked row with a FUTURE fire
    //    is bounded and owned: the scheduler does the follow-through, not the next round.
    //
    //    RECEIPTS, NOT PROSE. The question is asked of the ROW — `origin_turn` is the stamp
    //    every tracker open writes, so "this turn opened it" needs no parsing of a tool
    //    result, and a work_open that FAILED left no row to find. Same `agent_id`/`origin_turn`
    //    pair `teardown/finalize-record.ts`'s strike-0 close reads, widened to the opener
    //    because a row assigned elsewhere is still this turn's promise to have made.
    let openedFutureScheduledWorkThisTurn = false;
    if (!didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
      try {
        openedFutureScheduledWorkThisTurn = !!db.prepare(
          'SELECT 1 AS ok FROM work w WHERE (w.agent_id = ? OR w.requester_id = ?)'
          + ' AND w.origin_turn = ? AND COALESCE(w.scheduled_start, w.next_run_at) > ? LIMIT 1',
        ).get(agentId, agentId, turnNumber, Date.now());
      } catch (err) {
        // A read that cannot run must not manufacture an exemption: the floor keeps its
        // pre-T22 behaviour, which is the direction that never lets an empty promise pass.
        logger.warn('promise floor: could not read this turn\'s opened work; falling back to the pre-exemption floor', {
          agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    if (!didEffectfulWorkThisTurn && !transitionedATaskThisTurn && !openedFutureScheduledWorkThisTurn) {
      const quoted = persistedContent.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (steerFired(state.steerQueue, 'promise-floor')) {
        // Steered once already this turn and the model STILL ended on a promise.
        // Don't spin, let the turn end. This warn is the tripwire that a harder
        // floor is needed if the weak model can't be talked past it.
        logger.warn('promise floor: second promise ending, letting the turn end', {
          agentId, turnNumber, convKey: chosenConvKey,
        }, agentId);
      } else {
        const steer = (
          `[System] Your reply to the user was a promise to start ('${quoted}') but the turn ` +
          `was about to end with no work done. Do the work NOW with tool calls and deliver the ` +
          `result. Do not narrate what you are about to do again.`
        );
        const steerId = uuidv4();
        try {
          // Model-visible engine channel, same pattern as the owed-interrupt
          // re-prompt: an origin_kind='engine' row on the 'engine-steer' conv_key
          // sentinel (never pickable as a pending event), PLUS a queue entry so the
          // steer reaches the model on the next iteration. The promise text row the
          // user already saw is KEPT visible (never delete a user-visible row); the
          // follow-through lands after it.
          insertEngineEventIfAbsent({
            work: null,
            id: steerId,
            agentId,
            content: steer,
            sourceAgentId: null,
            originIntent: 'promise_floor',
            turnNumber,
          });
        } catch { /* best effort */ }
        state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'promise-floor', content: steer, atLoop: state.loopCount }) });
        logger.info('v2 promise floor: reply was a forward promise with negligible work this turn; steering the model to do the work now', {
          agentId, turnNumber, convKey: chosenConvKey,
        }, agentId);
        return continueLoop(state); // one more round to actually do the work and deliver
      }
    }
  }

  return proceed(state);
}
