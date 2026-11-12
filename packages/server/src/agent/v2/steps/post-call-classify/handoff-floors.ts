// Delegation-and-delivery floors: a user-triggered turn may not end silent because work went to a peer,
// and a reminder turn must say its reminder. Each steers the agent up to `MAX_FLOOR_STEER_ATTEMPTS` times,
// then records a platform-voice ghost if the delivery ledger shows nothing reached the person.

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { askIdForMessage } from '../../../../work/store.js';
import { type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
// Both floors steer through `persistEngineSteer`, which owns the enqueue, the row and the advance.
import { steerFireCount } from '../../steer-queue.js';
import { replyChannelWords } from '../../turn-address.js';
import { liveAddress } from '../../turn-address-live.js';
import { turnDeliveredToPerson } from '../../answered-edge.js';
import { MAX_FLOOR_STEER_ATTEMPTS, recordFloorGhost } from '../../floor-ghost.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The A2A-handoff floor and the reminder-delivery silence floor. */
export async function runHandoffFloors(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, chosenConvKey, counterparty, counterpartyIsAgentSender, db,
    isEngineTurn, maxToolLoops, triggerRow, turnCtx, turnNumber,
  } = ctx;
  const MAX_TOOL_LOOPS = maxToolLoops;
  const chosenConversationId = turnCtx.conversationId ?? null;
  const { persistedContent } = sc;
  // A2A-handoff floor: on a weak model the handoff contract's "end your turn" wins over telling the user,
  // so a user turn can end silent with results in hand. An explicit channel send this turn stands it down.
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    // Only a waiting human (the trigger row) is owed; a wake turn that sends an A2A serves nobody waiting.
    !!triggerRow &&
    (!persistedContent || persistedContent.trim().length === 0) &&
    chosenConvKey &&
    chosenConvKey !== 'engine' &&
    !Object.values(state.explicitSendThisTurn).some(Boolean) &&
    state.toolResults.some((tr) => !tr.isError && tr.name === 'send_to_agent')
  ) {
    const handoffAttempts = steerFireCount(state.steerQueue, 'a2a-handoff-floor');
    if (handoffAttempts < MAX_FLOOR_STEER_ATTEMPTS && state.loopCount < MAX_TOOL_LOOPS) {
      const again = handoffAttempts === 1;
      // Name who is waiting and where the written reply lands, from the turn's address.
      const addr = liveAddress(turnCtx.address);
      const who = addr?.kind === 'person' ? addr.name : null;
      const waiter = who ?? 'the user';
      const routeNote = who
        ? `as your reply (it goes to ${who} by ${replyChannelWords(addr)}; do NOT call imessage_send or any send tool)`
        : `directly in this conversation (do NOT call imessage_send or any send tool; the engine routes your reply)`;
      const steer = again
        ? (
          `[System] Second time: this turn is STILL about to end with nothing said to ${waiter}, ` +
          `and they are waiting. Nothing else on this turn matters until they hear from you. ` +
          `WRITE one or two sentences to them now, ${routeNote}: what you have, and ` +
          `that another agent is finishing the rest.`
        )
        : (
          `[System] You handed work to another agent and are ending this turn without telling ` +
          `${waiter} anything. ${who ? `${who} is` : 'The user is'} waiting. WRITE ${waiter} a short reply NOW, ${routeNote}: ` +
          `report any results you already have, and say you have asked another agent for ` +
          `the rest and will report back when they answer. Do not message the other agent again.`
        );
      // One model-facing channel, the steer queue: an events-lane row would reach the model a turn later.
      state = persistEngineSteer(
        state,
        { agentId, content: steer, turnNumber, floor: 'a2a-handoff-floor', key: again ? 'retry' : '', atLoop: state.loopCount },
        { broadcast },
      );
      logger.info('v2 a2a-handoff floor: user-facing turn ending silently after a handoff; steering the model to report to the user first', {
        agentId, turnNumber, convKey: chosenConvKey, attempt: handoffAttempts + 1,
      }, agentId);
      return continueLoop(state); // one more round to report to the user
    }
    // Both steers spent: verify against the delivery ledger before recording a ghost, since the model may
    // have answered on a channel this check cannot see. A peer box handles its own silent handoffs.
    if (handoffAttempts >= MAX_FLOOR_STEER_ATTEMPTS && !counterpartyIsAgentSender
        && !turnDeliveredToPerson(agentId, turnNumber, chosenConversationId ?? null)) {
      const root = turnCtx.root;
      recordFloorGhost({
        agentId, turnNumber, floor: 'a2a-handoff-floor',
        workId: root?.kind === 'ask' ? askIdForMessage(root.id) : null,
        attempts: handoffAttempts,
        ownerLine:
          'your agent handed part of this to another agent and then went quiet without telling you. '
          + 'The engine asked it twice to report back and it did not, so nothing was delivered on this '
          + 'turn. The other agent is still working; ask your agent where things stand.',
        detail: { conv_key: chosenConvKey ?? null },
      }, { broadcast });
    }
  }

  // Reminder-delivery floor: a reminder turn exists to say one thing to the owner. The agent is steered to
  // say it in its own words; the engine never delivers the reminder as the agent.
  {
    const servedRem = turnCtx.servedWork;
    if (
      servedRem?.taskKind === 'reminder' &&
      (!persistedContent || persistedContent.trim().length === 0) &&
      !Object.values(state.explicitSendThisTurn).some(Boolean)
    ) {
      try {
        const remRow = servedRem.taskId
          ? (db.prepare('SELECT title, description FROM work WHERE id = ?')
              .get(servedRem.taskId) as { title: string | null; description: string | null } | undefined)
          : undefined;
        const remText = (remRow?.description || remRow?.title || '').replace(/^Reminder:?\s*/i, '').trim();
        const remAttempts = steerFireCount(state.steerQueue, 'reminder-silence');
        if (remText && remAttempts < MAX_FLOOR_STEER_ATTEMPTS && state.loopCount < MAX_TOOL_LOOPS) {
          // The reply reaches the owner by the channel the turn's address says, not always this conversation.
          const liveAddr = liveAddress(turnCtx.address);
          const remRoute = liveAddr
            ? `as your reply (it goes to the owner by ${replyChannelWords(liveAddr)}; do NOT call imessage_send or any send tool)`
            : `directly in this conversation (do NOT call imessage_send or any send tool; the engine routes your reply)`;
          const steer = remAttempts === 1
            ? (
              `[System] Second time: this reminder still has not reached the owner. It is the ` +
              `only reason this turn exists. WRITE it to them now, in your own words, ` +
              `${remRoute}. The reminder is: ${remText}`
            )
            : (
              `[System] This turn is delivering a reminder and is about to end with nothing said ` +
              `to the owner. WRITE it to them now, in your own words, ` +
              `${remRoute}. The reminder is: ${remText}`
            );
          // Steer queue only: an events-lane copy reached the model a turn later, cut to a short gist.
          state = persistEngineSteer(
            state,
            { agentId, content: steer, turnNumber, floor: 'reminder-silence', key: remAttempts === 1 ? 'retry' : '', atLoop: state.loopCount },
            { broadcast },
          );
          logger.info('v2 reminder silence floor: reminder turn about to end silently; steering the model to say it', {
            agentId, turnNumber, taskId: servedRem.taskId, attempt: remAttempts + 1,
          }, agentId);
          return continueLoop(state); // one more round for the agent to deliver its own reminder
        }
        if (remText && remAttempts >= MAX_FLOOR_STEER_ATTEMPTS
            && !turnDeliveredToPerson(agentId, turnNumber, chosenConversationId ?? null)) {
          recordFloorGhost({
            agentId, turnNumber, floor: 'reminder-silence',
            workId: servedRem.taskId ?? null,
            attempts: remAttempts,
            ownerLine:
              'a reminder was due and your agent did not deliver it. The engine asked it twice and '
              + `it stayed silent, so nothing reached you on this turn. The reminder was: ${remText}`,
            detail: { task_id: servedRem.taskId ?? null },
          }, { broadcast });
        }
      } catch { /* best effort; never block turn end */ }
    }
  }

  return proceed(state);
}
