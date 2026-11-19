// Every web_browse action restarts a 10-minute clock; with no action the session closes, and the next action opens a new browser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch } }));

const assertPublicHttpTarget = vi.hoisted(() => vi.fn());
vi.mock('../net-guard.js', () => ({ assertPublicHttpTarget }));

// Empty stubs so importing browser.ts stays light, navigate() reaches none of them.
vi.mock('../model.js', () => ({}));
vi.mock('../../services/vision-model.js', () => ({}));
vi.mock('../../db/connection.js', () => ({}));

import { executeWebBrowse } from '../browser.js';

// Fake data only: a browser whose context and page come up cleanly.
function workingBrowser() {
  return {
    isConnected: () => true,
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        title: vi.fn().mockResolvedValue('Example Domain'),
        url: () => 'https://example.com/',
      }),
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  launch.mockReset();
  assertPublicHttpTarget.mockReset();
  assertPublicHttpTarget.mockResolvedValue({ href: 'https://example.com/', address: '93.184.216.34' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the hidden browser closes after ten idle minutes', () => {
  it('ten idle minutes close the browser', async () => {
    const b = workingBrowser();
    launch.mockResolvedValue(b);

    await executeWebBrowse('agent-idle-1', { action: 'navigate', url: 'https://example.com/' });

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(b.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('an action restarts the clock', async () => {
    const b = workingBrowser();
    launch.mockResolvedValue(b);

    await executeWebBrowse('agent-idle-2', { action: 'navigate', url: 'https://example.com/' });
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await executeWebBrowse('agent-idle-2', { action: 'navigate', url: 'https://example.com/' });

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(b.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('close leaves no clock behind', async () => {
    const b = workingBrowser();
    launch.mockResolvedValue(b);

    await executeWebBrowse('agent-idle-3', { action: 'navigate', url: 'https://example.com/' });
    const closed = await executeWebBrowse('agent-idle-3', { action: 'close' });
    expect(closed).toBe('Browser session closed.');
    expect(b.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(b.close).toHaveBeenCalledTimes(1);
  });
});
