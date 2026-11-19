// Agent SDK transport: query() only sends a system prompt plus messages and returns text.
// No SDK tools, agent loop or context management.

import { isOfferedTool } from '../agent/text-tool-fallback.js';
import { createLogger } from '../logger.js';
import type { ToolDefinition } from '../agent/tools/types.js';
import { createSdkStopReasonTracker } from './sdk-stop-reason.js';

const logger = createLogger('agent-sdk');

// Maps a model id to the SDK short name (opus, sonnet, haiku); other Anthropic ids map by family.
function mapModelName(apiModelId: string): string {
  if (apiModelId === 'opus' || apiModelId === 'sonnet' || apiModelId === 'haiku') return apiModelId;
  if (apiModelId.includes('opus')) return 'opus';
  if (apiModelId.includes('sonnet')) return 'sonnet';
  if (apiModelId.includes('haiku')) return 'haiku';
  return apiModelId;
}


interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

let toolCallIdCounter = 0;

/** Formats tool definitions into the prompt as text; the model answers with <tool_call> XML blocks. */
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

/** Parses <tool_call> blocks from the reply; with `offeredNames`, only calls to those tools are taken. */
export function parseToolCallsFromText(text: string, offeredNames?: string[]): { cleanText: string; toolCalls: ParsedToolCall[] } {
  const toolCalls: ParsedToolCall[] = [];
  let cleanText = text;
  const offered = offeredNames ? new Set(offeredNames) : null;
  const toolCallRegex = /<tool_call>\s*<name>([\s\S]*?)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
  let match;
  while ((match = toolCallRegex.exec(text)) !== null) {
    const name = match[1].trim();
    if (offered && !isOfferedTool(offered, name)) continue;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(match[2].trim());
    } catch {
      logger.warn('Failed to parse tool call arguments', { name, rawLength: match[2].trim().length });
      args = { __malformed_args: match[2].trim().slice(0, 500) }; // the tool door answers this with a tool error; the tool never runs
    }
    toolCalls.push({
      id: `sdk_tool_${++toolCallIdCounter}`,
      name,
      arguments: args,
    });

    cleanText = cleanText.replace(match[0], '').trim();
  }

  return { cleanText, toolCalls };
}

// Stand-ins for attachment blocks in HISTORY: history is packed into a text system prompt, so real
// attachments cannot be re-sent. A marker keeps the turn count and context alignment intact.
const HISTORY_IMAGE_PLACEHOLDER = '[image omitted by this connection]';
const HISTORY_DOCUMENT_PLACEHOLDER = '[document omitted by this connection]';

/**
 * Thrown when the CURRENT user message carries an image this transport cannot forward; the wording hits the
 * classifier's vision_mismatch branch (agent/v2/classifiers/provider.ts).
 */
export class AgentSdkVisionUnsupportedError extends Error {
  constructor() {
    super(
      'This model connection does not support image input (vision). ' +
      'The image was NOT read. To send pictures, pin a vision-capable model or use the auto-router.',
    );
    this.name = 'AgentSdkVisionUnsupportedError';
  }
}

/**
 * Thrown instead of a bare abort when the patience timer (never a stop) ended the call. Downstream reads the
 * type: `sawAnyContent` picks DECLARED_PATIENCE_EXCEEDED_CODE or STREAM_IDLE_TIMEOUT_CODE in agent/model.ts.
 */
export class AgentSdkPatienceExceededError extends Error {
  readonly timeoutMs: number;
  readonly sawAnyContent: boolean;
  constructor(timeoutMs: number, sawAnyContent: boolean) {
    super(`Agent SDK call aborted after ${timeoutMs}ms — exceeded this provider's declared patience`);
    this.name = 'AgentSdkPatienceExceededError';
    this.timeoutMs = timeoutMs;
    this.sawAnyContent = sawAnyContent;
  }
}

type SdkContentBlock = { type?: string; text?: string; [k: string]: unknown };

function contentHasTopLevelImage(content: string | object[]): boolean {
  if (typeof content === 'string') return false;
  return (content as SdkContentBlock[]).some(b => b.type === 'image');
}

/**
 * Renders message content to text in this transport's <tool_call>/<tool_result> convention; image and
 * document blocks become placeholders. Exported for unit tests.
 */
export function renderContentToText(content: string | object[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content as SdkContentBlock[]) {
    switch (b.type) {
      case 'text':
        if (b.text) parts.push(b.text);
        break;
      case 'tool_use': {
        const name = (b.name as string) ?? 'tool';
        const args = JSON.stringify((b.input as unknown) ?? {});
        parts.push(`<tool_call>\n<name>${name}</name>\n<arguments>\n${args}\n</arguments>\n</tool_call>`);
        break;
      }
      case 'tool_result': {
        const inner = b.content;
        let text: string;
        if (typeof inner === 'string') {
          text = inner;
        } else if (Array.isArray(inner)) {
          text = (inner as SdkContentBlock[])
            .map(ib => (ib.type === 'text' ? (ib.text ?? '')
              : ib.type === 'image' ? HISTORY_IMAGE_PLACEHOLDER
              : ''))
            .filter(Boolean)
            .join('\n');
        } else {
          text = inner == null ? '' : JSON.stringify(inner);
        }
        const err = b.is_error ? ' error="true"' : '';
        parts.push(`<tool_result>\n<result${err}>${text}</result>\n</tool_result>`);
        break;
      }
      case 'image':
        parts.push(HISTORY_IMAGE_PLACEHOLDER);
        break;
      case 'document':
        parts.push(HISTORY_DOCUMENT_PLACEHOLDER);
        break;
      default:
        if (b.text) parts.push(b.text);
        break;
    }
  }
  return parts.join('\n');
}

/**
 * Packs history into the system prompt; the latest user message becomes the prompt. Throws
 * AgentSdkVisionUnsupportedError on a current image. Exported for unit tests.
 */
export function formatHistoryForSystemPrompt(
  messages: Array<{ role: string; content: string | object[] }>,
): { historySection: string; lastUserMessage: string } {
  let lastUserMessage = '';

  const historyMessages: Array<{ role: string; content: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;

    if (isLast && msg.role === 'user') {
      // A user-attached image cannot ride a string prompt, so refuse rather than answer blind.
      // Tool-result images are tool_result blocks, not 'image', so they are stubbed instead.
      if (contentHasTopLevelImage(msg.content)) {
        throw new AgentSdkVisionUnsupportedError();
      }
      lastUserMessage = renderContentToText(msg.content);
    } else {
      historyMessages.push({ role: msg.role, content: renderContentToText(msg.content) });
    }
  }

  const nonEmpty = historyMessages.filter(m => m.content.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { historySection: '', lastUserMessage };
  }

  const formatted = nonEmpty.map(m => {
    const label = m.role === 'user' ? 'Human' : 'Assistant';
    return `${label}: ${m.content}`;
  }).join('\n\n');

  const historySection = `\n\n=== Conversation History ===\n${formatted}\n=== End History ===`;

  return { historySection, lastUserMessage };
}


export interface AgentSdkCallResult {
  content: string;
  toolCalls: ParsedToolCall[];
  inputTokens: number;
  outputTokens: number;
  // Prompt-cache tokens when the SDK reports them; undefined when absent, so the recorder stores NULL.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  stopReason: string;
}

export async function callAnthropicViaSdk(params: {
  agentId: string;
  apiModelId: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string | object[] }>;
  tools?: ToolDefinition[];
  onChunk?: (text: string) => void;
  /** First-chunk bound from the provider's declared patience; null or undefined means no bound. */
  timeoutMs?: number | null;
  /** Between-chunk (idle) bound; null or undefined falls back to `timeoutMs`. */
  idleTimeoutMs?: number | null;
  /** The stop button's signal; aborts the same controller as the timer but never counts as a patience trip. */
  abortSignal?: AbortSignal;
}): Promise<AgentSdkCallResult> {
  const { agentId, apiModelId, systemPrompt, messages, tools, onChunk, timeoutMs, idleTimeoutMs, abortSignal } = params;

  // Dynamic import, SDK may not be installed
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { query } = sdk;

  const { historySection, lastUserMessage } = formatHistoryForSystemPrompt(messages);

  let fullSystemPrompt = systemPrompt + historySection;
  if (tools && tools.length > 0) {
    fullSystemPrompt += formatToolsForPrompt(tools);
  }

  const sdkModel = mapModelName(apiModelId);
  let fullResponse = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  // True once a text delta has arrived; selects the idle bound.
  let sawAnyContent = false;
  const stopReason = createSdkStopReasonTracker();   // the provider's own word for why it stopped

  logger.info('Calling Anthropic via Agent SDK', {
    model: sdkModel,
    apiModelId,
    messageCount: messages.length,
    toolCount: tools?.length ?? 0,
    systemPromptLength: fullSystemPrompt.length,
    promptLength: lastUserMessage.length,
  }, agentId);

  // An AbortController is the only cancellation lever query() exposes. It is built when the patience timer
  // or the caller's stop signal can cancel; with neither, query() gets none.
  // The timer bounds a GAP, not a total: every stream message re-arms it (first-chunk bound until content
  // arrives, then the idle bound). The shared makeStreamWatchdog lives in agent/model.ts, which dynamically
  // imports this file, so importing it here would be a cycle.
  let timedOutByPatience = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortController: AbortController | undefined;
  let detachExternal: (() => void) | undefined;
  // The bound that actually expired, so the error names the right gap.
  let trippedBoundMs: number | null = null;
  const firstChunkBoundMs = timeoutMs;
  const idleBoundMs = idleTimeoutMs ?? timeoutMs;
  let armGap: ((ms: number) => void) | undefined;
  if (timeoutMs != null || abortSignal) {
    abortController = new AbortController();
    const controller = abortController;
    if (firstChunkBoundMs != null) {
      const arm = (ms: number): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timedOutByPatience = true;
          trippedBoundMs = ms;
          controller.abort();
        }, ms);
        timer.unref?.();
      };
      armGap = arm;
      arm(firstChunkBoundMs);
    }
    if (abortSignal) {
      // Already aborted: the stop landed before dialling, so abort before query() is entered and nothing
      // reaches the provider.
      if (abortSignal.aborted) controller.abort();
      else {
        const onExternalAbort = (): void => { controller.abort(); };
        abortSignal.addEventListener('abort', onExternalAbort, { once: true });
        detachExternal = () => abortSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  let sawTokenEvents = false;
  /** Any stream message is evidence of life; the idle bound applies once content has started. */
  const bumpGap = (): void => {
    if (!armGap) return;
    const ms = sawAnyContent ? idleBoundMs : firstChunkBoundMs;
    if (ms != null) armGap(ms);
  };
  /** Generated content has arrived, so the idle bound governs from here. */
  const noteContent = (): void => {
    sawAnyContent = true;
    bumpGap();
  };

  try {
    for await (const message of query({
      prompt: lastUserMessage || 'Continue.',
      options: {
        model: sdkModel,
        systemPrompt: fullSystemPrompt,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as any,
        includePartialMessages: true,
        ...(abortController ? { abortController } : {}),
      },
    })) {
      bumpGap();
      if (stopReason.observe(message as { type?: string })) continue; // a provider refusal is held back and raised after the loop only if no reply text arrived
      if (message.type === 'assistant') {
        const betaMsg = (message as any).message;
        if (betaMsg?.content) {
          for (const block of betaMsg.content) {
            // With token events on, the finished message repeats what was streamed: take its text
            // only when no token arrived (a provider or SDK that does not stream).
            if (block.type === 'text' && block.text && !sawTokenEvents) {
              fullResponse += block.text;
              noteContent();
              onChunk?.(block.text);
            }
          }
        }
        if (betaMsg?.usage) {
          inputTokens = betaMsg.usage.input_tokens ?? 0;
          outputTokens = betaMsg.usage.output_tokens ?? 0;
          if (betaMsg.usage.cache_read_input_tokens != null) cacheReadTokens = betaMsg.usage.cache_read_input_tokens;
          if (betaMsg.usage.cache_creation_input_tokens != null) cacheCreationTokens = betaMsg.usage.cache_creation_input_tokens;
        }
      } else if (message.type === 'stream_event') {
        const event = (message as any).event;
        if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
          sawTokenEvents = true;
          const text = event.delta.text ?? '';
          fullResponse += text;
          noteContent();
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
    // Name our own abort with a type agent/model.ts's catch can detect structurally (it never reads prose).
    if (timedOutByPatience) {
      // Report the gap that actually expired: the first-chunk bound if nothing arrived, else the idle bound.
      const boundMs = trippedBoundMs ?? timeoutMs!;
      logger.error(`Agent SDK call aborted: exceeded this provider's declared patience (${boundMs}ms gap)`, {
        error: msg, model: sdkModel, boundMs, firstChunkBoundMs, idleBoundMs, sawAnyContent,
      }, agentId);
      throw new AgentSdkPatienceExceededError(boundMs, sawAnyContent);
    }
    // An external abort (the stop button) is re-thrown untouched with no type of its own: the callers decide
    // "was this a stop?" from the stop flag, not from the error.
    logger.error('Agent SDK call failed', { error: msg, model: sdkModel }, agentId);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    detachExternal?.();
  }
  stopReason.throwIfNoReply(fullResponse);
  if (inputTokens === 0) {
    inputTokens = Math.ceil((fullSystemPrompt.length + lastUserMessage.length) / 4);
  }
  if (outputTokens === 0) {
    outputTokens = Math.ceil(fullResponse.length / 4);
  }

  const { cleanText, toolCalls } = parseToolCallsFromText(fullResponse, (tools ?? []).map(t => t.name));

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
    cacheReadTokens,
    cacheCreationTokens,
    stopReason: stopReason.resolve(toolCalls.length),
  };
}
