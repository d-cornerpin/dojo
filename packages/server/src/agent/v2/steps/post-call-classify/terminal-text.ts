// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — WHAT ACTUALLY GETS PERSISTED AS THE AGENT'S TEXT, and the
// Lane-2 start line, moved byte-faithfully out of `loop.ts`'s `postCallClassify`
// span. Four decisions in order: the persistence classifier's verdict, the two
// copied-markup strips (system routing tags, per-message time stamps), the
// suppression arm, and the pre-tool narration that is promoted to a real reply when
// a human is waiting on it.
//
// ⚠ THIS IS WHERE THE ACK-DELIVERY PAIR IS WRITTEN, and it is why CUT 8 owed three
// carrier commits: `turnCtx.engineStartAckDeliveredThisTurn` and
// `turnCtx.deferredDeliveredByAck` are set HERE and read by the wall-clock timer,
// by the redundant-closeout floor and by the next iteration's gates. Handed back by
// value the timer would ack a person who has already been acked.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { INTERNAL_WORKING_NOTE_PREFIX, WORKING_NOTE_PREFIX } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent, START_ACK_ORIGIN_INTENT } from '../../../../memory/message-store.js';
import { type AgentTurnState } from '../../state.js';
import { outputPersistenceClassifier, stripLeadingTimeStamp } from '../../classifiers/output.js';
// T19 (D1): the closed, declared inventory of scheduled work that owes a person a message.
// Asked, never re-typed — a fifth copy of "is this a reminder" is what the declaration exists
// to prevent.
import { DELIVERABLE_OWING_TASK_KINDS } from '../../../../work/deliverable-declaration.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** Decide the turn's persisted text and, when it is a start line, deliver it as one.
 *  No way out of the loop: every arm of this section proceeds. */
export async function runTerminalText(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, counterparty, deliverEngineUserAck, hasUnansweredUser, messageId,
    result, startAckRepliedNow, turnCtx, turnNumber,
  } = ctx;
  const { interAgentTurn } = sc;
  const persistenceDecision = outputPersistenceClassifier({
    responseText: result.content ?? null,
    toolCallsThisTurn: result.toolCalls,
    isInterAgentTrigger: interAgentTurn,
    sentToAgentThisTurn: state.sentToAgentThisTurn,
  });

  let persistedContent: string | null = result.content;
  // v2.5.7, strip system routing tags the LLM may have copied from
  // prior conversation history (e.g. "[SENT VIA IMESSAGE to the owner]")
  // before persisting OR routing to iMessage. This cleans both the
  // dashboard render path and the iMessage outbound path at the source,
  // and keeps the next turn's LLM context free of the hallucinated tags
  // (so we don't reinforce the pattern).
  if (persistedContent) {
    const { stripSystemTags } = await import('../../../../services/imessage-bridge.js');
    const cleaned = stripSystemTags(persistedContent);
    persistedContent = cleaned || null;
  }
  // Same class of copied-markup strip for the per-message time stamps
  // (2026-07-16): the floor model prefixes its own replies with the
  // bracket-time it sees on every historical message. Strip at the source
  // so persist, demotion capture, deferred delivery, and channel routing
  // all see clean text (see stripLeadingTimeStamp for the observed case).
  if (persistedContent) {
    const destamped = stripLeadingTimeStamp(persistedContent).trim();
    persistedContent = destamped.length > 0 ? destamped : null;
  }
  // On an inter-agent turn, suppress the text even when it accompanies tool
  // calls (intermediate planning text leaks otherwise). On normal turns keep
  // the long-standing "only suppress standalone trailing text" behavior.
  if (persistenceDecision.decision === 'suppress' && (result.toolCalls.length === 0 || interAgentTurn)) {
    logger.debug('v2: suppressed trailing text', {
      agentId,
      reason: persistenceDecision.reason,
      interAgentTurn,
    }, agentId);
    persistedContent = null;
  }
  // Channel-awareness (attribution redesign §5): assistant text that rides in
  // the SAME model response as one or more tool calls is the agent thinking-
  // before-acting, Lane-2 process narration ("Let me check the calendar",
  // "Close-out gate is released now, let me handle the other task", "Now I have a
  // clear picture, let me reply to the PM agent"), never a message to the user. The user
  // reply is ALWAYS the terminal message: a separate, tool-less response emitted
  // after the work completes (verified empirically, every legitimate reply is
  // tool-less; every preamble / machinery-narration / A2A-coordination leak rides
  // with a tool call). outputPersistenceClassifier already applies exactly this on
  // inter-agent turns; generalize it to ALL turns so preambles stop leaking into
  // the conversation on normal user turns too. Subsumes the prior
  // send_to_agent/broadcast-only suppression. Deterministic engine enforcement,
  // not prompt-hope (the weak-model correctness floor).
  let deliveredAsStartLine = false;
  if (persistedContent && result.toolCalls.length > 0) {
    // GOVERNING RULE (comms-audit G-SUP-2): on a turn a HUMAN is waiting on,
    // this text MIGHT be the genuine answer the weak model paired with a
    // closing tool (work_update(action="status"), etc.), the v2.7.24 capture below
    // exists for exactly that, but this blanket null defeated it (two patches
    // in conflict). Don't show it as a mid-turn bubble (avoid preamble leak),
    // but REMEMBER it: if the turn ends with no proper tool-less reply, the
    // finalize block recovers it so the ask is never silently dropped. On an
    // inter-agent / background turn it is coordination narration, hard-
    // suppress with no recovery (keeps A2A chatter off human channels).
    //
    // ⚠ UX-REPAIR ROUND 4 T19 (D1) — AND A SCHEDULER TURN HAS A WAITING HUMAN THAT
    // `hasUnansweredUser` CANNOT SEE. That flag asks whether an unanswered CHAT ROW exists,
    // and `preflight/turn-classification.ts` states the rule in so many words: *"Engine
    // events and A2A are not human conversations, so they never make this true."* A fired
    // reminder is the one shape where a person IS waiting and no unanswered row exists — the
    // wake IS the ask. On 2026-08-10 13:45Z the model wrote its reminder (`routine.`) twice,
    // each time in the same response as the `work_update` call the engine's own steer asked
    // for, and both times this arm was skipped, the text was demoted to `[working-note]`, and
    // the owner heard nothing. The capture's stated purpose — *"so the ask is never silently
    // dropped"* — was scoped to asks and could not reach a run.
    //
    // The question asked is the DECLARED one and nothing else: is this turn's root an
    // occurrence whose task was declared deliverable-owing (`work/deliverable-declaration.ts`,
    // the closed inventory `reminder|brief|report|notify`)? Never the run's prose, never a
    // guess about what the text looks like. A nightly backup's run owes nobody a message and
    // is unchanged, byte for byte.
    //
    // The header's empirical claim above — *"every legitimate reply is tool-less"* — was
    // measured on USER turns and stays the rule there; this incident is its recorded
    // scheduler-turn counterexample. Demote-don't-discard (owner 2026-07-10) is untouched:
    // the note is still written and the streamed bubble is still converted in place. The only
    // change is that the words are REMEMBERED, so `finalize/deferred-recovery.ts` can deliver
    // them if the turn ends with no tool-less reply.
    const userDeliverableRunTurn =
      turnCtx.root?.kind === 'occurrence' &&
      DELIVERABLE_OWING_TASK_KINDS.includes(turnCtx.servedWork?.taskKind ?? '');
    if ((hasUnansweredUser || userDeliverableRunTurn) && !interAgentTurn) {
      turnCtx.deferredUserReplyWithTools = persistedContent;
      // Steered start line (owner ruling 2026-07-22): the start-ack steer
      // asked the model to speak and this is its next text riding with
      // tool calls. Surface it NOW as the user-visible start line, the
      // model's own words at the moment they were said. Consumed so
      // nothing double-sends; the terminal reply still lands separately
      // when the work completes.
      if (
        turnCtx.startAckSteerArmedThisTurn &&
        !turnCtx.engineStartAckDeliveredThisTurn &&
        turnCtx.deferredUserReplyWithTools &&
        !startAckRepliedNow()
      ) {
        turnCtx.engineStartAckDeliveredThisTurn = true;
        deliveredAsStartLine = true;
        const startLine = turnCtx.deferredUserReplyWithTools.trim();
        turnCtx.deferredUserReplyWithTools = null;
        turnCtx.deferredDeliveredByAck = true;
        // Fresh id on purpose: messageId already holds this iteration's
        // persisted tool_use row, so reusing it makes the INSERT no-op and
        // the ack line never reaches the DB (caught by the ack scenario).
        // The doubled display the owner saw on .19 was ack row + demoted
        // NOTE of the same text; skipping the demotion below (the text was
        // promoted whole, nothing to demote) leaves exactly one copy.
        // UX-REPAIR T2: the engine KNOWS this bubble is a start line — it decided so
        // two statements up — and until now it threw the knowledge away at the door.
        // The stamp is what lets the settlement authority refuse it as an ask's
        // receipt (`work/ask-settlement.ts`, the seventh narrowing) instead of
        // marking a question answered before anybody has looked at it. The explicit
        // `'agent-text'` is the other half: origin_intent alone would classify the
        // row `fallback` (`shared/visibility.ts`), and this line is the MODEL'S OWN
        // WORDS pushed early (PHASE-4 T4), not engine-composed prose. Both facts
        // travel or neither should.
        await deliverEngineUserAck(startLine, START_ACK_ORIGIN_INTENT, null, 'agent-text');
        logger.info('v2 start-ack steer: model spoke its start line mid-work; delivered as the visible ack (streamed bubble promoted in place)', {
          agentId, turnNumber, preview: startLine.slice(0, 60),
        }, agentId);
      }
    }
    // Demote, don't discard (owner request 2026-07-10). This narration
    // already STREAMED into the user's chat live; classifying it out of the
    // conversation made the bubble visibly vanish, which reads as the engine
    // killing the agent mid-thought. Persist it as a [working-note] system
    // row (role='system' never enters model context, so this cannot feed the
    // re-answer class) and tell the dashboard to convert the streamed bubble
    // in place into a dimmed note. Live view and reload agree. Inter-agent
    // turns keep the hard suppression: their narration never streamed to the
    // user (chat:chunk is suppressed on those turns), so there is nothing on
    // screen to demote.
    if (!interAgentTurn && !deliveredAsStartLine) {
      try {
        const noteId = uuidv4();
        // RC-9: channel-aware demotion. On a ROUTED-channel human turn (iMessage /
        // SMS / Teams / email) exactly ONE routing pass delivers exactly ONE string
        // to the channel, while the dashboard live-mirrors EVERY iteration. A demoted
        // narration line here was NOT delivered to that channel, so a visible working
        // note reads as a second, contradictory reply (F-22: the dashboard showing
        // "Not yet, sending now" that never reached iMessage). Mark such notes
        // INTERNAL: prefix them [working-note:internal] and flag the broadcast so the
        // dashboard hides them by default (shown only in wordy/verbose mode). Owner
        // dashboard/voice turns are unchanged (there is one lane, nothing to confuse).
        const routedHumanChannel =
          counterparty.kind === 'user' &&
          (counterparty.relation === 'owner' || counterparty.relation === 'known_contact') &&
          (counterparty.channel === 'imessage' || counterparty.channel === 'sms' ||
           counterparty.channel === 'teams' || counterparty.channel === 'email');
        const notePrefix = routedHumanChannel ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX;
        // Chat-native system note: prefix-marked, NO origin stamp, same
        // convention as routing markers and dividers. An origin_kind of
        // 'engine' here would make the row inter-agent-shaped, and those
        // belong in the store, not messages (the NO_INTERAGENT_LEAK
        // invariant caught exactly that on the first draft of this).
        insertMessageIfAbsent({
          id: noteId, agentId, role: 'system',
          content: `${notePrefix}${persistedContent}`, turnNumber,
        });
        broadcast({
          type: 'chat:workingnote',
          agentId,
          messageId,
          noteId,
          content: persistedContent,
          ...(routedHumanChannel ? { internal: true } : {}),
        });
      } catch { /* cosmetic; never block the turn */ }
    }
    persistedContent = null;
  }

  sc.persistedContent = persistedContent;
  sc.deliveredAsStartLine = deliveredAsStartLine;
  return proceed(state);
}
