// Persists the model's output: the assistant row (text plus tool_use blocks), attachments, fillers
// and broadcasts. The filler latch lives on `turnCtx`, not a module local, so it fires once per turn.

import type Anthropic from '@anthropic-ai/sdk';
import { stripMoodMarker } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { redactAssistantBlocksForPersist, redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { ownOutputBroadcast } from '../../../interagent-broadcast.js';
import { isStopFenced } from '../../../shared-state.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/**
 * Reply text discharges the owed compile, so the gate comes down for the rest of the turn. Erring
 * toward disarm is deliberate: the gate re-arms next turn from the spine if the compile is pending.
 */
function compileDutyDischarged(s: AgentTurnState): Partial<AgentTurnState> {
  return s.compileOwedAskIds.length > 0 && !s.compileGateSatisfied
    ? { compileGateSatisfied: true }
    : {};
}

/** Persist the assistant's own row and everything that rides with it. No way out. */
export async function runPersistAssistant(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agent, agentId, configuredModelId, counterparty, inboundChannel, latestUserSource,
    messageId, noteTerminalAnswer, result, turnCtx, turnNumber,
  } = ctx;
  const chosenConversationId = turnCtx.conversationId ?? null;
  const { interAgentTurn, persistedContent } = sc;
  // An A2A turn's rows carry their thread from birth; the writer derives the rest of the label.
  const a2aThreadId = counterparty.kind === 'agent'
    ? (ctx.unrepliedAssign?.threadId ?? (turnCtx.root?.kind === 'a2a' ? turnCtx.root.id : null))
    : null;

  // A stop can land while post-call stages await, so re-read the fence before the row and broadcast.
  // The retract clears any partial bubble streamed live; the stop's record is written by the exit path.
  // `proceed`, not `abandon`: execute's own checkpoint cancels the tool batch and finalize still runs.
  if (isStopFenced(agentId)) {
    sc.hasXmlFallbackTools = result.toolCalls.some((tc) => tc.id.startsWith('text_tool_'));
    sc.effectiveModelIdForPersist =
      state.modelId === '__auto__' ? configuredModelId : state.modelId;
    broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
    broadcast({ type: 'chat:retract', agentId, messageId });
    logger.info('v2: the owner stopped this agent while the post-call stages ran — the reply is NOT persisted and NOT broadcast', {
      agentId, turnNumber, hadText: !!(persistedContent && persistedContent.trim().length > 0),
      toolCalls: result.toolCalls.length,
    }, agentId);
    return proceed(state);
  }
  // Synthetic `text_tool_*` ids from the XML fallback are persisted text-only: the provider cannot
  // reference ids it did not generate.
  const hasXmlFallbackTools = result.toolCalls.some((tc) =>
    tc.id.startsWith('text_tool_'),
  );

  // Drain show_to_user attachments only on text-bearing iterations (tool-only pills cannot show them); the
  // queue persists and the end-of-turn flush catches leftovers. A tool-inserted row would break alternation.
  const { drainPendingAttachments } = await import('../../../pending-attachments.js');
  const hasTerminalTextThisIter = !!(persistedContent && persistedContent.trim().length > 0);
  const queuedAttachments = hasTerminalTextThisIter ? drainPendingAttachments(agentId) : [];
  const queuedAttachmentsJson =
    queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

  const effectiveModelIdForPersist =
    state.modelId === '__auto__' ? configuredModelId : state.modelId;

  if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
    // A voice turn running tools with no opener text gets a short spoken filler, once per turn,
    // so the user is not left in silence.
    if (
      !turnCtx.voiceFillerFired &&
      latestUserSource === 'voice' &&
      (persistedContent ?? '').trim().length === 0
    ) {
      try {
        const { pickFillerPhrase } = await import('../../../../voice/filler-phrases.js');
        const { pushVoiceFiller } = await import('../../../../voice/voice-ws.js');
        const phrase = pickFillerPhrase();
        const pushed = pushVoiceFiller(agentId, phrase);
        if (pushed) {
          turnCtx.voiceFillerFired = true;
          logger.info('Voice filler pushed before tool execution', {
            agentId, phrase, toolCount: result.toolCalls.length,
          }, agentId);
        }
      } catch (err) {
        logger.warn('Voice filler push failed (non-fatal)', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }

    // The same filler for a live phone call, so the caller does not hear dead air while tools run.
    if (
      !turnCtx.voiceFillerFired &&
      turnCtx.phoneStreamCallSid &&
      inboundChannel === 'phone' &&
      (persistedContent ?? '').trim().length === 0
    ) {
      try {
        const { pickFillerPhrase } = await import('../../../../voice/filler-phrases.js');
        const { getCallSession } = await import('../../../../twilio/call-session.js');
        const phrase = pickFillerPhrase();
        const session = getCallSession(turnCtx.phoneStreamCallSid);
        if (session && !session.isEnded()) {
          void session.queueAgentSay(phrase);   // tools start at once; the filler plays while they run
          turnCtx.voiceFillerFired = true;
          logger.info('Phone filler pushed before tool execution', {
            agentId, callSid: turnCtx.phoneStreamCallSid, phrase, toolCount: result.toolCalls.length,
          }, agentId);
        }
      } catch (err) {
        logger.warn('Phone filler push failed (non-fatal)', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    const assistantContent: Anthropic.ContentBlockParam[] = [];
    if (persistedContent) {
      assistantContent.push({ type: 'text', text: persistedContent });
    }
    for (const tc of result.toolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }
    // Secrets never enter stored content: declared secret fields are redacted from tool_use arguments and
    // handled secrets scrubbed from the rest; result.toolCalls keeps the real values for the live call.
    // No channel carve-out; terminal-text.ts scrubs the tool-less reply the same way.
    const assistantContentForStore = redactAssistantBlocksForPersist(agentId, assistantContent);
    const reasoningForStore = result.reasoningContent
      ? redactHandedCredentials(agentId, result.reasoningContent) : null;
    const assistantContentJson = JSON.stringify(assistantContentForStore);
    if (interAgentTurn) {
      // Own inter-agent output goes to the inter-agent lane, never the `messages` chat table; the merged
      // tail loaders union it back into model context unchanged. The row id stays stable.
      insertMessageIfAbsent({
        id: messageId,
        agentId,
        role: 'assistant',
        lane: 'a2a',
        content: assistantContentJson,
        attachments: queuedAttachmentsJson,
        turnNumber,
        a2aThreadId,
      });
    } else {
      insertMessageIfAbsent({
        id: messageId, agentId, role: 'assistant', content: assistantContentJson,
        attachments: queuedAttachmentsJson,
        modelId: effectiveModelIdForPersist, cost: null, turnNumber,
        reasoningContent: reasoningForStore,
      });
    }
    // The event family follows the same `interAgentTurn` flag that just picked the writer.
    broadcast(ownOutputBroadcast({
      interAgentTurn,
      agentId,
      agentName: (agent.name as string | null) ?? null,
      id: messageId,
      role: 'assistant',
      content: JSON.stringify(assistantContentForStore),
      createdAt: new Date().toISOString(),
      modelId: effectiveModelIdForPersist,
      attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
      // The thinking panel keeps the redacted copy: the raw value would enter the reasoning the
      // provider replays for the rest of the turn.
      reasoningContent: reasoningForStore ?? undefined,
      conversationId: chosenConversationId,
    }));
    // Text riding with tool calls is still deliverable: keep the latest so the end-of-turn channel
    // router has it even when the turn ends in [no-reply].
    if (persistedContent && persistedContent.trim().length > 0) {
      state = advance(state, {
        lastAssistantTextForIM: stripMoodMarker(persistedContent),
        ...compileDutyDischarged(state),
      });
      // New words replace an early answer as the turn's reply, so the turn's end sends them.
      turnCtx.earlyAnswerRowId = null;
    }
  } else if (persistedContent) {
    if (interAgentTurn) {
      // Own inter-agent output never touches `messages`; the classifier normally nulls this text,
      // and relocating it here keeps the invariant total.
      insertMessageIfAbsent({
        id: messageId,
        agentId,
        role: 'assistant',
        lane: 'a2a',
        content: persistedContent,
        attachments: queuedAttachmentsJson,
        turnNumber,
        a2aThreadId,
      });
    } else {
      insertMessageIfAbsent({
        id: messageId, agentId, role: 'assistant', content: persistedContent,
        attachments: queuedAttachmentsJson,
        modelId: effectiveModelIdForPersist, cost: null, turnNumber,
        // The reply stands as written; only the private reasoning is redacted.
        reasoningContent: result.reasoningContent
          ? redactHandedCredentials(agentId, result.reasoningContent) : null,
      });
    }
    if (persistedContent.trim().length > 0) {
      state = advance(state, {
        lastAssistantTextForIM: stripMoodMarker(persistedContent),
        ...compileDutyDischarged(state),
      });
      turnCtx.earlyAnswerRowId = null;
      noteTerminalAnswer(messageId, 'a genuine terminal reply');
    }
    // Always send chat:message: the dashboard replaces the streamed bubble by id, correcting the raw
    // streamed text to what was stored (sanitized, mood marker moved to its own column).
    broadcast(ownOutputBroadcast({
      interAgentTurn,
      agentId,
      agentName: (agent.name as string | null) ?? null,
      id: messageId,
      role: 'assistant',
      content: persistedContent,
      createdAt: new Date().toISOString(),
      modelId: effectiveModelIdForPersist,
      attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
    }));
  }

  // The files ride the turn's reply to the person's channel; the bubble above already shows them.
  if (queuedAttachments.length > 0) turnCtx.replyFiles.push(...queuedAttachments);

  // Broadcast streaming complete (only if we actually streamed something)
  if ((persistedContent && persistedContent.trim().length > 0) || result.toolCalls.length > 0) {
    broadcast({
      type: 'chat:chunk',
      agentId,
      messageId,
      content: '',
      done: true,
      modelId: state.modelId === '__auto__' ? configuredModelId : state.modelId,
    });
  }

  sc.hasXmlFallbackTools = hasXmlFallbackTools;
  sc.effectiveModelIdForPersist = effectiveModelIdForPersist;
  return proceed(state);
}
