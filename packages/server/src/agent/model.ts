import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { AgentError } from './errors.js';
import { classifyProviderError, isRetryableProviderClass } from './provider-error.js';
import { scheduleRateLimitRetry } from './rate-limit-retry.js';
import { toolDefinitions } from './tools/definitions.js';
import { getFilteredTools } from './tools/surface.js';
import type { ToolDefinition } from './tools/types.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { estimateTokens } from '../memory/budget.js';
import { validateAtProviderBoundary, AssemblyValidationError } from '../memory/assembly-validation.js';
import { repairToolPairing } from './tool-pairing.js';
import { collectMessageLaneIds } from '../memory/message-lane-tag.js';
import { recordCost } from '../costs/tracker.js';
import { checkBudget } from '../costs/budget.js';
import { updateRateLimits } from '../router/rate-limits.js';
import { recordProviderSuccess, recordProviderError } from '../gateway/routes/services.js';
import { broadcast } from '../gateway/ws.js';
import { isPrimaryAgent, getPrimaryAgentId } from '../config/platform.js';
import type { ToolCall } from '@dojo/shared';

const logger = createLogger('model');

// Client cache is defined below after CachedClient type

// ── Stream idle watchdog (2026-07-10) ──
// A provider can hang or slow-walk a streaming response indefinitely; the
// production trigger was a 602-second call that returned one empty token and
// held a reminder turn hostage (DOJO-ISSUES-LOG 2026-07-10). Bound the STREAM,
// not the generation: a healthy long answer keeps producing chunks and never
// times out; a dead connection dies at the first-chunk bound and a mid-stream
// stall dies at the idle bound. The watchdog's abort is distinguishable from
// the user's stop button (timedOut()), and the v2 loop grants one same-model
// retry on the translated timeout error.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 90_000;
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

export interface StreamWatchdog {
  /** Combined signal: fires on watchdog timeout OR the external (stop) signal. */
  signal: AbortSignal;
  /** Call on every received chunk/event; re-arms the idle bound. */
  bump: () => void;
  /** Call when the stream finishes (success or failure); disarms the timer. */
  finish: () => void;
  /** True iff the WATCHDOG fired (never true for a user stop). */
  timedOut: () => boolean;
  /** Milliseconds since the watchdog was armed. */
  elapsedMs: () => number;
}

export function makeStreamWatchdog(
  external?: AbortSignal,
  firstChunkMs: number = STREAM_FIRST_CHUNK_TIMEOUT_MS,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): StreamWatchdog {
  const controller = new AbortController();
  const startedAt = Date.now();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { fired = true; controller.abort(); }, ms);
    timer.unref?.();
  };
  arm(firstChunkMs);
  return {
    signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal,
    bump: () => arm(idleMs),
    finish: () => { if (timer) { clearTimeout(timer); timer = null; } },
    timedOut: () => fired,
    elapsedMs: () => Date.now() - startedAt,
  };
}

/** The loop matches on this exact phrase to grant a single same-model retry. */
export const STREAM_IDLE_TIMEOUT_ERROR = 'model stream idle timeout';

// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP-A TB8 JOB 1 — THE STOP REASON STOPS BEING FABRICATED.
//
// This path used to report `stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn'` and
// discard the provider's `finish_reason` entirely. Every OpenAI-compatible call — which is
// the whole floor-model path — therefore told the engine "the model finished normally" even
// when the provider had TRUNCATED it at the output cap. `v2/classifiers/output.ts` has had
// `'length'` in `TRUNCATION_STOP_REASONS` since it was written and could never once fire on
// this path; the ladder that reads it was unreachable for its whole life.
//
// THE BOUND THAT MATTERS IS THE CAP THE PRODUCT ALREADY CONFIGURES, and it was derived from
// the durable sink rather than chosen: over 19,124 completed calls carrying a known cap
// (2026-07-27 → 2026-08-06, all four batteries), exactly 17 reached their model's own
// `max_output_tokens` — 0.089% — and every recorded runaway is one of them, across two
// different models and two different caps. Both alternatives the brief named were tested
// against that corpus and both are refused, with their numbers, in
// `steps/post-call-classify/__tests__/output-grind.test.ts`: a DURATION bound orders the two
// populations wrong (legitimate calls at 216.3 s against runaways at 129.95 s), and any
// sub-cap OUTPUT-TOKEN threshold sits 133 tokens (0.8%) from a legitimate call that ended in
// a tool call. The provider reporting its own truncation is the only signal that separates
// them categorically — 17 of 17 caught, 0 of 19,107 false.
//
// `'stop'` and `'tool_calls'` are deliberately left to the synthesis: they say only what it
// already said, and this change adds a signal rather than re-spelling the existing ones.
// The agent-SDK path at :791 has done the same thing since it was written; this makes the
// two paths agree.
// ════════════════════════════════════════════════════════════════════════════════════════
export function resolveOpenAIStopReason(
  finishReason: string | null | undefined,
  toolCallCount: number,
): string {
  if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') return finishReason;
  return toolCallCount > 0 ? 'tool_use' : 'end_turn';
}

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
// The repair itself is `agent/tool-pairing.ts` (PHASE-3 T6): extracted so it could be unit
// tested at all, and FIXED there — the walk's carrier test required a message to be PURELY
// tool_results, so a carrier the assembler's own `mergeConsecutiveRoles` had folded a user
// line into stopped it dead and the repair CREATED an orphan `tool_result`, which is 14 of
// the detect window's 17 day-0 divergences. That module's header carries the derivation.
//
// This wrapper keeps the log line the correlation was measured against, and now reports
// BOTH directions, so the same grep still answers the same question.
function sanitizeOrphanToolBlocks(
  messages: Array<{ role: string; content: unknown }>,
  agentId: string,
): void {
  const report = repairToolPairing(messages);
  if (report.strippedToolUse > 0 || report.strippedToolResult > 0) {
    logger.warn('Stripped orphan tool_use blocks from messages', {
      droppedCount: report.strippedToolUse,
      droppedToolResult: report.strippedToolResult,
      droppedMessages: report.droppedMessages,
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
      const errorText = await response.text().catch(() => ''); // raw fetch: the status is exact
      const facts = classifyProviderError({ status: response.status, message: errorText });
      throw new AgentError(`Ollama call failed: HTTP ${response.status} ${errorText.slice(0, 200)}`, agentId, {
        code: 'MODEL_CALL_FAILED',
        retryable: isRetryableProviderClass(facts.class),
        provider: facts,
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
      provider: classifyProviderError(err),
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

/**
 * The base URL the OpenAI SDK is pointed at, for a configured provider.
 *
 * HL1 PIN: extracted from `getOpenAIClient`'s inline IIFE byte-for-byte so the
 * request shape it decides can be pinned by a golden without standing up a
 * client or a credential. No behaviour change — the IIFE below became a call.
 */
export function resolveOpenAIBaseUrl(baseUrl?: string | null): string | undefined {
  if (!baseUrl) return undefined;
  const cleaned = baseUrl.replace(/\/+$/, '');
  if (hostNeedsNoV1(cleaned)) return cleaned;
  return cleaned.endsWith('/v1') ? cleaned : cleaned + '/v1';
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

  const resolvedBaseUrl = resolveOpenAIBaseUrl(baseUrl);

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
export async function buildOpenAIMessages(
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

/**
 * The provider-shaped knobs on an OpenAI-compatible chat request.
 *
 * HL1 PIN: lifted out of `callOpenAIModel` byte-for-byte (both blocks in their
 * original order) so the request shape is pinnable by a golden without a
 * network call. Mutates `requestParams` in place exactly as the inline code did.
 *
 * ── OpenRouter unified reasoning toggle ──
 * When the provider is OpenRouter (detected by base URL) and the model is
 * known to support thinking, honor the per-model thinking_enabled flag by
 * sending the `reasoning` parameter. OpenRouter translates this into each
 * upstream provider's convention (Anthropic thinking, o-series
 * reasoning_effort, Gemini thinkingBudget, DeepSeek R1, etc). For generic
 * openai-compatible providers we leave the request alone.
 *
 * ── DeepSeek native thinking ──
 * DeepSeek v4-flash/v4-pro return reasoning as a sibling `reasoning_content`
 * field in stream deltas and on assistant messages, distinct from
 * Anthropic's thinking-block-inside-content pattern. Toggle is sent via
 * top-level `thinking: { type: 'enabled' | 'disabled' }`. v4-pro defaults
 * to thinking-on; we honor model.thinking_enabled here so the user has
 * explicit control via the Models page. Round-trip is handled by
 * (a) capturing delta.reasoning_content in the stream loop below and
 * (b) passing assistantMsg.reasoning_content on subsequent requests via
 * the message build path. Per DeepSeek docs we also avoid sending
 * temperature / top_p when thinking is enabled (they're rejected), the
 * current dispatch doesn't send those anyway, so no extra guard needed.
 */
export function applyProviderRequestParams(
  requestParams: OpenAI.ChatCompletionCreateParams,
  opts: { isOpenRouter: boolean; isDeepSeek: boolean; supportsThinking: boolean; thinkingEnabled: boolean },
): void {
  if (opts.isOpenRouter && opts.supportsThinking) {
    // `extra_body` survives the OpenAI SDK's pass-through to non-standard
    // params. Use it so the unified reasoning object makes it into the
    // wire request untouched.
    (requestParams as unknown as { extra_body?: Record<string, unknown> }).extra_body = {
      ...((requestParams as unknown as { extra_body?: Record<string, unknown> }).extra_body ?? {}),
      reasoning: { enabled: opts.thinkingEnabled },
    };
  }

  if (opts.isDeepSeek) {
    (requestParams as unknown as { thinking?: { type: string } }).thinking = {
      type: opts.thinkingEnabled && opts.supportsThinking ? 'enabled' : 'disabled',
    };
  }
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

  // ── THE OPENAI FRONT-TRIMMER IS DELETED (PHASE-3 T4 Step 2b, 2026-08-01) ──
  // STRIP. It was `model.ts:1224-1292` at `1d112ad`: a `splice(1, 1)` loop that deleted the
  // OLDEST conversation messages until the input fit, plus its own orphan repair.
  // requirement preserved: NEVER EXCEED THE PROVIDER'S WINDOW. That requirement now belongs
  // upstream and it is enforced IN PRIORITY ORDER instead of oldest-first — the allocator
  // budgets against `contextWindowPolicy` (memory/budget.ts) and `validateAssembly` /
  // `repairAssembly` (memory/assembly-validation.ts) check and repair at this same boundary,
  // dropping the LOWEST-PRIORITY lane and throwing when nothing droppable is left (C10/C11).
  // What this deletion actually removes is the INVERSION: a front-trimmer only knows slot
  // order, so it ate `lane.scratchpad` (priority 20) while keeping `lane.events` (40) — the
  // owner's directive going out of the window before the morning briefing did.
  // Measured before deleting: day-0 detect run 73 calls / **0 budget violations**; the driven
  // pre-flip arm at `1d112ad` **checked=63 diverged=0**. The trimmer had nothing to trim.

  // Reserve at most 25% of context for output, or whatever's left after input
  const finalInputEstimate = openaiMessages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + estimateTokens(content);
  }, 0) + estimateTokens(JSON.stringify(openaiTools ?? []));
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

  const supportsThinking = modelInfo.capabilities.includes('thinking');
  applyProviderRequestParams(requestParams, {
    isOpenRouter, isDeepSeek, supportsThinking, thinkingEnabled: modelInfo.thinkingEnabled,
  });

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

  // Stream idle watchdog: bounds connect/first-token and inter-chunk gaps;
  // combined with the stop-button signal so user aborts still work unchanged.
  const watchdog = makeStreamWatchdog(params.abortSignal);
  try {
    const requestOptions = { signal: watchdog.signal };
    // .withResponse() hands back both the parsed stream and the raw Response so
    // we can feed rate-limit headers into the proactive tracker (FA-R2). It does
    // not consume the SSE body; `stream` is iterated below exactly as before.
    const { data: stream, response: rawResponse } =
      await client.chat.completions.create(requestParams, requestOptions).withResponse();

    let fullText = '';
    let fullReasoning = '';
    const toolCalls: ToolCall[] = [];
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();
    // Final usage chunk (from stream_options.include_usage), carries cache stats.
    let realUsage: (OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }) | undefined;

    // TB8 JOB 1: the provider's own terminal reason, kept rather than thrown away. It
    // arrives on the last content-bearing chunk, before the usage chunk, so it is captured
    // beside `realUsage` and read once the stream is done.
    let providerFinishReason: string | null = null;

    for await (const chunk of stream) {
      watchdog.bump();
      // The usage chunk arrives last with an empty choices array, capture it
      // before the delta guard skips it.
      if (chunk.usage) realUsage = chunk.usage as typeof realUsage;
      const finish = chunk.choices[0]?.finish_reason;
      if (finish) providerFinishReason = finish;
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

    watchdog.finish();
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
      // Step 3: the post-trim estimate, i.e. the one describing the request that went out.
      estimatedInputTokens: finalInputEstimate,
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

    // TB8 JOB 1: the honest stop reason, and the shape the census reads. `finishReason` on
    // this line is what makes the recorded runaway class countable from the log for the
    // first time — the 17 at-cap calls in the durable sink were only ever identifiable by
    // joining `cost_records` to `models`, after the fact.
    const stopReason = resolveOpenAIStopReason(providerFinishReason, toolCalls.length);
    logger.info('OpenAI call completed', {
      model: modelInfo.apiModelId,
      inputTokens, outputTokens, latencyMs,
      cost: totalCost.toFixed(6),
      toolCallCount: toolCalls.length,
      reasoningChars: fullReasoning.length,
      finishReason: providerFinishReason, stopReason,
    }, agentId);

    if (stopReason === 'length' && toolCalls.length === 0) {
      // THE GRIND, named where it happens. The engine's restart is the ladder in
      // `v2/steps/post-call-classify/empty-response.ts`; this line is the record.
      logger.warn('OpenAI call ran out its ENTIRE output budget with no tool call — the grind class', {
        model: modelInfo.apiModelId,
        outputTokens, latencyMs,
        reasoningChars: fullReasoning.length,
        contentChars: fullText.length,
      }, agentId);
    }

    // FA-R2: feed the proactive rate-limit tracker from the response headers,
    // mirroring the Anthropic path. OpenAI sends x-ratelimit-remaining-requests
    // / x-ratelimit-reset-requests, which updateRateLimits already understands;
    // DeepSeek and OpenRouter vary and may send none, so this is best-effort and
    // no-ops when no rate-limit headers are present. Lets selectModel skip a
    // model that has run its window down on the NEXT turn.
    try {
      const rlHeaders: Record<string, string> = {};
      rawResponse?.headers?.forEach?.((value: string, key: string) => { rlHeaders[key] = value; });
      updateRateLimits(modelId, rlHeaders);
    } catch { /* rate limit header extraction is best-effort */ }

    return {
      content: fullText,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason,
      reasoningContent: fullReasoning.length > 0 ? fullReasoning : undefined,
    };
  } catch (err) {
    watchdog.finish();
    if (watchdog.timedOut() && !params.abortSignal?.aborted) {
      // The WATCHDOG aborted (never the user's stop; that leaves timedOut()
      // false or shows on the external signal). Translate to the retryable
      // phrase the v2 loop matches for its single same-model retry.
      recordProviderError(modelInfo.providerId);
      const msg = `${STREAM_IDLE_TIMEOUT_ERROR}: no data from provider for too long (elapsed ${watchdog.elapsedMs()}ms)`;
      logger.warn(`OpenAI call aborted by stream watchdog: ${msg}`, {
        model: modelInfo.apiModelId, providerId: modelInfo.providerId,
      }, agentId);
      throw new AgentError(msg, agentId, { code: 'stream_idle_timeout', retryable: true });
    }
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

    // PHASE-4 T5 (provider-error.ts): the provider's STATUS, never this message's digits —
    // `message.includes('503')` was true of "prompt is too long: 250316 tokens".
    const facts = classifyProviderError(err);
    const isRateLimited = facts.class === 'rate_limit' || facts.class === 'quota';
    const isOverloaded = facts.class === 'overloaded';

    // FA-R2: record the rate limit in the proactive tracker regardless of routing
    // mode, mirroring the Anthropic path (see callAnthropicSdkModel). This lets
    // selectModel skip this model on the NEXT turn without hitting the 429 again.
    // OpenAI-compatible providers (DeepSeek, OpenRouter, OpenAI) don't reliably
    // surface usable rate-limit headers here, so synthesize remaining=0 and set
    // the reset from retry-after when present (else a 60s default). Control flow
    // is unchanged; the error still propagates below exactly as before.
    if (isRateLimited || isOverloaded) {
      try {
        const rlHeaders: Record<string, string> = { 'x-ratelimit-remaining': '0' };
        let retryAfterSecs: number | null = null;
        if (err instanceof OpenAI.APIError && err.headers) {
          const retryAfter = err.headers['retry-after'];
          if (retryAfter) {
            const secs = parseInt(retryAfter, 10);
            if (!isNaN(secs)) retryAfterSecs = secs;
          }
        }
        rlHeaders['x-ratelimit-reset'] = new Date(
          Date.now() + (retryAfterSecs !== null ? retryAfterSecs * 1000 : 60000),
        ).toISOString();
        updateRateLimits(modelId, rlHeaders);
      } catch { /* best effort */ }
    }

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
      retryable: isRetryableProviderClass(facts.class),
      provider: facts,
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
  const { callAnthropicViaSdk, AgentSdkVisionUnsupportedError } = await import('../providers/anthropic-sdk.js');

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

  try {
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
    recordProviderSuccess(modelInfo.providerId);

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
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // A pre-flight vision refusal (FA-PC4) is NOT a provider fault: don't mark
    // the provider unhealthy and don't log at error. Re-throw so the recovery
    // cascade's vision_mismatch branch gives the agent a plain "this model can't
    // see images" note. The message wording is what that classifier keys on.
    if (err instanceof AgentSdkVisionUnsupportedError) {
      logger.warn(`Agent SDK call refused an image: ${message}`, { model: modelInfo.apiModelId, agentId }, agentId);
      throw new AgentError(message, agentId, {
        code: 'MODEL_CALL_FAILED',
        retryable: false,
        cause: err,
      });
    }

    recordProviderError(modelInfo.providerId);

    logger[params.bestEffort ? 'warn' : 'error'](`Agent SDK call failed: ${message}`, {
      model: modelInfo.apiModelId,
      providerId: modelInfo.providerId,
      latencyMs,
      bestEffort: params.bestEffort ?? false,
    }, agentId);

    // Classify with the SHARED recovery classifier so the SDK path, the direct
    // Anthropic path, and the FA-A1 step-0 passthrough all agree on what counts
    // as a rate limit (recovery.ts classifyError, reused rather than a fourth
    // hand-rolled substring set). classifyError also recognizes subscription
    // "usage limit" wording. Known drift, still: the direct/OpenAI catches and
    // rate-limit-retry.ts keep their own substring sets (FA-A1 3-classifier note).
    const { classifyError } = await import('./v2/recovery.js');
    const kind = classifyError(err instanceof Error ? err : new Error(message)).kind;
    const isRateLimited = kind === 'rate_limit';
    const isOverloaded = kind === 'overloaded';

    // Retry-after: the SDK usually throws generic errors with no headers, so
    // this stays null and the reset falls back to 60s, mirroring the direct
    // path's no-header branch. Kept for the rare Anthropic.APIError shape.
    let retryAfterSeconds: number | null = null;
    if (err instanceof Anthropic.APIError && err.headers) {
      const retryAfter = err.headers['retry-after'];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) retryAfterSeconds = parsed;
      }
    }

    // (a) Feed the proactive next-turn tracker exactly like the FA-R2 / direct
    // sites: synthesize remaining=0 + a reset from retry-after (else 60s). Lets
    // selectModel skip a rate-limited pinned model on the NEXT turn.
    if (isRateLimited || isOverloaded) {
      try {
        const rlHeaders: Record<string, string> = { 'x-ratelimit-remaining': '0' };
        rlHeaders['x-ratelimit-reset'] = new Date(
          Date.now() + (retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 60000),
        ).toISOString();
        updateRateLimits(modelId, rlHeaders);
      } catch { /* best effort */ }
    }

    // (b) Pinned-model 429/overload -> arm the background decay retry, same as
    // the direct path. NOT for auto-routed agents (routerTier set): the router's
    // fallback chain owns those. Once armed, hasActiveRateLimitRetry is true, so
    // the FA-A1 step-0 passthrough owns recovery and the agent is never injured.
    if ((isRateLimited || isOverloaded) && !params.routerTier) {
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

    // Re-throw so control flow stays identical to the other transports.
    throw new AgentError(`Agent SDK call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: isRateLimited || isOverloaded,
      cause: err instanceof Error ? err : undefined,
    });
  }
}

// FA-PC5 (D-I): provider types whose inference is genuinely free + local. They
// are exempt from the daily paid-spend wall BY TYPE, not by where they sit in
// the transport dispatch ladder, so a local model never trips a spend cap.
// Ollama is the only local type today; a future local type goes here.
const FREE_LOCAL_PROVIDER_TYPES = new Set(['ollama', 'local']);

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

  // ── EXIT VALIDATION (PHASE-3 T4 Step 2, requirements C9/C10/C11) ──
  // ONE call, above every transport branch (ollama :2262, openai :2267, agent-sdk :2273,
  // anthropic-direct falls through) and after every mutation the assembler and the loop
  // make — including the tail-append and the orphan sanitize directly above. Research 06
  // §3: there was no exit boundary at all, and the only size authority was the pair of
  // oldest-first front-trimmers further down this file.
  //
  // DETECT-ONLY for a dated 7-calendar-day window — see the AS-BUILT note on PHASE-3 T4
  // Step 2 for the literal start date and SHA. It logs divergence and returns the array
  // UNCHANGED; the front-trimmers below are still the ceiling backstop and T4's sequencing
  // rider forbids removing them while this only watches. Step 2b flips the mode constant in
  // `memory/assembly-validation.ts` and deletes both trimmers in the same commit.
  //
  // AS-BUILT deviation, +2 lines from the planned insertion point: the plan pinned this
  // immediately after `sanitizeOrphanToolBlocks`, ABOVE `getModelInfo`. It sits just below
  // it instead, because the budget it validates against is a function of the model's window
  // and output cap, both of which `getModelInfo` produces. Everything the pin was for is
  // preserved: one insertion, all transports, after every mutation.
  //
  // The catch is for a defect in the INSTRUMENT — a measurement that throws must not break
  // a turn it was only watching. `AssemblyValidationError` is re-thrown unconditionally:
  // that is C11's loud failure, and a boundary that swallows it is warn-and-send with extra
  // steps. It cannot fire before the Step-2b flip (detect mode never repairs and never
  // throws), and it must not be neutered by that flip either.
  //
  // PHASE-3 T6: `laneIds` is now SUPPLIED. `repairAssembly`'s priority repair (C10) refuses
  // without a lane map, so before T6 a Step-2b flip would have turned every size violation
  // into a throw. The map is read off the messages themselves (`memory/message-lane-tag.ts`)
  // rather than threaded through `ModelCallParams`, so it is aligned by construction and no
  // caller can forget to pass it.
  try {
    await validateAtProviderBoundary({
      agentId,
      modelId,
      messages,
      systemPrompt,
      contextWindow: modelInfo.contextWindow,
      maxOutputTokens: modelInfo.maxOutputTokens,
      laneIds: collectMessageLaneIds(messages),
    });
  } catch (err) {
    if (err instanceof AssemblyValidationError) throw err;
    logger.warn('ASSEMBLY_VALIDATION_INSTRUMENT_FAILED', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // The 'auto' sentinel (provider '__system__') is a router pointer, not a
  // callable model. On the normal path the router resolves it BEFORE callModel
  // (v2/loop decideTier + selectModel), so a sentinel reaching here is always a
  // caller bug. Fail fast with a named error instead of dying downstream with
  // the opaque "No credential found for provider __system__".
  if (modelInfo.providerId === '__system__') {
    throw new AgentError(
      `Model '${modelId}' is a router sentinel, not a callable model; resolve it through the router before callModel`,
      agentId,
      { code: 'SENTINEL_MODEL_DISPATCH', retryable: false },
    );
  }

  // FA-PC5 (D-I): apply the daily cap to ALL paid transports. This wall runs
  // ABOVE the transport dispatch so OpenAI / openai-compatible / Agent-SDK calls
  // are guarded identically to Anthropic-direct (previously only the latter saw
  // it, since the others early-return below before the old wall). Genuinely-free
  // local providers are exempt BY PROVIDER TYPE, not by dispatch order. The
  // budget_fallback recursion is also skipped: the outer call already made the
  // budget decision and the redirect target is a $0 model, so re-running the
  // wall here would loop (and would needlessly re-notify).
  if (!FREE_LOCAL_PROVIDER_TYPES.has(modelInfo.providerType) && routerTier !== 'budget_fallback') {
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
          const msgId = uuidv4();
          insertMessageIfAbsent({ id: msgId, agentId, role: 'system', content: notifyMsg });
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
            insertMessageIfAbsent({ id: primaryMsgId, agentId: primaryId, role: 'system', content: primaryNotify });
            broadcast({
              type: 'chat:message',
              agentId: primaryId,
              message: { id: primaryMsgId, agentId: primaryId, role: 'system' as const, content: primaryNotify, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
            });
          }
        } catch { /* notification is best-effort */ }

        // Recursively call with the free model. The redirect target may itself be
        // an ollama transport (exempt above) or a paid $0 model (skipped via the
        // budget_fallback tier), either way it dispatches without re-walling.
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
  }

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
  // S1 (PHASE-3 T3): where the cache breakpoint goes. The LAST ALWAYS-LOADED tool, so a
  // mid-session `load_tool_docs` appends behind it and the ~24.7K-token cached prefix
  // survives. `-1` = no always-loaded tool at all; the breakpoint then falls back to the end
  // of the array, which is the pre-S1 behaviour and the only honest answer when there is no
  // stable head to cache.
  let toolCacheBreakpoint = -1;
  if (tools) {
    const allPermitted = getFilteredTools(agentId);
    const { partitionToolsForApiCall, getAgentAlwaysLoadedTools } = await import('../tools/tool-docs.js');
    const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
    const part = partitionToolsForApiCall(agentId, allPermitted, alwaysLoaded);
    filteredTools = part.tools;
    toolCacheBreakpoint = part.cacheBreakpointIndex;
  }
  const toolsJson = tools ? JSON.stringify(filteredTools) : '';
  // PHASE-3 T2: the ONE estimator. Was /3.5 here and /3 on the OpenAI path — two answers to
  // "what does this text cost" in one file.
  const toolTokenEstimate = estimateTokens(toolsJson);

  const estimateMessageTokens = (msgs: Anthropic.MessageParam[]) =>
    msgs.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + estimateTokens(content);
    }, 0);

  const systemTokenEstimate = estimateTokens(systemPrompt);

  // ── THE ANTHROPIC FRONT-TRIMMER IS DELETED (PHASE-3 T4 Step 2b, 2026-08-01) ──
  // STRIP. It was `model.ts:2244-2292` at `1d112ad`: `minOutputReserve = 4096`, a
  // `hardInputLimit`, a `splice(0, 1)` loop deleting the OLDEST messages until the input
  // fit, its own leading-`tool_result` repair, and — the part requirement C11 names by
  // name — a final `logger.warn('Input still exceeds context window after trimming')`
  // that then SENT ANYWAY.
  // requirement preserved: NEVER EXCEED THE PROVIDER'S WINDOW, and never send an array that
  // does. Both halves now live upstream and both are stronger: the allocator budgets against
  // `contextWindowPolicy` (memory/budget.ts), and `validateAssembly`/`repairAssembly`
  // (memory/assembly-validation.ts) run at THIS boundary in `'repair'` mode — repairing in
  // PRIORITY order (lowest lane first, C10) and THROWING when nothing droppable is left
  // (C11). Warn-and-send has no expression left in the tree.
  // Measured before deleting: day-0 detect run 73 calls / **0 budget violations**; the driven
  // pre-flip arm at `1d112ad` **checked=63 diverged=0**. On real traffic this loop never ran.
  const inputEstimate = systemTokenEstimate + estimateMessageTokens(anthropicMessages) + toolTokenEstimate;

  // KEPT with the trimmer gone, deliberately (T4 Step 2b pinned it as a SEPARATE guard).
  // Its old comment said "post-trim … in case budget trimming created new orphans", and that
  // reason died with the loop above. What it is now is the last pairing check on the array
  // this transport actually sends — `anthropicMessages` is a shallow re-map of `messages`,
  // so the universal `sanitizeOrphanToolBlocks` at the boundary already covers it, and this
  // is layered defense rather than a duplicate mechanism (Part I). Deleting a guard because
  // its stated reason went away is exactly the inference roadmap #15 forbids.
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
    // the tools array up to the breakpoint (and the system block's marker extends it).
    //
    // S1 (PHASE-3 T3, §T0-E): the breakpoint used to sit on `arr.length - 1` — the LAST
    // tool, whichever it happened to be. Membership grows mid-session (`load_tool_docs`),
    // so "the last tool" moved, and every such load re-wrote the cached prefix: the next
    // call re-billed ~24.7K tokens, about 13× the whole prefix growth the owner accepted.
    // It now sits on the last ALWAYS-LOADED tool, which `partitionToolsForApiCall`
    // guarantees is a stable, deterministically ordered head. Session extras append behind
    // it and cost nothing but themselves.
    ...(filteredTools.length > 0 ? { tools: filteredTools.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      ...(i === (toolCacheBreakpoint >= 0 ? toolCacheBreakpoint : arr.length - 1)
        ? { cache_control: CACHE_EPHEMERAL }
        : {}),
    })) } : {}),
  };

  // FA-PC5: the budget wall (and free-model redirect) now runs above the
  // transport dispatch at the top of callModel, covering every paid transport
  // uniformly. The Anthropic-direct path is guarded there, so no separate wall
  // is needed here.

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

  const anthWatchdog = makeStreamWatchdog(params.abortSignal);
  try {
    // Stream idle watchdog (see makeStreamWatchdog): bounds first-token and
    // inter-event gaps; the stop button rides the combined signal unchanged.
    const requestOptions = { signal: anthWatchdog.signal };
    const stream = client.messages.stream(requestParams, requestOptions);
    // Bump on EVERY SSE event, not just text: an extended-thinking phase emits
    // non-text events for long stretches, and those prove the connection is
    // alive just as well as words do.
    stream.on('streamEvent', () => anthWatchdog.bump());

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let currentToolName = '';
    let currentToolInput = '';
    let currentToolId = '';

    stream.on('text', (text) => {
      anthWatchdog.bump();
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
    anthWatchdog.finish();

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
      // T2 Step 3 recorded this as "the same sum this transport's hard cap compares against
      // `hardInputLimit`, so the recorded estimate is the one that decided whether history
      // was trimmed". T4 Step 2b DELETED that hard cap, so the second half of that sentence
      // no longer names anything. What survives is the first half and it is the reason to
      // keep recording it: this is the sum the transport actually sends, beside what the
      // provider charged, which is how the estimator's divisor stays checkable against
      // reality (`memory/budget.ts`). Nothing here decides a trim any more — the allocator
      // and `validateAssembly` do that upstream.
      estimatedInputTokens: inputEstimate,
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
    anthWatchdog.finish();
    if (anthWatchdog.timedOut() && !params.abortSignal?.aborted) {
      const msg = `${STREAM_IDLE_TIMEOUT_ERROR}: no data from provider for too long (elapsed ${anthWatchdog.elapsedMs()}ms)`;
      logger.warn(`Anthropic call aborted by stream watchdog: ${msg}`, {}, agentId);
      throw new AgentError(msg, agentId, { code: 'stream_idle_timeout', retryable: true });
    }
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

    // Determine if retryable — PHASE-4 T5, from `err.status` (which the line above already
    // read into errorDetail) and the structured body, never the message's digits.
    const facts = classifyProviderError(err);
    const isRateLimited = facts.class === 'rate_limit' || facts.class === 'quota';
    const isOverloaded = facts.class === 'overloaded';

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
      retryable: isRetryableProviderClass(facts.class),
      code: 'MODEL_CALL_FAILED',
      cause: err instanceof Error ? err : undefined,
      provider: facts,
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

/**
 * The most output tokens this model can emit, for the budget's output reserve (PHASE-3 T4).
 * `getModelInfo` is private (it reads the provider row and normalises six fields); this is
 * the one field `memory/budget.ts` needs and the same one both transports cap `max_tokens`
 * against (`:1353`, `:2368`), so the reserve and the request agree by construction.
 * `undefined` on an unknown model means "no cap known" and the reserve uses its own floor
 * rather than inventing one.
 */
export function getModelOutputCap(modelId: string): number | undefined {
  try {
    const info = getModelInfo(modelId);
    return Number.isFinite(info.maxOutputTokens) && info.maxOutputTokens > 0
      ? info.maxOutputTokens
      : undefined;
  } catch {
    return undefined;
  }
}
