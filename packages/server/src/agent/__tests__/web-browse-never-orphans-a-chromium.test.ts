// WEB_BROWSE NEVER ORPHANS A CHROMIUM WHEN ITS PAGE SETUP FAILS (9601) —
//
// `BrowserSession.ensurePage` launched Chromium and stored it in `this.browser`, ran
// `newContext`/`newPage`, and only AFTER those attached the `disconnected` handler. If either
// threw, `this.browser` held a live Chromium that nothing could reach: the next `navigate` saw
// `this.page === null`, launched a SECOND Chromium and overwrote the field — one orphan per
// failed attempt. And `ensurePage` had no single-flight: two overlapping `web_browse` calls
// for the same agent each launched a browser and the second overwrote the first, same orphan.
//
// THE FIX: the launch lives in `launchPage()`. The `disconnected` handler is attached right
// after launch (nulling the fields only while `this.browser === browser`); a `newContext`/
// `newPage` throw closes the half-built browser and rethrows; the three fields are assigned
// only on success. `ensurePage` keeps a single `launching` promise, so overlapping callers
// share one launch.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch } }));

const assertPublicHttpTarget = vi.hoisted(() => vi.fn());
vi.mock('../net-guard.js', () => ({ assertPublicHttpTarget }));

// Empty stubs so importing browser.ts stays light — navigate() reaches none of them.
vi.mock('../model.js', () => ({}));
vi.mock('../../services/vision-model.js', () => ({}));
vi.mock('../../db/connection.js', () => ({}));

let BrowserSession: typeof import('../browser.js').BrowserSession;

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

beforeEach(async () => {
  // A fresh module registry per clause so the launch stub is genuinely dialled again, as in
  // site-snapshot-releases-its-slot.test.ts.
  vi.resetModules();
  launch.mockReset();
  assertPublicHttpTarget.mockReset();
  assertPublicHttpTarget.mockResolvedValue({ href: 'https://example.com/', address: '93.184.216.34' });
  ({ BrowserSession } = await import('../browser.js'));
});

describe('web_browse never orphans a Chromium', () => {
  it('a newContext that rejects closes the browser it just launched', async () => {
    const browser = {
      isConnected: () => true,
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      newContext: vi.fn().mockRejectedValue(new Error('browser closed')),
    };
    launch.mockResolvedValue(browser);

    const session = new BrowserSession('a1');
    await expect(session.navigate('https://example.com/')).rejects.toThrow('browser closed');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('two navigates started together share one launch', async () => {
    // launch stays pending until the test resolves it by hand, so the second navigate must
    // join the first launch instead of starting its own.
    const resolvers: Array<(browser: ReturnType<typeof workingBrowser>) => void> = [];
    launch.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));

    const session = new BrowserSession('a2');
    const first = session.navigate('https://example.com/');
    const second = session.navigate('https://example.com/');
    // One macrotask so both navigates have reached the pending launch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launch).toHaveBeenCalledTimes(1);

    for (const resolveLaunch of resolvers) resolveLaunch(workingBrowser());
    await expect(first).resolves.toContain('Navigated to');
    await expect(second).resolves.toContain('Navigated to');
  });

  it('a failed launch leaves the session usable: the next navigate launches again and works', async () => {
    const dead = {
      isConnected: () => true,
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      newContext: vi.fn().mockRejectedValue(new Error('browser closed')),
    };
    launch.mockResolvedValueOnce(dead).mockResolvedValueOnce(workingBrowser());

    const session = new BrowserSession('a1');
    await expect(session.navigate('https://example.com/')).rejects.toThrow('browser closed');
    expect(dead.close).toHaveBeenCalledTimes(1);

    await expect(session.navigate('https://example.com/')).resolves.toContain('Navigated to');
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
