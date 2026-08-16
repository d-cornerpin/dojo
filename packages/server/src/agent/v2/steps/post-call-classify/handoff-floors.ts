// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE TWO DELEGATION-AND-DELIVERY FLOORS, moved byte-faithfully
// out of `loop.ts`'s `postCallClassify` span:
//   • the A2A-HANDOFF floor (owner law 2026-07-09: a turn the USER triggered may never
//     end in silence because the work was delegated to a peer);
//   • the REMINDER-DELIVERY SILENCE floor (P3 wave, converted PHASE-4 T4: a turn
//     serving a `kind='reminder'` occurrence exists to SAY one thing to the owner).
//
// Both are one-more-round floors and both are ghost-recorded, so a floor that steers
// and is ignored is counted rather than repeated forever — `MAX_FLOOR_STEER_ATTEMPTS`
// is the cap and it is carried verbatim.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { askIdForMessage } from '../../../../work/store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
// T53: neither floor writes the events lane and neither calls `enqueueSteer` directly —
// both steer through the RC-19 door, which owns the enqueue and the durable row.
import { steerFireCount } from '../../steer-queue.js';
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
  // A2A-handoff floor (owner law 2026-07-09: a turn the user triggered may
  // never end in silence because work was delegated). The async handoff
  // contract tells the model to end its turn after send_to_agent; on a weak
  // model that instruction wins over "tell the user first," so a user-facing
  // turn can end with results in hand and nothing delivered (production
  // transcript 2026-07-09: live device list fetched, then a handoff, then
  // silence). Mutually exclusive with the promise floor above, which
  // requires a non-empty final reply; this one requires an EMPTY one.
  // PHASE-4 T4 (OR2): the engine used to deliver a handoff notice ITSELF here,
  // picked from `A2A_HANDOFF_ACK_POOL` and persisted on the owner's lane as an
  // assistant bubble — the engine wearing the agent's face, which is exactly what
  // OR2 removes. The ladder is now: steer, re-enter, steer ONCE MORE, re-enter, and
  // if the agent still says nothing, VERIFY against the delivery ledger and record a
  // SYSTEM fault in the platform's own voice (`recordFloorGhost`). Silence still stops
  // being a silent outcome; it stops being a sentence the engine puts in the agent's
  // mouth.
  // A successful explicit channel send this turn (explicitSendThisTurn)
  // means the user already heard something delivered on purpose; stand down.
  if (
    counterparty.kind === 'user' &&
    !isEngineTurn &&
    // 2026-07-23 (owner production transcript, duplicate status reply):
    // the floor's own law is "a turn the USER TRIGGERED may never end
    // in silence because work was delegated". A wake/bookkeeping turn
    // that happens to send an A2A serves nobody who is waiting; firing
    // there steered the model into re-announcing settled work. The
    // trigger row is the receipt that a human is actually waiting.
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
      const steer = again
        ? (
          `[System] Second time: this turn is STILL about to end with nothing said to the user, ` +
          `and they are waiting. Nothing else on this turn matters until they hear from you. ` +
          `WRITE one or two sentences to them now, directly in this conversation (do NOT call ` +
          `imessage_send or any send tool; the engine routes your reply): what you have, and ` +
          `that another agent is finishing the rest.`
        )
        : (
          `[System] You handed work to another agent and are ending this turn without telling ` +
          `the user anything. The user is waiting. WRITE the user a short reply NOW, directly in ` +
          `this conversation (do NOT call imessage_send or any send tool; the engine routes your ` +
          `reply): report any results you already have, and say you have asked another agent for ` +
          `the rest and will report back when they answer. Do not message the other agent again.`
        );
      // ── T53 (owner ruling 5) — ONE MODEL-FACING CHANNEL, AND IT IS THE QUEUE ──
      // This floor's whole product is the EXTRA ROUND it buys with `continueLoop` below,
      // and the events-lane row this site also wrote could not appear in it: the tail query
      // drops `role='user'` rows created after the turn boundary, so the second copy landed
      // a turn later, after the ladder had already spent its two attempts and recorded its
      // ghost. `persistEngineSteer` files the same KEYED entry ('' then 'retry', so the
      // counter still climbs to `MAX_FLOOR_STEER_ATTEMPTS`) and writes the durable
      // `role='system'` row that keeps the steer on the record.
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
    // OR2's honest end of the ladder. Both steers are spent. VERIFY against the
    // delivery ledger before calling it a ghost — the model may have answered on a
    // channel this loop-local check cannot see, and accusing it of silence on an
    // absence is the reasoning non-negotiable #15 forbids.
    // RC-4.2's carve-out is preserved and re-stated as its own condition: a peer box
    // handles a silent handoff on its own lane, so an agent-flagged counterparty was
    // never owed the old notice and is not owed a ghost record either.
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

  // ── Reminder-delivery silence floor (P3 wave, 2026-07-21; CONVERTED PHASE-4 T4) ──
  // A turn serving a kind='reminder' occurrence exists to SAY one thing to the owner.
  // Observed silent-close: the model closed the run (correct bookkeeping) and ended
  // without replying, so the reminder never reached the owner at all.
  //
  // ⚠ WHAT CHANGED, AND WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE. The old floor read
  // the work row's own `description` and delivered `Reminder: <it>` as an ASSISTANT
  // message on the owner's lane. It was described as "deterministic and model-free",
  // and that is true and is the problem: the owner saw their agent remind them, in
  // their agent's voice, about a thing their agent had said nothing about. The kit's
  // own reminder clause used to pick its delivery with a regex over the row text, which
  // that fallback satisfies perfectly — so the engine speaking as the agent scored
  // GREEN (T4S1 §4.2b measured it). OR2: the AGENT is told, the agent speaks.
  //
  // The reminder text is handed to the MODEL as a steer, twice, and the delivery is
  // verified on the answered edge. If it still says nothing, that is a system fault and
  // it is recorded as one, in the platform's own voice, against the occurrence row.
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
          const steer = remAttempts === 1
            ? (
              `[System] Second time: this reminder still has not reached the owner. It is the ` +
              `only reason this turn exists. WRITE it to them now, in your own words, directly ` +
              `in this conversation (do NOT call imessage_send or any send tool; the engine ` +
              `routes your reply). The reminder is: ${remText}`
            )
            : (
              `[System] This turn is delivering a reminder and is about to end with nothing said ` +
              `to the owner. WRITE it to them now, in your own words, directly in this ` +
              `conversation (do NOT call imessage_send or any send tool; the engine routes your ` +
              `reply). The reminder is: ${remText}`
            );
          // ── T53 (owner ruling 5) — ONE MODEL-FACING CHANNEL, AND IT IS THE QUEUE ──
          // Of the seven double-writers this is the site where the second channel was worst:
          // the steer ends with the REMINDER'S OWN WORDS, and the events lane renders a
          // ≤400-char gist, so past a 251-character prefix the copy that reached the model a
          // turn later was a reminder with the reminder cut off. (Both arms of that boundary
          // are driven in `the-second-channel-stops-double-writing.test.ts`.) OR2's whole
          // point here is that the AGENT says the reminder in its own words; a truncated
          // second copy on a later turn is not that, and it could not reach the round this
          // floor buys in any case. `persistEngineSteer` files the same KEYED entry and
          // writes the durable `role='system'` row.
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
