// The `[no-reply]` sentinel: a trailing one is stripped, a bare one ends the turn silently with a closed
// marker, and a prose decline is held once and steered. Silence is refused where a person is owed: a captured
// answer is promoted, a live call gets a spoken ack, and a ghosted work ask is steered.

import { v4 as uuidv4 } from 'uuid';
import { NO_REPLY_CLOSED_MARKER, NO_REPLY_TAIL_RE, isBareNoReplySentinel } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent, readPersistedRow } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { recordedAnswerInConversation } from '../../answered-edge.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import { holdAndSteer } from './closeout-floors.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';
import { userWords } from '../../turn-address.js';

const logger = createLogger('v2-loop');

/** A reply that OPENS with an unambiguous self-decline. */
const DECLINE_OPENER_RE = /^\s*[`*_>]*\s*(?:no\s+(?:reply|response)\s+(?:needed|necessary|required|warranted)\b|no\s+need\s+to\s+(?:reply|respond)\b|nothing\s+(?:to\s+)?(?:reply|respond|to\s+say)\b|i(?:'|’)?ll\s+hold\s+off\s+(?:on\s+)?repl|i\s+(?:won(?:'|’)?t|will\s+not|am\s+not\s+going\s+to)\s+(?:reply|respond)\b)/i;

/** The no-reply sentinel, the decline-as-prose variant, and the ghosted-ask ladder. */
export async function runNoReply(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, counterparty, latestUserSource,
    messageId, noteTerminalAnswer, persistAndBroadcastSystemRow, result, triggerRow,
    turnCtx, turnNumber,
  } = ctx;
  const chosenConversationId = turnCtx.conversationId ?? null;
  let { persistedContent } = sc;
  // A bare sentinel is swallowed (never echoed to iMessage or chat) and a system marker persisted, so the
  // next turn sees the silence and nothing routes. A sentinel appended after a real reply is just stripped.
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

  // Decline-as-prose: a reply that opens with an unambiguous self-decline reads as a no-reply, not a
  // message to route. Leading phrase only, so a reply mentioning "no reply" mid-sentence is untouched.
  const declineRead =
    persistedContent !== null &&
    result.toolCalls.length === 0 &&
    !isBareNoReply &&
    // Never on a turn a human is waiting on: a genuine answer can open with such a phrase.
    !triggerRow &&
    DECLINE_OPENER_RE.test(persistedContent);

  // The agent is told how its line reads and decides: the same line written again goes out as written,
  // and only its own [no-reply] sends nothing.
  if (declineRead && persistedContent) {
    const t = persistedContent.replace(/\s+/g, ' ').trim();
    const held = holdAndSteer(state, { agentId, messageId: ctx.messageId, turnNumber, sc, db: ctx.db }, {
      floor: 'prose-decline', text: persistedContent,
      steer: `[Engine record: your reply opens as a decision not to reply: "${t.length > 120 ? `${t.slice(0, 120)}…` : t}". `
        + 'It has not been sent; written as your final reply again, it is sent as written. A final reply of [no-reply] sends nothing.]',
    });
    if (held) return held;
  }
  // A prose decline is never a no-reply on the engine's reading: once told, the agent's repeat is its
  // reply. Only the agent's own [no-reply] is a no-reply.
  const isDeclineNonReply = false;

  // A bare [no-reply] on a turn serving a human, with nothing surfaced and a captured text-with-tools
  // answer, promotes those words: every authorized human message gets exactly one substantive answer.
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
    // Voice and phone are live calls, where silence reads as a dropped call: swap the sentinel for a short
    // spoken ack. Phone utterances carry no `source`, so phone is told apart by `inboundChannel`.
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
    // Ghosted work ask: a bare [no-reply] on a human ask classified as work, with nothing surfaced, gets a
    // steer to point at the settled delivery or do the work. If a promoted start-ack line was shown, the
    // steer quotes it and asks the model to confirm it or answer now: ambiguity resolves toward answering.
    // Each rung fires once; a model that ghosts both leaves silence standing, loudly logged.
    const promotedRowId = turnCtx.startAckPromotedRowId;
    const ghostedWorkAsk =
      isBareNoReply && !!triggerRow && turnCtx.inboundClassifiedAsWork &&
      !state.surfacedReplyThisTurn;
    if (ghostedWorkAsk && !steerFired(state.steerQueue, 'ghosted-ask')) {
      broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
      // A named retract drops this iteration's empty bubble; a promoted line is a different row and stays.
      broadcast({ type: 'chat:retract', agentId, messageId });
      // The model's own words read back off their row, never a paraphrase; empty when nothing was promoted.
      let promotedSight = '';
      if (promotedRowId) {
        try {
          const said = (readPersistedRow(promotedRowId)?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
          if (said.length > 0) {
            promotedSight =
              ` ENGINE RECORD: ${userWords(turnCtx.address)} HAS heard one line from you this turn — while you were `
              + `working, the engine surfaced your own words to them: "${said}". The ask ledger `
              + 'still shows their question OPEN, because nothing is recorded as its answer yet. '
              + 'If that line WAS your answer, say so now in one ordinary reply so it is on the '
              + 'record; if it was only a status line, give them the answer itself now.';
          }
        } catch { /* the sight is a courtesy; the steer stands without it */ }
      }
      const steerText =
        `[Engine hint: you ended with [no-reply], but this message is a direct request from ${userWords(turnCtx.address)}. ` +
        'A direct ask never ends in silence. If this exact work was already delivered (check the RECENTLY ANSWERED engine record and your tracker), ' +
        `reply with ONE brief line pointing to the existing answer or delivery. Otherwise, do the work now, including creating the tracker task first if ${userWords(turnCtx.address)} asked for one.` +
        promotedSight + ']';
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
      // Second and last steer: the engine never speaks as the agent, so it hands back the model's own
      // recorded answer to restate. The lookup needs the conversation id (a UUID), never the conv key.
      try {
        const excerpt = (recordedAnswerInConversation(agentId, chosenConversationId) ?? '')
          .replace(/\s+/g, ' ').trim().slice(0, 220);
        if (excerpt.length > 0) {
          const steer2 =
            `[Engine record: you again ended with [no-reply] on ${userWords(turnCtx.address)}'s direct ask, but you already answered this earlier. Your recorded answer: "${excerpt}". Reply now with one brief line in your own words pointing back to that. Do not re-do the work and do not stay silent.]`;
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
      // Intentional silence: drop deferred narration so the finalize recovery cannot resurrect it.
      turnCtx.deferredUserReplyWithTools = null;

      // A silent turn that opened a canvas or queued attachments still surfaces them on this bubble; draining
      // here pre-empts the end-of-turn safety net, so the chip is surfaced exactly once.
      let surfacedNoReplyAttachments = false;
      try {
        const { drainPendingAttachments } = await import('../../../pending-attachments.js');
        const noReplyAttachments = drainPendingAttachments(agentId);
        if (noReplyAttachments.length > 0) {
          // A short factual line tells the user what opened; the canvas chip rides on it.
          const canvasDoc = noReplyAttachments.find((a) => a.openInCanvas);
          const noReplyCaption = canvasDoc
            ? `Dojo: opened ${canvasDoc.filename ? `"${canvasDoc.filename.replace(/\.[a-z0-9]+$/i, '')}"` : 'a document'} in the canvas.`
            : '';   // no engine words in the agent's voice
          const surfacedRow = insertMessageIfAbsent({
            id: messageId, agentId, role: 'assistant', content: noReplyCaption,
            attachments: JSON.stringify(noReplyAttachments), turnNumber,
          });
          if (surfacedRow && noReplyCaption) (await import('../../../dojo-voice.js')).tellAgentFilesPostedByDojo(agentId, noReplyAttachments, noReplyCaption, 'because you opened it and ended with no reply');   // the agent is told what the Dojo posted
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

          // An iMessage requester gets the files on their channel too: the end-of-turn router is skipped on a
          // no-reply turn, and the safety net cannot find drained files.
          if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
            try {
              const { textFilesToRequester } = await import('../text-files-to-requester.js');
              await textFilesToRequester(agentId, counterparty.senderId, noReplyAttachments as Array<{ path?: string; filename?: string }>);
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
        // End the bubble's streaming state (or the thinking dots stay), then retract it so no empty
        // assistant row renders; a retract of a bubble that is not there is a no-op.
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
        });
        broadcast({ type: 'chat:retract', agentId, messageId });
        const sysId = uuidv4();
        // The shared constant, so the row matches the readers that look for it.
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
      // This turn's rows already carry the conversation from their INSERT; no re-tag is needed.
      logger.info('v2: agent ended turn silently via [no-reply] sentinel', {
        agentId, loopCount: state.loopCount,
      }, agentId);
    }
  }

  sc.persistedContent = persistedContent;
  return proceed(state);
}
