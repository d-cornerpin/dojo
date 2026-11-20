// Thinking is turned off for the forced call only: the next ordinary call is sent with the model's own thinking.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', async () => (await import('./fixtures/provider-wire.js')).fakeAnthropicModule());
vi.mock('../../providers/anthropic-sdk.js', async () => (await import('./fixtures/provider-wire.js')).fakeSdkModule());
vi.mock('../tools/surface.js', async () => (await import('./fixtures/provider-wire.js')).surfaceModule());
vi.mock('../../db/connection.js', async () => (await import('./fixtures/provider-wire.js')).connectionModule());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { useProviderWire, callOn, bodyOf } from './fixtures/provider-wire.js';

useProviderWire({ beforeAll, afterAll, beforeEach, afterEach });

describe('thinking off does not leak into the next ordinary call', () => {
  it('deepseek: forced, then ordinary, sends disabled then enabled', async () => {
    await callOn('deepseek', true);
    await callOn('deepseek', false);
    expect(bodyOf(0).thinking).toEqual({ type: 'disabled' });
    expect(bodyOf(1).thinking).toEqual({ type: 'enabled' });
    expect(bodyOf(1).tool_choice).toBeUndefined();
  });
});
