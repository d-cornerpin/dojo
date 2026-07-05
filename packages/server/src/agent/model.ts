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
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }>;
  systemPrompt: string;
  /**
   * C28 Part 1 (P-2): optional system-side volatile tail. Rendered AFTER the
   * cached stable system block (Anthropic: a second uncached text block;
   * OpenRouter: a second unmarked system message), so it can never invalidate
   * the cached prefix. Empty after P-1; defense-in-depth for future needs.
   */
  systemVolatile?: string;
  tools?: boolean;
  onChunk?: (chunk: string) => void;
  /**
   * Streamed thinking / reasoning chunks from providers that expose them
   * as a sibling field of `content` (e.g. DeepSeek v4-pro). Called once
   * per delta. Live UI uses this to render a collapsible "Thinking…"
   * section above the eventual answer. Anthropic's thinking blocks
   * arrive inside content and don't use this callback.
   */
  onReasoningChunk?: (chunk: string) => void;
  routerTier?: string; // populated by auto-router
  // External abort signal, when fired, the underlying SDK call aborts
  // and callModel throws. Used by the runtime's stop button to actually
  // cancel in-flight calls (vs. v1's pre-fix behavior where stop only
  // affected the runtime loop, not the underlying fetch).
  abortSignal?: AbortSignal;
  // F3: set by best-effort utility calls whose caller fully handles failure
  // with a fallback (e.g. web_fetch page extraction falls back to raw fetch).
  // Downgrades the provider-failure log from ERROR to WARN so a handled,
  // recoverable failure doesn't read as an agent-level error in the log.
  bestEffort?: boolean;
}

export interface ModelCallResult {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /**
   * Aggregated reasoning text returned by the model when thinking is
   * enabled (DeepSeek v4-pro etc.). Empty string when thinking didn't
   * fire. The runtime persists this on the assistant message so the
   * next request can round-trip it (DeepSeek requires reasoning_content
   * be echoed on tool-call follow-up turns).
   */
  reasoningContent?: string;
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
    logger.error(`No credential found for provider "${providerId}", check ~/.dojo/secrets.yaml providers.${providerId}`, {
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
    credentialLength: credential.length, // never log secret bytes (audit finding 8/21)
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

// ── Universal orphan tool_use/tool_result sanitization ──
// Mutates the messages array in place. Strips tool_use blocks from assistant
// messages whose ids aren't matched by tool_result blocks in the
// immediately-following tool-result-bearing messages.
//
// Parallel-call gotcha: when an agent fires N parallel tool_use blocks, the
// store / assembler often emit N separate consecutive `role:'user'` (or
// `role:'tool'`) messages, one per result, instead of a single bundled
// user message. The old version of this function only looked at the SINGLE
// immediately-next message, so it saw the first tool_result and declared
// the remaining N-1 tool_use blocks orphaned. Stripping them silently
// rewrote the assistant message, on the next turn the model thought it
// had only called one tool, so it re-fired the others. That's the
// "agent repeats itself" regression the owner caught.
//
// Fix: walk forward consuming every consecutive message that looks like a
// tool-result carrier and union all their tool_use_ids before deciding
// what's orphaned. A message "looks like a tool-result carrier" when it
// has role='user' or role='tool' AND every content block is type
// 'tool_result' (i.e. it's purely a result container, not a normal user
// message that happens to follow tool calls).
function sanitizeOrphanToolBlocks(
  messages: Array<{ role: string; content: unknown }>,
  agentId: string,
): void {
  const isPureToolResultMessage = (m: { role: string; content: unknown }): boolean => {
    if (m.role !== 'user' && m.role !== 'tool') return false;
    if (!Array.isArray(m.content)) return false;
    const blocks = m.content as Array<Record<string, unknown>>;
    if (blocks.length === 0) return false;
    return blocks.every(b => b.type === 'tool_result');
  };

  let stripped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as Array<Record<string, unknown>>;
    const useIds = blocks
      .filter(b => b.type === 'tool_use' && typeof b.id === 'string')
      .map(b => b.id as string);
    if (useIds.length === 0) continue;

    // Collect tool_result IDs from ALL consecutive following tool-result
    // carrier messages, not just messages[i+1]. Parallel tool calls
    // commonly result in multiple back-to-back tool-result messages.
    const resultIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && isPureToolResultMessage(messages[j])) {
      for (const b of messages[j].content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          resultIds.add(b.tool_use_id as string);
        }
      }
      j++;
    }

    const orphanIds = useIds.filter(id => !resultIds.has(id));
    if (orphanIds.length === 0) continue;

    const orphanSet = new Set(orphanIds);
    const kept = blocks.filter(b => !(b.type === 'tool_use' && orphanSet.has(b.id as string)));
    stripped += orphanIds.length;

    if (kept.length === 0) {
      messages.splice(i, 1);
    } else {
      messages[i] = { ...msg, content: kept };
    }
  }

  if (stripped > 0) {
    logger.warn('Stripped orphan tool_use blocks from messages', {
      droppedCount: stripped,
      messageCount: messages.length,
    }, agentId);
  }
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
      // Invalid JSON, treat as text-only for safety rather than enabling everything
      logger.warn('Model has invalid capabilities JSON, defaulting to text-only', { modelId });
      capabilities = ['text'];
      capabilitiesValid = false;
    }
  } else {
    // No capabilities data at all, don't assume anything
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
    // Default ON, matches migration default and the UX the user asked for.
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
        const pendingOllamaImages: string[] = []; // base64 data for images

        for (const tr of toolResults) {
          const toolUseId = tr.tool_use_id as string;
          const toolName = toolIdToName.get(toolUseId) ?? '';

          if (typeof tr.content === 'string') {
            native.push({ role: 'tool', content: tr.content, tool_name: toolName });
          } else if (Array.isArray(tr.content)) {
            // Structured content blocks, extract text for tool result,
            // queue images for a follow-up user message
            const contentBlocks = tr.content as Array<Record<string, unknown>>;
            const textParts = contentBlocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n');
            native.push({ role: 'tool', content: textParts || '[Image loaded]', tool_name: toolName });

            for (const img of contentBlocks.filter(b => b.type === 'image')) {
              const source = img.source as Record<string, unknown> | undefined;
              if (source?.type === 'base64' && typeof source.data === 'string') {
                pendingOllamaImages.push(source.data as string);
              }
            }
          } else {
            native.push({ role: 'tool', content: JSON.stringify(tr.content), tool_name: toolName });
          }
        }

        // Ollama supports images in user messages via the 'images' field
        if (pendingOllamaImages.length > 0) {
          native.push({
            role: 'user',
            content: '[Image from tool result, analyze this image]',
            images: pendingOllamaImages,
          } as unknown as typeof native[0]);
        }

        // Emit any remaining text blocks
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
            logger.warn('Ollama translator: document block has no base64 data, skipping', {
              title,
            }, agentId);
            continue;
          }

          try {
            const extracted = await extractPdfText(source.data);
            const header = `[PDF attachment: ${title}, ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}${extracted.truncated ? `, truncated to first ${extracted.pagesExtracted}` : ''}]`;
            const footer = `[end of ${title}]`;
            textParts.push(`${header}\n${extracted.text}\n${footer}`);

            if (extracted.truncated) {
              broadcast({
                type: 'chat:error',
                agentId,
                error: `"${title}" was too large, only the first ${extracted.pagesExtracted} of ${extracted.pageCount} pages reached the agent.`,
                severity: 'warning',
                retryable: false,
              });
            }
          } catch (err) {
            const reason = err instanceof PdfExtractError
              ? err.message
              : (err instanceof Error ? err.message : String(err));
            logger.warn('Ollama translator: PDF extraction failed, dropping attachment', {
              title,
              reason,
            }, agentId);
            broadcast({
              type: 'chat:error',
              agentId,
              error: `Couldn't read "${title}", the agent will respond without it.`,
              severity: 'warning',
              retryable: false,
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
  // ON THE SAME PROVIDER, remote Ollama hosts have their own slot pool).
  const lock = getOllamaLock();
  await lock.acquire(modelInfo.providerId, ollamaModelName);

  const startTime = Date.now();

  const nativeMessages = await buildNativeOllamaMessages(systemPrompt, messages, agentId);

  // Build tools in the shape Ollama's native API accepts (same as the OpenAI
  // function-calling schema, Ollama mirrors it). Two-phase loading: only
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
    // ignore the flag, the call still works; we just capture the thinking
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
    // Combine external abort (from stop button) with internal 5-min timeout.
    // Node 22+ AbortSignal.any returns a signal that aborts when EITHER
    // input signal aborts.
    const timeoutSignal = AbortSignal.timeout(300000);
    const signal = params.abortSignal
      ? AbortSignal.any([timeoutSignal, params.abortSignal])
      : timeoutSignal;
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal,
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
                // Structured repair before rejecting (OPEN-1), same floor-model
                // failure mode (raw control chars in long string args).
                const repaired = repairToolCallArgs(rawArgs);
                if (repaired !== null) {
                  parsedArgs = repaired;
                  logger.info('Repaired malformed tool call JSON arguments', {
                    toolName: tc.function?.name,
                  }, agentId);
                } else {
                  logger.warn('Ollama: malformed tool call JSON arguments (repair failed)', {
                    toolName: tc.function?.name,
                    rawArgs: typeof rawArgs === 'string' ? rawArgs.slice(0, 200) : String(rawArgs),
                  }, agentId);
                  parsedArgs = { __malformed_args: typeof rawArgs === 'string' ? rawArgs.slice(0, 500) : String(rawArgs) };
                }
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

    // Record cost ($0 for local models, still tracked for latency metrics)
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
    // F3: best-effort utility calls (caller has a fallback) log at WARN, a
    // handled recoverable failure is not an agent-level error.
    logger[params.bestEffort ? 'warn' : 'error'](`Ollama call failed: ${message}`, {
      model: ollamaModelName,
      baseUrl,
      latencyMs,
      bestEffort: params.bestEffort ?? false,
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

// Hosts whose API is rooted at the bare domain (no `/v1` segment). The
// OpenAI SDK calls paths like `/chat/completions` directly off the
// configured baseURL, so for these hosts we DON'T append `/v1`. DeepSeek
// is the canonical example: their docs put the chat endpoint at
// https://api.deepseek.com/chat/completions, not /v1/chat/completions.
const NO_V1_HOSTS = ['api.deepseek.com', 'deepseek.com'];

function hostNeedsNoV1(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return NO_V1_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

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
    ? (() => {
        const cleaned = baseUrl.replace(/\/+$/, '');
        if (hostNeedsNoV1(cleaned)) return cleaned;
        return cleaned.endsWith('/v1') ? cleaned : cleaned + '/v1';
      })()
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
// function runs, this helper just translates whatever's left.
async function buildOpenAIMessages(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }>,
  agentId: string,
  isDeepSeek = false,
  isOpenRouter = false,
  systemVolatile = '',
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  // OpenAI & DeepSeek auto-cache a stable system prefix with NO markup, so they
  // get a plain string (changing the shape could disturb their auto-cache).
  // OpenRouter is a proxy: Anthropic/Gemini-backed models behind it need an
  // explicit cache_control marker (OpenRouter's adopted convention), which it
  // ignores for backends that already auto-cache. So mark only for OpenRouter.
  const systemMessage = (isOpenRouter
    ? { role: 'system', content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] }
    : { role: 'system', content: systemPrompt }) as OpenAI.ChatCompletionMessageParam;
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [systemMessage];
  // C28 P-2: a second, unmarked system message for any system-side volatile
  // content, so it sits AFTER the marked/auto-cached stable system prefix and
  // cannot invalidate it. Empty after P-1; only added if ever populated.
  if (systemVolatile) {
    openaiMessages.push({ role: 'system', content: systemVolatile } as OpenAI.ChatCompletionMessageParam);
  }

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
        // Collect any image blocks from tool results that contain structured
        // content (e.g., file_read on an image). OpenAI tool results only
        // support string content, so we extract the text portion for the tool
        // result and emit any images as a follow-up user message.
        const pendingImages: Array<Record<string, unknown>> = [];

        for (const tr of toolResults) {
          if (typeof tr.content === 'string') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id as string,
              content: tr.content,
            });
          } else if (Array.isArray(tr.content)) {
            // Structured content blocks, extract text and images separately
            const contentBlocks = tr.content as Array<Record<string, unknown>>;
            const textParts = contentBlocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n');
            const imageBlks = contentBlocks.filter(b => b.type === 'image');
            const docBlks = contentBlocks.filter(b => b.type === 'document');

            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id as string,
              content: textParts || '[Image loaded, see below]',
            });

            // Queue images to be emitted as a user message after tool results
            for (const img of imageBlks) {
              const source = img.source as Record<string, unknown> | undefined;
              if (source?.type === 'base64' && typeof source.data === 'string') {
                const mediaType = (source.media_type as string) || 'image/png';
                pendingImages.push({
                  type: 'image_url',
                  image_url: { url: `data:${mediaType};base64,${source.data}` },
                });
              }
            }

            // Inline PDF text for non-vision document blocks
            for (const doc of docBlks) {
              const source = doc.source as Record<string, unknown> | undefined;
              if (source?.type === 'base64' && typeof source.data === 'string') {
                try {
                  const { extractPdfText } = await import('../services/pdf-extract.js');
                  const extracted = await extractPdfText(source.data as string);
                  const title = (doc.title as string) ?? 'document';
                  openaiMessages.push({
                    role: 'user',
                    content: `[PDF: ${title}]\n${extracted.text}\n[end of ${title}]`,
                  });
                } catch { /* PDF extraction failed, skip */ }
              }
            }
          } else {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id as string,
              content: JSON.stringify(tr.content),
            });
          }
        }

        // Emit queued images as a user message so the model can see them.
        // OpenAI doesn't support images in tool results, but a follow-up
        // user message with the image works for vision-capable models.
        if (pendingImages.length > 0) {
          const parts: OpenAI.ChatCompletionContentPart[] = [
            { type: 'text', text: '[Image from tool result, analyze this image]' },
            ...(pendingImages as unknown as OpenAI.ChatCompletionContentPart[]),
          ];
          openaiMessages.push({ role: 'user', content: parts });
        }

        // Fall through to emit any remaining text blocks
        const remainingText = blocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n').trim();
        if (remainingText) {
          openaiMessages.push({ role: 'user', content: remainingText });
        }
        continue;
      }

      // Regular user message, text + optional images + optional PDFs
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
            logger.warn('OpenAI translator: document block has no base64 data, skipping', {
              title,
            }, agentId);
            continue;
          }
          try {
            const extracted = await extractPdfText(source.data);
            const header = `[PDF attachment: ${title}, ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}${extracted.truncated ? `, truncated to first ${extracted.pagesExtracted}` : ''}]`;
            const footer = `[end of ${title}]`;
            textContent = (textContent ? textContent + '\n\n' : '') + `${header}\n${extracted.text}\n${footer}`;

            if (extracted.truncated) {
              broadcast({
                type: 'chat:error',
                agentId,
                error: `"${title}" was too large, only the first ${extracted.pagesExtracted} of ${extracted.pageCount} pages reached the agent.`,
                severity: 'warning',
                retryable: false,
              });
            }
          } catch (err) {
            const reason = err instanceof PdfExtractError
              ? err.message
              : (err instanceof Error ? err.message : String(err));
            logger.warn('OpenAI translator: PDF extraction failed, dropping attachment', {
              title,
              reason,
            }, agentId);
            broadcast({
              type: 'chat:error',
              agentId,
              error: `Couldn't read "${title}", the agent will respond without it.`,
              severity: 'warning',
              retryable: false,
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
          logger.warn('OpenAI translator: image block has no base64 data, skipping', {}, agentId);
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
        // Nothing survived encoding, fall back to whatever text we have.
        openaiMessages.push({ role: 'user', content: textContent || '(attachment could not be decoded)' });
      } else if (parts.length === 1 && parts[0].type === 'text') {
        // Only text survived, send as string for compat with providers that
        // don't love the array form for text-only messages.
        openaiMessages.push({ role: 'user', content: parts[0].text });
      } else {
        openaiMessages.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: 'assistant', content: m.content };
        if (m.reasoningContent) {
          (msg as unknown as Record<string, unknown>).reasoning_content = m.reasoningContent;
        } else if (isDeepSeek) {
          // DeepSeek requires reasoning_content on every assistant turn in
          // thinking mode. Use empty string as a safe fallback when we don't
          // have stored reasoning (legacy rows, or empty thinking response).
          (msg as unknown as Record<string, unknown>).reasoning_content = '';
        }
        openaiMessages.push(msg);
      } else if (Array.isArray(m.content)) {
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

        // DeepSeek 400s if reasoning_content is missing on tool-call
        // follow-ups. Always include it, empty string when we don't have
        // stored reasoning. Other providers ignore the unknown field.
        if (m.reasoningContent) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content = m.reasoningContent;
        } else if (isDeepSeek) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content = '';
        }

        openaiMessages.push(assistantMsg);
      }
    }
  }

  return openaiMessages;
}

/**
 * Best-effort repair of malformed tool-call argument JSON from weak models.
 * The dominant DeepSeek (and other floor-model) failure mode is raw, unescaped
 * control characters, newlines / tabs / carriage returns, inside long string
 * values (e.g. a multi-line `result` or `description` field), plus the
 * occasional trailing comma. The engine must build to the floor: rejecting the
 * call forces a full retry that burns turns and can trip the thrash breaker
 * (DOJO-ISSUES-LOG OPEN-1/OPEN-4). We walk the raw string tracking in-string
 * state and escape any raw control char that appears inside a JSON string, then
 * re-parse (also trying a trailing-comma strip). Returns the parsed object on
 * success, or null if it still can't parse (e.g. genuinely truncated output).
 */
export function repairToolCallArgs(raw: string): Record<string, unknown> | null {
  const escapeControlCharsInStrings = (s: string): string => {
    let out = '';
    let inStr = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; escaped = true; continue; }
        if (ch === '"') { out += ch; inStr = false; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        // Other C0 control chars (e.g. \b, \f, vertical tab) are illegal raw in
        // JSON strings too, escape via \u00XX so the parser accepts them.
        if (ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
        out += ch;
      } else {
        if (ch === '"') { inStr = true; }
        out += ch;
      }
    }
    return out;
  };
  const escaped = escapeControlCharsInStrings(raw);
  const candidates = [escaped, escaped.replace(/,(\s*[}\]])/g, '$1')];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

async function callOpenAIModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[] },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;
  const startTime = Date.now();

  const client = getOpenAIClient(modelInfo.providerId, modelInfo.providerBaseUrl);

  const isDeepSeek = (modelInfo.providerBaseUrl ?? '').toLowerCase().includes('deepseek.com');
  const isOpenRouter = (modelInfo.providerBaseUrl ?? '').toLowerCase().includes('openrouter.ai');
  const openaiMessages = await buildOpenAIMessages(systemPrompt, messages, agentId, isDeepSeek, isOpenRouter, params.systemVolatile ?? '');

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
    logger.warn('Input exceeds context window, trimming oldest messages to fit', {
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
          // Orphan tool result, its assistant was just dropped
          const toolTokens = Math.ceil(
            (typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '')).length / 3,
          );
          openaiMessages.splice(1, 1);
          currentEstimate -= toolTokens;
          continue;
        }
        if (first.role === 'assistant' && Array.isArray(first.tool_calls)) {
          // Assistant with tool_calls at the front, check if next message
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

  // v2.7.27: belt-and-suspenders tool_call/tool_result pair sanitizer.
  // The trimming logic earlier only fires when input exceeds the context
  // window. The PM agent was hitting "Messages with role 'tool' must be
  // a response to a preceding message with 'tool_calls'" (orphaned tool result) AND
  // "An assistant message with 'tool_calls' must be followed by tool messages
  // responding to each 'tool_call_id'" (assistant tool_calls without matching
  // results) without crossing the context ceiling. Two passes:
  //   1. Drop any role='tool' message whose tool_call_id isn't owed by the
  //      MOST RECENT assistant-with-tool_calls. (The old version checked
  //      the immediately-prior kept message only, that broke parallel
  //      calls because after the first tool result was kept, subsequent
  //      tool results in the same parallel batch had a tool message as
  //      their immediate prior and got dropped. That made Pass 2 also
  //      drop the assistant because its tool_calls were "unanswered",
  //      erasing the whole turn from history, the regression that made
  //      DeepSeek re-fire identical parallel calls every turn.)
  //   2. Drop any assistant message whose tool_calls do not all have
  //      matching tool-result messages immediately after (orphan call).
  // Idempotent and cheap, runs every call.
  {
    type AnyMsg = OpenAI.ChatCompletionMessageParam & {
      tool_calls?: Array<{ id: string }>;
      tool_call_id?: string;
    };

    // Pass 1: drop orphan tool results. A tool result is an orphan iff its
    // tool_call_id is not in the set of pending call ids the most recent
    // assistant-with-tool_calls is owed answers for. As we keep tool
    // messages we remove their id from the pending set; when we encounter
    // the NEXT assistant message we reset.
    const afterPass1: OpenAI.ChatCompletionMessageParam[] = [];
    let strippedOrphanResult = 0;
    let pendingOwedIds: Set<string> | null = null;
    for (const m of openaiMessages as AnyMsg[]) {
      if (m.role === 'assistant') {
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          pendingOwedIds = new Set(m.tool_calls.map((c) => c.id));
        } else {
          pendingOwedIds = null;
        }
        afterPass1.push(m);
        continue;
      }
      if (m.role === 'tool') {
        const callId = m.tool_call_id ?? '';
        if (!pendingOwedIds || !pendingOwedIds.has(callId)) {
          strippedOrphanResult++;
          continue;
        }
        afterPass1.push(m);
        continue;
      }
      // Any other role (user, system) breaks the parallel-batch run; the
      // assistant's tool_calls should have been fully answered by then.
      pendingOwedIds = null;
      afterPass1.push(m);
    }

    // Pass 2: drop assistant messages whose tool_calls are not all answered
    // by the immediately-following tool-result messages with matching ids.
    const afterPass2: OpenAI.ChatCompletionMessageParam[] = [];
    let strippedOrphanCall = 0;
    for (let i = 0; i < afterPass1.length; i++) {
      const m = afterPass1[i] as AnyMsg;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const callIds = new Set(m.tool_calls.map((c) => c.id));
        const followIds = new Set<string>();
        let j = i + 1;
        while (j < afterPass1.length) {
          const f = afterPass1[j] as AnyMsg;
          if (f.role !== 'tool') break;
          if (f.tool_call_id) followIds.add(f.tool_call_id);
          j++;
        }
        // Every call id must be answered.
        let allAnswered = true;
        for (const id of callIds) {
          if (!followIds.has(id)) { allAnswered = false; break; }
        }
        if (!allAnswered) {
          // Drop this assistant message AND any of the following tool
          // results that belong to it (they would orphan too).
          strippedOrphanCall++;
          // Skip the following tool results we just inspected.
          i = j - 1;
          continue;
        }
      }
      afterPass2.push(m);
    }

    if (strippedOrphanResult > 0 || strippedOrphanCall > 0) {
      logger.warn('Sanitized tool_call/tool_result pairs before model call', {
        agentId,
        strippedOrphanResult,
        strippedOrphanCall,
        finalMessageCount: afterPass2.length,
        originalMessageCount: openaiMessages.length,
      }, agentId);
      openaiMessages.length = 0;
      openaiMessages.push(...afterPass2);
    }
  }

  const requestParams: OpenAI.ChatCompletionCreateParams = {
    model: modelInfo.apiModelId,
    messages: openaiMessages,
    stream: true,
    // Ask for a final usage chunk so we can see real prompt-cache hits (DeepSeek
    // reports prompt_cache_hit_tokens; OpenAI reports prompt_tokens_details
    // .cached_tokens). Used for cache-hit logging below; harmless if ignored.
    stream_options: { include_usage: true },
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
  // (isOpenRouter is declared once near the top of this function.)
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

  // ── DeepSeek native thinking ──
  // DeepSeek v4-flash/v4-pro return reasoning as a sibling `reasoning_content`
  // field in stream deltas and on assistant messages, distinct from
  // Anthropic's thinking-block-inside-content pattern. Toggle is sent via
  // top-level `thinking: { type: 'enabled' | 'disabled' }`. v4-pro defaults
  // to thinking-on; we honor model.thinking_enabled here so the user has
  // explicit control via the Models page. Round-trip is handled by
  // (a) capturing delta.reasoning_content in the stream loop below and
  // (b) passing assistantMsg.reasoning_content on subsequent requests via
  // the message build path. Per DeepSeek docs we also avoid sending
  // temperature / top_p when thinking is enabled (they're rejected), the
  // current dispatch doesn't send those anyway, so no extra guard needed.
  if (isDeepSeek) {
    (requestParams as unknown as { thinking?: { type: string } }).thinking = {
      type: modelInfo.thinkingEnabled && supportsThinking ? 'enabled' : 'disabled',
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

  // DeepSeek-only diagnostic: log per-assistant-message reasoning_content
  // presence so future "must be passed back" 400s can be diagnosed from logs.
  if (isDeepSeek) {
    const assistantSummary = openaiMessages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === 'assistant')
      .map(({ m, i }) => {
        const rc = (m as unknown as Record<string, unknown>).reasoning_content;
        const tc = (m as { tool_calls?: unknown[] }).tool_calls;
        return {
          idx: i,
          hasToolCalls: Array.isArray(tc) && tc.length > 0,
          hasReasoningField: rc !== undefined,
          reasoningChars: typeof rc === 'string' ? rc.length : 0,
        };
      });
    logger.info('DeepSeek request, assistant message reasoning round-trip', {
      assistantMessages: assistantSummary,
    }, agentId);
  }

  try {
    // Pass the external abort signal so stop-button aborts cancel the
    // in-flight fetch (instead of letting it complete in the background).
    const requestOptions = params.abortSignal ? { signal: params.abortSignal } : undefined;
    const stream = await client.chat.completions.create(requestParams, requestOptions);

    let fullText = '';
    let fullReasoning = '';
    const toolCalls: ToolCall[] = [];
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();
    // Final usage chunk (from stream_options.include_usage), carries cache stats.
    let realUsage: (OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }) | undefined;

    for await (const chunk of stream) {
      // The usage chunk arrives last with an empty choices array, capture it
      // before the delta guard skips it.
      if (chunk.usage) realUsage = chunk.usage as typeof realUsage;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Reasoning content (DeepSeek-style sibling field). Stream it through
      // a separate callback so the dashboard renders it in a collapsible
      // "Thinking…" section that's distinct from the final answer text.
      // OpenRouter also surfaces this when reasoning is enabled on its
      // unified path. Anthropic's thinking blocks come via content-array,
      // not here, and are handled in the Anthropic dispatch path.
      const reasoningChunk = (delta as unknown as { reasoning_content?: string }).reasoning_content
        ?? (delta as unknown as { reasoning?: string }).reasoning
        ?? null;
      if (reasoningChunk) {
        fullReasoning += reasoningChunk;
        if (params.onReasoningChunk) params.onReasoningChunk(reasoningChunk);
      }

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
          // Attempt a structured repair before rejecting (OPEN-1): weak models
          // routinely emit raw control chars inside long string args. Rejecting
          // forces a full retry that burns turns and feeds the thrash breaker.
          const repaired = repairToolCallArgs(acc.args);
          if (repaired !== null) {
            parsedArgs = repaired;
            logger.info('Repaired malformed tool call JSON arguments', {
              toolName: acc.name,
            }, agentId);
          } else {
            malformedArgs = true;
            logger.warn('OpenAI: malformed tool call JSON arguments (repair failed)', {
              toolName: acc.name,
              rawArgs: acc.args.slice(0, 200),
            }, agentId);
          }
        }
      }
      if (malformedArgs) {
        // Instead of silently using empty args, synthesize an error tool result
        // so the model sees the failure and can retry with valid JSON.
        // We push a synthetic tool call that the runtime will execute, the
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

    // Prompt-cache visibility: log how much of the prompt was served from cache.
    // DeepSeek exposes prompt_cache_hit/miss_tokens; OpenAI exposes
    // prompt_tokens_details.cached_tokens. Lets us confirm caching actually
    // HITS (markers alone don't guarantee it, the prefix must be stable).
    // Token accounting (C28 P-7). Prefer real provider usage; the char
    // estimate is now only the fallback for when the stream returned no usage.
    //   inputTokens      = TOTAL prompt tokens (returned to the caller for
    //                      context accounting; real when reported, else estimate)
    //   uncachedInputTokens = the DISJOINT uncached input passed to recordCost
    //   cacheReadTokens  = cache-hit portion (DeepSeek prompt_cache_hit /
    //                      OpenAI prompt_tokens_details.cached), undefined when
    //                      the provider did not report (persists NULL)
    // These providers report cache HITS only (no cache-creation surcharge),
    // so cacheCreationTokens is never passed here.
    let inputTokens: number;
    let outputTokens: number;
    let uncachedInputTokens: number;
    let cacheReadTokens: number | undefined;
    if (realUsage) {
      const promptTokens = realUsage.prompt_tokens ?? 0;
      const cachedTokens = realUsage.prompt_cache_hit_tokens ?? realUsage.prompt_tokens_details?.cached_tokens ?? 0;
      // DeepSeek reports miss directly (prompt = hit + miss); OpenAI reports
      // cached_tokens as a subset of prompt_tokens, so subtract for uncached.
      const missTokens = realUsage.prompt_cache_miss_tokens;
      cacheReadTokens = cachedTokens;
      inputTokens = promptTokens;
      uncachedInputTokens = typeof missTokens === 'number' ? missTokens : Math.max(0, promptTokens - cachedTokens);
      outputTokens = realUsage.completion_tokens ?? 0;
      logger.info('prompt cache usage', {
        provider: modelInfo.providerType,
        model: modelInfo.apiModelId,
        promptTokens,
        cachedTokens,
        cacheHitRatio: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) / 100 : 0,
      }, agentId);
    } else {
      // No usage in the stream: fall back to char-length estimates.
      inputTokens = Math.ceil((systemPrompt.length + JSON.stringify(openaiMessages).length) / 4);
      outputTokens = Math.ceil((fullText.length + JSON.stringify(toolCalls).length) / 4);
      uncachedInputTokens = inputTokens;
      cacheReadTokens = undefined;
    }

    // Calculate cost. Uncached input at full rate + cache reads at 0.1x (P-7).
    const costPerM = getOpenAICost(modelInfo.apiModelId);
    const totalCost = (uncachedInputTokens / 1_000_000) * costPerM.input
      + ((cacheReadTokens ?? 0) / 1_000_000) * costPerM.input * 0.1
      + (outputTokens / 1_000_000) * costPerM.output;

    // Audit log
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, cost, created_at)
      VALUES (?, ?, 'model_call', ?, 'success', ?, ?, datetime('now'))
    `).run(
      uuidv4(), agentId, modelInfo.apiModelId,
      JSON.stringify({ inputTokens, outputTokens, cacheReadTokens: cacheReadTokens ?? null, latencyMs }),
      totalCost,
    );

    recordCost({
      agentId, modelId,
      providerId: modelInfo.providerId,
      inputTokens: uncachedInputTokens, outputTokens, latencyMs,
      requestType: routerTier ?? 'agent_turn',
      cacheReadTokens,
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
      fullText.includes('<|tool_call>') ||
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

      // Pattern 5: <|tool_call>call:tool_name(key="value", ...)<tool_call|>
      // Used by some Qwen/DeepSeek-derived models
      if (toolCalls.length === 0) {
        const pipeRegex = /<\|tool_call>call:(\w+)\(([^)]*)\)<(?:tool_call\||\|tool_call)>/g;
        let pipeMatch;
        while ((pipeMatch = pipeRegex.exec(fullText)) !== null) {
          const toolName = pipeMatch[1];
          const rawArgs = pipeMatch[2];
          const args: Record<string, unknown> = {};
          // Parse key="value" or key=value pairs
          const argPairs = rawArgs.matchAll(/(\w+)="([^"]*)"/g);
          for (const pair of argPairs) {
            args[pair[1]] = pair[2];
          }
          // Also try key=value (unquoted)
          const unquotedPairs = rawArgs.matchAll(/(\w+)=([^,)"]+)/g);
          for (const pair of unquotedPairs) {
            if (!(pair[1] in args)) args[pair[1]] = pair[2].trim();
          }
          toolCalls.push({
            id: `text_tool_${Date.now()}_${toolCalls.length}`,
            name: toolName,
            arguments: args,
          });
        }
      }

      if (toolCalls.length > 0) {
        // Strip all recognized tool call patterns from visible text
        fullText = fullText.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
          .replace(/<invoke name="[^"]*">[\s\S]*?<\/invoke>/g, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
          .replace(/<\|tool_call>[\s\S]*?<(?:tool_call\||\|tool_call)>/g, '')
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
      reasoningChars: fullReasoning.length,
    }, agentId);

    return {
      content: fullText,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      reasoningContent: fullReasoning.length > 0 ? fullReasoning : undefined,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    recordProviderError(modelInfo.providerId);

    // F3/W3-1: best-effort utility calls (caller fully handles failure with a
    // fallback) log at WARN; genuine agent-turn calls stay at ERROR. Same
    // severity rule as the Ollama path below.
    logger[params.bestEffort ? 'warn' : 'error'](`OpenAI call failed: ${message}`, {
      model: modelInfo.apiModelId,
      providerId: modelInfo.providerId,
      latencyMs,
      bestEffort: params.bestEffort ?? false,
    }, agentId);

    const isRateLimited = message.includes('rate_limit') || message.includes('429');
    const isOverloaded = message.includes('overloaded') || message.includes('529') || message.includes('503');

    // Schedule background retry for rate limits, skip for auto-routed agents
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

  // Dynamic import, gracefully fail if SDK not installed
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
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
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

  // so the model-call-failure recovery path can be exercised end-to-end. Remove for release.
  // C23: import wrapped so a partial uninstall no-ops instead of throwing on every model
  // call; a genuine forced error still throws AFTER the try. release.sh also blocks shipping.

  // ── Universal orphan tool_use/tool_result sanitization ──
  // Runs BEFORE provider dispatch so ALL code paths (Anthropic, OpenAI, Ollama,
  // Agent SDK) get clean messages. The assembler has its own sanitization, but
  // provider-specific budget trimming and message transforms can create new
  // orphans after that runs.
  sanitizeOrphanToolBlocks(messages, agentId);

  const modelInfo = getModelInfo(modelId);

  // Ollama uses OpenAI-compatible API, not Anthropic SDK
  if (modelInfo.providerType === 'ollama') {
    return callOllamaModel(params, modelInfo);
  }

  // OpenAI and OpenAI-compatible providers
  if (modelInfo.providerType === 'openai' || modelInfo.providerType === 'openai-compatible') {
    return callOpenAIModel(params, modelInfo);
  }

  // Agent SDK transport, uses query() instead of the Anthropic Messages API
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
  // Prompt caching: the system prompt is a large, mostly-stable prefix. Marking
  // its final block with cache_control lets Anthropic reuse the prefill across
  // turns instead of re-processing it every call, a big TTFT + cost win for
  // rapid back-and-forth (e.g. voice). The OAuth passphrase block stays unmarked;
  // the breakpoint sits on the real prompt. Anthropic safely ignores the marker
  // on sub-minimum blocks, so this never errors on a short prompt.
  const CACHE_EPHEMERAL = { type: 'ephemeral' as const };
  const systemParam: Anthropic.TextBlockParam[] = isOAuth
    ? [
        { type: 'text' as const, text: OAUTH_SYSTEM_PASSPHRASE },
        { type: 'text' as const, text: systemPrompt, cache_control: CACHE_EPHEMERAL },
      ]
    : [{ type: 'text' as const, text: systemPrompt, cache_control: CACHE_EPHEMERAL }];
  // C28 P-2: the stable system block above carries the cache breakpoint; any
  // system-side volatile content trails it UNCACHED so it can't invalidate the
  // cached prefix. Empty after P-1, so this block is only added if ever populated.
  if (params.systemVolatile) {
    systemParam.push({ type: 'text' as const, text: params.systemVolatile });
  }

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
    // (2) that user message must not START with tool_result blocks, if it
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
          // Entire message was orphan tool_results, drop it
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

  // Also run on the post-trim anthropicMessages in case budget trimming
  // created new orphans (the universal check above ran on the pre-trim input)
  sanitizeOrphanToolBlocks(anthropicMessages as unknown as Array<{ role: string; content: unknown }>, agentId);

  const anthropicAvailable = Math.max(1024, modelInfo.contextWindow - inputEstimate - 500);
  const anthropicMaxTokens = Math.min(modelInfo.maxOutputTokens, anthropicAvailable);

  const requestParams: Anthropic.MessageCreateParams = {
    model: modelInfo.apiModelId,
    max_tokens: anthropicMaxTokens,
    system: systemParam,
    messages: anthropicMessages,
    // Tools are a large block that never changes turn-to-turn, so caching them
    // is a guaranteed win. Anthropic caches everything up to the breakpoint, and
    // tools come before the system block in the request, so this marker caches
    // the full tools array (and the system block's marker extends it).
    ...(filteredTools.length > 0 ? { tools: filteredTools.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      ...(i === arr.length - 1 ? { cache_control: CACHE_EPHEMERAL } : {}),
    })) } : {}),
  };

  // Budget check before making the API call
  const budgetCheck = checkBudget(agentId, 0.01);
  if (!budgetCheck.allowed) {
    if (budgetCheck.freeModelFallback) {
      // Budget exceeded but free model available, redirect to it
      const fb = budgetCheck.freeModelFallback;
      logger.warn(`Budget exceeded, falling back to free model: ${fb.modelName}`, {
        agentId,
        dailySpend: budgetCheck.dailySpend,
        dailyLimit: budgetCheck.dailyLimit,
        freeModel: fb.modelName,
      }, agentId);

      // Notify the agent's chat
      const notifyMsg = `[SOURCE: SYSTEM, not a message from the user] Daily budget reached ($${budgetCheck.dailySpend?.toFixed(2)} of $${budgetCheck.dailyLimit?.toFixed(2)}). Using ${fb.modelName} (free) instead.`;
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
          const primaryNotify = `[SOURCE: SYSTEM, not a message from the user] Agent "${agentId}" switched to free model (${fb.modelName}) due to budget limits.`;
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

    // No free models, block the call with clear message
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
    // Pass the external abort signal so stop-button aborts cancel the
    // in-flight Anthropic streaming request immediately.
    const requestOptions = params.abortSignal ? { signal: params.abortSignal } : undefined;
    const stream = client.messages.stream(requestParams, requestOptions);

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

    // Prompt-cache visibility (Anthropic): cache_read = served from cache,
    // cache_creation = written to cache this call. Confirms the cache_control
    // markers are actually hitting. Anthropic reports input_tokens DISJOINT
    // from these (it is already the uncached input), so they thread straight
    // into recordCost without any normalization (C28 P-7).
    const anthropicUsage = finalMessage.usage as typeof finalMessage.usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const cacheReadTokens = anthropicUsage.cache_read_input_tokens;
    const cacheCreationTokens = anthropicUsage.cache_creation_input_tokens;
    if (cacheReadTokens != null || cacheCreationTokens != null) {
      logger.info('prompt cache usage', {
        provider: 'anthropic',
        model: modelInfo.apiModelId,
        cacheReadTokens: cacheReadTokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? 0,
        uncachedInputTokens: inputTokens,
      }, agentId);
    }

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
      cacheReadTokens,
      cacheCreationTokens,
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

    // Put the key info in the message itself so it's visible in the log viewer.
    // F3/W3-1: best-effort utility calls log at WARN (caller fully handles the
    // failure); genuine agent-turn calls stay at ERROR.
    const statusStr = err instanceof Anthropic.APIError ? `[${err.status}] ` : '';
    errorDetail.bestEffort = params.bestEffort ?? false;
    logger[params.bestEffort ? 'warn' : 'error'](`Model call failed: ${statusStr}${message}`, errorDetail, agentId);

    // Determine if retryable
    const isRateLimited = message.includes('rate_limit') || message.includes('429');
    const isOverloaded = message.includes('overloaded') || message.includes('529');
    const isServerError = message.includes('500') || message.includes('503');

    // Record the rate limit in the proactive tracker regardless of routing mode.
    // This lets selectModel skip the rate-limited model on the NEXT turn without
    // having to hit the 429 again. Extract retry-after to set the cooldown.
    if (isRateLimited || isOverloaded) {
      try {
        if (err instanceof Anthropic.APIError && err.headers) {
          const rlHeaders: Record<string, string> = {};
          // Set remaining to 0 so isRateLimited() returns true
          rlHeaders['x-ratelimit-remaining'] = '0';
          // Use retry-after to set the reset time
          const retryAfter = err.headers['retry-after'];
          if (retryAfter) {
            const secs = parseInt(retryAfter, 10);
            if (!isNaN(secs)) {
              rlHeaders['x-ratelimit-reset'] = new Date(Date.now() + secs * 1000).toISOString();
            }
          } else {
            // Default: assume 60 seconds if no retry-after header
            rlHeaders['x-ratelimit-reset'] = new Date(Date.now() + 60000).toISOString();
          }
          updateRateLimits(modelId, rlHeaders);
        }
      } catch { /* best effort */ }
    }

    // Schedule background retry for rate limits, but NOT for auto-routed agents.
    // Auto-routed agents handle rate limits via the fallback chain in the runtime.
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
