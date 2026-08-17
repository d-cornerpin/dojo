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
// | apiRootIsBareHost                 | is the chat endpoint at the bare host, with no `/v1` segment?  | model.ts     |
// | systemPromptCacheMarker           | does the provider auto-cache a stable string system prefix, or | model.ts     |
// |                                   | does it need the explicit `cache_control` block form?          |              |
//
// ── T63 (2026-08-16): A PROVIDER MAY DECLARE THE PROFILE IT BEHAVES LIKE ──
// Every branch below used to be reached by SNIFFING the base URL, which works only while the
// dialect and the hostname are the same fact. They are not the same fact for a LOCAL install:
// the owner runs DeepSeek V4 behind an ollama / vLLM / LM-Studio-style OpenAI-compatible
// server at `http://localhost:8000/v1`, and that URL cannot tell anyone what the thing behind
// it wants. So `providers.behaves_like` (migration 162) carries the owner's own answer, and a
// DECLARED profile outranks sniffing. Two properties hold the honesty of that knob:
//
//   • THE DECLARATION NAMES A PROFILE THAT ALREADY EXISTS. `BEHAVES_LIKE_PROFILES` is the
//     contract-id list below and nothing else — the knob selects among shapes this file
//     already ships, it never composes a new one. An unrecognised value is "not declared",
//     the same conservatism `contractForModelId` promises for an unknown model.
//
//   • `apiRootIsBareHost` IS NOT DECLARABLE. It is a fact about the URL, read straight off
//     the base URL by `getOpenAIClient`/`resolveOpenAIBaseUrl` BEFORE any model is in hand.
//     A contract that answered it from a declaration could disagree with the base URL the
//     SDK was actually pointed at — a contract lying about the request it describes. It is
//     computed from the URL on every path, declared or sniffed, and that is the same value
//     all three branches produced before T63, which is why no seed moves.
//
// ── TOMBSTONE: `supportsParallelToolCalls`, REMOVED 2026-08-16 (T58, owner ruling 12) ──
// HL1's initial set named it and it landed DECLARED AND UNREAD: the dispatcher had no
// branch for it to absorb, so it was a declaration rather than a relocation, flagged in
// this header and handed up. The owner ruled "clean up after doubly confirming unneeded".
// Confirmed: no reader in either tree (grep across `dojo/` and `dojo-test-kit/`; the only
// mentions were this table, the seed below, and test fixtures repeating the seed), so the
// field, its seed and its fixtures are gone. Every field in the table above now has a
// named reader — that is the invariant the table exists to hold, and
// `__tests__/one-place-a-model-is-named.test.ts` pins the tombstone.
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
  apiRootIsBareHost: false,
  systemPromptCacheMarker: 'provider-auto',
};

/**
 * The profiles a provider may DECLARE it behaves like (T63) — the contract ids above, and
 * nothing else. The order is the order the owner's picker offers them: the default first.
 *
 * This list is the door's validator too (`config/schema.ts`'s `CreateProviderSchema`), so the
 * set of storable declarations and the set of resolvable ones cannot drift apart.
 */
export const BEHAVES_LIKE_PROFILES = [
  'generic-openai-compatible',
  'deepseek-native',
  'openrouter-proxy',
] as const;

export type BehavesLikeProfile = typeof BEHAVES_LIKE_PROFILES[number];

/** A stored declaration, or `null` when there is none / it names nothing this file ships. */
function declaredProfile(value: string | null | undefined): BehavesLikeProfile | null {
  const v = (value ?? '').trim();
  return (BEHAVES_LIKE_PROFILES as readonly string[]).includes(v) ? v as BehavesLikeProfile : null;
}

/**
 * One profile, resolved.
 *
 * The two inputs are the facts a profile is NOT allowed to invent:
 *   • `apiRootIsBareHost` — the URL's own answer (see the header's second property);
 *   • `answersInReasoningByModelId` — the `/deepseek/i` claim about the MODEL, which the
 *     proxy and generic profiles carry through and which `deepseek-native` overrides to
 *     `true` because on DeepSeek's own dialect every model answers that way.
 *
 * Each arm is byte-for-byte the object the corresponding branch returned before T63.
 */
function profileContract(
  profile: BehavesLikeProfile,
  facts: { apiRootIsBareHost: boolean; answersInReasoningByModelId: boolean },
): ModelContract {
  switch (profile) {
    case 'deepseek-native':
      // DeepSeek's own dialect. Every field here is what `agent/model.ts` did on 2026-08-15.
      return {
        ...BASE_CONTRACT,
        id: 'deepseek-native',
        requiresReasoningReplay: true,
        answersInReasoning: true,
        thinkingToggle: 'native-thinking-param',
        // Their docs: temperature / top_p are rejected while thinking is enabled. The
        // dispatcher asserted this in a comment and sent neither; now it is enforced.
        rejectsSamplingParamsWhenThinking: true,
        apiRootIsBareHost: facts.apiRootIsBareHost,
      };
    case 'openrouter-proxy':
      return {
        ...BASE_CONTRACT,
        id: 'openrouter-proxy',
        // A DeepSeek model reached THROUGH OpenRouter is still a DeepSeek model, and the
        // stream loop already captures its reasoning off the unified `reasoning` field.
        answersInReasoning: facts.answersInReasoningByModelId,
        thinkingToggle: 'openrouter-reasoning',
        systemPromptCacheMarker: 'explicit-ephemeral',
        apiRootIsBareHost: facts.apiRootIsBareHost,
      };
    case 'generic-openai-compatible':
      return {
        ...BASE_CONTRACT,
        answersInReasoning: facts.answersInReasoningByModelId,
        apiRootIsBareHost: facts.apiRootIsBareHost,
      };
  }
}

/**
 * The contract for one configured model.
 *
 * Takes exactly the `getModelInfo` fields the seeds are keyed on. `thinkingEnabled`
 * and `capabilities` are NOT contract inputs: they are per-model settings the owner flips
 * on the Models page, read at call time by the appliers, and folding a live setting into
 * a contract would make the contract lie about the next call.
 *
 * T63 adds a third input, `providerBehavesLike` — the provider's own declaration, which is a
 * setting the owner makes ONCE about the endpoint, not a live per-call flag, and which is
 * exactly as static as the base URL it outranks.
 */
export function contractForModel(modelInfo: {
  providerBaseUrl?: string | null;
  apiModelId?: string | null;
  providerBehavesLike?: string | null;
}): ModelContract {
  const baseUrl = modelInfo.providerBaseUrl ?? null;
  const apiModelId = modelInfo.apiModelId ?? '';
  const facts = {
    apiRootIsBareHost: apiRootIsBareHost(baseUrl),
    answersInReasoningByModelId: ANSWERS_IN_REASONING_MODELS.test(apiModelId),
  };

  // T63: the owner's declaration first. A local install's URL is not evidence of anything.
  const declared = declaredProfile(modelInfo.providerBehavesLike);
  if (declared) return profileContract(declared, facts);

  // No declaration: the pre-T63 URL sniffing, in its original order.
  if (facts.apiRootIsBareHost) return profileContract('deepseek-native', facts);
  if ((baseUrl ?? '').toLowerCase().includes(OPENROUTER_MARKER)) return profileContract('openrouter-proxy', facts);
  return profileContract('generic-openai-compatible', facts);
}

/**
 * The contract for a model id, read through the registry.
 *
 * The engine's steps hold a `modelId` string, not a `modelInfo` row. This is the door
 * they use; it never throws, and an unknown model gets the base contract, which is the
 * conservative answer (no replay, no wrong-channel branch, no toggle).
 */
export function contractForModelId(
  lookup: (modelId: string) => {
    providerBaseUrl?: string | null;
    apiModelId?: string | null;
    providerBehavesLike?: string | null;
  } | null,
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
