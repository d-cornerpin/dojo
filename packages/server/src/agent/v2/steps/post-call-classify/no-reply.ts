// The `[no-reply]` sentinel: a trailing one is stripped, a bare one ends the turn silently with a closed
// marker. A captured answer is promoted instead, and a live call gets a spoken ack.

import { v4 as uuidv4 } from 'uuid';
import { NO_REPLY_CLOSED_MARKER, NO_REPLY_TAIL_RE, isBareNoReplySentinel } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The no-reply sentinel: stripped when trailing, promoted or spoken over when owed, else a silent end. */
export async function runNoReply(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, latestUserSource,
    messageId, noteTerminalAnswer, result, triggerRow,
    turnCtx, turnNumber,
  } = ctx;
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
  if (!noReplyOverridden && isBareNoReply && (latestUserSource === 'voice' || state.inboundChannel === 'phone')) {
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
  } else if (!noReplyOverridden && isBareNoReply) {
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
        // The files ride a reply to the person's channel at the turn's end.
        turnCtx.replyFiles.push(...noReplyAttachments);
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

  sc.persistedContent = persistedContent;
  return proceed(state);
}
