// The "respond once" floors: a short closeout after a delivered answer, a second answer to a mid-turn
// arrival, a still-going job's progress, and the proactive-send backoff; then the surfaced-reply arm.

import { v4 as uuidv4 } from 'uuid';
import { WORKING_NOTE_PREFIX } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { isRowLabelOnly } from '../../../../memory/row-label-only.js';
import { advance, type AgentTurnState } from '../../state.js';
import { turnDeliveredToPerson } from '../../answered-edge.js';
import { PROACTIVE_SEND_DEMOTE_THRESHOLD, bumpProactiveSendStreak, getProactiveSendStreak } from '../../proactive-budget.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import { steerFired, type SteerFloorId } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { jobTaskOf } from './job-turn-end.js';
import { noteDeliveryHeld, tasksOwingADelivery } from '../../../../tracker/owed-delivery.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** A length, never a reading of the text: anything longer is substantive and is never held. */
const REDUNDANT_CLOSEOUT_MAX_CHARS = 30;

/** Demote, don't discard: persist the words as a `[working-note]` system row (outside model context) and
 *  convert the streamed bubble in place. Cosmetic: a failure never blocks the turn. */
function demoteToWorkingNote(
  p: { agentId: string; messageId: string; turnNumber: number; text: string },
  /** Why the Dojo held this line, recorded on every task the turn works that still owes a delivery. */
  held?: { why: string; owed: () => string[] },
): void {
  if (isRowLabelOnly(p.text)) return; // only the turn's label text, nothing to note
  if (held) {
    try { noteDeliveryHeld(held.owed(), { turnNumber: p.turnNumber, why: held.why, text: p.text }); } catch { /* the record never blocks the turn */ }
  }
  try {
    const noteId = uuidv4();
    insertMessageIfAbsent({
      id: noteId, agentId: p.agentId, role: 'system',
      content: `${WORKING_NOTE_PREFIX}${p.text}`, turnNumber: p.turnNumber,
    });
    broadcast({ type: 'chat:workingnote', agentId: p.agentId, messageId: p.messageId, noteId, content: p.text });
  } catch { /* cosmetic; never block the turn */ }
}

/** Steer, don't suppress: hold the agent's final reply once (its bubble becomes a working note), steer the
 *  agent with the finding, and run the loop again so the agent decides. Returns null when this floor has
 *  already steered this turn, and the reply goes out as written. */
export function holdAndSteer(
  state: AgentTurnState,
  at: { agentId: string; messageId: string; turnNumber: number; sc: PostCallScratch; db?: PostCallClassifyContext['db'] },
  p: { floor: SteerFloorId; text: string; steer: string },
): StepOutcome | null {
  if (steerFired(state.steerQueue, p.floor)) return null;
  at.sc.persistedContent = null;
  broadcast({ type: 'chat:chunk', agentId: at.agentId, messageId: at.messageId, content: '', done: true });
  demoteToWorkingNote({ agentId: at.agentId, messageId: at.messageId, turnNumber: at.turnNumber, text: p.text }, at.db ? {
    why: `held once by the reply check "${p.floor}"; the agent was told and decides whether to send it`,
    owed: () => tasksOwingADelivery(at.agentId, state.turnStartMs, jobTaskOf(at.agentId, at.db!)?.id ?? null),
  } : undefined);
  return continueLoop(persistEngineSteer(state, {
    agentId: at.agentId, content: p.steer, turnNumber: at.turnNumber, floor: p.floor, atLoop: state.loopCount,
  }, { broadcast }));
}

const quoteOf = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
};

/** "Respond once": the closeout floors and the surfaced-reply arm. No way out. */
export function runCloseoutFloors(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const { agentId, messageId, result, settledContextWakeTurn, turnCtx, turnNumber, db } = ctx;
  const { deliberateSurfaceTurn, interAgentTurn } = sc;
  let { persistedContent } = sc;
  // Tasks this turn works that still owe their owner a delivery, read once and only when asked.
  let owedMemo: string[] | null = null;
  const owed = (): string[] => (owedMemo ??= tasksOwingADelivery(agentId, state.turnStartMs, jobTaskOf(agentId, db)?.id ?? null));
  // Redundant closeout: a short line is held only when the delivery receipt shows this turn already gave
  // this person its answer; the length cap keeps a substantive second answer from ever being held.
  if (
    persistedContent &&
    persistedContent.trim().length <= REDUNDANT_CLOSEOUT_MAX_CHARS &&
    result.toolCalls.length === 0 &&
    turnDeliveredToPerson(agentId, turnNumber, turnCtx.root?.conversationId ?? null)
  ) {
    const held = holdAndSteer(state, { agentId, messageId, turnNumber, sc, db }, {
      floor: 'redundant-closeout', text: persistedContent,
      steer: `[Engine record: this turn already delivered its answer to the person. Your line "${quoteOf(persistedContent)}" has not been sent; `
        + 'written as your final reply again, it is sent as a further message. A final reply of [no-reply] sends nothing.]',
    });
    if (held) {
      logger.info('v2: held a short closeout after a delivered answer and told the agent (field fix 3 #11)', {
        agentId, turnNumber, loopCount: state.loopCount,
      }, agentId);
      return held;
    }
  }

  // A round the owed-interrupt step granted after a reply had landed was bought to ask about the arrival,
  // which its own turn answers (the ask stays open and re-serves), so that round's text becomes a note.
  // `afterReply` guards the mirror case: a round granted before any reply carries the turn's one answer.
  const grant = state.owedInterruptGrant;
  if (
    grant &&
    grant.afterReply &&
    state.loopCount > grant.atLoop &&
    persistedContent && persistedContent.trim().length > 0
  ) {
    logger.info('v2 T31: the owed-interrupt round produced a second user-facing answer to the arrival; holding it as a working note — the arrival is served by its own turn', {
      agentId, turnNumber, loopCount: state.loopCount, grantedAtLoop: grant.atLoop,
      owedCount: grant.messageIds.length, preview: persistedContent.slice(0, 80),
    }, agentId);
    demoteToWorkingNote({ agentId, messageId, turnNumber, text: persistedContent }, {
      why: 'a second answer to a message that arrived mid-turn; that message is answered by its own turn', owed,
    });
    persistedContent = null;
  }

  // Proactive-send backoff: past the threshold of consecutive unprompted settled-wake replies, the next stays in
  // chat and is not pushed. Deliberate surfaces are exempt, and so is a turn working a task that owes its owner
  // a delivery (`tracker/owed-delivery.ts`): the owner asked for that line.
  if (
    settledContextWakeTurn &&
    !deliberateSurfaceTurn &&
    !interAgentTurn &&
    result.toolCalls.length === 0 &&
    persistedContent && persistedContent.trim().length > 0
  ) {
    const streak = getProactiveSendStreak(agentId);
    if (owed().length > 0) {
      // Solicited: neither demoted nor counted toward the streak of unprompted pings.
      if (streak >= PROACTIVE_SEND_DEMOTE_THRESHOLD) {
        logger.info('v2: budget reached, but this turn is working a task that owes its owner a delivery; the line goes out (C8)', {
          agentId, turnNumber, streak, tasks: owed(),
        }, agentId);
      }
    } else if (streak >= PROACTIVE_SEND_DEMOTE_THRESHOLD) {
      logger.info('v2: proactive-send limit reached; the reply stays in chat and its push is held', {
        agentId, turnNumber, streak, threshold: PROACTIVE_SEND_DEMOTE_THRESHOLD,
      }, agentId);
      turnCtx.pushHeld = "the owner has not answered the agent's last unprompted messages";
    } else {
      // An allowed proactive delivery counts toward the streak and pings as normal.
      bumpProactiveSendStreak(agentId);
    }
  }

  // Marks a reply surfaced this turn; after the holds above, so a held line (now null) does not count.
  if (persistedContent && persistedContent.trim().length > 0 && !state.surfacedReplyThisTurn) {
    state = advance(state, { surfacedReplyThisTurn: true });
  }

  sc.persistedContent = persistedContent;
  return proceed(state);
}
