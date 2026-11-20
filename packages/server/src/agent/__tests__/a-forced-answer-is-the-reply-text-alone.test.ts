// A forced answer is the reply's words alone: read from the call or from the call written as text, with any other
// call beside it dropped; a provider that ignored the choice keeps its ordinary answer whole.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', async () => (await import('./fixtures/provider-wire.js')).fakeAnthropicModule());
vi.mock('../../providers/anthropic-sdk.js', async () => (await import('./fixtures/provider-wire.js')).fakeSdkModule());
vi.mock('../tools/surface.js', async () => (await import('./fixtures/provider-wire.js')).surfaceModule());
vi.mock('../../db/connection.js', async () => (await import('./fixtures/provider-wire.js')).connectionModule());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { useProviderWire, callOn, wire } from './fixtures/provider-wire.js';

useProviderWire({ beforeAll, afterAll, beforeEach, afterEach });

describe('a forced answer is the reply text alone', () => {
  it('the reply call becomes the trimmed text, and a call beside it is dropped', async () => {
    wire.replies.push({ toolCalls: [{ name: 'reply', args: '{"text":"  It means hello.  "}' }, { name: 'file_read', args: '{"arg":"/y"}' }] });
    const r = await callOn('compatible', true);
    expect(r.content).toBe('It means hello.');
    expect(r.toolCalls).toEqual([]);
  });

  it('a reply call the model wrote as text is read as the reply, never sent raw', async () => {
    wire.replies.push({ text: '<tool_call><name>reply</name><arguments>{"text": "It means hello."}</arguments></tool_call>' });
    const r = await callOn('compatible', true);
    expect(r.content).toBe('It means hello.');
    expect(r.toolCalls).toEqual([]);
  });

  it('a provider that ignored the choice keeps its ordinary answer whole', async () => {
    wire.replies.push({ toolCall: { name: 'file_read', args: '{"arg":"/y"}' } });
    const r = await callOn('compatible', true);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['file_read']);
  });
});
