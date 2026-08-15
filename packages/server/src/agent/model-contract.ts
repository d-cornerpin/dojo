// ════════════════════════════════════════════════════════════════════════════════════
// HL1 — THE MODEL CAPABILITY CONTRACT. THE ONE PLACE A PROVIDER IS NAMED.
//
// THE PROBLEM, in the owner's words (2026-08-15): *we tailor everything to a floor model
// while needing it to work on frontier models.* DeepSeek's own harness keeps every
// DeepSeek quirk inside one adapter (`packages/llm/llm-deepseek`) and its core never
// mentions a model name; this repo had EIGHT `isDeepSeek`/deepseek branches scattered
// through `agent/model.ts` alone, so "does the engine do this because the model needs it,
// or because we tuned it to Flash" was unanswerable without reading the dispatcher.
//
// THE SHAPE: one declared contract per model, consulted by the engine and the model
// client. Provider- and model-NAME checks survive ONLY in this file — that is the whole
// property, and `__tests__/the-contract-is-the-only-place-a-provider-is-named.test.ts`
// enforces it against `agent/model.ts`.
//
// THIS FILE IS A RELOCATION, NOT A BEHAVIOUR CHANGE. Every field below is seeded from
// what the dispatcher already did on 2026-08-15, and the request-shape golden
// (`__tests__/__goldens__/request-shape-per-configured-model.json`, recorded from the
// pre-migration code in the commit before this one) is the proof: it does not move by
// one byte across the migration.
//
// ── THE FIELD TABLE. ONE DOC-LINE PER FIELD IS THE PRICE OF ADDING ONE. ──
//
// | field                             | what it answers                                              | who reads it |
// |-----------------------------------|--------------------------------------------------------------|--------------|
// | requiresReasoningReplay           | must this model be handed its own `reasoning_content` back    | model.ts     |
// |                                   | on tool-call turns, with `''` when we have none?              |              |
// | answersInReasoning                | can this model put its WHOLE answer in the hidden reasoning    | the empty-   |
// |                                   | channel and return empty visible content? (dsh, verified)      | response     |
// |                                   |                                                                | ladder (HL2) |
// | thinkingToggle                     | which wire mechanism turns thinking on/off for this model      | model.ts     |
// | rejectsSamplingParamsWhenThinking | does this model 400 on temperature/top_p while thinking?       | model.ts     |
// | emptyRetryBudget                  | how many SILENT re-runs the empty-response ladder may spend    | the empty-   |
// |                                   | before it nudges                                               | response     |
// |                                   |                                                                | ladder       |
// | supportsParallelToolCalls         | may a single assistant turn carry more than one tool call?     | NOBODY YET   |
// |                                   | **Declared, not consulted at HEAD** — there is no branch in    | (declared    |
// |                                   | the dispatcher to absorb, so this is the one field that is a   |  only, see   |
// |                                   | declaration rather than a relocation. Its future reader is     |  the note    |
// |                                   | `runtime.ts`'s `enforceModelCapabilities`. Flagged, not hidden.|  below)      |
// | apiRootIsBareHost                 | is the chat endpoint at the bare host, with no `/v1` segment?  | model.ts     |
// | systemPromptCacheMarker           | does the provider auto-cache a stable string system prefix, or | model.ts     |
// |                                   | does it need the explicit `cache_control` block form?          |              |
//
// ⚠ `supportsParallelToolCalls` IS THE ONE UNREAD FIELD AND IT IS SAID OUT LOUD. The
// plan named it in HL1's initial set; the dispatcher has no branch for it. It is seeded
// from today's universal behaviour (every configured model may batch) so that when a
// reader arrives it inherits a truthful value rather than a guess, and it is handed up
// rather than quietly counted as a migrated branch.
// ════════════════════════════════════════════════════════════════════════════════════

/** How thinking is turned on and off on the wire, for models that have a toggle. */
export type ThinkingToggle =
  /** No toggle exists or none is sent. The request is left alone. */
  | 'none'
  /** Top-level `thinking: { type: 'enabled' | 'disabled' }` (DeepSeek's native form). */
  | 'native-thinking-param'
  /** OpenRouter's unified `extra_body.reasoning: { enabled }`, translated per backend. */
  | 'openrouter-reasoning';

/** How the provider wants a cacheable system prefix marked. */
export type SystemPromptCacheMarker =
  /** The provider auto-caches a stable plain-string system prefix. Send a bare string. */
  | 'provider-auto'
  /** A proxy that needs the explicit `cache_control: { type: 'ephemeral' }` block form. */
  | 'explicit-ephemeral';

/** What the engine and the model client are allowed to know about a model. */
export interface ModelContract {
  /** A name for logs and tests. Never branched on. */
  readonly id: string;
  readonly requiresReasoningReplay: boolean;
  readonly answersInReasoning: boolean;
  readonly thinkingToggle: ThinkingToggle;
  readonly rejectsSamplingParamsWhenThinking: boolean;
  readonly emptyRetryBudget: number;
  readonly supportsParallelToolCalls: boolean;
  readonly apiRootIsBareHost: boolean;
  readonly systemPromptCacheMarker: SystemPromptCacheMarker;
}

// ── THE DEFINITION SITE. EVERY PROVIDER AND MODEL NAME IN THE ENGINE IS BELOW THIS LINE. ──

/**
 * Hosts whose API is rooted at the bare domain (no `/v1` segment). The OpenAI SDK calls
 * paths like `/chat/completions` directly off the configured baseURL, so for these hosts
 * we DON'T append `/v1`. DeepSeek is the canonical example: their docs put the chat
 * endpoint at https://api.deepseek.com/chat/completions, not /v1/chat/completions.
 */
const DEEPSEEK_HOSTS = ['api.deepseek.com', 'deepseek.com'];

/** OpenRouter is a proxy, detected by base URL exactly as the dispatcher did. */
const OPENROUTER_MARKER = 'openrouter.ai';

/** The model family dsh documents as able to answer entirely in the reasoning channel. */
const ANSWERS_IN_REASONING_MODELS = /deepseek/i;

function hostMatches(baseUrl: string | null | undefined, hosts: string[]): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

/**
 * `true` when the provider's chat endpoint sits at the bare host.
 *
 * Exported because `getOpenAIClient` resolves a base URL BEFORE any model is in hand
 * (it is keyed on provider + base URL and cached), so this one predicate is consulted
 * directly rather than through a contract instance. It is the same fact
 * `ModelContract.apiRootIsBareHost` carries, from the same list, at the same site.
 */
export function apiRootIsBareHost(baseUrl: string | null | undefined): boolean {
  return hostMatches(baseUrl, DEEPSEEK_HOSTS);
}

/** The fields every model gets unless its own family overrides them. */
const BASE_CONTRACT: ModelContract = {
  id: 'generic-openai-compatible',
  // Nothing outside DeepSeek's own API required a reasoning passback at HEAD.
  requiresReasoningReplay: false,
  answersInReasoning: false,
  thinkingToggle: 'none',
  rejectsSamplingParamsWhenThinking: false,
  // The ladder's silent-retry rung has been bounded at exactly one re-run since it was
  // written (`empty-response.ts`, `state.retriedEmptyResponse`). Seeded from that.
  emptyRetryBudget: 1,
  // Declared, not consulted — see the header. Every configured model may batch today.
  supportsParallelToolCalls: true,
  apiRootIsBareHost: false,
  systemPromptCacheMarker: 'provider-auto',
};

/**
 * The contract for one configured model.
 *
 * Takes exactly the two `getModelInfo` fields the seeds are keyed on. `thinkingEnabled`
 * and `capabilities` are NOT contract inputs: they are per-model settings the owner flips
 * on the Models page, read at call time by the appliers, and folding a live setting into
 * a contract would make the contract lie about the next call.
 */
export function contractForModel(modelInfo: {
  providerBaseUrl?: string | null;
  apiModelId?: string | null;
}): ModelContract {
  const baseUrl = modelInfo.providerBaseUrl ?? null;
  const apiModelId = modelInfo.apiModelId ?? '';
  const answersInReasoning = ANSWERS_IN_REASONING_MODELS.test(apiModelId);

  if (apiRootIsBareHost(baseUrl)) {
    // DeepSeek's own API. Every field here is what `agent/model.ts` did on 2026-08-15.
    return {
      ...BASE_CONTRACT,
      id: 'deepseek-native',
      requiresReasoningReplay: true,
      answersInReasoning: true,
      thinkingToggle: 'native-thinking-param',
      // Their docs: temperature / top_p are rejected while thinking is enabled. The
      // dispatcher asserted this in a comment and sent neither; now it is enforced.
      rejectsSamplingParamsWhenThinking: true,
      apiRootIsBareHost: true,
    };
  }

  if ((baseUrl ?? '').toLowerCase().includes(OPENROUTER_MARKER)) {
    return {
      ...BASE_CONTRACT,
      id: 'openrouter-proxy',
      // A DeepSeek model reached THROUGH OpenRouter is still a DeepSeek model, and the
      // stream loop already captures its reasoning off the unified `reasoning` field.
      answersInReasoning,
      thinkingToggle: 'openrouter-reasoning',
      systemPromptCacheMarker: 'explicit-ephemeral',
    };
  }

  return { ...BASE_CONTRACT, answersInReasoning };
}

/**
 * The contract for a model id, read through the registry.
 *
 * The engine's steps hold a `modelId` string, not a `modelInfo` row. This is the door
 * they use; it never throws, and an unknown model gets the base contract, which is the
 * conservative answer (no replay, no wrong-channel branch, no toggle).
 */
export function contractForModelId(
  lookup: (modelId: string) => { providerBaseUrl?: string | null; apiModelId?: string | null } | null,
  modelId: string | null | undefined,
): ModelContract {
  if (!modelId) return BASE_CONTRACT;
  try {
    const info = lookup(modelId);
    return info ? contractForModel(info) : BASE_CONTRACT;
  } catch {
    return BASE_CONTRACT;
  }
}
