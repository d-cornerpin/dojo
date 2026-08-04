// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE `[no-reply]` SENTINEL AND ITS LADDER, moved byte-faithfully
// out of `loop.ts`'s `postCallClassify` span.
//
// The agent says `[no-reply]` when an incoming message closes the conversation and
// there is nothing to answer. Three things had to be true for that to be safe, and all
// three are here: the BARE sentinel is recognised, the DECLINE-AS-PROSE variant ("no
// reply needed here…") is recognised as the same intent, and REG-3's override refuses
// the silence on a turn a human is genuinely waiting on.
//
// THE GHOSTED-WORK-ASK LADDER IS THE HEART OF IT: a WORK ask answered with silence gets
// one hint, and if the agent ghosts again it gets its OWN RECORDED ANSWER handed back —
// which is the second rung, and the reason `turnCtx.inboundClassifiedAsWork` (CUT 6's
// carrier) exists at all.
//
// TWO of the seventeen `continue` conversions are here, both rungs of that ladder.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { NO_REPLY_CLOSED_MARKER, NO_REPLY_TAIL_RE, isBareNoReplySentinel } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent, tagTurnOutputConversationId } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { recordedAnswerInConversation } from '../../answered-edge.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The no-reply sentinel, the decline-as-prose variant, and the ghosted-ask ladder. */
export async function runNoReply(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, chosenConvKey, counterparty, latestUserSource,
    messageId, noteTerminalAnswer, persistAndBroadcastSystemRow, result, triggerRow,
    turnCtx, turnNumber,
  } = ctx;
  const chosenConversationId = turnCtx.conversationId ?? null;
  let { persistedContent } = sc;
  // No-reply sentinel: the agent emits `[no-reply]` (case-insensitive,
  // possibly with surrounding whitespace) when the incoming message
  // closes the conversation (goodnight, that's all, etc.) and there's
  // nothing actionable to respond to. We swallow the literal sentinel
  // (so it doesn't get echoed via iMessage or rendered in chat) and
  // persist a system marker instead, so the agent's next turn sees
  // that the prior turn ended silently. Skipping persistedContent here
  // means lastAssistantTextForIM stays unset, which suppresses the
  // iMessage routing at end-of-turn. Critical for preventing endless
  // back-and-forth chatter on iMessage.
  //
  // Two forms: (a) the entire message IS the sentinel, swallow the
  // bubble entirely, persist a [conversation closed] system marker.
  // (b) the message ENDS with the sentinel (optionally wrapped in
  // backticks/asterisks), strip just the sentinel so the user sees
  // the actual reply text. This handles the common model mistake of
  // appending the sentinel after a real reply (2026-06-02 bug fix:
  // the primary agent was tail-appending `[no-reply]` to user-facing
  // messages and the literal text was rendering in chat).
  // PHASE-1 T8: both shapes come from @dojo/shared now. They were spelled out here and
  // again in the dashboard's marker lib, which is the same drift that made the closed
  // marker unreadable to its own matcher.
  if (
    persistedContent &&
    result.toolCalls.length === 0 &&
    NO_REPLY_TAIL_RE.test(persistedContent) &&
    !isBareNoReplySentinel(persistedContent)
  ) {
    const cleaned = persistedContent.replace(NO_REPLY_TAIL_RE, '').trimEnd();
    if (cleaned.length > 0) {
      logger.info('v2: stripped trailing [no-reply] sentinel from user-facing message', {
        agentId, originalLength: persistedContent.length, cleanedLength: cleaned.length,
      }, agentId);
      persistedContent = cleaned;
    }
  }
  const isBareNoReply =
    persistedContent !== null &&
    result.toolCalls.length === 0 &&
    isBareNoReplySentinel(persistedContent);

  // Decline-as-prose: the weak model sometimes states "I'm not going to reply to
  // this" in prose ("No reply needed here, I can't address X…") instead of the
  // [no-reply] sentinel. Treated as a normal reply, that deliberation gets ROUTED
  // to the counterparty, it was literally sent to Ben as the Globex renewal email
  // reply (thread "Renewal") AND shown in the owner's chat. Honor the agent's
  // stated intent: a message that OPENS with an unambiguous self-decline is a
  // no-reply, not a message to anyone, suppress + don't route, same as the
  // sentinel. Conservative: leading phrase only, no tool calls, so it never
  // swallows a substantive reply that merely mentions "no reply" mid-sentence.
  const DECLINE_OPENER_RE = /^\s*[`*_>]*\s*(?:no\s+(?:reply|response)\s+(?:needed|necessary|required|warranted)\b|no\s+need\s+to\s+(?:reply|respond)\b|nothing\s+(?:to\s+)?(?:reply|respond|to\s+say)\b|i(?:'|’)?ll\s+hold\s+off\s+(?:on\s+)?repl|i\s+(?:won(?:'|’)?t|will\s+not|am\s+not\s+going\s+to)\s+(?:reply|respond)\b)/i;
  const isDeclineNonReply =
    persistedContent !== null &&
    result.toolCalls.length === 0 &&
    !isBareNoReply &&
    // N-2 (comms-audit): NEVER treat a prose "decline" as no-reply on a turn a
    // human is WAITING on. The DECLINE_OPENER_RE false-positives on a genuine
    // answer that merely opens with such a phrase ("No response needed on the
    // receipt, your June total is $432."), which was nulled and dropped on every
    // channel. The governing rule: suppression never fires when serving a waiting
    // ask. A bare [no-reply] (the agent's explicit, whole-message choice) is still
    // honored for chatter-prevention; only the FUZZY prose-decline is guarded.
    !triggerRow &&
    DECLINE_OPENER_RE.test(persistedContent);

  // REG-3 refinement (2026-07-16, the trivial-save sequence): intentional
  // silence stands on turns nobody is waiting on (the narration-resurrection
  // case REG-3 protects). But a bare [no-reply] on a turn SERVING A HUMAN
  // TRIGGER, with NO surfaced reply and a captured text-with-tools answer,
  // means "I already answered" while the answer only exists as a demoted
  // note. Contract #1 (every authorized human message gets exactly one
  // substantive answer) outranks the sentinel: promote the model's own
  // captured words as the terminal reply. isDeclineNonReply already
  // requires !triggerRow (N-2), so only the bare sentinel can reach here.
  let noReplyOverridden = false;
  if (
    isBareNoReply &&
    triggerRow &&
    !state.surfacedReplyThisTurn &&
    !turnCtx.deferredDeliveredByAck &&
    turnCtx.deferredUserReplyWithTools &&
    turnCtx.deferredUserReplyWithTools.trim().length > 0
  ) {
    persistedContent = turnCtx.deferredUserReplyWithTools.trim();
    turnCtx.deferredUserReplyWithTools = null;
    noReplyOverridden = true;
    logger.info('v2: [no-reply] on a served human turn with an undelivered captured answer; promoting it as the reply', {
      agentId, turnNumber, preview: persistedContent.slice(0, 60),
    }, agentId);
  }
  if (!noReplyOverridden && (isBareNoReply || isDeclineNonReply) && (latestUserSource === 'voice' || state.inboundChannel === 'phone')) {
    // Voice AND phone are LIVE conversations, so going silent reads as a dropped
    // call. (comms-audit B-1/phone: phone utterances persist with NO `source`, so
    // they read as 'text' and were EXCLUDED from this guard, a bare [no-reply] on
    // a live call left the caller in dead air. Phone is distinguished by
    // inboundChannel==='phone'.) The voice-conduct prompt block tells the agent not
    // to use [no-reply] here, but the weakest model (the correctness floor) still
    // emits it sometimes, so the engine enforces the floor: swap the bare sentinel
    // for a short spoken acknowledgment and let it flow through the normal persist +
    // TTS path instead of swallowing into dead air.
    const voiceAcks = [
      'Okay, just say the word.',
      "Sounds good, I'm here when you need me.",
      "Got it. Holler when you're ready.",
    ];
    persistedContent = voiceAcks[Math.floor(Math.random() * voiceAcks.length)];
    logger.info('v2: [no-reply] on a voice turn, substituted a brief spoken acknowledgment to avoid dead air', {
      agentId, loopCount: state.loopCount,
    }, agentId);
  } else if (!noReplyOverridden && (isBareNoReply || isDeclineNonReply)) {
    // ── Ghosted-work-ask floor (2026-07-22, battery catch) ── Contract #1
    // (every authorized human message gets exactly one substantive answer)
    // reaches its last unguarded gap here: a bare [no-reply] on a turn
    // serving a human ask the classifier read as WORK, with nothing
    // surfaced and nothing captured to promote. Observed: a repeat of an
    // already-delivered job made the model go silent in one model call
    // (the settled-work record taught it not to re-answer; it over-read
    // that as "don't reply at all"). Silence on chatter stays honored
    // (REG-3); a work ask gets a steer first: reply with a pointer to the
    // settled delivery, or do the work. If the model ghosts the steer too
    // and this conversation HAS an engine-recorded settled answer, a second
    // steer hands the model its own recorded words to restate (the engine
    // never speaks as the agent, owner ruling 2026-07-22); double-ghosted
    // silence stands, loudly logged, and the ladder owns the follow-up.
    const ghostedWorkAsk =
      isBareNoReply && !!triggerRow && turnCtx.inboundClassifiedAsWork &&
      !state.surfacedReplyThisTurn && !turnCtx.deferredDeliveredByAck;
    if (ghostedWorkAsk && !steerFired(state.steerQueue, 'ghosted-ask')) {
      broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
      // T9: was an EMPTY chat:message meaning "drop this bubble" — an event named
      // "here is a message" carrying its own opposite, and the one shape that made
      // "every broadcast has a row" unstateable. It is a named event now.
      broadcast({ type: 'chat:retract', agentId, messageId });
      const steerText =
        '[Engine hint: you ended with [no-reply], but this message is a direct request from the user. ' +
        'A direct ask never ends in silence. If this exact work was already delivered (check the RECENTLY ANSWERED engine record and your tracker), ' +
        'reply with ONE brief line pointing to the existing answer or delivery. Otherwise, do the work now, including creating the tracker task first if the user asked for one.]';
      try {
        persistAndBroadcastSystemRow(steerText);
      } catch { /* dashboard row is best effort */ }
      state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'ghosted-ask', content: steerText, atLoop: state.loopCount }) });
      logger.info('v2 ghosted-work-ask floor: bare [no-reply] on a work-classified human ask with nothing surfaced; steering once (answer-or-point, never silence)', {
        agentId, turnNumber, classifierKeyed: true,
      }, agentId);
      return continueLoop(state);
    }
    if (ghostedWorkAsk && steerFired(state.steerQueue, 'ghosted-ask') && !steerFired(state.steerQueue, 'ghosted-ask-answer') && chosenConversationId) {
      // Second (last) steer, owner ruling 2026-07-22: the engine never
      // speaks as the agent, so instead of re-serving the recorded answer
      // itself, hand the model its own recorded words to restate. If this
      // is ghosted too, silence stands (marker row + loud log below); the
      // ladder and stamps own the follow-up.
      //
      // PHASE-3 STRIP-3: gate and lookup both read `chosenConvKey` before.
      // `recordedAnswerInConversation` filters `m1.conversation_id = ?` — a UUID column —
      // and a conv key matches 0 of the dev body's 6,975 stamped rows where real ids match
      // 954, so this rung had never once fired since the T10I rekey. Both values are
      // `string` and the key crossed a function boundary: no type and no bind-site grep
      // could see it. Pinned by integration.test.ts, "STRIP-3 … (a)".
      try {
        const excerpt = (recordedAnswerInConversation(agentId, chosenConversationId) ?? '')
          .replace(/\s+/g, ' ').trim().slice(0, 220);
        if (excerpt.length > 0) {
          const steer2 =
            `[Engine record: you again ended with [no-reply] on the user's direct ask, but you already answered this in this conversation. Your recorded answer: "${excerpt}". Reply now with one brief line in your own words pointing back to that. Do not re-do the work and do not stay silent.]`;
          try {
            persistAndBroadcastSystemRow(steer2);
          } catch { /* dashboard row is best effort */ }
          broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
          state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'ghosted-ask-answer', content: steer2, atLoop: state.loopCount }) });
          logger.info('v2 ghosted-work-ask floor: model ghosted the first steer; second steer hands it its own recorded answer to restate', {
            agentId, turnNumber,
          }, agentId);
          return continueLoop(state);
        }
      } catch { /* best effort; silence falls through to the marker below */ }
    }
    if (ghostedWorkAsk && steerFired(state.steerQueue, 'ghosted-ask')) {
      logger.warn('v2 ghosted-work-ask floor: model ghosted the steer(s) on a work-classified human ask; engine does not speak for the agent, silence stands with the marker row', {
        agentId, turnNumber, secondSteerFired: steerFired(state.steerQueue, 'ghosted-ask-answer'),
      }, agentId);
    }
    {
      if (isDeclineNonReply) {
        logger.info('v2: agent declined in prose ("no reply needed…"), honoring intent as no-reply (not routing it)', {
          agentId, turnNumber, preview: (persistedContent ?? '').slice(0, 60),
        }, agentId);
      }
      persistedContent = null;
      // REG-3 (comms-audit): the agent INTENTIONALLY went silent ([no-reply] /
      // prose decline). Discard any deferred text-with-tools narration so the
      // G-SUP-2 finalize recovery can't resurrect it and override the decision.
      turnCtx.deferredUserReplyWithTools = null;

      // Silent turn that still opened a canvas (or queued attachments via
      // show_to_user): surface the pending "Open in canvas" chip / thumbnails
      // onto this otherwise-empty assistant bubble instead of dropping it. The
      // user asked the agent to open a canvas; even on [no-reply] they need the
      // affordance back to it (an explicit canvas_render + [no-reply] otherwise
      // left NO chip). Draining here also pre-empts the end-of-turn safety net,
      // so the chip is surfaced exactly once.
      let surfacedNoReplyAttachments = false;
      try {
        const { drainPendingAttachments } = await import('../../../pending-attachments.js');
        const noReplyAttachments = drainPendingAttachments(agentId);
        if (noReplyAttachments.length > 0) {
          // A short factual line so the bubble renders cleanly (and tells the
          // user WHAT opened); the "Open in canvas" chip rides on it.
          const canvasDoc = noReplyAttachments.find((a) => a.openInCanvas);
          const noReplyCaption = canvasDoc
            ? `Opened ${canvasDoc.filename ? `"${canvasDoc.filename.replace(/\.[a-z0-9]+$/i, '')}"` : 'a document'} in the canvas.`
            : 'Here you go.';
          insertMessageIfAbsent({
            id: messageId, agentId, role: 'assistant', content: noReplyCaption,
            attachments: JSON.stringify(noReplyAttachments), turnNumber,
          });
          noteTerminalAnswer(messageId, 'canvas chip surfaced as the reply');
          broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: messageId, agentId, role: 'assistant' as const,
              content: noReplyCaption,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
              attachments: noReplyAttachments,
            },
          });
          surfacedNoReplyAttachments = true;

          // N-3 (comms-audit): same gap as A-1, on the [no-reply] path. The drain
          // above surfaces the files onto the DASHBOARD bubble only. If the requester
          // is on iMessage, the deliverable they asked for never reaches their channel
          // (the end-of-turn channel router is skipped on a no-reply turn, and the
          // stranded safety net can't re-find these, they're already drained). Deliver
          // to the iMessage counterparty here. iMessage user only (a dashboard turn
          // already rendered them in the bubble).
          if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
            try {
              const { sendIMessageWithAttachment } = await import('../../../../services/imessage-bridge.js');
              for (const att of noReplyAttachments as Array<{ path?: string }>) {
                if (att.path) sendIMessageWithAttachment(counterparty.senderId, att.path, '');
              }
            } catch (err) {
              logger.warn('N-3: no-reply attachment iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
            }
          }
        }
      } catch (err) {
        logger.warn('v2: failed to surface no-reply canvas chip', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }

      if (!surfacedNoReplyAttachments) {
        // Clear the streaming bubble in the dashboard. We need BOTH events:
        //  - chat:chunk done:true ends the bubble's streaming state (without
        //    this the thinking dots stay forever, since the normal done:true
        //    at line ~923 only fires when persistedContent or tools exist).
        //  - chat:retract drops the bubble entirely so the chat doesn't show an
        //    empty assistant row. T9: this was an EMPTY chat:message, and the
        //    overload had a visible failure mode — when NO bubble existed for the
        //    id the client APPENDED the empty message instead of dropping it, and
        //    it rendered as a bare timestamp (research 17 §4 item 1). A retract on
        //    a bubble that is not there is a no-op.
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
        });
        broadcast({ type: 'chat:retract', agentId, messageId });
        const sysId = uuidv4();
        // THE COMMA IS GONE (PHASE-1 T8). This literal was written with a comma while
        // both matchers — @dojo/shared's constant and the dashboard's inline copy —
        // expected an em-dash, so the row this line writes was invisible to its own
        // reader and rendered raw in the owner's chat. Taking the constant is what makes
        // that class impossible rather than merely fixed.
        const sysContent = NO_REPLY_CLOSED_MARKER;
        try {
          insertMessageIfAbsent({ id: sysId, agentId, role: 'system', content: sysContent, turnNumber });
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: sysId, agentId, role: 'system' as const,
              content: sysContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.warn('v2: failed to persist no-reply marker', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }
      // Turn continuity: declining ([no-reply]) IS addressing the counterparty.
      // Tag this turn's own messages with the conversation, that conv_key is
      // the durable "served" signal (the conversation won't be re-picked) AND
      // the content-isolation tag (its work won't bleed into another turn).
      if (chosenConvKey) {
        try { if (chosenConversationId) tagTurnOutputConversationId({ agentId, turnNumber, conversationId: chosenConversationId }); } catch { /* best effort */ }
      }
      logger.info('v2: agent ended turn silently via [no-reply] sentinel', {
        agentId, loopCount: state.loopCount,
      }, agentId);
    }
  }

  sc.persistedContent = persistedContent;
  return proceed(state);
}
