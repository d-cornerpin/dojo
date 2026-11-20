// A provider that refuses the forced form (a bad request, 400 or 422) gets exactly one ordinary call; a refusal
// for money, for a too-long context, or any other failure is not tried again.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', async () => (await import('./fixtures/provider-wire.js')).fakeAnthropicModule());
vi.mock('../../providers/anthropic-sdk.js', async () => (await import('./fixtures/provider-wire.js')).fakeSdkModule());
vi.mock('../tools/surface.js', async () => (await import('./fixtures/provider-wire.js')).surfaceModule());
vi.mock('../../db/connection.js', async () => (await import('./fixtures/provider-wire.js')).connectionModule());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { useProviderWire, callOn, bodyOf, wire } from './fixtures/provider-wire.js';

useProviderWire({ beforeAll, afterAll, beforeEach, afterEach });

describe('a provider that refuses the forced form gets one plain try', () => {
  it.each([400, 422])('a %s refusal is followed by exactly one ordinary call, whose answer is returned', async (status) => {
    await callOn('deepseek', false);
    wire.replies.push({ status }, { text: 'It means hello.' });
    const r = await callOn('deepseek', true);
    expect(wire.http).toHaveLength(3);
    expect(bodyOf(1).tool_choice).toEqual({ type: 'function', function: { name: 'reply' } });
    expect(wire.http[2].body).toBe(wire.http[0].body);
    expect(r.content).toBe('It means hello.');
  });

  it.each([
    [401, 'invalid api key'],
    [400, 'Your credit balance is too low to access the API'],
    [400, "This model's maximum context length is 65536 tokens"],
  ])('a %s "%s" is not tried again', async (status, message) => {
    wire.replies.push({ status, message });
    await expect(callOn('compatible', true)).rejects.toBeInstanceOf(Error);
    expect(wire.http).toHaveLength(1);
  });
});
