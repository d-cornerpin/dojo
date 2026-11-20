// A call that requires the reply names the `reply` tool after the ordinary tools where the transport can force a
// tool choice (OpenAI and compatible), with thinking off; elsewhere it goes out exactly as the ordinary call.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', async () => (await import('./fixtures/provider-wire.js')).fakeAnthropicModule());
vi.mock('../../providers/anthropic-sdk.js', async () => (await import('./fixtures/provider-wire.js')).fakeSdkModule());
vi.mock('../tools/surface.js', async () => (await import('./fixtures/provider-wire.js')).surfaceModule());
vi.mock('../../db/connection.js', async () => (await import('./fixtures/provider-wire.js')).connectionModule());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { useProviderWire, callOn, bodyOf, sentBodies } from './fixtures/provider-wire.js';

useProviderWire({ beforeAll, afterAll, beforeEach, afterEach });
const names = (b: Record<string, unknown>): string[] => (b.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);

describe('a forced call names the reply tool where it can', () => {
  it.each(['openai', 'compatible', 'deepseek', 'openrouter'] as const)('%s: the ordinary tools, then reply, named as the choice', async (form) => {
    await callOn(form, false);
    await callOn(form, true);
    const [ordinary, forced] = [bodyOf(0), bodyOf(1)];
    expect(names(forced)).toEqual([...names(ordinary), 'reply']);
    expect((forced.tools as unknown[]).slice(0, -1)).toEqual(ordinary.tools);
    expect(forced.tool_choice).toEqual({ type: 'function', function: { name: 'reply' } });
    expect(forced.messages).toEqual(ordinary.messages);
  });

  it('deepseek and openrouter: the forced call is sent with thinking off', async () => {
    await callOn('deepseek', true);
    await callOn('openrouter', true);
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' });
    expect(bodyOf(0).reasoning_effort).toBeUndefined();
    expect(bodyOf(1).extra_body).toEqual({ reasoning: { enabled: false } });
  });

  it.each(['anthropic', 'ollama', 'sdk'] as const)('%s: the forced call goes out as the ordinary one', async (form) => {
    await callOn(form, false);
    await callOn(form, true);
    const bodies = sentBodies(form);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
});
