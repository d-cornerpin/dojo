import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { AgentError } from './errors.js';
import { scheduleRateLimitRetry } from './rate-limit-retry.js';
import { toolDefinitions, getFilteredTools, type ToolDefinition } from './tools.js';
import { recordCost } from '../costs/tracker.js';
import { checkBudget } from '../costs/budget.js';
import { updateRateLimits } from '../router/rate-limits.js';
import { recordProviderSuccess, recordProviderError } from '../gateway/routes/services.js';
import { broadcast } from '../gateway/ws.js';
import { isPrimaryAgent, getPrimaryAgentId } from '../config/platform.js';
import type { ToolCall } from '@dojo/shared';

const logger = createLogger('model');

// Client cache is defined below after CachedClient type

export interface ModelCallParams {
  agentId: string;
  modelId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
  systemPrompt: string;
  tools?: boolean;
  onChunk?: (chunk: string) => void;
  routerTier?: string; // populated by auto-router
}

export interface ModelCallResult {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

// OAuth tokens require specific beta headers per Anthropic's API
// claude-code-20250219 is required for OAuth tokens to access Sonnet/Opus models
const OAUTH_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
];

// Auto-detect OAuth tokens by prefix (sk-ant-oat*)
function isOAuthToken(credential: string): boolean {
  return credential.includes('sk-ant-oat');
}

function getProviderAuthType(providerId: string): 'api_key' | 'oauth' | 'agent-sdk' {
  const db = getDb();
  const row = db.prepare('SELECT auth_type FROM providers WHERE id = ?').get(providerId) as { auth_type: string } | undefined;
  if (row?.auth_type === 'agent-sdk') return 'agent-sdk';
  return (row?.auth_type === 'oauth' ? 'oauth' : 'api_key');
}

interface CachedClient {
  client: Anthropic;
  isOAuth: boolean;
}

const clientCache = new Map<string, CachedClient>();

function getClient(providerId: string): CachedClient {
  const cached = clientCache.get(providerId);
  if (cached) return cached;

  const credential = getProviderCredential(providerId);
  if (!credential) {
    logger.error(`No credential found for provider "${providerId}" — check ~/.dojo/secrets.yaml providers.${providerId}`, {
      providerId,
    });
    throw new AgentError(`No credential found for provider: ${providerId}`, '', {
      code: 'NO_API_KEY',
      retryable: false,
    });
  }

  // Determine auth mode: check DB auth_type first, then auto-detect from token prefix
  const dbAuthType = getProviderAuthType(providerId);
  const useOAuth = dbAuthType === 'oauth' || isOAuthToken(credential);

  logger.info('Creating Anthropic client', {
    providerId,
    authType: useOAuth ? 'oauth' : 'api_key',
    credentialPrefix: credential.slice(0, 14) + '...',
  });

  let client: Anthropic;
  if (useOAuth) {
    // OAuth: Authorization: Bearer header + required beta headers
    client = new Anthropic({
      authToken: credential,
      defaultHeaders: {
        'anthropic-beta': OAUTH_BETAS.join(','),
        'User-Agent': 'dojo-platform',
      },
    });
  } else {
    // API Key: standard x-api-key header
    client = new Anthropic({ apiKey: credential });
  }

  const entry: CachedClient = { client, isOAuth: useOAuth };
  clientCache.set(providerId, entry);
  return entry;
}

// Determine max output tokens based on model family
function getMaxOutputTokens(apiModelId: string, providerType: string): number {
  if (providerType === 'ollama') return 8192; // Ollama models typically support 8k output

  // Anthropic model families
  if (apiModelId.includes('opus')) return 32768;
  if (apiModelId.includes('sonnet')) return 64000;
  if (apiModelId.includes('haiku')) return 8192;

  // Default for unknown models
  return 16384;
}

function getModelInfo(modelId: string): { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[]; numCtxOverride: number | null; numCtxRecommended: number | null } {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.provider_id, m.api_model_id, m.context_window, m.max_output_tokens, m.thinking_enabled, m.num_ctx_override, m.num_ctx_recommended, m.capabilities, p.type as provider_type, p.base_url as provider_base_url
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId) as {
    provider_id: string;
    api_model_id: string;
    context_window: number | null;
    max_output_tokens: number | null;
    thinking_enabled: number | null;
    num_ctx_override: number | null;
    num_ctx_recommended: number | null;
    capabilities: string | null;
    provider_type: string;
    provider_base_url: string | null;
  } | undefined;

  if (!row) {
    throw new AgentError(`Model not found: ${modelId}`, '', {
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    });
  }

  let capabilities: string[] = [];
  let capabilitiesValid = false;
  if (row.capabilities) {
    try {
      const parsed = JSON.parse(row.capabilities);
      if (Array.isArray(parsed)) {
        capabilities = parsed.filter(c => typeof c === 'string');
        capabilitiesValid = true;
      }
    } catch {
      // Invalid JSON — treat as text-only for safety rather than enabling everything
      logger.warn('Model has invalid capabilities JSON, defaulting to text-only', { modelId });
      capabilities = ['text'];
      capabilitiesValid = false;
    }
  } else {
    // No capabilities data at all — don't assume anything
    capabilitiesValid = false;
  }

  return {
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    contextWindow: row.context_window ?? 200000,
    // Use the provider-reported value from DB, fall back to derived value for older records
    maxOutputTokens: row.max_output_tokens ?? getMaxOutputTokens(row.api_model_id, row.provider_type),
    providerType: row.provider_type,
    providerBaseUrl: row.provider_base_url,
    // Default ON — matches migration default and the UX the user asked for.
    thinkingEnabled: row.thinking_enabled === null || row.thinking_enabled === undefined
      ? true
      : Boolean(row.thinking_enabled),
    capabilities,
    // Ollama num_ctx controls. Runtime uses `override ?? recommended`.
    // Both null → no `options.num_ctx` sent, Ollama uses Modelfile default.
    numCtxOverride: typeof row.num_ctx_override === 'number' ? row.num_ctx_override : null,
    numCtxRecommended: typeof row.num_ctx_recommended === 'number' ? row.num_ctx_recommended : null,
  };
}

// ── Ollama Call Path (Native /api/chat API) ──
//
// Uses Ollama's native /api/chat endpoint (not /v1/chat/completions) so we
// can access the `think` parameter, get the separate `thinking` response
// field, use native `images: [base64]` on user messages for vision models,
// and pick up future Ollama features as they land.
//
// The native response shape differs from OpenAI-compat in a few key ways:
//   • flat `message` (not `choices[0].message`)
//   • `thinking` as a separate field alongside `content`
//   • `tool_calls[].function.arguments` is a pre-parsed object (not JSON string)
//   • token counts in `prompt_eval_count` / `eval_count` (not `usage.*`)
//   • streaming is newline-delimited JSON (one object per line)
//   • `done_reason` / `done: true` instead of `finish_reason`

import { getOllamaLock } from '../services/ollama-lock.js';

interface NativeOllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // base64-encoded image data, one entry per image
  tool_calls?: Array<{
    id?: string;
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
  tool_name?: string; // required on role:'tool' messages
}

// Translate our internal Anthropic-style message format into Ollama's native
// /api/chat message shape. Handles:
//   • tool_use content blocks → assistant.tool_calls
//   • tool_result content blocks → separate {role:'tool', tool_name, content}
//     messages (tool name recovered from the matching prior tool_use id)
//   • image content blocks → `images: [base64,...]` on the user message
//   • document (PDF) blocks → text extracted via pdfjs and inlined as a
//     framed text section in the user message. Extraction failures broadcast
//     a chat:error banner and the PDF is dropped.
//
// Async because PDF extraction via pdfjs is async; the call site must await.
async function buildNativeOllamaMessages(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): Promise<NativeOllamaMessage[]> {
  const native: NativeOllamaMessage[] = [{ role: 'system', content: systemPrompt }];
  const toolIdToName = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        native.push({ role: 'user', content: m.content });
        continue;
      }
      if (!Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const toolResults = blocks.filter(b => b.type === 'tool_result');

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const toolUseId = tr.tool_use_id as string;
          const toolName = toolIdToName.get(toolUseId) ?? '';
          const content = typeof tr.content === 'string'
            ? tr.content
            : JSON.stringify(tr.content);
          native.push({ role: 'tool', content, tool_name: toolName });
        }
        // Don't `continue` — emit any text blocks that were merged into
        // this message by the assembler's mergeConsecutiveRoles.
        const remainingText = blocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n').trim();
        if (remainingText) {
          native.push({ role: 'user', content: remainingText });
        }
        continue;
      }

      // Regular user message: text + optional images + documents
      const textBlocks = blocks.filter(b => b.type === 'text');
      const imageBlocks = blocks.filter(b => b.type === 'image');
      const documentBlocks = blocks.filter(b => b.type === 'document');

      const textParts: string[] = [];
      const userText = textBlocks.map(b => (b.text as string) ?? '').join('\n');
      if (userText) textParts.push(userText);

      // ── PDF text extraction ──
      // For each PDF document block, extract the text via pdfjs and splice
      // it into the user message as a labeled section. This gives local
      // models the full textual content of the document without needing a
      // native document type. Extraction failures broadcast a banner and
      // the PDF is dropped from the turn.
      if (documentBlocks.length > 0) {
        const { extractPdfText, PdfExtractError } = await import('../services/pdf-extract.js');
        for (const doc of documentBlocks) {
          const source = doc.source as Record<string, unknown> | undefined;
          const title = (typeof doc.title === 'string' && doc.title) ? doc.title : 'attached document';
          if (!source || source.type !== 'base64' || typeof source.data !== 'string') {
            logger.warn('Ollama translator: document block has no base64 data — skipping', {
              title,
            }, agentId);
            continue;
          }

          try {
            const extracted = await extractPdfText(source.data);
            const header = `[PDF attachment: ${title} — ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}${extracted.truncated ? `, truncated to first ${extracted.pagesExtracted}` : ''}]`;
            const footer = `[end of ${title}]`;
            textParts.push(`${header}\n${extracted.text}\n${footer}`);

            if (extracted.truncated) {
              broadcast({
                type: 'chat:error',
                agentId,
                error: `"${title}" was too large to fit in context and was truncated after ${extracted.pagesExtracted} of ${extracted.pageCount} pages. The agent will only see the first part of the document.`,
              });
            }
          } catch (err) {
            const reason = err instanceof PdfExtractError
              ? err.message
              : (err instanceof Error ? err.message : String(err));
            logger.warn('Ollama translator: PDF extraction failed — dropping attachment', {
              title,
              reason,
            }, agentId);
            broadcast({
              type: 'chat:error',
              agentId,
              error: `Couldn't extract text from "${title}" (${reason}). The agent will respond to your message without the PDF's contents.`,
            });
          }
        }
      }

      const images: string[] = [];
      for (const img of imageBlocks) {
        const source = img.source as Record<string, unknown> | undefined;
        if (source && source.type === 'base64' && typeof source.data === 'string') {
          images.push(source.data);
        }
      }

      const userMsg: NativeOllamaMessage = {
        role: 'user',
        content: textParts.join('\n\n'),
      };
      if (images.length > 0) userMsg.images = images;
      native.push(userMsg);
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        native.push({ role: 'assistant', content: m.content });
        continue;
      }
      if (!Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const textBlocks = blocks.filter(b => b.type === 'text');
      const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');
      const text = textBlocks.map(b => (b.text as string) ?? '').join('\n');

      const assistantMsg: NativeOllamaMessage = { role: 'assistant', content: text };

      if (toolUseBlocks.length > 0) {
        assistantMsg.tool_calls = toolUseBlocks.map(tc => {
          const id = tc.id as string;
          const name = tc.name as string;
          toolIdToName.set(id, name);
          return {
            id,
            function: {
              name,
              arguments: (tc.input ?? {}) as Record<string, unknown>,
            },
          };
        });
      }

      native.push(assistantMsg);
    }
  }

  return native;
}

async function callOllamaModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[]; numCtxOverride: number | null; numCtxRecommended: number | null },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;
  const baseUrl = (modelInfo.providerBaseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const ollamaModelName = modelInfo.apiModelId;

  // Acquire the Ollama model lock (waits if a different model is in use
  // ON THE SAME PROVIDER — remote Ollama hosts have their own slot pool).
  const lock = getOllamaLock();
  await lock.acquire(modelInfo.providerId, ollamaModelName);

  const startTime = Date.now();

  const nativeMessages = await buildNativeOllamaMessages(systemPrompt, messages, agentId);

  // Build tools in the shape Ollama's native API accepts (same as the OpenAI
  // function-calling schema — Ollama mirrors it). Two-phase loading: only
  // always-loaded + session-loaded tools go to the model.
  let nativeTools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> | undefined = undefined;
  if (tools) {
    const allPermitted = getFilteredTools(agentId);
    const { filterToolsForApiCall, getAgentAlwaysLoadedTools } = await import('../tools/tool-docs.js');
    const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
    const filtered = filterToolsForApiCall(agentId, allPermitted, alwaysLoaded);
    if (filtered.length > 0) {
      nativeTools = filtered.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema as Record<string, unknown>,
        },
      }));
    }
  }

  // Effective num_ctx: the user's explicit override wins, otherwise the
  // auto-computed RAM-aware recommendation, otherwise no value at all
  // (Ollama falls back to the model's Modelfile default).
  const effectiveNumCtx: number | null =
    typeof modelInfo.numCtxOverride === 'number'
      ? modelInfo.numCtxOverride
      : (typeof modelInfo.numCtxRecommended === 'number' ? modelInfo.numCtxRecommended : null);
  const numCtxSource: 'override' | 'recommended' | 'default' =
    typeof modelInfo.numCtxOverride === 'number'
      ? 'override'
      : (typeof modelInfo.numCtxRecommended === 'number' ? 'recommended' : 'default');

  logger.info('Calling Ollama native /api/chat (streaming)', {
    model: ollamaModelName,
    baseUrl,
    messageCount: nativeMessages.length,
    toolCount: nativeTools?.length ?? 0,
    hasImages: nativeMessages.some(m => m.images && m.images.length > 0),
    thinkingEnabled: modelInfo.thinkingEnabled,
    numCtxOverride: modelInfo.numCtxOverride,
    numCtxRecommended: modelInfo.numCtxRecommended,
    effectiveNumCtx,
    numCtxSource,
  }, agentId);

  const requestBody: Record<string, unknown> = {
    model: ollamaModelName,
    messages: nativeMessages,
    stream: true,
    // `think` is driven by the per-model toggle in Settings → Models. For
    // models without the thinking capability this is a harmless no-op. Some
    // families (gpt-oss, DeepSeek-R1) are trained to always think and will
    // ignore the flag — the call still works; we just capture the thinking
    // separately and don't surface it to the UI.
    think: modelInfo.thinkingEnabled,
  };
  if (nativeTools && nativeTools.length > 0) {
    requestBody.tools = nativeTools;
  }
  // Set options.num_ctx when we have either an override or an auto-computed
  // recommendation. If neither is set, let Ollama use the Modelfile default.
  if (typeof effectiveNumCtx === 'number') {
    requestBody.options = { num_ctx: effectiveNumCtx };
  }

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AgentError(`Ollama call failed: HTTP ${response.status} ${errorText.slice(0, 200)}`, agentId, {
        code: 'MODEL_CALL_FAILED',
        retryable: response.status >= 500,
      });
    }

    if (!response.body) {
      throw new AgentError('Ollama response body is empty', agentId, {
        code: 'MODEL_CALL_FAILED',
        retryable: true,
      });
    }

    // ── Streaming accumulator: newline-delimited JSON ──
    // Each line is a complete JSON object. Content tokens, thinking tokens,
    // and tool_calls arrive in `message.*` across successive lines; the
    // final line has `done: true` with usage stats.
    let fullContent = '';
    let fullThinking = '';
    let accumulatedToolCalls: ToolCall[] = [];
    let doneReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let chunk: {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }>;
        };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      try {
        chunk = JSON.parse(line);
      } catch {
        logger.debug('Ollama: failed to parse stream line', {
          linePreview: line.slice(0, 120),
        }, agentId);
        return;
      }

      const message = chunk.message;
      if (message) {
        if (typeof message.content === 'string' && message.content.length > 0) {
          fullContent += message.content;
          if (onChunk) onChunk(message.content);
        }
        if (typeof message.thinking === 'string' && message.thinking.length > 0) {
          fullThinking += message.thinking;
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          // Ollama emits the full tool_calls array in one chunk (typically the
          // last message chunk before `done: true`), not per-argument deltas.
          // Replacing-on-each-chunk is safe across gpt-oss / qwen3 / llama3.1.
          accumulatedToolCalls = message.tool_calls.map((tc, idx) => {
            const rawArgs = tc.function?.arguments;
            let parsedArgs: Record<string, unknown>;
            if (rawArgs && typeof rawArgs === 'object') {
              parsedArgs = rawArgs as Record<string, unknown>;
            } else if (typeof rawArgs === 'string') {
              try {
                parsedArgs = JSON.parse(rawArgs);
              } catch {
                logger.warn('Ollama: malformed tool call JSON arguments', {
                  toolName: tc.function?.name,
                  rawArgs: typeof rawArgs === 'string' ? rawArgs.slice(0, 200) : String(rawArgs),
                }, agentId);
                parsedArgs = { __malformed_args: typeof rawArgs === 'string' ? rawArgs.slice(0, 500) : String(rawArgs) };
              }
            } else {
              parsedArgs = {};
            }
            return {
              id: tc.id && tc.id.length > 0 ? tc.id : `ollama_tool_${Date.now()}_${idx}`,
              name: tc.function?.name ?? '',
              arguments: parsedArgs,
            };
          });
        }
      }

      if (chunk.done === true) {
        doneReason = chunk.done_reason ?? null;
        if (typeof chunk.prompt_eval_count === 'number') inputTokens = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === 'number') outputTokens = chunk.eval_count;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    // Flush any trailing content left in the buffer after the stream ends.
    if (buffer.trim()) processLine(buffer);

    const latencyMs = Date.now() - startTime;

    if (fullThinking.length > 0) {
      logger.debug('Ollama: thinking captured (not surfaced to UI)', {
        modelName: ollamaModelName,
        thinkingLength: fullThinking.length,
        thinkingPreview: fullThinking.slice(0, 120),
      }, agentId);
    }

    // Record cost ($0 for local models — still tracked for latency metrics)
    recordCost({
      agentId,
      modelId,
      providerId: modelInfo.providerId,
      inputTokens,
      outputTokens,
      latencyMs,
      requestType: routerTier ?? 'ollama',
    });

    recordProviderSuccess(modelInfo.providerId);

    logger.info('Ollama native call completed', {
      model: ollamaModelName,
      inputTokens,
      outputTokens,
      latencyMs,
      contentLength: fullContent.length,
      thinkingLength: fullThinking.length,
      toolCallCount: accumulatedToolCalls.length,
      doneReason,
    }, agentId);

    return {
      content: fullContent,
      toolCalls: accumulatedToolCalls,
      inputTokens,
      outputTokens,
      stopReason: accumulatedToolCalls.length > 0
        ? 'tool_use'
        : (doneReason === 'stop' ? 'end_turn' : (doneReason ?? 'end_turn')),
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    recordProviderError(modelInfo.providerId);
    logger.error(`Ollama call failed: ${message}`, {
      model: ollamaModelName,
      baseUrl,
      latencyMs,
    }, agentId);
    throw err instanceof AgentError ? err : new AgentError(`Ollama call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: true,
    });
  } finally {
    lock.release(modelInfo.providerId, ollamaModelName);
  }
}

// ── OpenAI Call Path ──

const openaiClientCache = new Map<string, OpenAI>();

function getOpenAIClient(providerId: string, baseUrl?: string | null): OpenAI {
  const cacheKey = `${providerId}:${baseUrl ?? 'default'}`;
  const cached = openaiClientCache.get(cacheKey);
  if (cached) return cached;

  const credential = getProviderCredential(providerId);
  if (!credential) {
    throw new AgentError(`No credential found for OpenAI provider: ${providerId}`, '', {
      code: 'NO_API_KEY',
      retryable: false,
    });
  }

  const resolvedBaseUrl = baseUrl
    ? (baseUrl.replace(/\/+$/, '').endsWith('/v1')
        ? baseUrl.replace(/\/+$/, '')
        : baseUrl.replace(/\/+$/, '') + '/v1')
    : undefined;

  logger.info('Creating OpenAI-compatible client', { providerId, baseUrl, resolvedBaseUrl: resolvedBaseUrl ?? 'https://api.openai.com/v1 (default)' });

  const client = new OpenAI({
    apiKey: credential,
    ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
  });

  openaiClientCache.set(cacheKey, client);
  return client;
}

// Build OpenAI Chat Completions messages from our internal Anthropic-style
// content blocks. Image blocks become proper `image_url` parts (data URLs),
// document blocks get their text extracted via pdf-extract and inlined so
// providers without native document support still see the content.
//
// Any image/document blocks for models that LACK vision should already have
// been stripped by `enforceModelCapabilities` in runtime.ts before this
// function runs — this helper just translates whatever's left.
async function buildOpenAIMessages(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        openaiMessages.push({ role: 'user', content: m.content });
        continue;
      }
      if (!Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const toolResults = blocks.filter(b => b.type === 'tool_result');

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id as string,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
        // Don't `continue` — there may be text blocks in this message too
        // (the assembler merges consecutive same-role messages, so a
        // tool_result message can get merged with a text user message).
        // Fall through to emit any text content as a separate user message.
        const remainingText = blocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n').trim();
        if (remainingText) {
          openaiMessages.push({ role: 'user', content: remainingText });
        }
        continue;
      }

      // Regular user message — text + optional images + optional PDFs
      const textBlocks = blocks.filter(b => b.type === 'text');
      const imageBlocks = blocks.filter(b => b.type === 'image');
      const documentBlocks = blocks.filter(b => b.type === 'document');

      // Start with any user-typed text.
      let textContent = textBlocks.map(b => (b.text as string) ?? '').join('\n');

      // Inline PDF text (the OpenAI Chat Completions API has no document
      // type, so this is the only way to get PDFs in front of the model).
      if (documentBlocks.length > 0) {
        const { extractPdfText, PdfExtractError } = await import('../services/pdf-extract.js');
        for (const doc of documentBlocks) {
          const source = doc.source as Record<string, unknown> | undefined;
          const title = (typeof doc.title === 'string' && doc.title) ? doc.title : 'attached document';
          if (!source || source.type !== 'base64' || typeof source.data !== 'string') {
            logger.warn('OpenAI translator: document block has no base64 data — skipping', {
              title,
            }, agentId);
            continue;
          }
          try {
            const extracted = await extractPdfText(source.data);
            const header = `[PDF attachment: ${title} — ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}${extracted.truncated ? `, truncated to first ${extracted.pagesExtracted}` : ''}]`;
            const footer = `[end of ${title}]`;
            textContent = (textContent ? textContent + '\n\n' : '') + `${header}\n${extracted.text}\n${footer}`;

            if (extracted.truncated) {
              broadcast({
                type: 'chat:error',
                agentId,
                error: `"${title}" was too large to fit in context and was truncated after ${extracted.pagesExtracted} of ${extracted.pageCount} pages. The agent will only see the first part of the document.`,
              });
            }
          } catch (err) {
            const reason = err instanceof PdfExtractError
              ? err.message
              : (err instanceof Error ? err.message : String(err));
            logger.warn('OpenAI translator: PDF extraction failed — dropping attachment', {
              title,
              reason,
            }, agentId);
            broadcast({
              type: 'chat:error',
              agentId,
              error: `Couldn't extract text from "${title}" (${reason}). The agent will respond to your message without the PDF's contents.`,
            });
          }
        }
      }

      // No images → send as a simple string (backwards compatible).
      if (imageBlocks.length === 0) {
        openaiMessages.push({ role: 'user', content: textContent });
        continue;
      }

      // Images present → build multimodal content as an array of parts,
      // using OpenAI's image_url with a base64 data URL so we don't need
      // external hosting. This is supported by OpenAI itself, OpenRouter,
      // MoonshotAI, Gemini (via OpenAI compat), Together, and most other
      // OpenAI-compatible providers for models with vision capability.
      const parts: OpenAI.ChatCompletionContentPart[] = [];
      if (textContent) {
        parts.push({ type: 'text', text: textContent });
      }
      for (const img of imageBlocks) {
        const source = img.source as Record<string, unknown> | undefined;
        if (!source || source.type !== 'base64' || typeof source.data !== 'string') {
          logger.warn('OpenAI translator: image block has no base64 data — skipping', {}, agentId);
          continue;
        }
        const mediaType = (source.media_type as string) || 'image/jpeg';
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mediaType};base64,${source.data}`,
          },
        });
      }

      if (parts.length === 0) {
        // Nothing survived encoding — fall back to whatever text we have.
        openaiMessages.push({ role: 'user', content: textContent || '(attachment could not be decoded)' });
      } else if (parts.length === 1 && parts[0].type === 'text') {
        // Only text survived — send as string for compat with providers that
        // don't love the array form for text-only messages.
        openaiMessages.push({ role: 'user', content: parts[0].text });
      } else {
        openaiMessages.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        openaiMessages.push({ role: 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        // Handle tool_use blocks from Anthropic format
        const blocks = m.content as unknown as Array<Record<string, unknown>>;
        const textBlocks = blocks.filter(b => b.type === 'text');
        const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textBlocks.map(b => (b.text as string) ?? '').join('\n') || null,
        };

        if (toolUseBlocks.length > 0) {
          assistantMsg.tool_calls = toolUseBlocks.map(tc => ({
            id: tc.id as string,
            type: 'function' as const,
            function: {
              name: tc.name as string,
              arguments: JSON.stringify(tc.input ?? {}),
            },
          }));
        }

        openaiMessages.push(assistantMsg);
      }
    }
  }

  return openaiMessages;
}

async function callOpenAIModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[] },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;
  const startTime = Date.now();

  const client = getOpenAIClient(modelInfo.providerId, modelInfo.providerBaseUrl);

  const openaiMessages = await buildOpenAIMessages(systemPrompt, messages, agentId);

  // Build tools in OpenAI format (two-phase loading: only always-loaded + session-loaded)
  let openaiTools: OpenAI.ChatCompletionTool[] | undefined = undefined;
  if (tools) {
    const allPermitted = getFilteredTools(agentId);
    const { filterToolsForApiCall, getAgentAlwaysLoadedTools } = await import('../tools/tool-docs.js');
    const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
    const filtered = filterToolsForApiCall(agentId, allPermitted, alwaysLoaded);
    openaiTools = filtered.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));
  }

  // Determine the right max tokens parameter
  // o-series models use max_completion_tokens, others use max_tokens
  const isReasoningModel = modelInfo.apiModelId.match(/^o[1-4]/);

  // Estimate input tokens to cap output so we don't exceed context window.
  // Use ~3 chars/token (conservative) to avoid underestimating.
  const inputEstimate = openaiMessages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + Math.ceil(content.length / 3);
  }, 0) + Math.ceil(JSON.stringify(openaiTools ?? []).length / 3);

  // Hard guard: if the input alone exceeds the context window (minus a
  // minimum output reservation), trim the oldest messages until it fits.
  // OpenAI-compatible providers (MiniMax, OpenRouter, etc.) reject
  // over-limit requests outright, unlike Anthropic which auto-truncates.
  // Keep at least the system message (index 0) and the most recent user
  // message (last index); trim from the middle outward.
  const minOutputReserve = 1024;
  const hardCeiling = modelInfo.contextWindow - minOutputReserve;
  if (inputEstimate > hardCeiling && openaiMessages.length > 2) {
    logger.warn('Input exceeds context window — trimming oldest messages to fit', {
      inputEstimate,
      contextWindow: modelInfo.contextWindow,
      messageCount: openaiMessages.length,
    }, agentId);

    // Preserve the system message (first) and the most recent messages.
    // Drop from index 1 forward (oldest conversation messages) until we're
    // under the ceiling. Each dropped message reclaims its estimated tokens.
    //
    // IMPORTANT: After dropping, clean up orphaned tool messages. When we
    // drop an assistant message with tool_calls, the subsequent role='tool'
    // messages reference tool_call_ids that no longer exist. And vice versa:
    // dropping a role='tool' message leaves the assistant's tool_calls
    // dangling. OpenAI-compatible providers reject both cases.
    let currentEstimate = inputEstimate;
    while (currentEstimate > hardCeiling && openaiMessages.length > 2) {
      const dropped = openaiMessages.splice(1, 1)[0];
      const droppedTokens = Math.ceil(
        (typeof dropped.content === 'string' ? dropped.content : JSON.stringify(dropped.content ?? '')).length / 3,
      );
      currentEstimate -= droppedTokens;

      // After dropping, walk forward from index 1 stripping orphans:
      // - role='tool' messages whose tool_call_id has no matching assistant
      // - assistant messages with tool_calls whose IDs have no matching tool message
      while (openaiMessages.length > 2) {
        const first = openaiMessages[1] as unknown as Record<string, unknown>; // index 0 is system
        if (!first) break;
        if (first.role === 'tool') {
          // Orphan tool result — its assistant was just dropped
          const toolTokens = Math.ceil(
            (typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '')).length / 3,
          );
          openaiMessages.splice(1, 1);
          currentEstimate -= toolTokens;
          continue;
        }
        if (first.role === 'assistant' && Array.isArray(first.tool_calls)) {
          // Assistant with tool_calls at the front — check if next message
          // is the matching tool result. If not, drop this assistant too.
          const next = openaiMessages[2] as unknown as Record<string, unknown> | undefined;
          if (!next || next.role !== 'tool') {
            const astTokens = Math.ceil(
              (typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '')).length / 3,
            );
            openaiMessages.splice(1, 1);
            currentEstimate -= astTokens;
            continue;
          }
        }
        break;
      }
    }

    logger.info('Trimmed context to fit', {
      newEstimate: currentEstimate,
      remainingMessages: openaiMessages.length,
    }, agentId);
  }

  // Reserve at most 25% of context for output, or whatever's left after input
  const finalInputEstimate = openaiMessages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + Math.ceil(content.length / 3);
  }, 0) + Math.ceil(JSON.stringify(openaiTools ?? []).length / 3);
  const maxOutputBudget = Math.floor(modelInfo.contextWindow * 0.25);
  const availableForOutput = Math.max(1024, Math.min(maxOutputBudget, modelInfo.contextWindow - finalInputEstimate - 1000));
  const effectiveMaxTokens = Math.min(modelInfo.maxOutputTokens, availableForOutput);

  const requestParams: OpenAI.ChatCompletionCreateParams = {
    model: modelInfo.apiModelId,
    messages: openaiMessages,
    stream: true,
    ...(isReasoningModel
      ? { max_completion_tokens: effectiveMaxTokens }
      : { max_tokens: effectiveMaxTokens }),
    ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools } : {}),
  };

  // ── OpenRouter unified reasoning toggle ──
  // When the provider is OpenRouter (detected by base URL) and the model is
  // known to support thinking, honor the per-model thinking_enabled flag by
  // sending the `reasoning` parameter. OpenRouter translates this into each
  // upstream provider's convention (Anthropic thinking, o-series
  // reasoning_effort, Gemini thinkingBudget, DeepSeek R1, etc). For generic
  // openai-compatible providers we leave the request alone.
  const isOpenRouter = (modelInfo.providerBaseUrl ?? '').toLowerCase().includes('openrouter.ai');
  const supportsThinking = modelInfo.capabilities.includes('thinking');
  if (isOpenRouter && supportsThinking) {
    // `extra_body` survives the OpenAI SDK's pass-through to non-standard
    // params. Use it so the unified reasoning object makes it into the
    // wire request untouched.
    (requestParams as unknown as { extra_body?: Record<string, unknown> }).extra_body = {
      ...((requestParams as unknown as { extra_body?: Record<string, unknown> }).extra_body ?? {}),
      reasoning: { enabled: modelInfo.thinkingEnabled },
    };
  }

  logger.info('Calling OpenAI model', {
    model: modelInfo.apiModelId,
    provider: modelInfo.providerId,
    messageCount: openaiMessages.length,
    toolCount: openaiTools?.length ?? 0,
    maxOutputTokens: modelInfo.maxOutputTokens,
    thinkingEnabled: modelInfo.thinkingEnabled,
    reasoningToggleApplied: isOpenRouter && supportsThinking,
  }, agentId);

  try {
    const stream = await client.chat.completions.create(requestParams);

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        fullText += delta.content;
        if (onChunk) onChunk(delta.content);
      }

      // Tool calls come in incrementally
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccumulator.has(idx)) {
            toolCallAccumulator.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const acc = toolCallAccumulator.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    // Finalize tool calls
    for (const [, acc] of toolCallAccumulator) {
      let parsedArgs: Record<string, unknown> = {};
      let malformedArgs = false;
      if (acc.args && acc.args.trim().length > 0) {
        try {
          parsedArgs = JSON.parse(acc.args);
        } catch {
          malformedArgs = true;
          logger.warn('OpenAI: malformed tool call JSON arguments', {
            toolName: acc.name,
            rawArgs: acc.args.slice(0, 200),
          }, agentId);
        }
      }
      if (malformedArgs) {
        // Instead of silently using empty args, synthesize an error tool result
        // so the model sees the failure and can retry with valid JSON.
        // We push a synthetic tool call that the runtime will execute — the
        // executeTool dispatcher will receive it, but we flag it here by
        // injecting a special __malformed_args field. The runtime handles this
        // before dispatching to produce a clear error message for the model.
        parsedArgs = { __malformed_args: acc.args.slice(0, 500) };
      }
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      });
    }

    const latencyMs = Date.now() - startTime;

    // Estimate tokens (OpenAI streaming doesn't always give usage in stream mode)
    const inputTokens = Math.ceil((systemPrompt.length + JSON.stringify(openaiMessages).length) / 4);
    const outputTokens = Math.ceil((fullText.length + JSON.stringify(toolCalls).length) / 4);

    // Calculate cost
    const costPerM = getOpenAICost(modelInfo.apiModelId);
    const totalCost = (inputTokens / 1_000_000) * costPerM.input + (outputTokens / 1_000_000) * costPerM.output;

    // Audit log
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, cost, created_at)
      VALUES (?, ?, 'model_call', ?, 'success', ?, ?, datetime('now'))
    `).run(
      uuidv4(), agentId, modelInfo.apiModelId,
      JSON.stringify({ inputTokens, outputTokens, latencyMs }),
      totalCost,
    );

    recordCost({
      agentId, modelId,
      providerId: modelInfo.providerId,
      inputTokens, outputTokens, latencyMs,
      requestType: routerTier ?? 'agent_turn',
    });

    recordProviderSuccess(modelInfo.providerId);

    // ── Text-based tool call fallback ──
    // Some models (MiniMax, older Gemini) occasionally fall back to
    // outputting tool calls as XML text instead of using the structured
    // tool_calls mechanism. When that happens, toolCalls is empty but
    // fullText contains `<invoke name="X">` or similar patterns. We
    // detect and parse these so the runtime can execute them normally.
    if (toolCalls.length === 0 && (
      fullText.includes('<invoke name="') ||
      fullText.includes('<tool_call>') ||
      fullText.includes('<function_call') ||
      /```json\s*\{\s*"name"\s*:/.test(fullText)
    )) {
      // Pattern 1: <invoke name="tool"><parameter name="key">value</parameter></invoke>
      const invokeRegex = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
      let match;
      while ((match = invokeRegex.exec(fullText)) !== null) {
        const toolName = match[1];
        const paramsBlock = match[2];
        const args: Record<string, unknown> = {};
        const paramRegex = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
          const val = paramMatch[2].trim();
          try { args[paramMatch[1]] = JSON.parse(val); } catch { args[paramMatch[1]] = val; }
        }
        toolCalls.push({
          id: `text_tool_${Date.now()}_${toolCalls.length}`,
          name: toolName,
          arguments: args,
        });
      }
      // Pattern 2: <tool_call><name>tool</name><arguments>{...}</arguments></tool_call>
      if (toolCalls.length === 0) {
        const tcRegex = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
        let tcMatch;
        while ((tcMatch = tcRegex.exec(fullText)) !== null) {
          const tcName = tcMatch[1].trim();
          let tcArgs: Record<string, unknown> = {};
          try { tcArgs = JSON.parse(tcMatch[2].trim()); } catch { /* skip unparseable */ }
          toolCalls.push({
            id: `text_tool_${Date.now()}_${toolCalls.length}`,
            name: tcName,
            arguments: tcArgs,
          });
        }
      }

      // Pattern 3: ```json\n{"name": "tool", "arguments": {...}}\n```
      if (toolCalls.length === 0) {
        const jsonBlockRegex = /```json\s*(\{[\s\S]*?\})\s*```/g;
        let jbMatch;
        while ((jbMatch = jsonBlockRegex.exec(fullText)) !== null) {
          try {
            const obj = JSON.parse(jbMatch[1]);
            if (obj.name && typeof obj.name === 'string') {
              toolCalls.push({
                id: `text_tool_${Date.now()}_${toolCalls.length}`,
                name: obj.name,
                arguments: (obj.arguments ?? obj.parameters ?? {}) as Record<string, unknown>,
              });
            }
          } catch { /* not valid JSON tool call */ }
        }
      }

      // Pattern 4: <function_call name="tool" arguments='{"key": "value"}' />
      if (toolCalls.length === 0) {
        const fcRegex = /<function_call\s+name="([^"]+)"\s+arguments='([^']*)'\s*\/>/g;
        let fcMatch;
        while ((fcMatch = fcRegex.exec(fullText)) !== null) {
          let fcArgs: Record<string, unknown> = {};
          try { fcArgs = JSON.parse(fcMatch[2]); } catch { /* skip */ }
          toolCalls.push({
            id: `text_tool_${Date.now()}_${toolCalls.length}`,
            name: fcMatch[1],
            arguments: fcArgs,
          });
        }
      }

      if (toolCalls.length > 0) {
        // Strip all recognized tool call patterns from visible text
        fullText = fullText.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
          .replace(/<invoke name="[^"]*">[\s\S]*?<\/invoke>/g, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
          .replace(/<function_call[^>]*\/>/g, '')
          .replace(/```json\s*\{[\s\S]*?\}\s*```/g, '')
          .trim();
        logger.info('Extracted text-based tool calls (fallback)', {
          model: modelInfo.apiModelId,
          extractedCount: toolCalls.length,
          tools: toolCalls.map(tc => tc.name),
        }, agentId);
      }
    }

    logger.info('OpenAI call completed', {
      model: modelInfo.apiModelId,
      inputTokens, outputTokens, latencyMs,
      cost: totalCost.toFixed(6),
      toolCallCount: toolCalls.length,
    }, agentId);

    return {
      content: fullText,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    recordProviderError(modelInfo.providerId);

    logger.error(`OpenAI call failed: ${message}`, {
      model: modelInfo.apiModelId,
      providerId: modelInfo.providerId,
      latencyMs,
    }, agentId);

    const isRateLimited = message.includes('rate_limit') || message.includes('429');
    const isOverloaded = message.includes('overloaded') || message.includes('529') || message.includes('503');

    // Schedule background retry for rate limits — skip for auto-routed agents
    // (the auto-router's fallback chain handles model switching)
    if ((isRateLimited || isOverloaded) && !params.routerTier) {
      // OpenAI and OpenRouter include retry-after headers
      let retryAfterSeconds: number | null = null;
      if (err instanceof OpenAI.APIError && err.headers) {
        const retryAfter = err.headers['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) retryAfterSeconds = parsed;
        }
      }

      const lastMsg = (() => {
        try {
          const db = getDb();
          const row = db.prepare(
            "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
          ).get(agentId) as { content: string } | undefined;
          return row?.content ?? null;
        } catch { return null; }
      })();

      scheduleRateLimitRetry(agentId, retryAfterSeconds, lastMsg);
    }

    throw new AgentError(`OpenAI call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: isRateLimited || isOverloaded,
    });
  }
}

// OpenAI pricing per million tokens
function getOpenAICost(apiModelId: string): { input: number; output: number } {
  const id = apiModelId.toLowerCase();
  if (id.includes('gpt-5')) return { input: 10.0, output: 40.0 };
  if (id.includes('gpt-4.1-nano')) return { input: 0.10, output: 0.40 };
  if (id.includes('gpt-4.1-mini')) return { input: 0.40, output: 1.60 };
  if (id.includes('gpt-4.1')) return { input: 2.0, output: 8.0 };
  if (id.includes('gpt-4o-mini')) return { input: 0.15, output: 0.60 };
  if (id.includes('gpt-4o')) return { input: 2.50, output: 10.0 };
  if (id.includes('o4-mini')) return { input: 1.10, output: 4.40 };
  if (id.includes('o3-mini')) return { input: 1.10, output: 4.40 };
  if (id.includes('o3')) return { input: 10.0, output: 40.0 };
  if (id.includes('o1-mini')) return { input: 1.10, output: 4.40 };
  if (id.includes('o1-pro')) return { input: 100.0, output: 400.0 };
  if (id.includes('o1')) return { input: 15.0, output: 60.0 };
  return { input: 2.50, output: 10.0 }; // default to gpt-4o pricing
}

// ── Agent SDK Call Path ──

async function callAnthropicSdkModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[] },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;

  // Dynamic import — gracefully fail if SDK not installed
  const { callAnthropicViaSdk } = await import('../providers/anthropic-sdk.js');

  // Get tools for prompt-based formatting (two-phase loading)
  let toolDefs: ToolDefinition[] = [];
  if (tools) {
    const allPermitted = getFilteredTools(agentId);
    const { filterToolsForApiCall, getAgentAlwaysLoadedTools } = await import('../tools/tool-docs.js');
    const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
    toolDefs = filterToolsForApiCall(agentId, allPermitted, alwaysLoaded);
  }

  const startTime = Date.now();
  const streamedChunks: string[] = [];

  const result = await callAnthropicViaSdk({
    agentId,
    apiModelId: modelInfo.apiModelId,
    systemPrompt,
    messages: messages as Array<{ role: string; content: string | object[] }>,
    tools: toolDefs,
    onChunk: (chunk) => {
      streamedChunks.push(chunk);
      onChunk?.(chunk);
    },
  });

  const latencyMs = Date.now() - startTime;

  // Record cost (estimated for subscription)
  try {
    const { recordCost } = await import('../costs/tracker.js');
    recordCost({
      agentId,
      modelId,
      providerId: modelInfo.providerId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs,
      requestType: routerTier ?? 'agent-sdk',
    });
  } catch { /* cost tracking is best-effort */ }

  // Map SDK tool calls to our format
  const toolCalls = result.toolCalls.map(tc => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  }));

  return {
    content: result.content,
    toolCalls,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    stopReason: result.stopReason,
  };
}

export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;

  const modelInfo = getModelInfo(modelId);

  // Ollama uses OpenAI-compatible API, not Anthropic SDK
  if (modelInfo.providerType === 'ollama') {
    return callOllamaModel(params, modelInfo);
  }

  // OpenAI and OpenAI-compatible providers
  if (modelInfo.providerType === 'openai' || modelInfo.providerType === 'openai-compatible') {
    return callOpenAIModel(params, modelInfo);
  }

  // Agent SDK transport — uses query() instead of the Anthropic Messages API
  const authType = getProviderAuthType(modelInfo.providerId);
  if (authType === 'agent-sdk') {
    return callAnthropicSdkModel(params, modelInfo);
  }

  const { client, isOAuth } = getClient(modelInfo.providerId);

  const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // OAuth tokens require the system parameter as an array with a specific
  // passphrase as the first block for Sonnet/Opus model access
  const OAUTH_SYSTEM_PASSPHRASE = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
  const systemParam: string | Anthropic.TextBlockParam[] = isOAuth
    ? [
        { type: 'text' as const, text: OAUTH_SYSTEM_PASSPHRASE },
        { type: 'text' as const, text: systemPrompt },
      ]
    : systemPrompt;

  // Estimate input tokens and enforce hard cap.
  // Use ~3.5 chars/token (conservative) to avoid underestimating.
  // Two-phase tool loading: only send always-loaded + session-loaded tools.
  let filteredTools: ToolDefinition[] = [];
  if (tools) {
    const allPermitted = getFilteredTools(agentId);
    const { filterToolsForApiCall, getAgentAlwaysLoadedTools } = await import('../tools/tool-docs.js');
    const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
    filteredTools = filterToolsForApiCall(agentId, allPermitted, alwaysLoaded);
  }
  const toolsJson = tools ? JSON.stringify(filteredTools) : '';
  const toolTokenEstimate = Math.ceil(toolsJson.length / 3.5);

  const estimateMessageTokens = (msgs: Anthropic.MessageParam[]) =>
    msgs.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(content.length / 3.5);
    }, 0);

  const systemTokenEstimate = Math.ceil(systemPrompt.length / 3.5);

  // Hard cap: input (system + messages + tools) must leave room for output
  const minOutputReserve = 4096;
  const hardInputLimit = modelInfo.contextWindow - minOutputReserve;
  let inputEstimate = systemTokenEstimate + estimateMessageTokens(anthropicMessages) + toolTokenEstimate;

  // If over budget, drop oldest messages (after any briefing/vault/summary preamble)
  // Keep at least the last 4 messages so the agent has immediate context
  while (inputEstimate > hardInputLimit && anthropicMessages.length > 4) {
    anthropicMessages.splice(0, 1);
    // After trimming, walk forward until we land on a valid first message.
    // Two invariants to enforce: (1) first message must be role=user, and
    // (2) that user message must not START with tool_result blocks — if it
    // does, those tool_result IDs refer to a tool_use we just trimmed away,
    // which causes the Anthropic API to 400 with
    // "unexpected tool_use_id found in tool_result blocks". Strip orphan
    // tool_results off the front of the first user message (or drop it
    // entirely if that's all it contained).
    while (anthropicMessages.length > 0) {
      const first = anthropicMessages[0];
      if (first.role !== 'user') {
        anthropicMessages.splice(0, 1);
        continue;
      }
      if (Array.isArray(first.content)) {
        const blocks = first.content as unknown as Array<Record<string, unknown>>;
        const kept = blocks.filter(b => b.type !== 'tool_result');
        if (kept.length === 0) {
          // Entire message was orphan tool_results — drop it
          anthropicMessages.splice(0, 1);
          continue;
        }
        if (kept.length < blocks.length) {
          anthropicMessages[0] = { ...first, content: kept as unknown as Anthropic.ContentBlockParam[] };
        }
      }
      break;
    }
    inputEstimate = systemTokenEstimate + estimateMessageTokens(anthropicMessages) + toolTokenEstimate;
  }

  if (inputEstimate > hardInputLimit) {
    logger.warn('Input still exceeds context window after trimming', {
      agentId,
      inputEstimate,
      hardInputLimit,
      contextWindow: modelInfo.contextWindow,
      messageCount: anthropicMessages.length,
    }, agentId);
  }

  const anthropicAvailable = Math.max(1024, modelInfo.contextWindow - inputEstimate - 500);
  const anthropicMaxTokens = Math.min(modelInfo.maxOutputTokens, anthropicAvailable);

  const requestParams: Anthropic.MessageCreateParams = {
    model: modelInfo.apiModelId,
    max_tokens: anthropicMaxTokens,
    system: systemParam,
    messages: anthropicMessages,
    ...(filteredTools.length > 0 ? { tools: filteredTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    })) } : {}),
  };

  // Budget check before making the API call
  const budgetCheck = checkBudget(agentId, 0.01);
  if (!budgetCheck.allowed) {
    if (budgetCheck.freeModelFallback) {
      // Budget exceeded but free model available — redirect to it
      const fb = budgetCheck.freeModelFallback;
      logger.warn(`Budget exceeded, falling back to free model: ${fb.modelName}`, {
        agentId,
        dailySpend: budgetCheck.dailySpend,
        dailyLimit: budgetCheck.dailyLimit,
        freeModel: fb.modelName,
      }, agentId);

      // Notify the agent's chat
      const notifyMsg = `[SOURCE: SYSTEM — not a message from the user] Daily budget reached ($${budgetCheck.dailySpend?.toFixed(2)} of $${budgetCheck.dailyLimit?.toFixed(2)}). Using ${fb.modelName} (free) instead.`;
      try {
        const db = getDb();
        const msgId = uuidv4();
        db.prepare("INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))").run(msgId, agentId, notifyMsg);
        broadcast({
          type: 'chat:message',
          agentId,
          message: { id: msgId, agentId, role: 'system' as const, content: notifyMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
        });

        // Also notify primary agent if this is a sub-agent
        const primaryId = getPrimaryAgentId();
        if (!isPrimaryAgent(agentId)) {
          const primaryMsgId = uuidv4();
          const primaryNotify = `[SOURCE: SYSTEM — not a message from the user] Agent "${agentId}" switched to free model (${fb.modelName}) due to budget limits.`;
          db.prepare("INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))").run(primaryMsgId, primaryId, primaryNotify);
          broadcast({
            type: 'chat:message',
            agentId: primaryId,
            message: { id: primaryMsgId, agentId: primaryId, role: 'system' as const, content: primaryNotify, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
          });
        }
      } catch { /* notification is best-effort */ }

      // Recursively call with the free model
      return callModel({
        ...params,
        modelId: fb.modelId,
        routerTier: 'budget_fallback',
      });
    }

    // No free models — block the call with clear message
    const blockMsg = budgetCheck.reason ?? `Daily budget limit reached ($${budgetCheck.dailySpend?.toFixed(2)} spent of $${budgetCheck.dailyLimit?.toFixed(2)} limit). No free models available.`;
    throw new AgentError(blockMsg, agentId, {
      code: 'BUDGET_EXCEEDED',
      retryable: false,
    });
  }

  // Log request details for debugging
  const msgPreview = anthropicMessages.map((m, i) => ({
    idx: i,
    role: m.role,
    contentType: typeof m.content === 'string' ? 'string' : 'array',
    contentLen: typeof m.content === 'string' ? m.content.length : (m.content as unknown[]).length,
  }));

  logger.info('Calling model', {
    model: modelInfo.apiModelId,
    provider: modelInfo.providerId,
    messageCount: messages.length,
    systemPromptLength: systemPrompt.length,
    messages: msgPreview,
    toolCount: filteredTools.length,
  }, agentId);

  const startTime = Date.now();

  try {
    const stream = client.messages.stream(requestParams);

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let currentToolName = '';
    let currentToolInput = '';
    let currentToolId = '';

    stream.on('text', (text) => {
      fullText += text;
      if (onChunk) {
        onChunk(text);
      }
    });

    stream.on('contentBlock', (block) => {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    });

    const finalMessage = await stream.finalMessage();

    const latencyMs = Date.now() - startTime;
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;

    // Calculate cost
    const inputCost = modelInfo.apiModelId.includes('opus')
      ? (inputTokens / 1_000_000) * 15.0
      : modelInfo.apiModelId.includes('sonnet')
        ? (inputTokens / 1_000_000) * 3.0
        : (inputTokens / 1_000_000) * 0.80;

    const outputCost = modelInfo.apiModelId.includes('opus')
      ? (outputTokens / 1_000_000) * 75.0
      : modelInfo.apiModelId.includes('sonnet')
        ? (outputTokens / 1_000_000) * 15.0
        : (outputTokens / 1_000_000) * 4.0;

    const totalCost = inputCost + outputCost;

    // Audit log for model call
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, cost, created_at)
      VALUES (?, ?, 'model_call', ?, 'success', ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      modelInfo.apiModelId,
      JSON.stringify({ inputTokens, outputTokens, latencyMs }),
      totalCost,
    );

    // Record cost in the Phase 4 cost_records table
    recordCost({
      agentId,
      modelId,
      providerId: modelInfo.providerId,
      inputTokens,
      outputTokens,
      latencyMs,
      requestType: routerTier ?? (tools ? 'agent_turn' : 'completion'),
    });

    // Update rate limits from response headers (if available from stream)
    try {
      const rawResponse = (stream as unknown as { response?: { headers?: Record<string, string> } }).response;
      if (rawResponse?.headers) {
        const headers: Record<string, string> = {};
        if (typeof rawResponse.headers === 'object') {
          for (const [key, value] of Object.entries(rawResponse.headers)) {
            if (typeof value === 'string') headers[key] = value;
          }
        }
        updateRateLimits(modelId, headers);
      }
    } catch {
      // Rate limit header extraction is best-effort
    }

    // Track provider health
    recordProviderSuccess(modelInfo.providerId);

    logger.info('Model call completed', {
      model: modelInfo.apiModelId,
      inputTokens,
      outputTokens,
      latencyMs,
      cost: totalCost.toFixed(6),
      stopReason: finalMessage.stop_reason,
      toolCallCount: toolCalls.length,
    }, agentId);

    return {
      content: fullText,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason: finalMessage.stop_reason,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // Extract detailed error info from Anthropic SDK
    // Track provider health
    recordProviderError(modelInfo.providerId);

    const errorDetail: Record<string, unknown> = {
      model: modelInfo.apiModelId,
      providerId: modelInfo.providerId,
      latencyMs,
      error: message,
    };

    if (err instanceof Anthropic.APIError) {
      errorDetail.status = err.status;
      errorDetail.errorBody = err.error;
      errorDetail.requestId = err.headers?.['request-id'];
    } else if (err instanceof Error) {
      errorDetail.stack = err.stack?.split('\n').slice(0, 3).join(' | ');
    }

    // Put the key info in the message itself so it's visible in the log viewer
    const statusStr = err instanceof Anthropic.APIError ? `[${err.status}] ` : '';
    logger.error(`Model call failed: ${statusStr}${message}`, errorDetail, agentId);

    // Determine if retryable
    const isRateLimited = message.includes('rate_limit') || message.includes('429');
    const isOverloaded = message.includes('overloaded') || message.includes('529');
    const isServerError = message.includes('500') || message.includes('503');

    // Schedule background retry for rate limits — but NOT for auto-routed agents.
    // Auto-routed agents handle rate limits via the fallback chain in the runtime
    // (try the next model in the tier, then cross-tier). The background retry
    // manager would interfere by replaying the message on the SAME rate-limited
    // model 10 seconds later, conflicting with the fallback that already selected
    // a different model.
    if ((isRateLimited || isOverloaded) && !params.routerTier) {
      // Try to extract retry-after header (Anthropic API key responses include this)
      let retryAfterSeconds: number | null = null;
      if (err instanceof Anthropic.APIError && err.headers) {
        const retryAfter = err.headers['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) retryAfterSeconds = parsed;
        }
      }

      // Get the last user message to replay on retry
      const lastMsg = (() => {
        try {
          const db = getDb();
          const row = db.prepare(
            "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
          ).get(agentId) as { content: string } | undefined;
          return row?.content ?? null;
        } catch { return null; }
      })();

      scheduleRateLimitRetry(agentId, retryAfterSeconds, lastMsg);
    }

    throw new AgentError(`Model call failed: ${message}`, agentId, {
      retryable: isRateLimited || isOverloaded || isServerError,
      code: 'MODEL_CALL_FAILED',
      cause: err instanceof Error ? err : undefined,
    });
  }
}

export function clearClientCache(providerId?: string): void {
  if (providerId) {
    clientCache.delete(providerId);
    // Also clear OpenAI client cache entries for this provider
    for (const key of openaiClientCache.keys()) {
      if (key.startsWith(`${providerId}:`)) openaiClientCache.delete(key);
    }
  } else {
    clientCache.clear();
    openaiClientCache.clear();
  }
}

export function getContextWindow(modelId: string): number {
  try {
    const info = getModelInfo(modelId);
    return info.contextWindow;
  } catch {
    return 200000; // Default fallback
  }
}
