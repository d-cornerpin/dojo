// The promise floor: a user turn whose reply only promises, with nothing behind it, gets one more
// round to do the work, record it, or check it.

import { classifyTool } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { CLOSING_WORK_OPS, isWorkVerb, toolOpKey } from '../../../../tools/work-verbs.js';
import { broadcast } from '../../../../gateway/ws.js';
import { type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFired } from '../../steer-queue.js';
import { replyClaim } from '../../reply-claims.js';
import { linkedTaskOf } from '../../../../work/ask-settlement.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';
import { turnWindow } from './job-turn-end.js';
import { userWords } from '../../turn-address.js';

const logger = createLogger('v2-loop');

/** Memory writes that outlive a session reset. `scratchpad_set` is excluded: the pad does not
 *  survive a reset. */
const DURABLE_MEMORY_WRITES: ReadonlySet<string> = new Set([
  'vault_remember',
  'vault_update',
  'update_agent',
]);

/** Board contact this turn, read or write. The calendar side is a name prefix on purpose: a missed
 *  member only narrows this exemption, so a new `calendar_*` tool joining it is the safe default. */
function isBoardContact(name: string): boolean {
  return isWorkVerb(name) || name.startsWith('calendar_');
}

/** The promise floor: a turn that only promised gets one more round to deliver. */
export function runPromiseFloor(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const { agentId, chosenConvKey, counterparty, db, isEngineTurn, turnNumber } = ctx;
  const { persistedContent } = sc;
  // Three classes share the guards and one steer per turn: a promise to start with no work done, a
  // standing promise with nothing durable written, and a claim about live state with no board read.
  // Earlier classes take precedence. Exemptions are receipts (rows, tool results), never the reply's prose.
  // One-shot: a second promise ending is logged and the turn ends rather than spins.
  const forwardPromise = replyClaim(ctx, 'only_promises_to_start') === true;
  const standingPromise = !forwardPromise && replyClaim(ctx, 'standing_promise') === true;
  const standingStateClaim = !forwardPromise && !standingPromise && replyClaim(ctx, 'asserts_board_state') === true ? persistedContent : null;
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    persistedContent && persistedContent.trim().length > 0 &&
    turnWindow(state, agentId, 1) !== 'checkpoint' &&
    chosenConvKey &&
    chosenConvKey !== 'engine' &&
    (forwardPromise || standingPromise || standingStateClaim !== null)
  ) {
    const didEffectfulWorkThisTurn = state.toolResults.some(
      (tr) => !tr.isError && !!tr.name && classifyTool(tr.name, tr.arguments) === 'effectful-action',
    );
    const transitionedATaskThisTurn = state.toolResults.some(
      (tr) => !tr.isError && CLOSING_WORK_OPS.has(toolOpKey(tr.name, tr.arguments)),
    );
    // A promise to start is not pushed past the owner's hold on the task behind this request.
    const request = ctx.turnCtx.root?.kind === 'ask' ? ctx.turnCtx.root.sourceMessageId : null;
    const ownerHoldsItsTask = forwardPromise && !!linkedTaskOf(agentId, request) && !linkedTaskOf(agentId, request, { ownerHeldEnds: true });
    // A promise backed by a row this turn opened with a future fire is the scheduler's to keep;
    // `origin_turn` is stamped on every tracker open, and a failed open leaves no row.
    let openedFutureScheduledWorkThisTurn = false;
    if (forwardPromise && !didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
      try {
        openedFutureScheduledWorkThisTurn = !!db.prepare(
          'SELECT 1 AS ok FROM work w WHERE (w.agent_id = ? OR w.requester_id = ?)'
          + ' AND w.origin_turn = ? AND COALESCE(w.scheduled_start, w.next_run_at) > ? LIMIT 1',
        ).get(agentId, agentId, turnNumber, Date.now());
      } catch (err) {
        // A read that cannot run must not manufacture an exemption.
        logger.warn('promise floor: could not read this turn\'s opened work; falling back to the pre-exemption floor', {
          agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    // Durable: a successful call to a memory door above (a turn that opened a work row is never asked, `reply-claims.ts`).
    const wroteSomethingDurableThisTurn = standingPromise && !didEffectfulWorkThisTurn && !transitionedATaskThisTurn
      && state.toolResults.some((tr) => !tr.isError && !!tr.name && DURABLE_MEMORY_WRITES.has(tr.name));
    // Read from tool results, not rows: the question is about looking, and a read leaves no row.
    let readTheBoardThisTurn = false;
    if (standingStateClaim !== null && !didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
      readTheBoardThisTurn = state.toolResults.some(
        (tr) => !tr.isError && !!tr.name && isBoardContact(tr.name),
      );
    }
    if (!didEffectfulWorkThisTurn && !transitionedATaskThisTurn && !openedFutureScheduledWorkThisTurn
      && !wroteSomethingDurableThisTurn && !readTheBoardThisTurn && !ownerHoldsItsTask) {
      const quoted = persistedContent.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (steerFired(state.steerQueue, 'promise-floor')) {
        logger.warn('promise floor: second promise ending, letting the turn end', {
          agentId, turnNumber, convKey: chosenConvKey,
        }, agentId);
      } else {
        const steer = standingStateClaim !== null ? (
          // Check before asserting. The reply is already shown, so the round ends with [no-reply] or only
          // the correction, and is bounded to that answer so it does not pick up other work.
          `[System] Your reply told ${userWords(ctx.turnCtx.address)} what is currently scheduled or owed ('${quoted}'), ` +
          `but nothing this turn read the board, so that came from memory rather than from a row. ` +
          `Check it before you assert it: work_update(action="list") for the live tracker, plus ` +
          `calendar_agenda if you named a calendar event. ${userWords(ctx.turnCtx.address, true)} already has your reply, so do ` +
          `not say it again: if every line matches what the board actually holds, end the turn ` +
          `with [no-reply]; if a line is wrong, tell ${userWords(ctx.turnCtx.address)} only that correction, in a line or ` +
          `two, without repeating the lines that were right — a row that is abandoned, closed, or ` +
          `was never created is not "on deck" and will not fire. This round is for checking THAT ` +
          `answer: do not pick up new work you were not asked for.`
        ) : standingPromise ? (
          `[System] Your reply made a STANDING promise to ${userWords(ctx.turnCtx.address)} ('${quoted}') — a commitment ` +
          `about every future occasion — but nothing durable was written this turn, so nothing ` +
          `will carry it out. A promise that lives only in this conversation does not survive a ` +
          `session reset. Either record what you can actually deliver where it will be kept ` +
          `(vault_remember with verbatim:true and pin:true for a standing instruction; work_open ` +
          `for a tracked task or a scheduled reminder), or tell ${userWords(ctx.turnCtx.address)} honestly what you can ` +
          `and cannot do. Do not repeat the promise without recording it.`
        ) : (
          `[System] Your reply to ${userWords(ctx.turnCtx.address)} was a promise to start ('${quoted}') but the turn ` +
          `was about to end with no work done. Do the work NOW with tool calls and deliver the ` +
          `result. Do not narrate what you are about to do again.`
        );
        // persistEngineSteer files the queue entry and the durable system row; the promise row the
        // user already saw is never deleted.
        state = persistEngineSteer(
          state,
          { agentId, content: steer, turnNumber, floor: 'promise-floor', atLoop: state.loopCount },
          { broadcast },
        );
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
