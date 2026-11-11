// The model capability contract: the ONLY place a provider or model NAME is checked.
// The engine asks the declared contract instead; a test pins that `agent/model.ts` names nothing.
import type { ThinkingLevel } from '@dojo/shared';


export type ThinkingToggle =
  | 'none'
  | 'native-thinking-param'
  | 'openrouter-reasoning';

export type SystemPromptCacheMarker =
  | 'provider-auto'
  /** A proxy that needs the explicit `cache_control: { type: 'ephemeral' }` block form. */
  | 'explicit-ephemeral';

export interface ModelContract {
  /** A name for logs and tests. Never branched on. */
  readonly id: string;
  readonly requiresReasoningReplay: boolean;
  readonly answersInReasoning: boolean;
  readonly thinkingToggle: ThinkingToggle;
  readonly rejectsSamplingParamsWhenThinking: boolean;
  /** The `reasoning_effort` values this wire accepts. Empty means the parameter is never sent. */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** The most output tokens one call may be asked for on escalation; null: stay inside the stored cap. */
  readonly outputEscalationCeiling: number | null;
  readonly emptyRetryBudget: number;
  readonly apiRootIsBareHost: boolean;
  readonly systemPromptCacheMarker: SystemPromptCacheMarker;
}


/** Hosts whose chat endpoint sits at the bare domain, no version path appended: the SDK
 *  calls `/chat/completions` off the baseURL as-is, so nothing goes before that path. */
const DEEPSEEK_HOSTS = ['api.deepseek.com', 'deepseek.com'];

const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000;

const OPENROUTER_MARKER = 'openrouter.ai';

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

/** Bare-host answer, exported because base-URL resolution happens before any model is in hand. */
export function apiRootIsBareHost(baseUrl: string | null | undefined): boolean {
  return hostMatches(baseUrl, DEEPSEEK_HOSTS);
}

const BASE_CONTRACT: ModelContract = {
  id: 'generic-openai-compatible',
  // Only DeepSeek's own API needs reasoning replay; nothing else ever asked for it.
  requiresReasoningReplay: false,
  answersInReasoning: false,
  thinkingToggle: 'none',
  rejectsSamplingParamsWhenThinking: false,
  thinkingLevels: [],
  outputEscalationCeiling: null,
  // Matches the ladder's own bound: `empty-response.ts` allows exactly one silent re-run.
  emptyRetryBudget: 1,
  apiRootIsBareHost: false,
  systemPromptCacheMarker: 'provider-auto',
};

/** The profiles a provider may DECLARE it behaves like: the contract ids below, nothing else.
 *  The settings door validates this same list (`config/schema.ts`), so stored and resolvable match. */
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

/** One profile, resolved. The two inputs are facts a profile may NOT invent: the URL's own
 *  bare-host answer, and the model-id `deepseek` claim (`deepseek-native` overrides that). */
function profileContract(
  profile: BehavesLikeProfile,
  facts: { apiRootIsBareHost: boolean; answersInReasoningByModelId: boolean },
): ModelContract {
  switch (profile) {
    case 'deepseek-native':
      return {
        ...BASE_CONTRACT,
        id: 'deepseek-native',
        requiresReasoningReplay: true,
        answersInReasoning: true,
        thinkingToggle: 'native-thinking-param',
        // Their docs: temperature / top_p are rejected while thinking is enabled.
        rejectsSamplingParamsWhenThinking: true,
        thinkingLevels: ['low', 'high', 'max'],
        // Their pricing page: up to 384K output tokens for the V4 models. This is the room a
        // cut-off call may be given, NOT the everyday budget.
        outputEscalationCeiling: DEEPSEEK_MAX_OUTPUT_TOKENS,
        apiRootIsBareHost: facts.apiRootIsBareHost,
      };
    case 'openrouter-proxy':
      return {
        ...BASE_CONTRACT,
        id: 'openrouter-proxy',
        // A DeepSeek model reached THROUGH OpenRouter is still a DeepSeek model.
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

/** `thinkingEnabled` and `capabilities` are NOT contract inputs: live settings would make it lie. */
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

  // The owner's declaration comes first: a local install's URL is not evidence of anything.
  const declared = declaredProfile(modelInfo.providerBehavesLike);
  if (declared) return profileContract(declared, facts);

  if (facts.apiRootIsBareHost) return profileContract('deepseek-native', facts);
  if ((baseUrl ?? '').toLowerCase().includes(OPENROUTER_MARKER)) return profileContract('openrouter-proxy', facts);
  return profileContract('generic-openai-compatible', facts);
}

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
