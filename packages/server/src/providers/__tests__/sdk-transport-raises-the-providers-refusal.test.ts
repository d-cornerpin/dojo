// 9603 — a refusal the SDK delivers as an assistant message (top-level `error`) is a failure,
// not the agent's reply. Fake data only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Msg = Record<string, unknown>;
const stream = { messages: [] as Msg[] };
const script = globalThis as { __scriptedAgentSdk?: unknown };

import { callAnthropicViaSdk } from '../anthropic-sdk.js';
import { classifyProviderErrorText } from '../../agent/provider-error.js';

const assistant = (text: string, top: Record<string, unknown> = {}): Msg => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } },
  ...top,
});

const run = (onChunk?: (t: string) => void) => callAnthropicViaSdk({
  agentId: 'a1', apiModelId: 'claude-sonnet-4-5', systemPrompt: 's',
  messages: [{ role: 'user', content: 'go' }], onChunk,
} as never);

const thrown = async (onChunk?: (t: string) => void): Promise<string> => {
  try { await run(onChunk); } catch (e) { return (e as Error).message; }
  throw new Error('expected a rejection');
};

beforeEach(() => {
  stream.messages = [];
  script.__scriptedAgentSdk = { query: () => (async function* () { for (const m of stream.messages) yield m; })() };
});
afterEach(() => { script.__scriptedAgentSdk = undefined; });

describe('9603 — the SDK transport raises the provider\'s refusal', () => {
  it('billing_error rejects, is not streamed, and classifies as quota', async () => {
    stream.messages = [assistant('Credit balance is too low', { error: 'billing_error' })];
    const onChunk = vi.fn();
    const msg = await thrown(onChunk);
    expect(msg).toMatch(/insufficient balance/);
    expect(onChunk).not.toHaveBeenCalled();
    expect(classifyProviderErrorText(msg).class).toBe('quota');
  });
  it('rate_limit rejects and classifies as rate_limit', async () => {
    stream.messages = [assistant("You've hit your limit", { error: 'rate_limit' })];
    const msg = await thrown();
    expect(msg).toMatch(/rate_limit/);
    expect(classifyProviderErrorText(msg).class).toBe('rate_limit');
  });
  it('authentication_failed classifies as auth', async () => {
    stream.messages = [assistant('Invalid API key', { error: 'authentication_failed' })];
    expect(classifyProviderErrorText(await thrown()).class).toBe('auth');
  });
  it('server_error and invalid_request land on server and bad_request', async () => {
    stream.messages = [assistant('oops', { error: 'server_error' })];
    expect(classifyProviderErrorText(await thrown()).class).toBe('server');
    stream.messages = [assistant('oops', { error: 'invalid_request' })];
    expect(classifyProviderErrorText(await thrown()).class).toBe('bad_request');
  });
  it('a normal assistant message still returns its text', async () => {
    stream.messages = [assistant('All done.')];
    expect((await run()).content).toBe('All done.');
  });
  it('max_output_tokens with partial text still returns the text', async () => {
    stream.messages = [assistant('half an ans', { error: 'max_output_tokens' }), { type: 'result', subtype: 'success', stop_reason: 'max_tokens' }];
    const r = await run();
    expect(r.content).toBe('half an ans');
    expect(r.stopReason).toBe('max_tokens');
  });
  it('an error result with no text rejects; after normal text it does not', async () => {
    stream.messages = [{ type: 'result', subtype: 'error_during_execution', is_error: true }];
    expect(await thrown()).toMatch(/Agent SDK ended with an error/);
    stream.messages = [assistant('fine'), { type: 'result', subtype: 'error_during_execution', is_error: true }];
    expect((await run()).content).toBe('fine');
  });
});
