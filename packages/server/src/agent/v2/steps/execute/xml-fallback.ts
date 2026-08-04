// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — the XML-FALLBACK PERSIST PATH, moved byte-faithfully out
// of `loop.ts`'s `execute` span.
//
// Its own file because it is its own shape: a provider that could not emit native
// tool calls had them parsed out of its text, so the tool calls AND their results
// are collapsed into ONE plain-text assistant message for the dashboard while the
// model's own context keeps the plain text only. Matches v1 (`runtime.ts:1542-1570`);
// the DB INSERT is IGNORE'd because the message id is the one the text-only persist
// already used.
//
// The block's own `if (hasXmlFallbackTools)` came WITH it rather than being lifted
// to the call site — a relocation moves the condition too.
// ════════════════════════════════════════

import type { Anthropic } from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { hasHandedCredentialValues, redactDeclaredSecretArgs, redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { ownOutputBroadcast } from '../../../interagent-broadcast.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');
import type { ExecuteContext, TurnToolResult } from './index.js';

/** Writes no state: this block persists and broadcasts, and that is all it ever did. */
export function persistXmlFallbackCollapse(ctx: ExecuteContext, turnToolResults: TurnToolResult[]): void {
  const {
    agentId, agent, turnNumber, result, persistedContent, messageId,
    effectiveModelIdForPersist, interAgentTurn, hasXmlFallbackTools,
  } = ctx;

  // ── Persist tool results ──
  // XML-fallback path (matches v1 runtime.ts:1542-1570): collapse tool
  // calls + results into a single plain-text assistant message and
  // broadcast that. The DB INSERT is IGNORE'd because messageId is the
  // same as the assistant message we already persisted (text-only above);
  // the broadcast carries the user-facing collapsed view. Net effect:
  // model context has plain text only, dashboard shows tool calls + results.
  if (hasXmlFallbackTools) {
    const collapsedParts: string[] = [];
    if (persistedContent) collapsedParts.push(persistedContent);
    for (let i = 0; i < result.toolCalls.length; i++) {
      const tc = result.toolCalls[i];
      const tr = turnToolResults[i];
      const argJson = JSON.stringify(redactDeclaredSecretArgs(tc.name, tc.arguments));
      collapsedParts.push(`[Called ${tc.name}: ${argJson}]`);
      if (tr) {
        collapsedParts.push(`[Result${tr.isError ? ' ERROR' : ''}: ${tr.content}]`);
      }
    }
    const collapsedTextRaw = collapsedParts.join('\n');
    // NEXT-WAVE item 5 (rule 6): this is the DeepSeek/floor-model path (the very
    // one that constructs `sshpass -p '<pw>'`), and collapsedText inlines the
    // tool ARGS + RESULTS as plain text. Scrub any credential value the agent
    // pulled via credential_get out of the persisted + broadcast copy. The live
    // command already ran with the real value; only the stored/shown copy is
    // redacted. No-op when the agent has pulled no credentials this process.
    const collapsedText = hasHandedCredentialValues(agentId)
      ? redactHandedCredentials(agentId, collapsedTextRaw)
      : collapsedTextRaw;
    // Same messageId as the assistant first-persist, INSERT OR IGNORE
    // keeps the original text-only row intact.
    if (interAgentTurn) {
      // D-A step 8: the weak-model (XML-fallback) own-output on an inter-agent
      // iteration relocates to the store too, so the DeepSeek floor path never
      // leaks collapsed tool narration into the owner's chat.
      insertMessageIfAbsent({
        id: messageId,
        agentId,
        role: 'assistant',
        lane: 'a2a',
        content: collapsedText,
        turnNumber,
      });
    } else {
      insertMessageIfAbsent({
        id: messageId, agentId, role: 'assistant', content: collapsedText,
        modelId: effectiveModelIdForPersist, turnNumber,
      });
    }
    broadcast(ownOutputBroadcast({
      interAgentTurn,
      agentId,
      agentName: (agent.name as string | null) ?? null,
      id: messageId,
      role: 'assistant',
      content: collapsedText,
      createdAt: new Date().toISOString(),
      modelId: effectiveModelIdForPersist,
    }));
    logger.info('v2: collapsed XML-fallback tool calls into plain text', {
      toolCount: result.toolCalls.length,
      tools: result.toolCalls.map((tc) => tc.name),
    }, agentId);
  } else {
    // Normal path: persist as a separate `tool` role message with
    // structured tool_result blocks. If a tool result has contentBlocks
    // (e.g. file_read on an image), use those instead of plain string, 
    // the model sees the image via vision capabilities.
    const toolMessageId = uuidv4();
    const toolResultContent = turnToolResults.map((tr) => {
      const blocks = (tr as { contentBlocks?: Array<{ type: string; [key: string]: unknown }> }).contentBlocks;
      // PHASE-5 T6B (P5-R11 obligation 4 / PHASE-4 exit §8 item 3):
      // `credential_get`'s RESULT was stored here in the clear, deliberately,
      // because redacting it made the credential unusable — the loop
      // re-assembles from the database every iteration. That reason is gone
      // now the value is put back at the provider boundary, so this surface
      // closes WITH the capability rather than instead of it; either half
      // alone is a defect. `blocks` is deliberately not scrubbed — those are
      // the provider content blocks `file_read` attaches for images and PDFs
      // (T4B's vision side channel), never a credential result.
      const storedContent = hasHandedCredentialValues(agentId)
        ? redactHandedCredentials(agentId, tr.content)
        : tr.content;
      return {
        type: 'tool_result' as const,
        tool_use_id: tr.toolCallId,
        content: blocks
          ? (blocks as unknown as Anthropic.ToolResultBlockParam['content'])
          : storedContent,
        is_error: tr.isError,
      };
    }) as Anthropic.ToolResultBlockParam[];
    const toolResultJson = JSON.stringify(toolResultContent);
    if (interAgentTurn) {
      // D-A step 8: the inter-agent turn's tool_result rows relocate to the
      // store alongside their assistant tool_use rows (same per-phase
      // interAgentTurn classification), so a coordination burst's tool pills
      // never bury or leak into the owner's chat. The merged tail UNIONs them
      // back with role='tool', so the tool_use/tool_result pairing the model
      // sees on its next turn is byte-identical.
      insertMessageIfAbsent({
        id: toolMessageId,
        agentId,
        role: 'tool',
        lane: 'a2a',
        content: toolResultJson,
        turnNumber,
      });
    } else {
      insertMessageIfAbsent({ id: toolMessageId, agentId, role: 'tool', content: toolResultJson, turnNumber });
    }
    broadcast(ownOutputBroadcast({
      interAgentTurn,
      agentId,
      agentName: (agent.name as string | null) ?? null,
      id: toolMessageId,
      role: 'tool',
      content: JSON.stringify(toolResultContent),
      createdAt: new Date().toISOString(),
    }));
  }
}
