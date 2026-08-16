// ════════════════════════════════════════════════════════════════════════════════════
// HL1 — THE CONTRACT'S TWO GUARANTEES.
//
// 1. THE CONTAINMENT PROPERTY. `agent/model.ts` — the model client, and the file that
//    held eight provider-name branches on 2026-08-15 — names no provider and no model.
//    Every such check lives at the contract's own definition site. This is the guard
//    that keeps the ninth branch from landing quietly; it is the durable half of HL1.
//
// 2. EVERY FIELD IS EXERCISED, by a fictional model with a contract nothing on the box
//    has. A field nobody can move is a field nobody can trust.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { buildOpenAIMessages, resolveOpenAIBaseUrl, applyProviderRequestParams } from '../model.js';
import { contractForModel, contractForModelId, apiRootIsBareHost, type ModelContract } from '../model-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('HL1 — the capability contract is the only place a model or provider is named', () => {
  it('agent/model.ts contains no provider-name check at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'model.ts'), 'utf-8');
    // The exact shapes the eight migrated branches used: the two host substrings, and
    // the two locals they were bound to.
    for (const forbidden of ['deepseek.com', 'openrouter.ai', 'isDeepSeek', 'isOpenRouter']) {
      expect(src.includes(forbidden), `model.ts must not contain "${forbidden}"`).toBe(false);
    }
  });

  it('the contract module is where they went', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'model-contract.ts'), 'utf-8');
    expect(src).toContain('api.deepseek.com');
    expect(src).toContain('openrouter.ai');
  });

  it('seeds the configured families from what the dispatcher did before the migration', () => {
    const flash = contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-v4-flash' });
    expect(flash).toEqual({
      id: 'deepseek-native',
      requiresReasoningReplay: true,
      answersInReasoning: true,
      thinkingToggle: 'native-thinking-param',
      rejectsSamplingParamsWhenThinking: true,
      emptyRetryBudget: 1,
      apiRootIsBareHost: true,
      systemPromptCacheMarker: 'provider-auto',
    });

    const proxied = contractForModel({ providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'minimax/minimax-m2.7' });
    expect(proxied.requiresReasoningReplay).toBe(false);
    expect(proxied.thinkingToggle).toBe('openrouter-reasoning');
    expect(proxied.systemPromptCacheMarker).toBe('explicit-ephemeral');
    expect(proxied.answersInReasoning).toBe(false);

    // A DeepSeek model reached THROUGH the proxy is still a DeepSeek model for the one
    // field that is a claim about the MODEL rather than about the endpoint.
    const proxiedFlash = contractForModel({ providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'deepseek/deepseek-v4-flash' });
    expect(proxiedFlash.answersInReasoning).toBe(true);
    expect(proxiedFlash.requiresReasoningReplay).toBe(false); // unchanged from HEAD

    const generic = contractForModel({ providerBaseUrl: 'https://api.example.com', apiModelId: 'some-model' });
    expect(generic.id).toBe('generic-openai-compatible');
    expect(generic.thinkingToggle).toBe('none');
    expect(generic.apiRootIsBareHost).toBe(false);
  });

  it('never throws and answers conservatively for an unknown model', () => {
    expect(contractForModelId(() => null, 'nope').id).toBe('generic-openai-compatible');
    expect(contractForModelId(() => { throw new Error('db down'); }, 'x').requiresReasoningReplay).toBe(false);
    expect(contractForModelId(() => ({ providerBaseUrl: 'https://api.deepseek.com' }), null).answersInReasoning).toBe(false);
    expect(apiRootIsBareHost('not a url at all')).toBe(false);
    expect(apiRootIsBareHost(null)).toBe(false);
  });
});

// ── The fictional model: a contract no configured model has, so each field must move ──

const FICTIONAL: ModelContract = {
  id: 'fictional-test-model',
  requiresReasoningReplay: true,
  answersInReasoning: true,
  thinkingToggle: 'native-thinking-param',
  rejectsSamplingParamsWhenThinking: true,
  emptyRetryBudget: 3,
  apiRootIsBareHost: true,
  systemPromptCacheMarker: 'explicit-ephemeral',
};

const NOTHING: ModelContract = {
  ...FICTIONAL,
  id: 'fictional-flat-model',
  requiresReasoningReplay: false,
  answersInReasoning: false,
  thinkingToggle: 'none',
  rejectsSamplingParamsWhenThinking: false,
  emptyRetryBudget: 0,
  apiRootIsBareHost: false,
  systemPromptCacheMarker: 'provider-auto',
};

const TOOL_CALL_MSG = {
  role: 'assistant' as const,
  content: [{ type: 'tool_use', id: 'c1', name: 'noop', input: {} }] as unknown as Anthropic.ContentBlockParam[],
};

const freshParams = (): OpenAI.ChatCompletionCreateParams =>
  ({ model: 'm', messages: [], stream: true }) as unknown as OpenAI.ChatCompletionCreateParams;

describe('HL1 — every declared field moves the request', () => {
  it('systemPromptCacheMarker decides the system message shape', async () => {
    const marked = await buildOpenAIMessages('SYS', [], 'a', FICTIONAL, '');
    expect(marked[0].content).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    const plain = await buildOpenAIMessages('SYS', [], 'a', NOTHING, '');
    expect(plain[0].content).toBe('SYS');
  });

  it('requiresReasoningReplay decides the empty-string fallback', async () => {
    const withReplay = await buildOpenAIMessages('SYS', [TOOL_CALL_MSG], 'a', FICTIONAL, '');
    expect((withReplay[1] as unknown as Record<string, unknown>).reasoning_content).toBe('');
    const without = await buildOpenAIMessages('SYS', [TOOL_CALL_MSG], 'a', NOTHING, '');
    expect('reasoning_content' in (without[1] as object)).toBe(false);
  });

  it('thinkingToggle picks the wire mechanism', () => {
    const native = freshParams();
    applyProviderRequestParams(native, FICTIONAL, { supportsThinking: true, thinkingEnabled: true });
    expect((native as unknown as Record<string, unknown>).thinking).toEqual({ type: 'enabled' });
    expect((native as unknown as Record<string, unknown>).extra_body).toBeUndefined();

    const proxy = freshParams();
    applyProviderRequestParams(proxy, { ...FICTIONAL, thinkingToggle: 'openrouter-reasoning' }, { supportsThinking: true, thinkingEnabled: false });
    expect((proxy as unknown as Record<string, unknown>).extra_body).toEqual({ reasoning: { enabled: false } });
    expect((proxy as unknown as Record<string, unknown>).thinking).toBeUndefined();

    const none = freshParams();
    applyProviderRequestParams(none, NOTHING, { supportsThinking: true, thinkingEnabled: true });
    expect(Object.keys(none as unknown as Record<string, unknown>).sort()).toEqual(['messages', 'model', 'stream']);
  });

  it('rejectsSamplingParamsWhenThinking strips temperature and top_p, and only while thinking', () => {
    const thinking = freshParams() as unknown as Record<string, unknown>;
    thinking.temperature = 0.7;
    thinking.top_p = 0.9;
    applyProviderRequestParams(thinking as unknown as OpenAI.ChatCompletionCreateParams, FICTIONAL, { supportsThinking: true, thinkingEnabled: true });
    expect('temperature' in thinking).toBe(false);
    expect('top_p' in thinking).toBe(false);

    const notThinking = freshParams() as unknown as Record<string, unknown>;
    notThinking.temperature = 0.7;
    applyProviderRequestParams(notThinking as unknown as OpenAI.ChatCompletionCreateParams, FICTIONAL, { supportsThinking: true, thinkingEnabled: false });
    expect(notThinking.temperature).toBe(0.7);

    const permissive = freshParams() as unknown as Record<string, unknown>;
    permissive.temperature = 0.7;
    applyProviderRequestParams(permissive as unknown as OpenAI.ChatCompletionCreateParams, { ...NOTHING, thinkingToggle: 'native-thinking-param' }, { supportsThinking: true, thinkingEnabled: true });
    expect(permissive.temperature).toBe(0.7);
  });

  it('apiRootIsBareHost decides whether /v1 is appended', () => {
    expect(resolveOpenAIBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(resolveOpenAIBaseUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1');
    expect(resolveOpenAIBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(resolveOpenAIBaseUrl(null)).toBeUndefined();
  });

  // `emptyRetryBudget` is exercised by the empty-response ladder's own suite (HL2).

  // T58 (owner ruling 12) — the one field that was DECLARED AND UNREAD is gone. HL1 shipped
  // `supportsParallelToolCalls` flagged rather than hidden; the ruling was "clean up after
  // doubly confirming unneeded", the confirmation came back with no reader in either tree,
  // and the field was removed. This is the tombstone: the contract may not grow the field
  // back without a reader arriving in the same change.
  it('declares no field without a reader — the removed one stays removed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'model-contract.ts'), 'utf-8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('supportsParallelToolCalls');
    // The table above the code is where the removal is argued, so the tombstone must say so.
    expect(src).toContain('TOMBSTONE: `supportsParallelToolCalls`, REMOVED');
    // Every field the interface still declares is one the tests above move end-to-end.
    const iface = src.slice(src.indexOf('export interface ModelContract'), src.indexOf('// ── THE DEFINITION SITE'));
    for (const field of ['requiresReasoningReplay', 'answersInReasoning', 'thinkingToggle',
      'rejectsSamplingParamsWhenThinking', 'emptyRetryBudget', 'apiRootIsBareHost',
      'systemPromptCacheMarker']) {
      expect(iface, `${field} must still be declared`).toContain(field);
    }
  });
});
