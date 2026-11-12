// Persists one iteration's tool results: collapsed into assistant text (XML fallback) or a tool row.

import type { Anthropic } from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { hasHandedCredentialValues, redactDeclaredSecretArgs, redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { insertToolRowKeepingWhole, type KeptWhole } from '../../../../memory/kept-results.js';
import { ownOutputBroadcast } from '../../../interagent-broadcast.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');
import type { ExecuteContext, TurnToolResult } from './index.js';

/** Writes no state: persists and broadcasts only. */
export function persistXmlFallbackCollapse(ctx: ExecuteContext, turnToolResults: TurnToolResult[]): void {
  const {
    agentId, agent, turnNumber, result, persistedContent, messageId,
    effectiveModelIdForPersist, interAgentTurn, hasXmlFallbackTools,
  } = ctx;

  // XML fallback: tool calls and results collapse into one plain-text assistant message for the
  // dashboard, while the model's context keeps the text-only row.
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
    // The collapse inlines tool args and results, so scrub handed credential values from the stored and
    // shown copy; the command already ran with the real value.
    const collapsedText = hasHandedCredentialValues(agentId)
      ? redactHandedCredentials(agentId, collapsedTextRaw)
      : collapsedTextRaw;
    // Same messageId as the text-only first persist; INSERT OR IGNORE keeps that row intact.
    if (interAgentTurn) {
      // Inter-agent output goes to the a2a lane, so it never shows in the owner's chat.
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
    // Normal path: one `tool` row of tool_result blocks; contentBlocks (e.g. an image from file_read)
    // replace the string so the model sees it through vision.
    const toolMessageId = uuidv4();
    // Results too long for the view are kept whole, written with the row in one unit.
    const kept: KeptWhole[] = [];
    const toolResultContent = turnToolResults.map((tr) => {
      const blocks = (tr as { contentBlocks?: Array<{ type: string; [key: string]: unknown }> }).contentBlocks;
      // Handed credential values are redacted before storage (the provider boundary puts them back).
      // `blocks` are file_read image/PDF blocks, never a credential result, so they are not scrubbed.
      const redact = (text: string): string =>
        (hasHandedCredentialValues(agentId) ? redactHandedCredentials(agentId, text) : text);
      const storedContent = redact(tr.content);
      if (tr.keptWhole !== undefined) kept.push({ toolUseId: tr.toolCallId, toolName: tr.name, content: redact(tr.keptWhole) });
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
      // Inter-agent tool rows go to the a2a lane beside their tool_use rows; the merged tail unions them
      // back as role='tool', so the tool_use/tool_result pairing the model sees is unchanged.
      insertToolRowKeepingWhole({ id: toolMessageId, agentId, role: 'tool', lane: 'a2a', content: toolResultJson, turnNumber }, kept);
    } else {
      insertToolRowKeepingWhole({ id: toolMessageId, agentId, role: 'tool', content: toolResultJson, turnNumber }, kept);
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
