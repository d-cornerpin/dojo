import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Agent } from 'undici';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { extractTextToolCalls } from './text-tool-fallback.js';
import { AgentError } from './errors.js';
import { apiRootIsBareHost, contractForModel, contractForModelId, type ModelContract } from './model-contract.js';
import { classifyProviderError, classifyProviderErrorText, isRetryableProviderClass } from './provider-error.js';
import {
  resolveStreamPatience, resolveTransportTimeouts, resolveDoomCeiling, resolvePrefillThroughput, doomGuardApplies, LOCAL_PROVIDER_TYPES,
  STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, TRANSPORT_DEFAULT_TIMEOUT_MS,
  DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE,
  type StreamPatience,
} from './stream-patience.js';
import { getFilteredTools } from './tools/surface.js';
import type { ToolDefinition } from './tools/types.js';
import { estimateRequestTokens, reasoningRidesThisTurn, effectiveDivisor } from '../memory/budget.js';
import { validateAtProviderBoundary, AssemblyValidationError } from '../memory/assembly-validation.js';
import { repairToolPairing } from './tool-pairing.js';
import { resolveProviderStopReason } from './provider-stop-reason.js';
import { collectMessageLaneIds } from '../memory/message-lane-tag.js';
import { recordCost } from '../costs/tracker.js';
import { measuredDivisorsFor } from '../costs/estimator-divisors.js';
import { checkBudget, WALL_ESTIMATE_USD } from '../costs/budget.js';
import { updateRateLimits } from '../router/rate-limits.js';
import { routerWindowTokens } from '../router/router-window.js';
import { recordProviderSuccess, recordProviderError } from '../gateway/routes/services.js';
import { settleFailedCall } from './failed-call.js';
import { broadcast } from '../gateway/ws.js';
// The abort registry's two doors. shared-state.ts imports nothing but the logger: leaf edge, no cycle.
import { registerAbortable, releaseAbortable } from './shared-state.js';
import { redirectToAFreeModel } from './budget-redirect.js';
import { utilityBoundaryOutputTokens } from './utility-boundary.js';
import { utilityDial, utilityNumCtx, utilityOutputCap, utilityNumCtxExceedsConfigured, imageTokenAllowance, NUM_CTX_BLOCK, NUM_CTX_MARGIN_TOKENS } from './utility-dial.js';

/** Smallest bindable stored "Max output"; below it ignored with a warn. 256: the smallest real answer. */
export const MIN_BINDABLE_MAX_OUTPUT_TOKENS = 256;
import type { ToolCall } from '@dojo/shared';
import { attachmentBrackets, defangExternalMarkers } from '../tools/external-content.js';
/** An attachment's text (an extracted PDF) inside the fence that brackets it, if any. */
const withinFence = (fence: { head: string; end: string } | null | undefined, text: string): string => (fence ? `${fence.head}\n${defangExternalMarkers(text)}\n${fence.end}` : text);

const logger = createLogger('model');


// Bound the stream, not the generation: healthy chunks never time out, and the abort is
// distinguishable from a user stop. `stream-patience.ts` holds and validates the same pair.
export { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS };

export interface StreamWatchdog {
  /** Combined signal: fires on watchdog timeout OR the external (stop) signal. */
  signal: AbortSignal;
  /** Call on every received chunk/event; re-arms the CURRENT bound. */
  bump: () => void;
  /** Call on the first generated content; the idle bound takes over. Idempotent. */
  contentStarted: () => void;
  /** Call when the stream finishes (success or failure); disarms the timer. */
  finish: () => void;
  /** True iff the WATCHDOG fired (never true for a user stop). */
  timedOut: () => boolean;
  /** True iff the watchdog fired BEFORE any generated content arrived. */
  firstChunkTimedOut: () => boolean;
  elapsedMs: () => number;
}

// An ack frame proves the socket is open, never that generation began, so the first-chunk grant
// is not spent on it; `: ping` keepalives never bump either: a wedged server must not renew its leash.
export function makeStreamWatchdog(
  external?: AbortSignal,
  firstChunkMs: number = STREAM_FIRST_CHUNK_TIMEOUT_MS,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): StreamWatchdog {
  const controller = new AbortController();
  const startedAt = Date.now();
  let fired = false;
  let contentSeen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { fired = true; controller.abort(); }, ms);
    timer.unref?.();
  };
  arm(firstChunkMs);
  return {
    signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal,
    bump: () => arm(contentSeen ? idleMs : firstChunkMs),
    contentStarted: () => {
      if (contentSeen) return;
      contentSeen = true;
      arm(idleMs);
    },
    finish: () => { if (timer) { clearTimeout(timer); timer = null; } },
    timedOut: () => fired,
    firstChunkTimedOut: () => fired && !contentSeen,
    elapsedMs: () => Date.now() - startedAt,
  };
}

/** The loop matches on this exact phrase to grant a single same-model retry. */
export const STREAM_IDLE_TIMEOUT_ERROR = 'model stream idle timeout';

// Deliberately does NOT contain `STREAM_IDLE_TIMEOUT_ERROR`: the loop's one same-model retry matches
// on that substring, and re-dialing COLD restarts prompt processing and dies at the same bound.
// Providers that declared nothing keep the same phrase and the same one retry.
export const STREAM_FIRST_CHUNK_TIMEOUT_ERROR = 'model first-chunk timeout';

/** A stream that ends with no `finish_reason` was hung up mid-answer: this retryable cut lets
 *  the loop's single same-model retry deliver the whole answer. */
export const STREAM_NO_FINISH_ERROR = 'model stream ended without a finish signal';
class StreamEndedUnfinished extends Error {}

/** The one decision point for which timeout phrase an abort deserves, so the four throw sites
 *  across both transports cannot come to disagree. */
export function streamTimeoutPhrase(watchdog: StreamWatchdog, patience: StreamPatience): string {
  return watchdog.firstChunkTimedOut() && patience.firstChunkDeclared
    ? STREAM_FIRST_CHUNK_TIMEOUT_ERROR
    : STREAM_IDLE_TIMEOUT_ERROR;
}

/** Which `AgentError` code this abort deserves; the phrase's declared/idle split must reach
 *  `provider-error.ts` and `healer/injury-recovery.ts`, which classify from `.code`. */
export function streamTimeoutCode(watchdog: StreamWatchdog, patience: StreamPatience): string {
  return watchdog.firstChunkTimedOut() && patience.firstChunkDeclared
    ? DECLARED_PATIENCE_EXCEEDED_CODE
    : STREAM_IDLE_TIMEOUT_CODE;
}

/** Which bound this trip spent and whose number it was, for the log line rather than the error.
 *  The word "declared" appears only when the row actually declared it. */
export function streamTripBound(watchdog: StreamWatchdog, patience: StreamPatience): string {
  return watchdog.firstChunkTimedOut()
    ? `${patience.firstChunkDeclared ? 'its declared' : 'the standing'} ${patience.firstChunkMs}ms first-chunk bound`
    : `${patience.idleDeclared ? 'its declared' : 'the standing'} ${patience.idleMs}ms idle bound`;
}

/** The clause a declared-patience message carries: request size against declared patience; empty for idle
 *  timeouts. `injury-recovery.ts` reads it from `AgentError.message`, which outlives this call. */
export function declaredPatienceClause(
  watchdog: StreamWatchdog, patience: StreamPatience, estimatedInputTokens: number,
): string {
  if (!(watchdog.firstChunkTimedOut() && patience.firstChunkDeclared)) return '';
  return `; ~${estimatedInputTokens} estimated prompt tokens against a declared ${patience.firstChunkMs}ms first-chunk patience`;
}

// Refuse to dial a request the declared facts say cannot finish: the one place the outgoing
// token estimate is checked against `resolveDoomCeiling`, on every transport, before the wire.

/** Distinct from every watchdog-timeout phrase: "never dialed" reads apart from "dialed and died". */
export const PRE_DIAL_REFUSAL_PHRASE = 'refused before any network dial';

// Throws `DECLARED_PATIENCE_EXCEEDED_CODE` when the estimate exceeds what declared patience and
// prefill throughput can cover; a `null` ceiling is a silent no-op, so an undeclared row keeps
// byte-identical behavior. Never retryable: re-dialing the identical prompt proves the same math again.
function refuseIfDoomed(
  agentId: string,
  estimatedInputTokens: number,
  patience: StreamPatience,
  provider: { providerType: string; providerBaseUrl: string | null; prefillTokensPerSec: number | null; measuredPrefillTokensPerSec?: number | null },
): void {
  // A cloud provider gets its full window; this backstop guards a local box only.
  if (!doomGuardApplies(provider)) return;
  const { prefillTokensPerSec, measuredPrefillTokensPerSec } = provider;
  // PREFILL SELF-CALIBRATION: declared wins outright; the measured reading applies only where
  // no declaration exists. The source rides along: never call a number "declared" that nobody declared.
  const throughput = resolvePrefillThroughput(prefillTokensPerSec, measuredPrefillTokensPerSec);
  if (throughput === null) return;
  // A MEASUREMENT MAY ONLY TIGHTEN A BOUND SOMEBODY DECLARED: measured throughput alone must not
  // arm this gate on standing patience, or the box would refuse its owner's normal conversations.
  if (throughput.source === 'measured' && !patience.firstChunkDeclared) return;
  const ceiling = resolveDoomCeiling(patience.firstChunkMs, prefillTokensPerSec, measuredPrefillTokensPerSec);
  if (ceiling === null || estimatedInputTokens <= ceiling) return;
  // With throughput alone declared, `firstChunkMs` may be the standing default, not "declared".
  const firstChunkClause = patience.firstChunkDeclared
    ? `its declared ${patience.firstChunkMs}ms first-chunk patience`
    : `the standing ${patience.firstChunkMs}ms first-chunk patience`;
  // The admission budget and the compaction trigger both plan against this same ceiling, so this
  // gate is a BACKSTOP: only the source word changes in the message below, for undeclared rows.
  const message = `${PRE_DIAL_REFUSAL_PHRASE}: ~${estimatedInputTokens} estimated prompt tokens exceeds the ~${ceiling}-token ceiling this provider's ${throughput.source} ${throughput.tokensPerSec} tok/s prefill throughput can cover inside ${firstChunkClause}. Compact the conversation to shrink the prompt, or raise this provider's declared patience or prefill throughput. This gate is a backstop, not the mechanism — post-T82a its firing means the upstream budget was sized wrong, not that nothing upstream tried.`;
  // `prefillTokensPerSec` in the log stays bound to the DECLARED column (`null` on a measured
  // refusal); the number actually spent gets its own key. No key may read "declared" on a measured value.
  logger.warn(`Refusing to dial a doomed request: ${message}`, {
    agentId, estimatedInputTokens, ceiling, prefillTokensPerSec,
    throughputTokensPerSec: throughput.tokensPerSec, throughputSource: throughput.source,
    firstChunkMs: patience.firstChunkMs, firstChunkDeclared: patience.firstChunkDeclared,
  }, agentId);
  throw new AgentError(message, agentId, {
    code: DECLARED_PATIENCE_EXCEEDED_CODE,
    retryable: false,
    preDialRefusal: true,
  });
}

/** THE ONE TRUTH CHECK: did the watchdog cut this stream, or did the user? A cut means whatever
 *  arrived is NOT an answer; a stop means the partial text is the person's to keep. Four call sites. */
export function streamWasCutByWatchdog(
  watchdog: StreamWatchdog,
  external: AbortSignal | undefined,
): boolean {
  return watchdog.timedOut() && !external?.aborted;
}

export interface ModelCallParams {
  agentId: string;
  modelId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }>;
  systemPrompt: string;
  /** Optional system-side volatile tail, rendered AFTER the cached stable system block
   *  so it can never invalidate the cached prefix. */
  systemVolatile?: string;
  tools?: boolean;
  onChunk?: (chunk: string) => void;
  /** Streamed thinking chunks from providers that expose thinking as a sibling of `content`.
   *  Anthropic's thinking arrives inside content and does not use this callback. */
  onReasoningChunk?: (chunk: string) => void;
  /** Extra output room asked for THIS call (the engine's escalation); 0/absent = the everyday budget. */
  outputRoomAsk?: number;
  // routerTier is the auto-router's tier. purpose is what this call is, for the cost ledger's
  // request_type: the served turn declares 'agent_turn', every engine utility leaves it unset and
  // records 'completion'. Never inferred from `tools`: the tools gate can make a real turn toolless.
  routerTier?: string; purpose?: string;
  /** A utility caller that knows its artifact's size (the summariser knows its `targetTokens`) may ask
   *  for LESS than that purpose's ceiling; nobody may ask for more. Ignored unless `purpose` names a
   *  utility dial; see `utility-dial.ts`. */
  utilityTargetTokens?: number | null;
  /** Re-fit for a DIFFERENT model before dialing (the redirect picks an unsized-for one); `null` = fits. */
  refitFor?: (modelId: string) => Promise<{ messages: ModelCallParams['messages']; systemPrompt: string } | null>;
  /** When fired the SDK call aborts and callModel throws (the runtime's stop button). */
  abortSignal?: AbortSignal;
  /** Best-effort utility call with a fallback; downgrades the provider-failure log from ERROR to WARN. */
  bestEffort?: boolean;
}

export interface ModelCallResult {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** Aggregated reasoning text when thinking fired; the runtime persists it so the next request
   *  can round-trip it (DeepSeek requires echoing it on tool-call follow-up turns). */
  reasoningContent?: string;
  /** The output room this call was sent with and the most a retry could be given. Absent = none to offer. */
  outputRoom?: { sent: number; ceiling: number };
}

// These beta headers are required for OAuth tokens to access Sonnet/Opus models.
const OAUTH_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
];

function isOAuthToken(credential: string): boolean {
  return credential.includes('sk-ant-oat');
}

function getProviderAuthType(providerId: string): 'api_key' | 'oauth' | 'agent-sdk' {
  const db = getDb();
  const row = db.prepare('SELECT auth_type FROM providers WHERE id = ?').get(providerId) as { auth_type: string } | undefined;
  if (row?.auth_type === 'agent-sdk') return 'agent-sdk';
  return (row?.auth_type === 'oauth' ? 'oauth' : 'api_key');
}

// The one place patience becomes client options: a provider that declares nothing gets NEITHER
// OPTION PASSED. `undici`'s `Agent` is the only way to move `headersTimeout`/`bodyTimeout`.

const transportAgentCache = new Map<string, Agent>();

interface TransportClientOptions {
  fetchOptions: { dispatcher: Agent };
  timeout: number;
  /** Cache-key fragment, so a client built for one clock is never reused under another. */
  key: string;
}

/** The client options this provider's declared patience requires, or `null` for "nothing to
 *  configure": any provider declaring no bound past the transport's standing 300 s. */
function transportClientOptions(patience: StreamPatience): TransportClientOptions | null {
  const t = resolveTransportTimeouts(patience);
  if (!t) return null;
  const key = `${t.headersTimeoutMs}/${t.bodyTimeoutMs}/${t.requestTimeoutMs}`;
  let agent = transportAgentCache.get(key);
  if (!agent) {
    agent = new Agent({ headersTimeout: t.headersTimeoutMs, bodyTimeout: t.bodyTimeoutMs });
    transportAgentCache.set(key, agent);
    logger.info('Transport clock lifted for a provider-declared patience', {
      headersTimeoutMs: t.headersTimeoutMs,
      bodyTimeoutMs: t.bodyTimeoutMs,
      requestTimeoutMs: t.requestTimeoutMs,
    });
  }
  return { fetchOptions: { dispatcher: agent }, timeout: t.requestTimeoutMs, key };
}

interface CachedClient {
  client: Anthropic;
  isOAuth: boolean;
}

const clientCache = new Map<string, CachedClient>();

function getClient(providerId: string, patience: StreamPatience): CachedClient {
  // The cache key carries the transport clock: a row edited past the old clock must not get a stale client.
  const transport = transportClientOptions(patience);
  const cacheKey = `${providerId}:${transport?.key ?? 'transport-default'}`;
  const cached = clientCache.get(cacheKey);
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

  const dbAuthType = getProviderAuthType(providerId);
  const useOAuth = dbAuthType === 'oauth' || isOAuthToken(credential);

  logger.info('Creating Anthropic client', {
    providerId,
    authType: useOAuth ? 'oauth' : 'api_key',
    credentialLength: credential.length, // never log secret bytes (audit finding 8/21)
  });

  // Spread, not set: when nothing is declared this object has exactly the keys the control
  // arm is compared against, so the construction site is the fact, not a claim about it.
  const transportOpts = transport
    ? { fetchOptions: transport.fetchOptions, timeout: transport.timeout }
    : {};

  let client: Anthropic;
  if (useOAuth) {
    client = new Anthropic({
      authToken: credential,
      defaultHeaders: {
        'anthropic-beta': OAUTH_BETAS.join(','),
        'User-Agent': 'dojo-platform',
      },
      ...transportOpts,
    });
  } else {
    client = new Anthropic({ apiKey: credential, ...transportOpts });
  }

  const entry: CachedClient = { client, isOAuth: useOAuth };
  clientCache.set(cacheKey, entry);
  return entry;
}

// `max_tokens` = min(the model's own cap, what the window spares); the floors guard ONLY the
// derived term, never a stored `max_output_tokens`. Thinking-aware: a thinking model spends
// output on reasoning and returns `finish_reason: 'length'` with nothing visible.
export const OUTPUT_FLOOR_TOKENS = 1024;
export const THINKING_OUTPUT_FLOOR_TOKENS = 4096;

/** The fields the output budget reads. */
type OutputBudgetInfo = {
  contextWindow: number;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  capabilities: string[];
  outputEscalationCeiling?: number | null;
};

/** What `max_tokens` will be for this model on this prompt. Pure, so it can be argued with.
 *  `escalatedAsk` is honoured up to `resolveOutputCeiling` and never lowers the everyday budget. */
export function resolveOutputBudget(modelInfo: OutputBudgetInfo, inputEstimate: number, escalatedAsk = 0): number {
  // Thinking has to be both DECLARED by the model and left ON by the owner. A capability the
  // Models page switched off spends no output tokens, so it earns no extra room.
  const thinkingActive = modelInfo.thinkingEnabled && modelInfo.capabilities.includes('thinking');
  const floor = thinkingActive ? THINKING_OUTPUT_FLOOR_TOKENS : OUTPUT_FLOOR_TOKENS;

  const maxOutputBudget = Math.floor(modelInfo.contextWindow * 0.25);
  const availableForOutput = Math.max(
    floor,
    Math.min(maxOutputBudget, modelInfo.contextWindow - inputEstimate - 1000),
  );
  const everyday = Math.min(modelInfo.maxOutputTokens, availableForOutput);
  if (!(escalatedAsk > everyday)) return everyday;
  return Math.min(escalatedAsk, resolveOutputCeiling(modelInfo, inputEstimate));
}

/** The most output room one call could be given on this prompt: window room after the prompt,
 *  bounded by the contract's ceiling; never below the everyday budget. */
export function resolveOutputCeiling(modelInfo: OutputBudgetInfo, inputEstimate: number): number {
  const windowRoom = modelInfo.contextWindow - inputEstimate - 1000;
  const declared = modelInfo.outputEscalationCeiling ?? modelInfo.maxOutputTokens;
  return Math.max(resolveOutputBudget(modelInfo, inputEstimate), Math.min(declared, windowRoom));
}

function getMaxOutputTokens(apiModelId: string, providerType: string): number {
  if (providerType === 'ollama') return 8192; // Ollama models typically support 8k output

  if (apiModelId.includes('opus')) return 32768;
  if (apiModelId.includes('sonnet')) return 64000;
  if (apiModelId.includes('haiku')) return 8192;

  return 16384;
}

// Orphan repair lives in `agent/tool-pairing.ts` (its header carries the derivation); this is the warn log.
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

function getModelInfo(modelId: string): { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; providerAuthType: string; providerBehavesLike: string | null; firstChunkTimeoutMs: number | null; streamIdleTimeoutMs: number | null; prefillTokensPerSec: number | null; measuredPrefillTokensPerSec: number | null; thinkingEnabled: boolean; thinkingLevel: string; capabilities: string[]; numCtxOverride: number | null; numCtxRecommended: number | null } {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.provider_id, m.api_model_id, m.context_window, m.max_output_tokens, m.thinking_enabled, m.thinking_level, m.num_ctx_override, m.num_ctx_recommended, m.capabilities, p.type as provider_type, p.base_url as provider_base_url, p.auth_type as provider_auth_type, p.behaves_like as provider_behaves_like, p.first_chunk_timeout_ms as provider_first_chunk_timeout_ms, p.stream_idle_timeout_ms as provider_stream_idle_timeout_ms, p.prefill_tokens_per_sec as provider_prefill_tokens_per_sec, p.measured_prefill_tokens_per_sec as provider_measured_prefill_tokens_per_sec
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId) as {
    provider_id: string;
    api_model_id: string;
    context_window: number | null;
    max_output_tokens: number | null;
    thinking_enabled: number | null;
    thinking_level: string | null;
    num_ctx_override: number | null;
    num_ctx_recommended: number | null;
    capabilities: string | null;
    provider_type: string;
    provider_base_url: string | null;
    provider_auth_type: string | null;
    provider_behaves_like: string | null;
    provider_first_chunk_timeout_ms: number | null;
    provider_stream_idle_timeout_ms: number | null;
    provider_prefill_tokens_per_sec: number | null;
    provider_measured_prefill_tokens_per_sec: number | null;
  } | undefined;

  if (!row) {
    throw new AgentError(`Model not found: ${modelId}`, '', {
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    });
  }

  let capabilities: string[] = [];
  if (row.capabilities) {
    try {
      const parsed = JSON.parse(row.capabilities);
      if (Array.isArray(parsed)) {
        capabilities = parsed.filter(c => typeof c === 'string');
      }
    } catch {
      // Invalid JSON, treat as text-only for safety rather than enabling everything
      logger.warn('Model has invalid capabilities JSON, defaulting to text-only', { modelId });
      capabilities = ['text'];
    }
  }

  return {
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    // The ADVERTISED window as stored; the RAM-aware budget cap applies at `getContextWindow`,
    // not here: the utility dial widens per call. A stored 0 reads as the documented default.
    contextWindow: declaredContextWindow(row.context_window),
    maxOutputTokens: row.max_output_tokens ?? getMaxOutputTokens(row.api_model_id, row.provider_type),
    providerType: row.provider_type,
    providerBaseUrl: row.provider_base_url,
    // How this provider authenticates, and what dialect its owner declared it speaks.
    // `auth_type='none'` is the local-server case: a real, long-legal value.
    providerAuthType: row.provider_auth_type ?? 'api_key',
    providerBehavesLike: row.provider_behaves_like,
    // Declared patience; NULL = never said: `resolveStreamPatience` turns NULL into the standing constants.
    firstChunkTimeoutMs: row.provider_first_chunk_timeout_ms,
    streamIdleTimeoutMs: row.provider_stream_idle_timeout_ms,
    // Declared prefill throughput in tok/sec; NULL on every row today = no ceiling, gate skipped.
    prefillTokensPerSec: row.provider_prefill_tokens_per_sec,
    // Cost-ledger prefill read, used ONLY when the declared column is NULL; see `resolvePrefillThroughput`.
    measuredPrefillTokensPerSec: row.provider_measured_prefill_tokens_per_sec,
    // Default ON, matching the migration default.
    thinkingEnabled: row.thinking_enabled === null || row.thinking_enabled === undefined
      ? true
      : Boolean(row.thinking_enabled),
    thinkingLevel: row.thinking_level ?? 'high',
    capabilities,
    // Ollama num_ctx: runtime uses `override ?? recommended`; both null sends none (Modelfile default).
    numCtxOverride: typeof row.num_ctx_override === 'number' ? row.num_ctx_override : null,
    numCtxRecommended: typeof row.num_ctx_recommended === 'number' ? row.num_ctx_recommended : null,
  };
}

/**
 * THE RAM RECOMMENDATION IS THE DEFAULT CAP: no override → budget against it; an override wins
 * (a person who types one has decided); neither set → the advertised window. Always a `min`
 * against advertised, one-way: too small costs a compaction, too large a truncated prompt.
 */
export interface NumCtxResolution {
  /** The `num_ctx` this model's calls carry, or null for "send none, let the Modelfile decide". */
  effective: number | null;
  /** Which knob answered. `default` means neither column is set: the hosted-provider case. */
  source: 'override' | 'recommended' | 'default';
}

/** Which num_ctx knob wins, said ONCE: the wire and the budget cannot disagree about it. */
export function resolveNumCtx(info: {
  numCtxOverride: number | null;
  numCtxRecommended: number | null;
}): NumCtxResolution {
  if (typeof info.numCtxOverride === 'number') {
    return { effective: info.numCtxOverride, source: 'override' };
  }
  if (typeof info.numCtxRecommended === 'number') {
    return { effective: info.numCtxRecommended, source: 'recommended' };
  }
  return { effective: null, source: 'default' };
}

/** The window the engine budgets against: the advertised one, capped by the num_ctx the calls
 *  carry. `null` num_ctx (every hosted row) returns the advertised window unchanged. */
export function effectiveContextWindow(declaredWindow: number, numCtx: number | null): number {
  if (typeof numCtx !== 'number' || !Number.isFinite(numCtx) || numCtx <= 0) return declaredWindow;
  return Math.min(declaredWindow, numCtx);
}

/** The declared contract for a CONFIGURED model id; the lookup lives here because `getModelInfo`
 *  does, keeping `model-contract.ts` a pure declaration site. Never throws: unknown = base contract. */
export function contractForConfiguredModel(modelId: string | null | undefined): ModelContract {
  return contractForModelId(getModelInfo, modelId);
}

// Ollama native /api/chat, chosen for `think`, the sibling `thinking` field, and native `images`;
// its shape is flat `message`, pre-parsed tool args, `done_reason`, newline-delimited JSON.

import { getOllamaLock } from '../services/ollama-lock.js';
import { isStandardModelRow, standardModelRowId } from '../services/local-standard.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { refuseUncheckedAtFirstLoad } from './local-model-fit.js';

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

// Anthropic-style messages → /api/chat shape: tool_use → assistant.tool_calls, tool_result →
// role:'tool' (name from the prior tool_use id), images ride `images:`, PDFs inline as framed text.
export async function buildNativeOllamaMessages(
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
        const fencedImages: NativeOllamaMessage[] = []; // each placed after the whole run of tool messages

        for (const tr of toolResults) {
          const toolUseId = tr.tool_use_id as string;
          const toolName = toolIdToName.get(toolUseId) ?? '';

          if (typeof tr.content === 'string') {
            native.push({ role: 'tool', content: tr.content, tool_name: toolName });
          } else if (Array.isArray(tr.content)) {
            // Structured blocks: text for the tool result, images queued for a follow-up user message.
            const contentBlocks = tr.content as Array<Record<string, unknown>>;
            // A fenced attachment's head and end travel WITH the image, not in the tool text.
            const { around, isBracket } = attachmentBrackets(contentBlocks as Array<{ type: string; text?: unknown }>);
            const textParts = contentBlocks.filter((b, i) => b.type === 'text' && !isBracket[i]).map(b => (b.text as string) ?? '').join('\n');
            native.push({ role: 'tool', content: textParts || '[Image loaded]', tool_name: toolName });

            contentBlocks.forEach((img, i) => {
              if (img.type !== 'image') return;
              const source = img.source as Record<string, unknown> | undefined;
              if (source?.type !== 'base64' || typeof source.data !== 'string') return;
              const fence = around[i];
              if (fence) fencedImages.push({ role: 'user', content: `${fence.head}\n(the image attached to this message)\n${fence.end}`, images: [source.data] });
              else pendingOllamaImages.push(source.data as string);
            });
          } else {
            native.push({ role: 'tool', content: JSON.stringify(tr.content), tool_name: toolName });
          }
        }

        native.push(...fencedImages);
        if (pendingOllamaImages.length > 0) {
          native.push({
            role: 'user',
            content: '[Image from tool result, analyze this image]',
            images: pendingOllamaImages,
          } as unknown as typeof native[0]);
        }

        const remainingText = blocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n').trim();
        if (remainingText) {
          native.push({ role: 'user', content: remainingText });
        }
        continue;
      }

      // User message: text + images + documents; an attached contact's fence travels with its image.
      const { around, isBracket } = attachmentBrackets(blocks as Array<{ type: string; text?: unknown }>);
      const fenceOf = new Map(blocks.map((b, i) => [b, around[i]]));
      const textBlocks = blocks.filter((b, i) => b.type === 'text' && !isBracket[i]);
      const imageBlocks = blocks.filter(b => b.type === 'image');
      const documentBlocks = blocks.filter(b => b.type === 'document');

      const textParts: string[] = [];
      const userText = textBlocks.map(b => (b.text as string) ?? '').join('\n');
      if (userText) textParts.push(userText);

      // Each PDF block's text is extracted via pdfjs and spliced into the message as a labeled
      // section: local models get the document without a native document type; failures banner and drop.
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
            textParts.push(withinFence(fenceOf.get(doc), `${header}\n${extracted.text}\n${footer}`));

            if (extracted.truncated) {
              broadcast({
                type: 'chat:error', cardClass: 'informational',
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
              type: 'chat:error', cardClass: 'informational',
              agentId,
              error: `Couldn't read "${title}", the agent will respond without it.`,
              severity: 'warning',
              retryable: false,
            });
          }
        }
      }

      const images: string[] = [];
      const fencedImages: NativeOllamaMessage[] = [];
      for (const img of imageBlocks) {
        const source = img.source as Record<string, unknown> | undefined;
        const fence = fenceOf.get(img);
        if (source && source.type === 'base64' && typeof source.data === 'string') {
          if (fence) fencedImages.push({ role: 'user', content: `${fence.head}\n(the image attached to this message)\n${fence.end}`, images: [source.data] });
          else images.push(source.data);
        }
      }

      const userMsg: NativeOllamaMessage = {
        role: 'user',
        content: textParts.join('\n\n'),
      };
      if (images.length > 0) userMsg.images = images;
      native.push(userMsg, ...fencedImages);
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
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[]; numCtxOverride: number | null; numCtxRecommended: number | null; firstChunkTimeoutMs: number | null; streamIdleTimeoutMs: number | null; prefillTokensPerSec: number | null; measuredPrefillTokensPerSec: number | null },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier, purpose } = params;
  const baseUrl = (modelInfo.providerBaseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const ollamaModelName = modelInfo.apiModelId;

  const nativeMessages = await buildNativeOllamaMessages(systemPrompt, messages, agentId);

  // Ollama-shape tools; two-phase loading: only always-loaded + session-loaded tools reach the model.
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

  // One resolver, `resolveNumCtx`, shared by the wire and the engine's context budget; see its doc.
  const { effective: effectiveNumCtx, source: numCtxSource } = resolveNumCtx(modelInfo);

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

  // THE UTILITY DIAL: `null` for every agent turn and undeclared purpose; `utility-dial.ts` holds why
  // it keys off the caller's declaration, never off `tools === false`; a dial changes exactly three things.
  const dial = utilityDial(params.purpose);
  const pinned = !!dial && isStandardModelRow(modelId);   // an engine job on the local provider's own row of the pair
  const dialShown = {
    inputChars: (systemPrompt?.length ?? 0) + nativeMessages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
    // THE IMAGES COUNT TOO: a caption prompt is one sentence, so a dial sized on text alone
    // picks the floor while the screenshot beside it costs thousands and silently truncates.
    imageBase64Lengths: nativeMessages.flatMap((m) => (m.images ?? []).map((img) => img.length)),
    configuredNumCtx: effectiveNumCtx,
    charsPerToken: modelCharsPerToken(modelId),   // this model's measured density, not a fixed 4
  };
  // A dial asking for room gets it, up to the model's max, never past the window; callers split the rest.
  const windowRoom = typeof effectiveNumCtx === 'number' && effectiveNumCtx > 0 ? Math.floor(effectiveNumCtx / NUM_CTX_BLOCK) * NUM_CTX_BLOCK
    - Math.ceil(dialShown.inputChars / effectiveDivisor(dialShown.charsPerToken)) - imageTokenAllowance(dialShown.imageBase64Lengths) - NUM_CTX_MARGIN_TOKENS : Number.POSITIVE_INFINITY;
  const dialRoom = dial ? Math.max(0, Math.min(modelInfo.maxOutputTokens, windowRoom)) : Number.POSITIVE_INFINITY;
  const dialOutputCap = dial ? Math.max(utilityOutputCap(dial, params.utilityTargetTokens), Math.min(params.outputRoomAsk ?? 0, dialRoom)) : null;
  const dialNumCtxInput = dial ? { ...dialShown, outputTokens: dialOutputCap ?? dial.maxOutputTokens } : null;
  // The resident writer keeps one window, the room set aside for it, so a call of another length does not reload it.
  const writerRoom = pinned && modelId === standardModelRowId('writer') ? await (await import('../services/dojo-working-memory.js')).writerReservedWindowTokens(effectiveNumCtx ?? null) : 0;
  const dialNumCtx = dialNumCtxInput ? Math.max(utilityNumCtx(dialNumCtxInput), writerRoom) : null;

  const requestBody: Record<string, unknown> = {
    model: ollamaModelName,
    messages: nativeMessages,
    stream: true,
    // `think` follows the per-model toggle; a no-op on non-thinking models, ignored by always-think ones.
    // A UTILITY DIAL NEVER THINKS: inherited, the agent-turn toggle can eat the whole output budget.
    think: dial ? false : modelInfo.thinkingEnabled,
    // An engine job on the Dojo's own resident writer stays loaded and takes no lock slot.
    ...(pinned ? { keep_alive: -1 } : {}),
  };
  if (nativeTools && nativeTools.length > 0) {
    requestBody.tools = nativeTools;
  }
  const options: Record<string, number> = {};
  if (typeof dialNumCtx === 'number') {
    options.num_ctx = dialNumCtx;
  } else if (typeof effectiveNumCtx === 'number') {
    options.num_ctx = effectiveNumCtx;
  }
  // `num_predict` rides both shapes (dial cap, else configured max) so Settings means what it says.
  if (typeof dialOutputCap === 'number') {
    options.num_predict = dialOutputCap;
  } else if (typeof modelInfo.maxOutputTokens === 'number' && modelInfo.maxOutputTokens > 0) {
    // An implausibly small stored value is NOT bound; a leftover must not silently truncate turns.
    // The call uses the model default and a warn names it; floor = smallest plausible real answer.
    if (modelInfo.maxOutputTokens >= MIN_BINDABLE_MAX_OUTPUT_TOKENS) {
      options.num_predict = modelInfo.maxOutputTokens;
      if (modelInfo.maxOutputTokens > modelInfo.contextWindow && modelInfo.contextWindow > 0) {
        // Incoherent stored row, not a decision: report it; the honest repair is a person correcting it.
        logger.warn('this model\'s Max output exceeds its own context window — the stored row is incoherent', {
          model: ollamaModelName,
          maxOutputTokens: modelInfo.maxOutputTokens,
          contextWindow: modelInfo.contextWindow,
        }, agentId);
      }
    } else {
      logger.warn('ignoring an implausibly small stored Max output — this call uses the model default', {
        model: ollamaModelName,
        storedMaxOutputTokens: modelInfo.maxOutputTokens,
        floor: MIN_BINDABLE_MAX_OUTPUT_TOKENS,
      }, agentId);
    }
  }
  if (Object.keys(options).length > 0) {
    requestBody.options = options;
  }
  if (dial) {
    logger.info('utility dial: thinking off, output capped, window sized to the call', {
      purpose: dial.purpose,
      outputCap: dialOutputCap,
      numCtx: dialNumCtx,
      configuredNumCtx: effectiveNumCtx,
      // The one case the window is raised: input overran it; silent truncation would yield wrong answers.
      windowRaisedForInput: dialNumCtxInput ? utilityNumCtxExceedsConfigured(dialNumCtxInput) : false,
    }, agentId);
  }

  // As on the other transports, patience and this gate precede the lock and catch: a refusal must never
  // mark a healthy provider unhealthy for a call that never dialed it. The lock serializes dials only.
  const patience = resolveStreamPatience(modelInfo);
  // THE SHARED ESTIMATOR, like the other gates: prose and dense JSON carry different measured
  // per-provider divisors; `{prose: null, dense: null}` reduces both bounds to /CHARS_PER_TOKEN.
  const nativeDivisors = measuredDivisorsFor(modelInfo.providerId);
  const nativeEstimate = estimateRequestTokens(
    {
      proseChars: JSON.stringify(nativeMessages).length,
      schemaChars: JSON.stringify(nativeTools ?? []).length,
    },
    nativeDivisors,
  ).tokens;
  refuseIfDoomed(agentId, nativeEstimate, patience, modelInfo);

  // `resolveStreamPatience`'s 90s/60s come from HOSTED behaviour; an undeclared local box keeps the
  // 300s default per phase (arming 90s there is LESS patient), a declared row is exact; `patience`
  // stays raw elsewhere; accepted exception: a NULL row's 300s watchdog ties undici's headersTimeout.
  const bounds: StreamPatience = {
    firstChunkMs: patience.firstChunkDeclared ? patience.firstChunkMs : TRANSPORT_DEFAULT_TIMEOUT_MS,
    idleMs: patience.idleDeclared ? patience.idleMs : TRANSPORT_DEFAULT_TIMEOUT_MS,
    firstChunkDeclared: patience.firstChunkDeclared,
    idleDeclared: patience.idleDeclared,
  };

  // Model lock: waits if a different model is in use on the SAME provider; remote hosts pool their own.
  const lock = getOllamaLock();
  // THE WAIT BOUND IS THE NUMBER THE OCCUPANT IS ENTITLED TO: the lock gets the identical number
  // the watchdog arms below, so a queued call is never rejected at 90s while the holder gets 300s.
  await refuseUncheckedAtFirstLoad(modelId);   // a model picked while it could not be sized is judged now
  await lock.acquire(modelInfo.providerId, ollamaModelName, bounds.firstChunkMs, pinned);

  const startTime = Date.now();

  // The SAME `makeStreamWatchdog` the other two transports arm: bumped per chunk,
  // `contentStarted()` on the first delta. External stop rides `AbortSignal.any`.
  const watchdog = makeStreamWatchdog(params.abortSignal, bounds.firstChunkMs, bounds.idleMs);

  try {
    // THE WATCHDOG ALONE IS NOT ENOUGH: built-in `fetch` rides undici's GLOBAL dispatcher, whose 300s
    // `headersTimeout`/`bodyTimeout` cut a declared 600s row at ~300s unless a `transportClientOptions`
    // Agent is attached; a NULL row sets no `dispatcher` key and rides the global one unchanged.
    const transport = transportClientOptions(patience);
    // Node's `RequestInit.dispatcher` types off separately-versioned `undici-types`, drifted from the
    // `undici` package importing `Agent` here; the cast is narrow: this one field, not a blanket `any`.
    const dispatcher = transport?.fetchOptions.dispatcher as NonNullable<RequestInit['dispatcher']> | undefined;
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: watchdog.signal,
      ...(dispatcher ? { dispatcher } : {}),
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

    // NDJSON: each line is a complete object; the final line carries `done: true` and the usage counts.
    let fullContent = '';
    let fullThinking = '';
    let accumulatedToolCalls: ToolCall[] = [];
    let doneReason: string | null = null;
    let streamError: string | null = null; // Ollama reports a mid-reply failure as an `error` line
    let sawDone = false;
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
        error?: unknown;
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

      if (typeof chunk.error === 'string' && chunk.error) { streamError = chunk.error; return; }
      const message = chunk.message;
      if (message) {
        // Text, thinking or tool-call deltas are generated output and start the dead-connection
        // bound; Ollama's bare role-only frame is an ack frame and must not buy a shorter leash.
        if (
          (typeof message.content === 'string' && message.content.length > 0)
          || (typeof message.thinking === 'string' && message.thinking.length > 0)
          || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
        ) {
          watchdog.contentStarted();
        }
        if (typeof message.content === 'string' && message.content.length > 0) {
          fullContent += message.content;
          if (onChunk) onChunk(message.content);
        }
        if (typeof message.thinking === 'string' && message.thinking.length > 0) {
          fullThinking += message.thinking;
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          // Ollama emits the whole tool_calls array in one chunk, not per-arg deltas, so replacing is safe.
          accumulatedToolCalls = message.tool_calls.map((tc, idx) => {
            const rawArgs = tc.function?.arguments;
            let parsedArgs: Record<string, unknown>;
            if (rawArgs && typeof rawArgs === 'object') {
              parsedArgs = rawArgs as Record<string, unknown>;
            } else if (typeof rawArgs === 'string') {
              try {
                parsedArgs = JSON.parse(rawArgs);
              } catch {
                // Structured repair before rejecting (control chars in long args on floor models).
                const repaired = repairToolCallArgs(rawArgs);
                if (repaired !== null) {
                  parsedArgs = repaired;
                  logger.info('Repaired malformed tool call JSON arguments', {
                    toolName: tc.function?.name,
                  }, agentId);
                } else {
                  logger.warn('Ollama: malformed tool call JSON arguments (repair failed)', {
                    toolName: tc.function?.name,
                    rawLength: typeof rawArgs === 'string' ? rawArgs.length : String(rawArgs).length,
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
        sawDone = true;
        doneReason = chunk.done_reason ?? null;
        if (typeof chunk.prompt_eval_count === 'number') inputTokens = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === 'number') outputTokens = chunk.eval_count;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Same per-chunk re-arm as the other transports; `processLine` decides what was CONTENT.
      watchdog.bump();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    if (buffer.trim()) processLine(buffer);

    // No post-loop truth check is mirrored here on purpose: an aborted `fetch` body errors the stream,
    // `reader.read()` rejects into the catch: no silent exit to guard; only `done: true` finishes.
    if (streamError !== null || !sawDone) {
      const msg = `Ollama call failed: ${streamError ?? 'the reply stream ended before Ollama said it was finished'}`;
      throw new AgentError(msg, agentId, { code: 'MODEL_CALL_FAILED', retryable: true, provider: classifyProviderErrorText(msg) });
    }
    watchdog.finish();
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
      requestType: routerTier ?? purpose ?? 'completion',
      // The purpose on its OWN axis; `requestType` above, ?? chain included, is byte-unchanged.
      callPurpose: purpose,
    });

    recordProviderSuccess(modelInfo.providerId, { modelId, purpose });

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
      stopReason: resolveProviderStopReason(doneReason, accumulatedToolCalls.length),   // the provider's cut wins over a parsed tool call
      // The room this call really got, so a cut at it reads against a true number; only set when
      // `num_predict` went on the wire, ceiling the model's configured max, never below what was sent.
      ...(typeof options.num_predict === 'number'
        ? { outputRoom: { sent: options.num_predict, ceiling: Math.max(options.num_predict, Math.min(modelInfo.maxOutputTokens, dialRoom)) } }
        : {}),
    };
  } catch (err) {
    watchdog.finish();
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // THE TRIP'S IDENTITY IS MEASURED, NOT ASSERTED: the shared helper reads a clock that actually watched,
    // and `timedOut()` is set only in the timer callback: an external stop cannot mint a patience code.
    if (streamWasCutByWatchdog(watchdog, params.abortSignal)) {
      const code = streamTimeoutCode(watchdog, bounds);
      const declaredMsg = `${streamTimeoutPhrase(watchdog, bounds)}: no data from provider for too long (elapsed ${watchdog.elapsedMs()}ms)${declaredPatienceClause(watchdog, bounds, nativeEstimate)}`;
      recordProviderError(modelInfo.providerId);
      logger.warn(`Ollama call aborted by ${streamTripBound(watchdog, bounds)}: ${declaredMsg}`, {
        model: ollamaModelName, baseUrl, latencyMs,
      }, agentId);
      // Declared-patience exhaustion is never retryable; a plain idle timeout keeps its retry.
      throw new AgentError(declaredMsg, agentId, { code, retryable: code === STREAM_IDLE_TIMEOUT_CODE });
    }

    // Best-effort calls log handled failures at WARN, and a caller-stopped call is no failure at all.
    settleFailedCall('Ollama call', message, { model: ollamaModelName, baseUrl, latencyMs },
      { providerId: modelInfo.providerId, agentId, signal: params.abortSignal, bestEffort: params.bestEffort, facts: classifyProviderError(err) });
    throw err instanceof AgentError ? err : new AgentError(`Ollama call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: true,
      provider: classifyProviderError(err),
    });
  } finally {
    lock.release(modelInfo.providerId, ollamaModelName, pinned);
  }
}

// ── OpenAI Call Path ──

const openaiClientCache = new Map<string, OpenAI>();

// Base URL: bare-host endpoints keep their root, the rest get `/v1`; host list at its contract site.
export function resolveOpenAIBaseUrl(baseUrl?: string | null): string | undefined {
  if (!baseUrl) return undefined;
  const cleaned = baseUrl.replace(/\/+$/, '');
  if (apiRootIsBareHost(cleaned)) return cleaned;
  return cleaned.endsWith('/v1') ? cleaned : cleaned + '/v1';
}

// Stand-in for `auth_type='none'`: the SDK refuses construction without an `apiKey` string, so
// a keyless provider gets this visible placeholder rather than a throw. Never stored, never logged.
const NO_AUTH_PLACEHOLDER_KEY = 'dojo-provider-declares-no-auth';

function getOpenAIClient(
  providerId: string,
  patience: StreamPatience,
  baseUrl?: string | null,
  authType?: string | null,
): OpenAI {
  // The declared patience is part of the client's identity; see `transportClientOptions`.
  const transport = transportClientOptions(patience);
  const cacheKey = `${providerId}:${baseUrl ?? 'default'}:${transport?.key ?? 'transport-default'}`;
  const cached = openaiClientCache.get(cacheKey);
  if (cached) return cached;

  const credential = getProviderCredential(providerId);
  // A provider that declares no auth is not a provider that is missing its key.
  const declaresNoAuth = authType === 'none';
  if (!credential && !declaresNoAuth) {
    throw new AgentError(`No credential found for OpenAI provider: ${providerId}`, '', {
      code: 'NO_API_KEY',
      retryable: false,
    });
  }

  const resolvedBaseUrl = resolveOpenAIBaseUrl(baseUrl);

  logger.info('Creating OpenAI-compatible client', { providerId, baseUrl, resolvedBaseUrl: resolvedBaseUrl ?? 'https://api.openai.com/v1 (default)', declaresNoAuth });

  const client = new OpenAI({
    apiKey: credential ?? NO_AUTH_PLACEHOLDER_KEY,
    ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
    // Absent unless the provider declared patience the standing transport clock cannot honour.
    ...(transport ? { fetchOptions: transport.fetchOptions, timeout: transport.timeout } : {}),
  });

  openaiClientCache.set(cacheKey, client);
  return client;
}

// Anthropic blocks → OpenAI messages: images become data-URL `image_url` parts, documents inline.
// Models lacking vision were stripped upstream by `enforceModelCapabilities`; this only translates.
export async function buildOpenAIMessages(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }>,
  agentId: string,
  contract: ModelContract,
  systemVolatile = '',
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  // OpenAI & DeepSeek auto-cache a stable system prefix with NO markup, so they get a plain string.
  // OpenRouter needs an explicit marker; which one a provider is lives in the contract field.
  const systemMessage = (contract.systemPromptCacheMarker === 'explicit-ephemeral'
    ? { role: 'system', content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] }
    : { role: 'system', content: systemPrompt }) as OpenAI.ChatCompletionMessageParam;
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [systemMessage];
  // A second unmarked system message puts volatile content after the cached prefix so it cannot break it.
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
        // OpenAI tool results are string-only: the text stays inside, images follow as a user message.
        const pendingImages: Array<Record<string, unknown>> = [];

        for (const tr of toolResults) {
          if (typeof tr.content === 'string') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id as string,
              content: tr.content,
            });
          } else if (Array.isArray(tr.content)) {
            const contentBlocks = tr.content as Array<Record<string, unknown>>;
            // A fenced attachment's head and end travel WITH the image (render order), not in the tool text.
            const { around, isBracket } = attachmentBrackets(contentBlocks as Array<{ type: string; text?: unknown }>);
            const textParts = contentBlocks.filter((b, i) => b.type === 'text' && !isBracket[i]).map(b => (b.text as string) ?? '').join('\n');
            const imageBlks = contentBlocks.flatMap((b, i) => (b.type === 'image' ? [{ b, fence: around[i] }] : []));
            const docBlks = contentBlocks.flatMap((b, i) => (b.type === 'document' ? [{ b, fence: around[i] }] : []));

            // PDF text stays in the tool message: a user message between tool results breaks the order.
            const pdfTexts: string[] = [];
            for (const { b: doc, fence } of docBlks) {
              const source = doc.source as Record<string, unknown> | undefined;
              if (source?.type === 'base64' && typeof source.data === 'string') {
                try {
                  const { extractPdfText } = await import('../services/pdf-extract.js');
                  const extracted = await extractPdfText(source.data as string);
                  const title = (doc.title as string) ?? 'document';
                  pdfTexts.push(withinFence(fence, `[PDF: ${title}]\n${extracted.text}\n[end of ${title}]`));
                } catch { /* PDF extraction failed, skip */ }
              }
            }
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id as string,
              content: [textParts, ...pdfTexts].filter(Boolean).join('\n') || '[Image loaded, see below]',
            });

            for (const { b: img, fence } of imageBlks) {
              const source = img.source as Record<string, unknown> | undefined;
              if (source?.type === 'base64' && typeof source.data === 'string') {
                const mediaType = (source.media_type as string) || 'image/png';
                if (fence) pendingImages.push({ type: 'text', text: fence.head });
                pendingImages.push({
                  type: 'image_url',
                  image_url: { url: `data:${mediaType};base64,${source.data}` },
                });
                if (fence) pendingImages.push({ type: 'text', text: fence.end });
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

        // Queued images ride a follow-up user message: OpenAI tool results carry no images.
        if (pendingImages.length > 0) {
          const parts: OpenAI.ChatCompletionContentPart[] = [
            { type: 'text', text: '[Image from tool result, analyze this image]' },
            ...(pendingImages as unknown as OpenAI.ChatCompletionContentPart[]),
          ];
          openaiMessages.push({ role: 'user', content: parts });
        }

        const remainingText = blocks.filter(b => b.type === 'text').map(b => (b.text as string) ?? '').join('\n').trim();
        if (remainingText) {
          openaiMessages.push({ role: 'user', content: remainingText });
        }
        continue;
      }

      const { around, isBracket } = attachmentBrackets(blocks as Array<{ type: string; text?: unknown }>);
      const fenceOf = new Map(blocks.map((b, i) => [b, around[i]]));
      const textBlocks = blocks.filter((b, i) => b.type === 'text' && !isBracket[i]);
      const imageBlocks = blocks.filter(b => b.type === 'image');
      const documentBlocks = blocks.filter(b => b.type === 'document');

      let textContent = textBlocks.map(b => (b.text as string) ?? '').join('\n');

      // Inline PDF text: Chat Completions has no document type; the only way a PDF reaches the model.
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
            textContent = (textContent ? textContent + '\n\n' : '') + withinFence(fenceOf.get(doc), `${header}\n${extracted.text}\n${footer}`);

            if (extracted.truncated) {
              broadcast({
                type: 'chat:error', cardClass: 'informational',
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
              type: 'chat:error', cardClass: 'informational',
              agentId,
              error: `Couldn't read "${title}", the agent will respond without it.`,
              severity: 'warning',
              retryable: false,
            });
          }
        }
      }

      if (imageBlocks.length === 0) {
        openaiMessages.push({ role: 'user', content: textContent });
        continue;
      }

      // Images: `image_url` with a base64 data URL, so no external hosting is needed.
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
        const fence = fenceOf.get(img);
        if (fence) parts.push({ type: 'text', text: fence.head });
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mediaType};base64,${source.data}`,
          },
        });
        if (fence) parts.push({ type: 'text', text: fence.end });
      }

      if (parts.length === 0) {
        openaiMessages.push({ role: 'user', content: textContent || '(attachment could not be decoded)' });
      } else if (parts.length === 1 && parts[0].type === 'text') {
        // Only text survived: string form, for providers that dislike the array form there.
        openaiMessages.push({ role: 'user', content: parts[0].text });
      } else {
        openaiMessages.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        // A string-content assistant message can never carry tool calls, so its reasoning is dropped.
        const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: 'assistant', content: m.content };
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

        // Reasoning rides tool-call turns only; keep the `''` fallback: some providers 400 without it.
        // The condition is `memory/budget.ts`'s `reasoningRidesThisTurn`, the predicate the token math uses.
        if (reasoningRidesThisTurn(m.content)) {
          if (m.reasoningContent) {
            (assistantMsg as unknown as Record<string, unknown>).reasoning_content = m.reasoningContent;
          } else if (contract.requiresReasoningReplay) {
            (assistantMsg as unknown as Record<string, unknown>).reasoning_content = '';
          }
        }

        openaiMessages.push(assistantMsg);
      }
    }
  }

  return openaiMessages;
}

// Repairs malformed tool JSON: raw control chars and trailing commas are the dominant floor-model failure,
// and refusing costs a full retry that burns turns; escape control chars, re-parse, null if still broken.
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
        // Other C0 control chars are illegal raw in JSON strings too; escape as \u00XX.
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

// Mutates `requestParams` in place from the contract; field definitions: `model-contract.ts`.
// Proxy thinking gets the unified `reasoning` object; native models get `thinking` + `reasoning_effort`.
// temperature/top_p dropped while thinking when the contract rejects them.
export function applyProviderRequestParams(
  requestParams: OpenAI.ChatCompletionCreateParams,
  contract: ModelContract,
  opts: { supportsThinking: boolean; thinkingEnabled: boolean; thinkingLevel?: string | null },
): void {
  if (contract.thinkingToggle === 'openrouter-reasoning' && opts.supportsThinking) {
    // `extra_body` survives the SDK's pass-through, so the reasoning object reaches the wire untouched.
    (requestParams as unknown as { extra_body?: Record<string, unknown> }).extra_body = {
      ...((requestParams as unknown as { extra_body?: Record<string, unknown> }).extra_body ?? {}),
      reasoning: { enabled: opts.thinkingEnabled },
    };
  }

  const thinkingActive = opts.thinkingEnabled && opts.supportsThinking;
  if (contract.thinkingToggle === 'native-thinking-param') {
    (requestParams as unknown as { thinking?: { type: string } }).thinking = {
      type: thinkingActive ? 'enabled' : 'disabled',
    };
    // The level travels only while thinking is on and only if the contract lists it; no name sends none.
    if (thinkingActive && opts.thinkingLevel && (contract.thinkingLevels as readonly string[]).includes(opts.thinkingLevel)) {
      (requestParams as unknown as { reasoning_effort?: string }).reasoning_effort = opts.thinkingLevel;
    }
  }

  if (contract.rejectsSamplingParamsWhenThinking && thinkingActive) {
    const p = requestParams as unknown as Record<string, unknown>;
    delete p.temperature;
    delete p.top_p;
  }
}

async function callOpenAIModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; providerAuthType: string; providerBehavesLike: string | null; firstChunkTimeoutMs: number | null; streamIdleTimeoutMs: number | null; prefillTokensPerSec: number | null; measuredPrefillTokensPerSec: number | null; thinkingEnabled: boolean; thinkingLevel?: string; capabilities: string[] },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier, purpose } = params;
  const startTime = Date.now();

  // One read feeds the watchdog and the socket: the transport can never be less patient than its own bound.
  const patience = resolveStreamPatience(modelInfo);
  const client = getOpenAIClient(modelInfo.providerId, patience, modelInfo.providerBaseUrl, modelInfo.providerAuthType);

  // Which knobs a provider needs is the contract's business, not a name check.
  const contract = contractForModel(modelInfo);
  const openaiMessages = await buildOpenAIMessages(systemPrompt, messages, agentId, contract, params.systemVolatile ?? '');

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

  // o-series models take `max_completion_tokens`, the rest take `max_tokens`.
  const isReasoningModel = modelInfo.apiModelId.match(/^o[1-4]/);

  // No front-trimmer: NEVER EXCEED THE PROVIDER'S WINDOW; upstream (allocator + assembly) enforces it.

  // Output reserve: at most 25% of context or what's left after input; the math is `resolveOutputBudget`.
  // The estimate SPENDS this provider's measured divisors, not the asserted 4.
  // It can only GROW: an unmeasured provider gets today's number, and everything downstream reads it.
  const openaiProseChars = openaiMessages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + content.length;
  }, 0);
  const openaiSchemaChars = JSON.stringify(openaiTools ?? []).length;
  const openaiEstimate = estimateRequestTokens(
    { proseChars: openaiProseChars, schemaChars: openaiSchemaChars },
    measuredDivisorsFor(modelInfo.providerId),
  );
  const finalInputEstimate = openaiEstimate.tokens;

  // Pre-dial gate on this exact request's estimate, before any socket; a no-op until a throughput exists.
  refuseIfDoomed(agentId, finalInputEstimate, patience, modelInfo);

  // The engine's extra-room ask is honoured up to the contract's ceiling; the result reports what was sent.
  // A memory-summarize dial forces thinking off where the contract allows; else the model's own value.
  const thinkingSent = utilityDial(purpose)?.purpose === 'memory_summarize' && contract.thinkingToggle !== 'none' ? false : modelInfo.thinkingEnabled;
  const budgetInfo = { ...modelInfo, thinkingEnabled: thinkingSent, outputEscalationCeiling: contract.outputEscalationCeiling };
  const effectiveMaxTokens = resolveOutputBudget(budgetInfo, finalInputEstimate, params.outputRoomAsk ?? 0);
  const outputRoomCeiling = resolveOutputCeiling(budgetInfo, finalInputEstimate);

  // Tool pair sanitizer, idempotent, every call: orphan pairs 400 before trimming fires.
  // Pass 1 drops tool results outside the most recent assistant's owed-set, which spans the WHOLE batch;
  // a per-message check once erased parallel turns. Pass 2 drops assistant turns not fully answered next.
  {
    type AnyMsg = OpenAI.ChatCompletionMessageParam & {
      tool_calls?: Array<{ id: string }>;
      tool_call_id?: string;
    };

    // Pass 1: drop tool results whose id is not in the owed set; keeping one consumes its id.
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
      // Any other role breaks the parallel-batch run; those calls should be answered by then.
      pendingOwedIds = null;
      afterPass1.push(m);
    }

    // Pass 2: drop assistant turns whose tool_calls aren't all answered by the tool results right after.
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
        let allAnswered = true;
        for (const id of callIds) {
          if (!followIds.has(id)) { allAnswered = false; break; }
        }
        if (!allAnswered) {
          // Drop this assistant AND its following tool results, they would orphan too.
          strippedOrphanCall++;
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
    // A final usage chunk makes real prompt-cache hits visible (DeepSeek/OpenAI); harmless if ignored.
    stream_options: { include_usage: true },
    ...(isReasoningModel
      ? { max_completion_tokens: effectiveMaxTokens }
      : { max_tokens: effectiveMaxTokens }),
    ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools } : {}),
  };

  const supportsThinking = modelInfo.capabilities.includes('thinking');
  applyProviderRequestParams(requestParams, contract, {
    supportsThinking, thinkingEnabled: thinkingSent, thinkingLevel: modelInfo.thinkingLevel,
  });

  logger.info('Calling OpenAI model', {
    model: modelInfo.apiModelId,
    provider: modelInfo.providerId,
    contract: contract.id,
    messageCount: openaiMessages.length,
    toolCount: openaiTools?.length ?? 0,
    maxOutputTokens: modelInfo.maxOutputTokens,
    sentMaxTokens: effectiveMaxTokens,
    thinkingEnabled: thinkingSent,
    thinkingLevel: (requestParams as unknown as { reasoning_effort?: string }).reasoning_effort ?? null,
    reasoningToggleApplied: contract.thinkingToggle === 'openrouter-reasoning' && supportsThinking,
  }, agentId);

  // Replay diagnostic: per-assistant reasoning_content presence, so passback 400s are diagnosable.
  if (contract.requiresReasoningReplay) {
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
    // The label follows the contract field, not a provider name; `contract` names which one was dialed.
    logger.info('reasoning replay round-trip, per assistant message', {
      contract: contract.id,
      assistantMessages: assistantSummary,
    }, agentId);
  }

  // The watchdog bounds first-token and inter-chunk gaps, combined with the stop signal.
  // The PROVIDER sets the bounds: a local box reading a 35k prompt before token 1 is not a hang.
  // The watchdog is the BINDING bound: the transport clock gets the same numbers plus a margin, so it
  // never aborts first, and `streamTimeoutPhrase` names every timeout a caller can see.
  const watchdog = makeStreamWatchdog(params.abortSignal, patience.firstChunkMs, patience.idleMs);
  try {
    const requestOptions = { signal: watchdog.signal };
    // .withResponse() returns the stream AND the raw Response (rate limits) without consuming the body.
    const { data: stream, response: rawResponse } =
      await client.chat.completions.create(requestParams, requestOptions).withResponse();

    let fullText = '';
    let fullReasoning = '';
    const toolCalls: ToolCall[] = [];
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();
    let realUsage: (OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }) | undefined;

    // The provider's terminal reason, kept: it arrives on the last content chunk, before the usage chunk.
    let providerFinishReason: string | null = null;

    for await (const chunk of stream) {
      watchdog.bump();
      // The usage chunk arrives last with an empty choices array; capture before the delta guard.
      if (chunk.usage) realUsage = chunk.usage as typeof realUsage;
      const finish = chunk.choices[0]?.finish_reason;
      if (finish) providerFinishReason = finish;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // The moment the provider proves it can EMIT: ends prompt patience, starts the dead-connection bound.
      // A role-only delta is NOT generated output and must not buy a shorter leash.
      if (
        delta.content
        || delta.tool_calls
        || (delta as unknown as { reasoning_content?: string }).reasoning_content
        || (delta as unknown as { reasoning?: string }).reasoning
      ) {
        watchdog.contentStarted();
      }

      // Reasoning (DeepSeek-style sibling field, OpenRouter's unified path) streams via its own callback.
      const reasoningChunk = (delta as unknown as { reasoning_content?: string }).reasoning_content
        ?? (delta as unknown as { reasoning?: string }).reasoning
        ?? null;
      if (reasoningChunk) {
        fullReasoning += reasoningChunk;
        if (params.onReasoningChunk) params.onReasoningChunk(reasoningChunk);
      }

      if (delta.content) {
        fullText += delta.content;
        if (onChunk) onChunk(delta.content);
      }

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

    // A STALL IS NEVER AN ANSWER: the SDK swallows a watchdog abort, so a stall looks like completion here.
    // Re-raise HERE: this function's catch gives both abort kinds the same AgentError and health record.
    // Watchdog only: a mid-answer close sends no `finish_reason`; below that raises STREAM_NO_FINISH_ERROR.
    if (streamWasCutByWatchdog(watchdog, params.abortSignal)) {
      throw new Error(`${streamTimeoutPhrase(watchdog, patience)}: the stream ended on the watchdog's abort, which the SDK did not raise`);
    }

    // No finish_reason = the provider hung up mid-answer; only the user's own stop may ship a partial.
    if (providerFinishReason === null && !params.abortSignal?.aborted) {
      throw new StreamEndedUnfinished(`${STREAM_NO_FINISH_ERROR}: the provider closed the stream before saying the answer was finished`);
    }

    for (const [, acc] of toolCallAccumulator) {
      let parsedArgs: Record<string, unknown> = {};
      let malformedArgs = false;
      if (acc.args && acc.args.trim().length > 0) {
        try {
          parsedArgs = JSON.parse(acc.args);
        } catch {
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
              rawLength: acc.args.length,
            }, agentId);
          }
        }
      }
      if (malformedArgs) {
        // Not silent empty args: an error tool result so the model sees it, flagged `__malformed_args`.
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

    // Cache visibility: markers alone don't guarantee a HIT, the prefix must be stable.
    // Prefer real provider usage; char estimates only when no usage came back.
    // inputTokens is the TOTAL prompt, uncachedInputTokens the DISJOINT uncached input recordCost bills;
    // cacheReadTokens stays undefined if unreported; such providers report HITS only: no creation surcharge.
    let inputTokens: number;
    let outputTokens: number;
    let uncachedInputTokens: number;
    let cacheReadTokens: number | undefined;
    // Flipped true only by the no-usage branch below; `false` claims "this came off a usage block".
    let inputTokensEstimated = false;
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
      inputTokens = Math.ceil((systemPrompt.length + JSON.stringify(openaiMessages).length) / 4);
      outputTokens = Math.ceil((fullText.length + JSON.stringify(toolCalls).length) / 4);
      uncachedInputTokens = inputTokens;
      cacheReadTokens = undefined;
      // The ONE estimated-input branch: chars/4 runs ABOVE truth and the prefill speedometer keeps a
      // maximum, so an inflated count must never reach it.
      inputTokensEstimated = true;
    }

    const costPerM = getOpenAICost(modelInfo.apiModelId);
    const totalCost = (uncachedInputTokens / 1_000_000) * costPerM.input
      + ((cacheReadTokens ?? 0) / 1_000_000) * costPerM.input * 0.1
      + (outputTokens / 1_000_000) * costPerM.output;

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
      requestType: routerTier ?? purpose ?? 'completion',
      // The purpose on its OWN axis; `requestType` above, ?? chain included, is byte-unchanged.
      callPurpose: purpose,
      cacheReadTokens,
      // The post-trim estimate, i.e. the one describing the request that actually went out.
      estimatedInputTokens: finalInputEstimate,
      // The divisor THIS estimate used; `chars = estimate x divisor` recovers the count, per-request.
      estimatorCharsPerToken: openaiEstimate.effectiveCharsPerToken,
      // True only on the no-usage fallback above; the speedometer refuses such a row.
      inputTokensEstimated,
    });

    recordProviderSuccess(modelInfo.providerId, { modelId, purpose });

    // Text tool-call fallback: only a tool this call actually offered is taken; see text-tool-fallback.ts.
    if (toolCalls.length === 0 && openaiTools) {
      const extracted = extractTextToolCalls(fullText, openaiTools.flatMap(t => (t.type === 'function' ? [t.function.name] : [])));
      if (extracted.toolCalls.length > 0) {
        toolCalls.push(...extracted.toolCalls);
        fullText = extracted.cleanText;
        logger.info('Extracted text-based tool calls (fallback)', {
          model: modelInfo.apiModelId,
          extractedCount: toolCalls.length,
          tools: toolCalls.map(tc => tc.name),
        }, agentId);
      }
    }

    // The honest stop reason and the shape the census reads, countable straight from the log.
    const stopReason = resolveProviderStopReason(providerFinishReason, toolCalls.length);
    logger.info('OpenAI call completed', {
      model: modelInfo.apiModelId,
      inputTokens, outputTokens, latencyMs,
      cost: totalCost.toFixed(6),
      toolCallCount: toolCalls.length,
      reasoningChars: fullReasoning.length,
      finishReason: providerFinishReason, stopReason,
    }, agentId);

    if (stopReason === 'length' && toolCalls.length === 0) {
      // THE GRIND, named where it happens; restart lives in `v2/steps/post-call-classify/empty-response.ts`.
      logger.warn('OpenAI call ran out its ENTIRE output budget with no tool call — the grind class', {
        model: modelInfo.apiModelId,
        outputTokens, latencyMs,
        reasoningChars: fullReasoning.length,
        contentChars: fullText.length,
      }, agentId);
    }

    // Headers feed the rate-limit tracker, as on the Anthropic path; selectModel skips worn models.
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
      outputRoom: { sent: effectiveMaxTokens, ceiling: outputRoomCeiling },
    };
  } catch (err) {
    watchdog.finish();
    if (err instanceof StreamEndedUnfinished) {
      recordProviderError(modelInfo.providerId);
      logger.warn(`OpenAI call ended without a finish signal: ${err.message}`, {
        model: modelInfo.apiModelId, providerId: modelInfo.providerId,
      }, agentId);
      throw new AgentError(err.message, agentId, { code: 'MODEL_CALL_FAILED', retryable: true });
    }
    if (streamWasCutByWatchdog(watchdog, params.abortSignal)) {
      // The WATCHDOG aborted (never the user's stop; that leaves timedOut() false or shows on the
      // external signal). Translate to the retryable phrase the v2 loop matches for its one retry.
      recordProviderError(modelInfo.providerId);
      const code = streamTimeoutCode(watchdog, patience);
      const msg = `${streamTimeoutPhrase(watchdog, patience)}: no data from provider for too long (elapsed ${watchdog.elapsedMs()}ms)${declaredPatienceClause(watchdog, patience, finalInputEstimate)}`;
      logger.warn(`OpenAI call aborted by stream watchdog: ${msg}`, {
        model: modelInfo.apiModelId, providerId: modelInfo.providerId,
      }, agentId);
      // Declared-patience exhaustion is not retryable: the phrase withholds v2's retry, the flag says so.
      throw new AgentError(msg, agentId, { code, retryable: code === STREAM_IDLE_TIMEOUT_CODE });
    }
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // settleFailedCall: best-effort calls log WARN, genuine ones ERROR, a caller-stopped call is no failure.
    settleFailedCall('OpenAI call', message, { model: modelInfo.apiModelId, providerId: modelInfo.providerId, latencyMs },
      { providerId: modelInfo.providerId, agentId, signal: params.abortSignal, bestEffort: params.bestEffort, facts: classifyProviderError(err) });

    // Classify by the provider's STATUS, never by this message's digits.
    const facts = classifyProviderError(err);
    // Out-of-credit (402, quota 429) is not a rate limit: waiting won't fix it; propagate as `quota`.
    const isRateLimited = facts.class === 'rate_limit';
    const isOverloaded = facts.class === 'overloaded';

    // Record the rate limit whatever the routing mode; selectModel skips this model on its next pick.
    // These providers surface no usable headers: synthesize remaining=0, take reset from retry-after.
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
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null; thinkingEnabled: boolean; capabilities: string[]; firstChunkTimeoutMs: number | null; streamIdleTimeoutMs: number | null; prefillTokensPerSec: number | null; measuredPrefillTokensPerSec: number | null },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier, purpose } = params;

  const { callAnthropicViaSdk, AgentSdkVisionUnsupportedError, AgentSdkPatienceExceededError } = await import('../providers/anthropic-sdk.js');

  let toolDefs: ToolDefinition[] = [];
  if (tools) {
    const allPermitted = getFilteredTools(agentId);
    const { filterToolsForApiCall, getAgentAlwaysLoadedTools } = await import('../tools/tool-docs.js');
    const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
    toolDefs = filterToolsForApiCall(agentId, allPermitted, alwaysLoaded);
  }

  // All transports obey `resolveStreamPatience`; a hung call must not hold the compaction lock.
  // `query()` yields a message per chunk, so both bounds apply as inter-read gaps.
  const patience = resolveStreamPatience(modelInfo);
  const transportTimeouts = resolveTransportTimeouts(patience);
  // The two bounds are kept apart and applied as gaps, never merged into one flat total armed at dial.
  const sdkFirstChunkTimeoutMs = transportTimeouts?.headersTimeoutMs ?? patience.firstChunkMs;
  const sdkIdleTimeoutMs = transportTimeouts?.bodyTimeoutMs ?? patience.idleMs;

  // All four transports pay the same `estimateRequestTokens` gate; an unmeasured provider is a no-op.
  const sdkDivisors = measuredDivisorsFor(modelInfo.providerId);
  const sdkInputEstimate = estimateRequestTokens(
    {
      proseChars: systemPrompt.length + JSON.stringify(messages).length,
      schemaChars: JSON.stringify(toolDefs).length,
    },
    sdkDivisors,
  ).tokens;
  refuseIfDoomed(agentId, sdkInputEstimate, patience, modelInfo);

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
      // Both bounds travel separately, as gaps: send-to-first-byte, and between body bytes.
      timeoutMs: sdkFirstChunkTimeoutMs,
      idleTimeoutMs: sdkIdleTimeoutMs,
      // Every transport folds the stop signal into its abort; none may run on past a stop.
      abortSignal: params.abortSignal,
    });

    const latencyMs = Date.now() - startTime;
    recordProviderSuccess(modelInfo.providerId, { modelId, purpose });

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
        requestType: routerTier ?? purpose ?? 'completion',
        // The purpose on its OWN axis; `requestType` above, ?? chain included, is byte-unchanged.
        callPurpose: purpose,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
      });
    } catch { /* cost tracking is best-effort */ }

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

    // A pre-flight vision refusal is NOT a provider fault: don't mark the provider unhealthy
    // and don't log at error. The recovery cascade's vision_mismatch branch keys on this wording.
    if (err instanceof AgentSdkVisionUnsupportedError) {
      logger.warn(`Agent SDK call refused an image: ${message}`, { model: modelInfo.apiModelId, agentId }, agentId);
      throw new AgentError(message, agentId, {
        code: 'MODEL_CALL_FAILED',
        retryable: false,
        cause: err,
      });
    }

    // The type is the discriminator: thrown only when our own patience timer fired, never for a stop
    // (the shared AbortController is told apart by `timedOutByPatience`) or an SDK failure.
    // The abort carries the other transports' identity, or recovery's honest-fail flag never sets.
    // The healer would otherwise cold-redial the same unfinishable prompt.
    // It is honest: `firstChunkTimedOut` reads `!sawAnyContent`, so trips after start stay retryable.
    if (err instanceof AgentSdkPatienceExceededError) {
      const syntheticWatchdog: StreamWatchdog = {
        signal: new AbortController().signal,
        bump: () => {},
        contentStarted: () => {},
        finish: () => {},
        timedOut: () => true,
        firstChunkTimedOut: () => !err.sawAnyContent,
        elapsedMs: () => latencyMs,
      };
      const code = streamTimeoutCode(syntheticWatchdog, patience);
      const declaredMsg = `${streamTimeoutPhrase(syntheticWatchdog, patience)}: no data from provider for too long (elapsed ${latencyMs}ms)${declaredPatienceClause(syntheticWatchdog, patience, sdkInputEstimate)}`;
      recordProviderError(modelInfo.providerId);
      logger.warn(`Agent SDK call aborted by declared patience: ${declaredMsg}`, {
        model: modelInfo.apiModelId, providerId: modelInfo.providerId, timeoutMs: err.timeoutMs,
      }, agentId);
      // Declared-patience exhaustion is never retryable; a plain idle timeout keeps its retry.
      throw new AgentError(declaredMsg, agentId, { code, retryable: code === STREAM_IDLE_TIMEOUT_CODE });
    }

    settleFailedCall('Agent SDK call', message, { model: modelInfo.apiModelId, providerId: modelInfo.providerId, latencyMs },
      { providerId: modelInfo.providerId, agentId, signal: params.abortSignal, bestEffort: params.bestEffort, facts: classifyProviderError(err) });

    // The shared recovery classifier decides rate limits for every path, 'usage limit' wording included.
    // Known drift: the direct/OpenAI catches keep their own substring sets.
    const { classifyError } = await import('./v2/recovery.js');
    const kind = classifyError(err instanceof Error ? err : new Error(message)).kind;
    const isRateLimited = kind === 'rate_limit';
    const isOverloaded = kind === 'overloaded';

    // The SDK usually throws headerless errors, so retry-after stays null and the reset falls back to 60s.
    let retryAfterSeconds: number | null = null;
    if (err instanceof Anthropic.APIError && err.headers) {
      const retryAfter = err.headers['retry-after'];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) retryAfterSeconds = parsed;
      }
    }

    // Feed the next-turn tracker as at the other sites: remaining=0, reset from retry-after else 60s.
    if (isRateLimited || isOverloaded) {
      try {
        const rlHeaders: Record<string, string> = { 'x-ratelimit-remaining': '0' };
        rlHeaders['x-ratelimit-reset'] = new Date(
          Date.now() + (retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 60000),
        ).toISOString();
        updateRateLimits(modelId, rlHeaders);
      } catch { /* best effort */ }
    }

    // Re-throw so control flow stays identical to the other transports.
    throw new AgentError(`Agent SDK call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: isRateLimited || isOverloaded,
      cause: err instanceof Error ? err : undefined,
    });
  }
}

// Provider types whose inference is genuinely free + local: exempt from the daily paid-spend
// wall BY TYPE, not by dispatch position. The set lives beside the doom guard that reads it.
const FREE_LOCAL_PROVIDER_TYPES = LOCAL_PROVIDER_TYPES;

// EVERY PROVIDER CALL AN AGENT MAKES IS ABORTABLE BY THAT AGENT'S STOP. One place dials every
// provider call, so the stop reaches all its callers: register at the stop-aware door, release by
// identity on every exit; the door REFUSES while a stop is live.
export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  const stopCtl = new AbortController();
  // The refusal is READ: pre-aborted signal doesn't stop all transports; stop early => no dial.
  if (!registerAbortable(params.agentId, stopCtl)) {
    throw new AgentError(
      'The user stopped this agent before this call could be dialled.',
      params.agentId,
      { code: 'MODEL_CALL_FAILED', retryable: false },
    );
  }
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, stopCtl.signal])
    : stopCtl.signal;
  try {
    return await dialModel({ ...params, abortSignal: signal });
  } finally {
    releaseAbortable(params.agentId, stopCtl);
  }
}

async function dialModel(params: ModelCallParams): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier, purpose } = params;

  // Sanitize orphaned pairs before dispatch: provider-side trimming makes some the assembler missed.
  sanitizeOrphanToolBlocks(messages, agentId);

  const modelInfo = getModelInfo(modelId);

  // Exit validation: ONE call above every transport branch, after every mutation.
  // Repairs in priority order and throws when nothing droppable is left; no front trimmer remains below.
  // `AssemblyValidationError` always re-throws; any other validator failure only warns and the call is sent.
  // This only watches: must not break a live turn. `laneIds` is read off the messages and self-aligns.
  try {
    await validateAtProviderBoundary({
      agentId,
      modelId,
      messages,
      systemPrompt,
      contextWindow: modelInfo.contextWindow,
      maxOutputTokens: modelInfo.maxOutputTokens,
      // A dial is charged only what it SENDS: no tool payload when toolless, and its own output
      // cap (64 for a title), not the everyday 4,096.
      dialOutputTokens: utilityBoundaryOutputTokens(purpose, modelInfo.maxOutputTokens, params.utilityTargetTokens, params.outputRoomAsk),
      toolsSent: tools !== false,
      laneIds: collectMessageLaneIds(messages),
    });
  } catch (err) {
    if (err instanceof AssemblyValidationError) throw err;
    logger.warn('ASSEMBLY_VALIDATION_INSTRUMENT_FAILED', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // The 'auto' sentinel (provider '__system__') is a router pointer, not a callable model.
  // The router resolves it before callModel, so reaching here is a caller bug: named error, not opaque one.
  if (modelInfo.providerId === '__system__') {
    throw new AgentError(
      `Model '${modelId}' is a router sentinel, not a callable model; resolve it through the router before callModel`,
      agentId,
      { code: 'SENTINEL_MODEL_DISPATCH', retryable: false },
    );
  }

  // The daily cap runs above the transport dispatch, so every paid transport is guarded identically.
  // Free local providers are exempt by type; budget_fallback recursion skips it, a re-run would loop.
  if (!FREE_LOCAL_PROVIDER_TYPES.has(modelInfo.providerType) && routerTier !== 'budget_fallback') {
    const budgetCheck = checkBudget(agentId, WALL_ESTIMATE_USD);
    if (!budgetCheck.allowed) {
      if (budgetCheck.freeModelFallback) {
        // Free models are tried until one answers; the redirect is announced once, after it has.
        return redirectToAFreeModel(params, budgetCheck, callModel);
      }

      const blockMsg = budgetCheck.reason ?? `Daily budget limit reached ($${budgetCheck.dailySpend?.toFixed(2)} spent of $${budgetCheck.dailyLimit?.toFixed(2)} limit). No free models available.`;
      throw new AgentError(blockMsg, agentId, {
        code: 'BUDGET_EXCEEDED',
        retryable: false,
      });
    }
  }

  if (modelInfo.providerType === 'ollama') {
    return callOllamaModel(params, modelInfo);
  }

  if (modelInfo.providerType === 'openai' || modelInfo.providerType === 'openai-compatible') {
    return callOpenAIModel(params, modelInfo);
  }

  const authType = getProviderAuthType(modelInfo.providerId);
  if (authType === 'agent-sdk') {
    return callAnthropicSdkModel(params, modelInfo);
  }

  // The client is built from the resolved patience: a declaration this socket cannot honour is a lie.
  const anthPatience = resolveStreamPatience(modelInfo);
  const { client, isOAuth } = getClient(modelInfo.providerId, anthPatience);

  const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // OAuth requires the system parameter as an array with this passphrase as its first block.
  const OAUTH_SYSTEM_PASSPHRASE = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
  // Prompt caching: the system prompt is a large, mostly-stable prefix, so its final block carries
  // cache_control and Anthropic reuses the prefill across turns; the OAuth passphrase block stays
  // unmarked so the breakpoint sits on the real prompt. Sub-minimum blocks ignore the marker.
  const CACHE_EPHEMERAL = { type: 'ephemeral' as const };
  const systemParam: Anthropic.TextBlockParam[] = isOAuth
    ? [
        { type: 'text' as const, text: OAUTH_SYSTEM_PASSPHRASE },
        { type: 'text' as const, text: systemPrompt, cache_control: CACHE_EPHEMERAL },
      ]
    : [{ type: 'text' as const, text: systemPrompt, cache_control: CACHE_EPHEMERAL }];
  // The stable system block above carries the breakpoint; system-side volatile content trails
  // it UNCACHED so it cannot invalidate the cached prefix. Only added if ever populated.
  if (params.systemVolatile) {
    systemParam.push({ type: 'text' as const, text: params.systemVolatile });
  }

  // Two-phase tool loading: only always-loaded + session-loaded tools are sent.
  let filteredTools: ToolDefinition[] = [];
  // Cache breakpoint: the LAST ALWAYS-LOADED tool, so a mid-session `load_tool_docs` appends
  // behind it and the cached prefix survives; `-1` = none, so it falls back to the array end.
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
  // One estimator: `estimateRequestTokens` turns characters into tokens ONCE, spending this
  // provider's two measured divisors on the two populations (prose for system/messages, dense for
  // schemas), floored so it can only grow against the asserted 4. Per-part numbers feed logs and
  // `resolveOutputBudget`.
  const toolSchemaChars = toolsJson.length;

  const messageChars = (msgs: Anthropic.MessageParam[]) =>
    msgs.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);

  // No front-trimmer here: NEVER EXCEED THE PROVIDER'S WINDOW is enforced upstream, in priority
  // order at the assembly boundary, throwing when nothing droppable is left.
  const anthropicEstimate = estimateRequestTokens(
    {
      proseChars: systemPrompt.length + messageChars(anthropicMessages),
      schemaChars: toolSchemaChars,
    },
    measuredDivisorsFor(modelInfo.providerId),
  );
  const inputEstimate = anthropicEstimate.tokens;

  // Pre-dial gate, second transport: building the client is not a dial, so this still runs
  // strictly before anything reaches a socket; byte-preserving no-op without a declared prefill rate.
  refuseIfDoomed(agentId, inputEstimate, anthPatience, modelInfo);

  // The last pairing check on the array this transport sends (a shallow re-map of `messages`):
  // layered defense, not duplication; deleting a guard because its stated reason went away is
  // exactly the forbidden inference.
  sanitizeOrphanToolBlocks(anthropicMessages as unknown as Array<{ role: string; content: unknown }>, agentId);

  // Thinking-aware floor: 1024 tokens is a guaranteed empty answer for a thinking model. The two
  // transports deliberately keep different reserves (500/1000 headroom, the 25% rule is
  // OpenAI-side only); this floor is not such a difference.
  const anthropicFloor = modelInfo.thinkingEnabled && modelInfo.capabilities.includes('thinking')
    ? THINKING_OUTPUT_FLOOR_TOKENS
    : OUTPUT_FLOOR_TOKENS;
  const anthropicAvailable = Math.max(anthropicFloor, modelInfo.contextWindow - inputEstimate - 500);
  const anthropicMaxTokens = Math.min(modelInfo.maxOutputTokens, anthropicAvailable);

  const requestParams: Anthropic.MessageCreateParams = {
    model: modelInfo.apiModelId,
    max_tokens: anthropicMaxTokens,
    system: systemParam,
    messages: anthropicMessages,
    // Tools never change turn-to-turn and come before the system block; this marker caches them up to
    // the last ALWAYS-LOADED tool, so session extras append behind it and cost only themselves.
    ...(filteredTools.length > 0 ? { tools: filteredTools.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      ...(i === (toolCacheBreakpoint >= 0 ? toolCacheBreakpoint : arr.length - 1)
        ? { cache_control: CACHE_EPHEMERAL }
        : {}),
    })) } : {}),
  };

  // The budget wall's check sits at the top of callModel, above dispatch, for every paid transport.
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

  // Provider-declared bounds from the PROVIDER row: a column that silently did nothing would be
  // a form that lies; NULL (every provider today) = the two standing constants the client uses.
  const anthWatchdog = makeStreamWatchdog(params.abortSignal, anthPatience.firstChunkMs, anthPatience.idleMs);
  try {
    // Stream idle watchdog (see makeStreamWatchdog): bounds first-token and
    // inter-event gaps; the stop button rides the combined signal unchanged.
    const requestOptions = { signal: anthWatchdog.signal };
    const stream = client.messages.stream(requestParams, requestOptions);
    // Bump on EVERY SSE event: extended thinking emits non-text events for long stretches, and
    // they prove liveness without proving generation began. `content_block_delta` is the first
    // event carrying output, so the idle bound takes over there; `message_start` and
    // `content_block_start` are ack frames and do not qualify.
    stream.on('streamEvent', (event) => {
      anthWatchdog.bump();
      if (event.type === 'content_block_delta') anthWatchdog.contentStarted();
    });

    let fullText = '';
    const toolCalls: ToolCall[] = [];

    stream.on('text', (text) => {
      anthWatchdog.bump();
      anthWatchdog.contentStarted();
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

    // Same truth check as the OpenAI seam: the SDK's post-loop guard is a dependency's promise,
    // not ours, and the two seams must never disagree on whether a stalled stream is an answer.
    if (streamWasCutByWatchdog(anthWatchdog, params.abortSignal)) {
      throw new Error(`${streamTimeoutPhrase(anthWatchdog, anthPatience)}: the stream ended on the watchdog's abort, which the SDK did not raise`);
    }
    anthWatchdog.finish();

    const latencyMs = Date.now() - startTime;
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;

    // Cache visibility: cache_read = served from cache, cache_creation = written this call.
    // Anthropic reports input_tokens DISJOINT from both, so they go to recordCost unnormalized.
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

    recordCost({
      agentId,
      modelId,
      providerId: modelInfo.providerId,
      inputTokens,
      outputTokens,
      latencyMs,
      requestType: routerTier ?? purpose ?? 'completion',
      // The purpose on its OWN axis; `requestType` above, ?? chain included, is byte-unchanged.
      callPurpose: purpose,
      cacheReadTokens,
      cacheCreationTokens,
      // The sum this transport actually sends, beside what the provider charged: this keeps the
      // estimator's divisor checkable (`memory/budget.ts`); nothing here decides a trim.
      estimatedInputTokens: inputEstimate,
      // As on the OpenAI path: the divisor this estimate was really produced by.
      estimatorCharsPerToken: anthropicEstimate.effectiveCharsPerToken,
    });

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

    recordProviderSuccess(modelInfo.providerId, { modelId, purpose });

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
    if (streamWasCutByWatchdog(anthWatchdog, params.abortSignal)) {
      recordProviderError(modelInfo.providerId);
      const code = streamTimeoutCode(anthWatchdog, anthPatience);
      const msg = `${streamTimeoutPhrase(anthWatchdog, anthPatience)}: no data from provider for too long (elapsed ${anthWatchdog.elapsedMs()}ms)${declaredPatienceClause(anthWatchdog, anthPatience, inputEstimate)}`;
      logger.warn(`Anthropic call aborted by stream watchdog: ${msg}`, {}, agentId);
      throw new AgentError(msg, agentId, { code, retryable: code === STREAM_IDLE_TIMEOUT_CODE });
    }
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

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

    // Key info goes in the message itself so the log viewer shows it: best-effort utility calls
    // log at WARN (the caller fully handles the failure); genuine agent-turn calls stay at ERROR.
    const statusStr = err instanceof Anthropic.APIError ? `[${err.status}] ` : '';
    // Provider health is tracked in the same place, and NOT for a call the caller stopped.
    settleFailedCall('Model call', `${statusStr}${message}`, errorDetail,
      { providerId: modelInfo.providerId, agentId, signal: params.abortSignal, bestEffort: params.bestEffort, facts: classifyProviderError(err) });

    // Determine if retryable: from `err.status` and the structured body, never the message's digits.
    const facts = classifyProviderError(err);
    // Out-of-credit (402, quota 429) is not a rate limit: waiting won't fix it; propagate as `quota`.
    const isRateLimited = facts.class === 'rate_limit';
    const isOverloaded = facts.class === 'overloaded';

    // Recorded in the tracker regardless of routing mode, so the next turn skips the model without a 429.
    if (isRateLimited || isOverloaded) {
      try {
        if (err instanceof Anthropic.APIError && err.headers) {
          const rlHeaders: Record<string, string> = {};
          // Set remaining to 0 so isRateLimited() returns true
          rlHeaders['x-ratelimit-remaining'] = '0';
          const retryAfter = err.headers['retry-after'];
          if (retryAfter) {
            const secs = parseInt(retryAfter, 10);
            if (!isNaN(secs)) {
              rlHeaders['x-ratelimit-reset'] = new Date(Date.now() + secs * 1000).toISOString();
            }
          } else {
            rlHeaders['x-ratelimit-reset'] = new Date(Date.now() + 60000).toISOString();
          }
          updateRateLimits(modelId, rlHeaders);
        }
      } catch { /* best effort */ }
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
    // Both caches key on `providerId:...`; a bare `delete(providerId)` would leave an edited
    // provider answered by a stale client. Prefix deletion survives any future key fragment.
    for (const key of clientCache.keys()) {
      if (key.startsWith(`${providerId}:`)) clientCache.delete(key);
    }
    for (const key of openaiClientCache.keys()) {
      if (key.startsWith(`${providerId}:`)) openaiClientCache.delete(key);
    }
  } else {
    clientCache.clear();
    openaiClientCache.clear();
  }
}

/**
 * THE WINDOW THE ENGINE BUDGETS AGAINST: the ONE door every prompt-size decision reads, so
 * capping it once reaches every builder. `getModelInfo().contextWindow` stays the ADVERTISED
 * number so the utility dial keeps working: a cap inside `getModelInfo` would make the
 * provider boundary refuse assemblies the per-call `num_ctx` widening had just enlarged.
 */
export function getContextWindow(modelId: string): number {
  if (isAutoRouteSentinel(modelId)) return routedOpeningWindow();
  try {
    const info = getModelInfo(modelId);
    return effectiveContextWindow(info.contextWindow, resolveNumCtx(info).effective);
  } catch {
    return DEFAULT_CONTEXT_WINDOW;
  }
}

// No window of zero: DEFAULT_CONTEXT_WINDOW covers "declared no usable window": NULL, ZERO,
// negative, non-finite, or an id with no row at all.
// The `'__auto__'`/`'auto'` sentinel names no model: it reads THE ROUTER WINDOW (`router/
// router-window.ts`), the one window every automatic pick runs at; the seeded 200,000 is never read.
const DEFAULT_CONTEXT_WINDOW = 200_000;

function declaredContextWindow(stored: number | null | undefined): number {
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_CONTEXT_WINDOW;
}

function isAutoRouteSentinel(modelId: string): boolean {
  return modelId === '__auto__' || modelId === 'auto';
}

/** The router window; the default when no model is on the light, standard or heavy tier. */
function routedOpeningWindow(): number {
  return routerWindowTokens() ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * The most output tokens this model can emit. `getModelInfo` is private; this is the one field
 * `memory/budget.ts` needs, the same one both transports cap `max_tokens` against, so reserve
 * and request agree by construction. `undefined` = no cap known; the reserve uses its own floor.
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

/**
 * THE ADMISSION BUDGET AND THE COMPACTION TRIGGER LEARN THE BOX: the same patience-plus-prefill
 * derivation `refuseIfDoomed` makes. `null` unless the provider declared BOTH halves (a standing
 * default patience is not a declaration); either gap alone leaves every budget number untouched.
 * Never throws, like its two siblings: a budget decision is not where to find a missing table.
 */
export function getProviderCeilingTokens(modelId: string): number | null {
  try {
    const info = getModelInfo(modelId);
    if (!doomGuardApplies(info)) return null;   // a cloud model gets its full window
    const patience = resolveStreamPatience(info);
    if (!patience.firstChunkDeclared) return null;
    return resolveDoomCeiling(patience.firstChunkMs, info.prefillTokensPerSec, info.measuredPrefillTokensPerSec);
  } catch {
    return null;
  }
}
