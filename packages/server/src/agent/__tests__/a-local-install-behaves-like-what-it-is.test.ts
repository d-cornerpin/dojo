// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T63 — A LOCAL INSTALL BEHAVES LIKE WHAT IT IS.
//
// ── THE OWNER'S ORDER (2026-08-16) ──
// "I need a 'Manual OpenAI API' provider option such that I can add an OpenAI API manually
// such as a local ds4 install."
//
// ── WHAT STEP-0 FOUND AT HEAD, PINNED BELOW BEFORE ANYTHING MOVED ──
// `contractForModel` resolved a provider by SNIFFING ITS URL: bare-host DeepSeek → the
// DeepSeek profile, `openrouter.ai` → the proxy profile, anything else → generic. A DeepSeek
// V4 served from `http://localhost:8000/v1` is "anything else", so it got:
//     requiresReasoningReplay: false · thinkingToggle: 'none' · rejects…: false
// while `answersInReasoning` came out TRUE all on its own, because that one field is keyed on
// the MODEL ID (`/deepseek/i`) rather than the endpoint. That combination is the exact wrong
// half: the empty-response ladder is told the model can answer in the hidden channel, and the
// serializer is told never to hand the reasoning back. `t63-red-*` below is that HEAD state,
// kept as the control for "no declaration → nothing moved".
//
// ── THE RULE THIS FILE IS ──
//  1. A provider may DECLARE the profile it behaves like, and the declaration OUTRANKS URL
//     sniffing — that is the whole knob, and it is the only new input.
//  2. `apiRootIsBareHost` is NOT part of the declaration. It is a fact about the URL, and
//     `getOpenAIClient` reads it straight off the base URL before any model is in hand
//     (`resolveOpenAIBaseUrl`); a contract that disagreed with the client's own base URL
//     would be a contract that lies about the request it is describing. A local DeepSeek at
//     `.../v1` keeps its `/v1`.
//  3. The declaration is observable ON THE WIRE, not just in the object: the reasoning-replay
//     serialization shape is the difference between "behaves like DeepSeek" and generic.
//  4. Every existing provider is byte-identical, because every existing row declares nothing.
//  5. An unrecognised declaration falls back to sniffing and never throws — the same
//     conservatism `contractForModelId` already promises for an unknown model.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { buildOpenAIMessages, resolveOpenAIBaseUrl, applyProviderRequestParams } from '../model.js';
import { contractForModel, contractForModelId, BEHAVES_LIKE_PROFILES } from '../model-contract.js';

/** The owner's case: DeepSeek V4 served by a local OpenAI-compatible server. */
const LOCAL_DS4 = { providerBaseUrl: 'http://localhost:8000/v1', apiModelId: 'deepseek-v4-flash' } as const;

/** One assistant turn carrying a tool call and NO stored reasoning — the `''` guard's case. */
const TOOL_CALL_TURN = [{
  role: 'assistant' as const,
  content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }] as unknown as Anthropic.ContentBlockParam[],
}];

const freshParams = (): OpenAI.ChatCompletionCreateParams =>
  ({ model: 'm', messages: [], stream: true }) as unknown as OpenAI.ChatCompletionCreateParams;

describe('T63 — what HEAD did for a local install, pinned', () => {
  it('t63-red-1: an undeclared local endpoint still resolves exactly as it did at HEAD', () => {
    expect(contractForModel(LOCAL_DS4)).toEqual({
      id: 'generic-openai-compatible',
      requiresReasoningReplay: false,
      // The one field keyed on the model id, not the endpoint. TRUE at HEAD, and it stays.
      answersInReasoning: true,
      thinkingToggle: 'none',
      rejectsSamplingParamsWhenThinking: false,
      emptyRetryBudget: 1,
      apiRootIsBareHost: false,
      systemPromptCacheMarker: 'provider-auto',
    });
  });

  it('t63-red-2: and its serialized tool-call turn carries no reasoning field at all', async () => {
    const msgs = await buildOpenAIMessages('SYS', TOOL_CALL_TURN, 'a', contractForModel(LOCAL_DS4), '');
    const assistant = msgs.find(m => m.role === 'assistant') as unknown as Record<string, unknown>;
    expect(assistant.tool_calls).toHaveLength(1);
    expect('reasoning_content' in assistant).toBe(false);
  });
});

describe('T63 — the declaration is the knob', () => {
  it('the three declarable profiles are exactly the contract profiles that exist', () => {
    expect([...BEHAVES_LIKE_PROFILES]).toEqual([
      'generic-openai-compatible',
      'deepseek-native',
      'openrouter-proxy',
    ]);
  });

  it('behaves-like-DeepSeek gives a local install the DeepSeek profile', () => {
    expect(contractForModel({ ...LOCAL_DS4, providerBehavesLike: 'deepseek-native' })).toEqual({
      id: 'deepseek-native',
      requiresReasoningReplay: true,
      answersInReasoning: true,
      thinkingToggle: 'native-thinking-param',
      rejectsSamplingParamsWhenThinking: true,
      emptyRetryBudget: 1,
      // RULE 2: the URL, not the declaration, decides where the chat endpoint sits.
      apiRootIsBareHost: false,
      systemPromptCacheMarker: 'provider-auto',
    });
  });

  it('and the client still points at the /v1 the local server actually serves', () => {
    expect(resolveOpenAIBaseUrl(LOCAL_DS4.providerBaseUrl)).toBe('http://localhost:8000/v1');
    expect(resolveOpenAIBaseUrl('http://localhost:8000')).toBe('http://localhost:8000/v1');
  });

  it('RULE 3 — the difference is visible on the wire, on the tool-call turn', async () => {
    const declared = contractForModel({ ...LOCAL_DS4, providerBehavesLike: 'deepseek-native' });
    const msgs = await buildOpenAIMessages('SYS', TOOL_CALL_TURN, 'a', declared, '');
    const assistant = msgs.find(m => m.role === 'assistant') as unknown as Record<string, unknown>;
    // The `''` 400-guard dsh's passback rule asks for, which the generic profile omits.
    expect(assistant.reasoning_content).toBe('');

    // And stored reasoning rides back verbatim on the same turn.
    const withStored = await buildOpenAIMessages('SYS', [{ ...TOOL_CALL_TURN[0], reasoningContent: 'R-LOCAL' }], 'a', declared, '');
    expect((withStored.find(m => m.role === 'assistant') as unknown as Record<string, unknown>).reasoning_content).toBe('R-LOCAL');
  });

  it('RULE 3 — and in the request knobs the profile owns', () => {
    const declared = contractForModel({ ...LOCAL_DS4, providerBehavesLike: 'deepseek-native' });
    const p = freshParams() as unknown as Record<string, unknown>;
    p.temperature = 0.7;
    applyProviderRequestParams(p as unknown as OpenAI.ChatCompletionCreateParams, declared, { supportsThinking: true, thinkingEnabled: true });
    expect(p.thinking).toEqual({ type: 'enabled' });
    expect('temperature' in p).toBe(false);

    const generic = freshParams() as unknown as Record<string, unknown>;
    generic.temperature = 0.7;
    applyProviderRequestParams(generic as unknown as OpenAI.ChatCompletionCreateParams, contractForModel(LOCAL_DS4), { supportsThinking: true, thinkingEnabled: true });
    expect('thinking' in generic).toBe(false);
    expect(generic.temperature).toBe(0.7);
  });

  it('behaves-like-OpenRouter is declarable too — a self-hosted proxy is a real shape', () => {
    const c = contractForModel({ providerBaseUrl: 'http://10.0.0.4:4000/v1', apiModelId: 'anthropic/claude-x', providerBehavesLike: 'openrouter-proxy' });
    expect(c.id).toBe('openrouter-proxy');
    expect(c.thinkingToggle).toBe('openrouter-reasoning');
    expect(c.systemPromptCacheMarker).toBe('explicit-ephemeral');
    expect(c.answersInReasoning).toBe(false);
  });

  it('a declaration OUTRANKS the URL, in both directions', () => {
    // Sniffing would say deepseek-native; the declaration says generic.
    const pinnedGeneric = contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-v4-flash', providerBehavesLike: 'generic-openai-compatible' });
    expect(pinnedGeneric.id).toBe('generic-openai-compatible');
    expect(pinnedGeneric.requiresReasoningReplay).toBe(false);
    // …and the URL fact is still the URL's to state.
    expect(pinnedGeneric.apiRootIsBareHost).toBe(true);
  });

  it('RULE 5 — an unrecognised declaration falls back to sniffing and never throws', () => {
    for (const junk of ['', '   ', 'llama.cpp', 'DROP TABLE providers', null, undefined]) {
      const c = contractForModel({ ...LOCAL_DS4, providerBehavesLike: junk as string | null | undefined });
      expect(c.id).toBe('generic-openai-compatible');
      expect(c.requiresReasoningReplay).toBe(false);
    }
    expect(contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'x', providerBehavesLike: 'nonsense' }).id).toBe('deepseek-native');
  });

  it('the declaration reaches the registry door the engine steps use', () => {
    const lookup = () => ({ providerBaseUrl: 'http://localhost:8000/v1', apiModelId: 'deepseek-v4-flash', providerBehavesLike: 'deepseek-native' });
    expect(contractForModelId(lookup, 'local-ds4').requiresReasoningReplay).toBe(true);
    expect(contractForModelId(() => null, 'local-ds4').requiresReasoningReplay).toBe(false);
  });
});

describe('T63 — RULE 4: every configured provider is byte-identical', () => {
  it('the three sniffed families answer exactly what they answered at HEAD', () => {
    expect(contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-v4-flash' })).toEqual({
      id: 'deepseek-native',
      requiresReasoningReplay: true,
      answersInReasoning: true,
      thinkingToggle: 'native-thinking-param',
      rejectsSamplingParamsWhenThinking: true,
      emptyRetryBudget: 1,
      apiRootIsBareHost: true,
      systemPromptCacheMarker: 'provider-auto',
    });

    expect(contractForModel({ providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'minimax/minimax-m2.7' })).toEqual({
      id: 'openrouter-proxy',
      requiresReasoningReplay: false,
      answersInReasoning: false,
      thinkingToggle: 'openrouter-reasoning',
      rejectsSamplingParamsWhenThinking: false,
      emptyRetryBudget: 1,
      apiRootIsBareHost: false,
      systemPromptCacheMarker: 'explicit-ephemeral',
    });

    expect(contractForModel({ providerBaseUrl: 'https://api.example.com', apiModelId: 'some-model' })).toEqual({
      id: 'generic-openai-compatible',
      requiresReasoningReplay: false,
      answersInReasoning: false,
      thinkingToggle: 'none',
      rejectsSamplingParamsWhenThinking: false,
      emptyRetryBudget: 1,
      apiRootIsBareHost: false,
      systemPromptCacheMarker: 'provider-auto',
    });

    // A DeepSeek model THROUGH the proxy keeps the one model-keyed field.
    expect(contractForModel({ providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'deepseek/deepseek-v4-flash' }).answersInReasoning).toBe(true);
    // And the bare OpenAI default (no base URL at all).
    expect(contractForModel({ providerBaseUrl: null, apiModelId: 'gpt-5-mini' }).id).toBe('generic-openai-compatible');
  });
});
