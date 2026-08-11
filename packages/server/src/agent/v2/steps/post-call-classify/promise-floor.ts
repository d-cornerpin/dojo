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
import { CLOSING_WORK_OPS, isWorkVerb, toolOpKey } from '../../../../tools/work-verbs.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { isForwardPromiseReply, isStandingPromiseReply, standingStateClaimSentence } from '../../ack-copy.js';
import { argsForResult } from './args-for-result.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/**
 * UX-REPAIR ROUND 8 T33 — the memory doors whose writes OUTLIVE a session reset, named one by
 * one rather than derived from a verb. `vault_remember` is the door the platform's own tool
 * description points at for this exact request shape ("phrases like … 'from now on, …' … call
 * this tool with verbatim: true and pin: true"), `vault_update` edits what is already pinned,
 * and `update_agent` rewrites a sub-agent's standing instructions. `scratchpad_set` is
 * excluded on its own description's word: the pad "does NOT survive session reset".
 */
const DURABLE_MEMORY_WRITES: ReadonlySet<string> = new Set([
  'vault_remember',
  'vault_update',
  'update_agent',
]);

/**
 * UX-REPAIR ROUND 9 T36 — CONTACT WITH THE BOARD THIS TURN, which is the third class's exemption.
 *
 * Two surfaces answer "what is currently scheduled or owed": the work board (the six verbs — a
 * `work_update` list or get READS it, and an open, note or transition means this turn put the row
 * there itself) and the calendar. Reads and writes both count on purpose: the question is whether
 * the turn had any contact with the thing it is describing, and a turn that just opened the
 * reminder it is confirming has not asserted anything from memory.
 *
 * The calendar side is a NAME PREFIX rather than an enumerated set, which is the opposite of the
 * rule `tools/work-verbs.ts` exists to enforce — and deliberately, because the direction of
 * failure is opposite too. There, a set that missed a member made a GATE go dark. Here a missed
 * member makes an EXEMPTION too narrow, i.e. steers a turn that did look; a new `calendar_*` tool
 * joining the exemption on the day it ships is the safe default, not a silent widening of a gate.
 */
function isBoardContact(name: string): boolean {
  return isWorkVerb(name) || name.startsWith('calendar_');
}

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
  //
  // ── THE SECOND CLASS (UX-REPAIR ROUND 8 T33): THE STANDING PROMISE ──
  // Round-8 S5: "From now on, when a reminder fires I'll post it here first — and if you
  // haven't replied within a few minutes, I'll text it to your phone as a backup." Zero tool
  // calls; every durable surface snapshotted before and after read identical (work rows,
  // vault, config, files, receipts). The promise covers a monitoring mechanism the platform
  // does not have and an SMS send this agent is refused by identity, and it lived only in one
  // assistant message — it did not even survive the next session reset. The recognizer above
  // could not see it: it asks about an IMMEDIATE promise ("I'll go pull that up"), and this is
  // a promise about every future occasion.
  //
  // The two classes share every guard and the ONE steer per turn, and they ask a DIFFERENT
  // question of the turn. "Do the work NOW" is the right order for a promise to start work
  // now; for a promise about future occasions the only thing that can make it real is a
  // durable record, so this class asks: was anything DURABLE written this turn? The forward
  // class keeps precedence, so every case the floor already fired on keeps its exact steer.
  //
  // ── THE THIRD CLASS (UX-REPAIR ROUND 9 T36): THE STANDING-STATE CLAIM ──
  // Round-9 S5, "Recap the week for me": one 1,100-character answer, ZERO tool calls in the whole
  // scenario. Its PAST-work claims were nearly perfect — exact file names, an exact 11-file count,
  // the flight fare quoted from the ticket's own result. Its claims about what is still LIVE were
  // fiction: "schedule intact for tomorrow" (no such row; the only future fire on the board was a
  // pasta timer), "Still on deck: parking pass renewal" (nothing), "two fence quotes still parked,
  // waiting on Bob's address" (88 such commitment rows, every one `abandoned`, four documents).
  // Third sighting in two rounds (round-8 S1, round-9 S5): the model recaps memory-state.
  //
  // The two promise classes ask what the reply COMMITTED to; this one asks what it ASSERTED, and
  // its exemption is a READ rather than a write — the same receipts-not-prose rule pointed the
  // other way. "I checked the tracker just now" is not a check. Both promise classes keep
  // precedence, so every case the floor already fired on keeps its exact steer.
  const forwardPromise = isForwardPromiseReply(persistedContent);
  const standingPromise = !forwardPromise && isStandingPromiseReply(persistedContent);
  const standingStateClaim = !forwardPromise && !standingPromise
    ? standingStateClaimSentence(persistedContent) : null;
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    persistedContent && persistedContent.trim().length > 0 &&
    state.loopCount < MAX_TOOL_LOOPS &&
    chosenConvKey &&
    chosenConvKey !== 'engine' &&
    (forwardPromise || standingPromise || standingStateClaim !== null)
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
    if (forwardPromise && !didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
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
    // ── T33's EXEMPTION QUESTION, for the standing class only: was anything DURABLE written
    //    this turn? RECEIPTS, NOT PROSE, on the same principle T22 established — the model
    //    saying "I've saved that to your preferences" is not a save. Two receipts count:
    //    (a) a `work` row stamped with THIS turn (the tracker's own `origin_turn`, so a
    //        commitment, task, project or scheduled reminder all qualify and a call that FAILED
    //        left no row to find), and
    //    (b) a successful call to one of the named memory doors that outlive a session reset.
    //    `scratchpad_set` is deliberately NOT one of them: its own tool description says the
    //    pad "does NOT survive session reset", which is precisely the death this promise died.
    let wroteSomethingDurableThisTurn = false;
    if (standingPromise && !didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
      wroteSomethingDurableThisTurn = state.toolResults.some(
        (tr) => !tr.isError && !!tr.name && DURABLE_MEMORY_WRITES.has(tr.name),
      );
      if (!wroteSomethingDurableThisTurn) {
        try {
          wroteSomethingDurableThisTurn = !!db.prepare(
            'SELECT 1 AS ok FROM work w WHERE (w.agent_id = ? OR w.requester_id = ?)'
            + ' AND w.origin_turn = ? LIMIT 1',
          ).get(agentId, agentId, turnNumber);
        } catch (err) {
          // Same rule as T22's read: a read that cannot run must not manufacture an exemption.
          logger.warn('promise floor: could not read this turn\'s opened work; treating the standing promise as unbacked', {
            agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }
    }
    // ── T36's EXEMPTION QUESTION, for the standing-STATE class only: did this turn have any
    //    contact with the board it is describing? RECEIPTS, NOT PROSE for the third time — the
    //    model writing "I checked the tracker just now" is not a check, and the S5 reply that
    //    named four live rows made no tool call at all. Read from the turn's own tool results
    //    rather than from a row, because the question is about the LOOKING, and a read leaves no
    //    row behind to find.
    let readTheBoardThisTurn = false;
    if (standingStateClaim !== null && !didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
      readTheBoardThisTurn = state.toolResults.some(
        (tr) => !tr.isError && !!tr.name && isBoardContact(tr.name),
      );
    }
    if (!didEffectfulWorkThisTurn && !transitionedATaskThisTurn && !openedFutureScheduledWorkThisTurn
      && !wroteSomethingDurableThisTurn && !readTheBoardThisTurn) {
      const quoted = (standingStateClaim ?? persistedContent).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (steerFired(state.steerQueue, 'promise-floor')) {
        // Steered once already this turn and the model STILL ended on a promise.
        // Don't spin, let the turn end. This warn is the tripwire that a harder
        // floor is needed if the weak model can't be talked past it.
        logger.warn('promise floor: second promise ending, letting the turn end', {
          agentId, turnNumber, convKey: chosenConvKey,
        }, agentId);
      } else {
        const steer = standingStateClaim !== null ? (
          // T36: the same floor, a third order — nothing here needs doing or recording, it needs
          // READING before it is said. Engine speaks to the MODEL, never to the user (OR2).
          //
          // THE LAST SENTENCE IS DRIVEN, NOT GUESSED. Two floor-model replays of the round-9 send
          // (2026-08-11) took the granted round and spent it on a blocked task the board read had
          // just surfaced — the check happened, the correction never did, and the recap the person
          // actually asked for was left behind as the turn's non-answer. Bounding the round to the
          // answer it was granted for is the difference between a check and a detour.
          `[System] Your reply told the user what is currently scheduled or owed ('${quoted}'), ` +
          `but nothing this turn read the board, so that came from memory rather than from a row. ` +
          `Check it before you assert it: work_update(action="list") for the live tracker, plus ` +
          `calendar_agenda if you named a calendar event. Then say that same answer again with ` +
          `every line corrected against what the board actually holds — a row that is abandoned, ` +
          `closed, or was never created is not "on deck" and will not fire. This round is for ` +
          `correcting THAT answer: do not pick up new work you were not asked for.`
        ) : standingPromise ? (
          // T33: the same floor, a different order — there is no work to "do now" for a promise
          // about future occasions, and the engine speaks to the MODEL, never to the user (OR2).
          `[System] Your reply made a STANDING promise to the user ('${quoted}') — a commitment ` +
          `about every future occasion — but nothing durable was written this turn, so nothing ` +
          `will carry it out. A promise that lives only in this conversation does not survive a ` +
          `session reset. Either record what you can actually deliver where it will be kept ` +
          `(vault_remember with verbatim:true and pin:true for a standing instruction; work_open ` +
          `for a tracked task or a scheduled reminder), or tell the user honestly what you can ` +
          `and cannot do. Do not repeat the promise without recording it.`
        ) : (
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
        // The message names the CLASS because there are three of them now and the old wording
        // ("reply was a forward promise") has been false for two of them since T33.
        logger.info('v2 promise floor: the reply cleared none of this class\'s receipts; steering the model', {
          agentId, turnNumber, convKey: chosenConvKey,
          floorClass: standingStateClaim !== null ? 'standing-state-claim'
            : standingPromise ? 'standing-promise' : 'forward-promise',
        }, agentId);
        return continueLoop(state); // one more round to actually do the work and deliver
      }
    }
  }

  return proceed(state);
}
