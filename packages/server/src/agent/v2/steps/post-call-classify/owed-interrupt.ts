// One steer for a person who spoke mid-turn: adjust the work now, leave the answer to its own turn.

import { createLogger } from '../../../../logger.js';
import { broadcast } from '../../../../gateway/ws.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFired } from '../../steer-queue.js';
import { getOwedMidTurnArrivals } from '../../counterparty.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';
import { turnWindow } from './job-turn-end.js';
import { userWords } from '../../turn-address.js';
import { requestsTakenUpBy } from '../../../../work/task-turns.js';

const logger = createLogger('v2-loop');

export async function runOwedInterrupt(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, chosenConvKey, counterparty, isEngineTurn, turnCtx,
    turnNumber, turnStartedAt,
  } = ctx;
  const { persistedContent } = sc;

  // The teardown claim marks every assembled mid-turn row served, so steer once first, scoped by
  // getOwedMidTurnArrivals to that claim's exact set minus the trigger and pre-turn burst. Steering may
  // precede the reply; recording may not: its delivery high water, taken before the answer, would let
  // that answer close an owed ask it never addressed.
  const hasReply = !!persistedContent && persistedContent.trim().length > 0;
  const mayRecord = hasReply && !state.owedInterruptSubjectsRecorded;
  const maySteer = !steerFired(state.steerQueue, 'owed-interrupt') && turnWindow(state, agentId, 1) !== 'checkpoint';
  // Riding tool calls must not take the loop: continuing would skip the execute phase and drop them.
  const ridingToolCalls = ctx.result.toolCalls.length > 0;
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    (maySteer || mayRecord) &&
    turnCtx.lastAssembledAtIso &&
    chosenConvKey &&
    chosenConvKey !== 'engine'
  ) {
    let owed = getOwedMidTurnArrivals(agentId, chosenConvKey, turnStartedAt, turnCtx.lastAssembledAtIso);
    if (owed.length > 0) {
      // Never quote human text that merely opens with an engine tag back into a re-prompt.
      const { looksLikeEngineMessage } = await import('../../classifiers/multistep.js');
      owed = owed.filter((m) => !looksLikeEngineMessage(m.content));
    }
    if (owed.length > 0) {
      const quoted = owed
        .slice(0, 3)
        .map((m) => `"${m.content.replace(/\s+/g, ' ').trim().slice(0, 200)}"`)
        .join('; ');
      const itThem = owed.length === 1 ? 'it' : 'them';
      // The arrival is not this turn's to answer: its own turn serves it, and closeout-floors.ts holds
      // whatever this round writes as a working note, so it cannot reach the person as a duplicate.
      const isAre = owed.length === 1 ? 'it is' : 'they are';
      const itsTheir = owed.length === 1 ? 'its' : 'their';
      // The steer is persisted, so it is still in the tail on the arrival's own turn; it must say
      // when it stops applying or that turn will not answer.
      const laterTurnRelease =
        ` (If you are reading this on a LATER turn, that turn IS ${itsTheir} turn — answer ${itThem} normally.)`;
      const afterReplyPrompt = (
        `[System] While you were working, ${userWords(turnCtx.address)} also sent: ${quoted}. ` +
        `Do NOT answer ${itThem} in this turn — ${isAre} queued and will be served on ${itsTheir} own turn next, ` +
        `and a second answer from you now would reach ${userWords(turnCtx.address)} as a duplicate.${laterTurnRelease} ` +
        `Do not re-run the tools you used for the main task; that work is done and delivered. ` +
        `Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; ${userWords(turnCtx.address)} already has it. ` +
        `If what they sent CANCELS or CHANGES work you are still doing, stop that work now and record it; otherwise finish this turn without adding anything.`
      );
      // In-flight form: nothing has reached the person yet, so finish or abort the turn's own work.
      // The serving ask's id is supplied because OPEN WORK does not list a claimed ask: the one request the turn took up.
      const taken = requestsTakenUpBy(agentId, turnNumber);
      const servingAskId = taken.length === 1 ? taken[0] : null;
      const inFlightPrompt = (
        `[System] While you are working, ${userWords(turnCtx.address)} also sent: ${quoted}. ` +
        `Nothing has reached them yet this turn. Do NOT answer ${itThem} in this turn — ${isAre} queued and will be served on ${itsTheir} own turn next.${laterTurnRelease} ` +
        `What this changes is the work you are doing RIGHT NOW: if it cancels or replaces that work, STOP — do not finish it and do not deliver its answer, ` +
        `and record the cancellation with work_close_request(action="commitment", disposition="dropped"` +
        `${servingAskId ? `, id="${servingAskId}"` : ', id=<the id in [brackets] from your OPEN WORK block>'}` +
        `, note="<${userWords(turnCtx.address)}'s own words>"). ` +
        `If it only adds to the work, carry on and cover it when its turn comes. ` +
        `Whatever you say in your one reply this turn, do not deliver the cancelled task's answer as though they had not spoken.`
      );
      const rePrompt = hasReply ? afterReplyPrompt : inFlightPrompt;
      // Record the owed subjects by id on their spine rows for settlement; best effort, so a
      // bookkeeping failure never costs the re-prompt. Only on a pass with a reply (see above).
      if (mayRecord) {
        try {
          const { recordOwedInterruptSubjects } = await import('../../../../work/ask-settlement.js');
          recordOwedInterruptSubjects(agentId, owed.map((m) => m.id), turnNumber);
        } catch (err) {
          logger.warn('owed-interrupt subjects not recorded; settlement will fall back to its other narrowings', {
            agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
        state = advance(state, { owedInterruptSubjectsRecorded: true });
      }
      if (!maySteer) return proceed(state);
      // When the model was shown these asks goes on their own ledger.
      try { (await import('../../../../work/delegated-relay-evidence.js')).recordOwedAskShown(agentId, owed.map((m) => m.id), turnNumber); } catch { /* best effort: the rule falls back to the ask's arrival */ }
      // persistEngineSteer files the queue entry (the model-facing channel) and the durable system row.
      state = persistEngineSteer(
        state,
        { agentId, content: rePrompt, turnNumber, floor: 'owed-interrupt', atLoop: state.loopCount },
        { broadcast },
      );
      state = advance(state, {
        // What the round is for; downstream floors read this to tell the arrival's answer from the turn's.
        owedInterruptGrant: {
          atLoop: state.loopCount,
          messageIds: owed.map((m) => m.id),
          afterReply: hasReply,
        },
      });
      logger.info('v2 owed-interrupt steer: a mid-turn user message was assembled and is not this turn\'s to answer; pointing the model at it before the teardown claim marks it served', {
        agentId, turnNumber, owedCount: owed.length, convKey: chosenConvKey,
        inFlight: !hasReply, ridingToolCalls,
      }, agentId);
      return ridingToolCalls ? proceed(state) : continueLoop(state);
    }
  }

  return proceed(state);
}
