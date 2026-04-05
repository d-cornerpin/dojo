// ════════════════════════════════════════
// Agent SDK Transport — uses query() as a transport layer only
// No SDK tools, no SDK agent loop, no SDK context management.
// We send system prompt + messages and get text back.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import type { ToolDefinition } from '../agent/tools.js';

const logger = createLogger('agent-sdk');

// Map model IDs to SDK short names.
// Agent SDK models are already stored as "opus"/"sonnet"/"haiku".
// Other Anthropic models (if routed here) get mapped by family.
function mapModelName(apiModelId: string): string {
  if (apiModelId === 'opus' || apiModelId === 'sonnet' || apiModelId === 'haiku') return apiModelId;
  if (apiModelId.includes('opus')) return 'opus';
  if (apiModelId.includes('sonnet')) return 'sonnet';
  if (apiModelId.includes('haiku')) return 'haiku';
  return apiModelId;
}

// ── Tool Call Parsing ──

interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

let toolCallIdCounter = 0;

/**
 * Format tool definitions into the system prompt as text (prompt-based tool calling).
 * The model sees tools as text instructions and returns tool calls as XML blocks.
 */
export function formatToolsForPrompt(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const toolDescriptions = tools.map(t => {
    const params = t.input_schema.properties
      ? Object.entries(t.input_schema.properties as Record<string, { type: string; description?: string }>)
          .map(([name, prop]) => `  - ${name} (${prop.type}): ${prop.description ?? ''}`)
          .join('\n')
      : '  (no parameters)';
    const required = (t.input_schema.required as string[])?.join(', ') || 'none';
    return `### ${t.name}\n${t.description}\nParameters:\n${params}\nRequired: ${required}`;
  }).join('\n\n');

  return `\n\n## Available Tools

You have access to the following tools. To call a tool, respond with an XML block like this:

<tool_call>
<name>tool_name</name>
<arguments>
{"param1": "value1", "param2": "value2"}
</arguments>
</tool_call>

You may call multiple tools in one response. After tool results are returned, continue with your response.

${toolDescriptions}`;
}

/**
 * Parse tool calls from the model's text response.
 * Looks for <tool_call> XML blocks.
 */
export function parseToolCallsFromText(text: string): { cleanText: string; toolCalls: ParsedToolCall[] } {
  const toolCalls: ParsedToolCall[] = [];
  let cleanText = text;

  const toolCallRegex = /<tool_call>\s*<name>([\s\S]*?)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
  let match;

  while ((match = toolCallRegex.exec(text)) !== null) {
    const name = match[1].trim();
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(match[2].trim());
    } catch {
      logger.warn('Failed to parse tool call arguments', { name, raw: match[2].trim() });
    }

    toolCalls.push({
      id: `sdk_tool_${++toolCallIdCounter}`,
      name,
      arguments: args,
    });

    // Remove the tool call block from the clean text
    cleanText = cleanText.replace(match[0], '').trim();
  }

  return { cleanText, toolCalls };
}

/**
 * Format tool results to include in the next prompt.
 */
export function formatToolResultsForPrompt(results: Array<{ toolCallId: string; name: string; content: string; isError: boolean }>): string {
  return results.map(r => {
    return `<tool_result>
<name>${r.name}</name>
<result${r.isError ? ' error="true"' : ''}>${r.content}</result>
</tool_result>`;
  }).join('\n\n');
}

// ── Conversation Formatting ──

/**
 * Format conversation history into the system prompt.
 * The SDK's query() takes a single prompt string, so we pack history into the system prompt
 * and use the latest user message as the prompt.
 */
function formatHistoryForSystemPrompt(
  messages: Array<{ role: string; content: string | object[] }>,
): { historySection: string; lastUserMessage: string } {
  let lastUserMessage = '';

  // Extract the last user message as the prompt
  // Everything else becomes history in the system prompt
  const historyMessages: Array<{ role: string; content: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as Array<{ type?: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');

    if (i === messages.length - 1 && msg.role === 'user') {
      lastUserMessage = content;
    } else {
      historyMessages.push({ role: msg.role, content });
    }
  }

  if (historyMessages.length === 0) {
    return { historySection: '', lastUserMessage };
  }

  const formatted = historyMessages.map(m => {
    const label = m.role === 'user' ? 'Human' : 'Assistant';
    return `${label}: ${m.content}`;
  }).join('\n\n');

  const historySection = `\n\n=== Conversation History ===\n${formatted}\n=== End History ===`;

  return { historySection, lastUserMessage };
}

// ── Main Call Function ──

export interface AgentSdkCallResult {
  content: string;
  toolCalls: ParsedToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export async function callAnthropicViaSdk(params: {
  agentId: string;
  apiModelId: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string | object[] }>;
  tools?: ToolDefinition[];
  onChunk?: (text: string) => void;
}): Promise<AgentSdkCallResult> {
  const { agentId, apiModelId, systemPrompt, messages, tools, onChunk } = params;

  // Dynamic import — SDK may not be installed
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { query } = sdk;

  // Format conversation: history goes into system prompt, last user msg becomes the prompt
  const { historySection, lastUserMessage } = formatHistoryForSystemPrompt(messages);

  // Build the full system prompt with history and tool definitions
  let fullSystemPrompt = systemPrompt + historySection;
  if (tools && tools.length > 0) {
    fullSystemPrompt += formatToolsForPrompt(tools);
  }

  const sdkModel = mapModelName(apiModelId);
  let fullResponse = '';
  let inputTokens = 0;
  let outputTokens = 0;

  logger.info('Calling Anthropic via Agent SDK', {
    model: sdkModel,
    apiModelId,
    messageCount: messages.length,
    toolCount: tools?.length ?? 0,
    systemPromptLength: fullSystemPrompt.length,
    promptLength: lastUserMessage.length,
  }, agentId);

  try {
    for await (const message of query({
      prompt: lastUserMessage || 'Continue.',
      options: {
        model: sdkModel,
        systemPrompt: fullSystemPrompt,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as any,
      },
    })) {
      if (message.type === 'assistant') {
        // Full assistant message with content blocks
        const betaMsg = (message as any).message;
        if (betaMsg?.content) {
          for (const block of betaMsg.content) {
            if (block.type === 'text' && block.text) {
              fullResponse += block.text;
              onChunk?.(block.text);
            }
          }
        }
        // Extract usage if available
        if (betaMsg?.usage) {
          inputTokens = betaMsg.usage.input_tokens ?? 0;
          outputTokens = betaMsg.usage.output_tokens ?? 0;
        }
      } else if (message.type === 'stream_event') {
        // Streaming chunks
        const event = (message as any).event;
        if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
          const text = event.delta.text ?? '';
          fullResponse += text;
          onChunk?.(text);
        }
      } else if (message.type === 'auth_status') {
        const authMsg = message as any;
        if (authMsg.error) {
          throw new Error(`Agent SDK auth failed: ${authMsg.error}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Agent SDK call failed', { error: msg, model: sdkModel }, agentId);
    throw err;
  }

  // Estimate tokens if not provided by the SDK
  if (inputTokens === 0) {
    inputTokens = Math.ceil((fullSystemPrompt.length + lastUserMessage.length) / 4);
  }
  if (outputTokens === 0) {
    outputTokens = Math.ceil(fullResponse.length / 4);
  }

  // Parse tool calls from response text
  const { cleanText, toolCalls } = parseToolCallsFromText(fullResponse);

  logger.info('Agent SDK call complete', {
    model: sdkModel,
    responseLength: fullResponse.length,
    toolCalls: toolCalls.length,
    inputTokens,
    outputTokens,
  }, agentId);

  return {
    content: toolCalls.length > 0 ? cleanText : fullResponse,
    toolCalls,
    inputTokens,
    outputTokens,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  };
}
