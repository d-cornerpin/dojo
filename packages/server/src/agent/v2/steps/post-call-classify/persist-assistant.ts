// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — PERSISTING WHAT THE MODEL SAID, moved byte-faithfully out of
// `loop.ts`'s `postCallClassify` span: the XML-fallback detection, the attachment
// drain, the assistant row itself (text plus `tool_use` blocks), the iMessage
// attachment route and the streaming-complete broadcast.
//
// TWO OF THE STEP'S FOUR OUTPUTS ARE BORN HERE — `hasXmlFallbackTools` and
// `effectiveModelIdForPersist` — and the driver hands both straight to `execute` in
// the same iteration, which is why they are OUTPUTS rather than fields on the bag.
//
// THE FILLER LATCH IS READ AND WRITTEN HERE. `turnCtx.voiceFillerFired` is CUT 8's
// second carrier: kept as a module local it would reset on every iteration and the
// caller would hear the engine's fillers stacked one after another.
// ════════════════════════════════════════

import type Anthropic from '@anthropic-ai/sdk';
import { stripMoodMarker } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { redactAssistantBlocksForPersist, redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { ownOutputBroadcast } from '../../../interagent-broadcast.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/**
 * UX-REPAIR ROUND 12 T47 — THE OWED COMPILE IS DISCHARGED BY THE REPLY ITSELF.
 *
 * The compile gate refuses TOOL CALLS; the duty it enforces is satisfied by TEXT. When the
 * model does both in one round — writes the combined answer and reaches for a tool with it —
 * the answer has landed and the gate has nothing left to force, so it comes down for the rest
 * of the turn.
 *
 * ERRING TOWARD DISARM IS THE POINT. A mid-turn caption that is not the compile also trips
 * this, and that is the safe direction by BUG-2's own lesson: a gate that keeps refusing after
 * a person's answer went out is the recorded failure, and the gate re-arms next turn from the
 * spine if the compile is genuinely still pending. The reverse mistake has no such floor.
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
  // ── XML-fallback detection (matches v1 runtime.ts:1240) ──
  // Weak/local models that don't support structured tool calling emit
  // tool calls via the XML text-fallback parser. Their tool IDs are
  // synthetic (`text_tool_*`). Persisting them as structured tool_use
  // blocks would corrupt the next turn, the provider can't reference
  // IDs it didn't generate. Instead we persist text-only, then broadcast
  // a collapsed view with calls + results inline so the user sees them.
  const hasXmlFallbackTools = result.toolCalls.some((tc) =>
    tc.id.startsWith('text_tool_'),
  );

  // Drain attachments queued by show_to_user during prior tool calls
  // in this turn. The runtime owns assistant-message persistence, so
  // we attach here rather than letting the tool insert a synthetic
  // message (which would break tool_use/tool_result alternation).
  //
  // v2.9.20: ONLY drain on text-bearing iterations. Tool-only
  // iterations (no text + tool_use blocks) render as compact tool
  // pills in non-wordy mode and have no slot to display
  // attachments - draining onto them silently swallowed the files.
  // The 2026-06-06 JJ-report incident lost the deliverable this
  // way: show_to_user → work_update(action="complete_step") → end. Attachments
  // drained onto the work_update(action="complete_step") pill and vanished. Now
  // the queue persists across tool iterations and only drains
  // when text accompanies the persist - and an end-of-turn safety
  // net catches anything still queued so files can't be lost.
  const { drainPendingAttachments } = await import('../../../pending-attachments.js');
  const hasTerminalTextThisIter = !!(persistedContent && persistedContent.trim().length > 0);
  const queuedAttachments = hasTerminalTextThisIter ? drainPendingAttachments(agentId) : [];
  const queuedAttachmentsJson =
    queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

  // Build content for persistence (text + tool_use blocks if any)
  const effectiveModelIdForPersist =
    state.modelId === '__auto__' ? configuredModelId : state.modelId;

  if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
    // v2.9.16: voice-mode filler. When a voice-triggered turn is
    // about to run tools AND the model produced no pre-tool text
    // of its own ("let me check that"), push a short random
    // acknowledgment into the active TTS burst so the user doesn't
    // sit in silence while tools execute. Once per turn, works
    // with both local (Kokoro) and cloud (Hume) TTS engines via
    // the engine-agnostic push handle on the voice session.
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

    // v2.9.23, same filler logic for live phone calls. Tool calls
    // are the only path that produces noticeable latency on phone
    // (a plain text reply now streams sentence-by-sentence via the
    // onChunk pipe above). When the model jumps straight to tools
    // with no opener text, push a short filler to the CallSession
    // so the caller hears something instead of dead air. Caller
    // hears "On it" / "One sec" / "Let me check" within ~150 ms
    // of finishing their utterance.
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
          await session.queueAgentSay(phrase);
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
    // THE PERSIST SEAM (rule 6: secrets never in message content). Two
    // redactions, one owner (credentials/secret-fields.ts): a DECLARED secret
    // field never enters a stored tool_use argument (PHASE-4 T5b / P4-R2 — the
    // owner's key was at rest in `credential_add`'s own arguments, in a row
    // replayed to the provider every later turn), and any secret this agent has
    // handled is scrubbed from the rest of the row (NEXT-WAVE item 5's classic
    // `sshpass -p '<pw>'`). result.toolCalls is untouched, so the live call still
    // runs with the real value; only the stored/broadcast copy is redacted.
    const assistantContentForStore = redactAssistantBlocksForPersist(agentId, assistantContent);
    const reasoningForStore = result.reasoningContent
      ? redactHandedCredentials(agentId, result.reasoningContent) : null;
    const assistantContentJson = JSON.stringify(assistantContentForStore);
    if (interAgentTurn) {
      // D-A step 8: the agent's OWN inter-agent-turn output goes to the physical
      // inter-agent store, never the `messages` chat table. Persisting it here
      // (stamped source='a2a') is what let a coordination burst bury the owner's
      // conversation 10k rows deep and blank the chat, and the 'a2a' stamp was a
      // leak-prone downstream overlay. The merged tail loaders UNION this row back
      // into the model context byte-identically (role/content/order/attachments/
      // turn_number preserved; the display/accounting columns NULL-pad exactly as
      // for peer-A2A rows), so model continuity holds. Regular-mode chat (messages-
      // only) never sees it; wordy mode serves it from the merged set. The row id
      // stays STABLE (other tables reference message ids) and content byte-identical.
      insertMessageIfAbsent({
        id: messageId,
        agentId,
        role: 'assistant',
        lane: 'a2a',
        content: assistantContentJson,
        attachments: queuedAttachmentsJson,
        turnNumber,
      });
    } else {
      // The old statement's trailing `NULL` was the `source` column — the else arm of
      // the a2a split, and T3-0b §3 measured it as the reason NO live writer stamps
      // source='a2a' into `messages`. Owner-lane is the writer module's default, so
      // that NULL position simply disappears.
      insertMessageIfAbsent({
        id: messageId, agentId, role: 'assistant', content: assistantContentJson,
        attachments: queuedAttachmentsJson,
        modelId: effectiveModelIdForPersist, cost: null, turnNumber,
        reasoningContent: reasoningForStore,
      });
    }
    // T9: the event family follows the SAME `interAgentTurn` flag that just picked the
    // writer, decided in one place (agent/interagent-broadcast.ts). Before this, the
    // broadcast sat outside the if/else and a coordination turn's tool_use row went out
    // on the owner's chat feed (research 17 D2). `convKey` rides the owner arm only —
    // conv_key is stamped on the row at turn TEARDOWN, so a mid-turn broadcast is the
    // only place the live view can learn it (research 17 §C2 / bug (a), not T9's).
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
      reasoningContent: reasoningForStore ?? undefined,
      conversationId: chosenConversationId,
    }));
    // v2.7.24, also track text-with-tools iterations as deliverable
    // assistant text. Previously this branch ran (because there are
    // tool calls) without updating lastAssistantTextForIM, which meant
    // a turn shaped "text + tool call → tool result → [no-reply]" would
    // leave the channel-routing block with nothing to deliver. The
    // user's substantive answer (the text in iter 1) never reached
    // iMessage / Teams / email. Capturing the LAST iteration's text
    // regardless of whether tools rode with it gives the routing
    // block the right value to deliver at end-of-turn.
    if (persistedContent && persistedContent.trim().length > 0) {
      state = advance(state, {
        lastAssistantTextForIM: stripMoodMarker(persistedContent),
        ...compileDutyDischarged(state),
      });
    }
  } else if (persistedContent) {
    if (interAgentTurn) {
      // D-A step 8: own-output on an inter-agent iteration NEVER touches
      // `messages`. In practice outputPersistenceClassifier always suppresses
      // trailing text on an inter-agent turn (so persistedContent is null and
      // this branch does not run), but keeping the relocation here makes the
      // "no own inter-agent output in messages" invariant total and future-proof.
      insertMessageIfAbsent({
        id: messageId,
        agentId,
        role: 'assistant',
        lane: 'a2a',
        content: persistedContent,
        attachments: queuedAttachmentsJson,
        turnNumber,
      });
    } else {
      insertMessageIfAbsent({
        id: messageId, agentId, role: 'assistant', content: persistedContent,
        attachments: queuedAttachmentsJson,
        modelId: effectiveModelIdForPersist, cost: null, turnNumber,
        // T5b: the REPLY stands (the phase's second binding caution — the
        // platform never edits what it said). The model's private reasoning
        // is not the reply, and it restates the key it was just handed.
        reasoningContent: result.reasoningContent
          ? redactHandedCredentials(agentId, result.reasoningContent) : null,
      });
    }
    if (persistedContent.trim().length > 0) {
      state = advance(state, {
        lastAssistantTextForIM: stripMoodMarker(persistedContent),
        ...compileDutyDischarged(state),
      });
      noteTerminalAnswer(messageId, 'a genuine terminal reply');
    }
    // T9 — THE TEXT-ONLY REPLY NOW GETS ITS CORRECTING chat:message, AND THAT IS
    // THIS TASK'S SHARPEST SINGLE FIX (research 17 D3).
    //
    // This used to fire only when attachments were queued. The reason given was "the
    // streaming chunks already delivered the text live, so we'd dupe-render if we
    // unconditionally fired chat:message", citing v1 runtime.ts:1303-1318. That reason
    // has been FALSE since 2026-04-30: the dashboard's handler REPLACES a bubble's
    // content in place on an id match (it says so in its own comment — "Pre-2026-04-30
    // this skipped on id match"), and appends only when no bubble exists, which is the
    // correct outcome for a client that missed the stream.
    //
    // What the omission actually cost: the chunks carry the model's RAW output, the row
    // carries what the writer stored — sanitized, timestamp-stripped, `[no-reply]`-free,
    // and since T8 with the orb mood marker moved out to its own column. With no
    // chat:message there was nothing to correct the bubble with, so on a plain text
    // reply the browser kept the raw string forever while the database held the clean
    // one. That is research 17 D3 ("streamed text != persisted text") and the live half
    // of the mood gap recorded at the T8 boundary.
    //
    // Found by BROADCAST_EQUALS_ROW on its first real run (bms4dtng747), which is what
    // a new invariant is for.
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

  // A-1 (comms-audit): the end-of-turn channel router routes TEXT only, so a
  // deliverable file attached to the reply reached only the dashboard. If the
  // requester is on iMessage, deliver the files to them too. iMessage counterparty
  // only (a dashboard turn already renders the files in its bubble above).
  if (queuedAttachments.length > 0 && counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
    try {
      const { sendIMessageWithAttachment } = await import('../../../../services/imessage-bridge.js');
      for (const att of queuedAttachments as Array<{ path?: string }>) {
        if (att.path) sendIMessageWithAttachment(counterparty.senderId, att.path, '');
      }
    } catch (err) {
      logger.warn('A-1: reply-attachment iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    }
  }

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
