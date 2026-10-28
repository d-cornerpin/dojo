// SOURCE CODE SWEEP S04 F4 — A SITE SNAPSHOT THAT DIES BEFORE ITS RENDER RELEASES ITS SLOT.
//
// `captureSiteScreenshot` opens an abortable "turn" slot (`openAgentCall`) so the stop button
// sees the in-flight render as live work, then awaits `browser.newContext(...)` and
// `context.newPage()`. Both run BEFORE the `try` whose `finally` releases the slot and closes
// the context — so a rejection from either (a shared browser that crashed mid-launch, or that
// disconnected between `getBrowser` and the page) leaks the slot: `countAbortable(agentId,
// 'turn')` stays above 0 and the agent reads as busy until the server restarts.
//
// THE FIX: the release is unconditional. `newContext`, the abort listener, the `refused` check
// and `newPage` all live inside the `try`, and the `finally` releases the slot and closes the
// context if it exists — so no throw path leaves a slot standing.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch } }));

const assertPublicHttpTarget = vi.hoisted(() => vi.fn());
vi.mock('../net-guard.js', () => {
  class NetGuardError extends Error {}
  return { assertPublicHttpTarget, NetGuardError };
});

let countAbortable: typeof import('../shared-state.js').countAbortable;
let captureSiteScreenshot: typeof import('../site-snapshot.js').captureSiteScreenshot;

beforeEach(async () => {
  // The shared browser is a module variable: a fresh module registry per clause so each test's
  // launch stub is genuinely dialled again and `shared` starts null.
  vi.resetModules();
  launch.mockReset();
  launch.mockResolvedValue({ isConnected: () => true, on: vi.fn(), newContext: vi.fn() });
  assertPublicHttpTarget.mockReset();
  assertPublicHttpTarget.mockResolvedValue({ href: 'https://example.com/', address: '93.184.216.34' });
  ({ countAbortable } = await import('../shared-state.js'));
  ({ captureSiteScreenshot } = await import('../site-snapshot.js'));
});

describe('captureSiteScreenshot releases its slot on a pre-render throw', () => {
  it('newContext rejecting leaves no live turn slot', async () => {
    launch.mockResolvedValue({
      isConnected: () => true,
      on: vi.fn(),
      newContext: vi.fn().mockRejectedValue(new Error('browser closed')),
    });

    await expect(captureSiteScreenshot('https://example.com/', 'agent-snap-1')).rejects.toThrow('browser closed');
    expect(countAbortable('agent-snap-1', 'turn')).toBe(0);
  });

  it('newPage rejecting closes the context and leaves no live turn slot', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    launch.mockResolvedValue({
      isConnected: () => true,
      on: vi.fn(),
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockRejectedValue(new Error('no page')),
        close: closeSpy,
        on: vi.fn(),
      }),
    });

    await expect(captureSiteScreenshot('https://example.com/', 'agent-snap-2')).rejects.toThrow('no page');
    expect(countAbortable('agent-snap-2', 'turn')).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
