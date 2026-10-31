// DS4 9600 — TWO SNAPSHOTS AT ONCE LAUNCH TWO BROWSERS AND ORPHAN ONE.
//
// `getBrowser` reuses one shared headless Chromium, but `chromium.launch` takes ~1-2s. Two
// `captureSiteScreenshot` calls that arrive while `shared` is null (first use, or after a crash)
// both pass the `if (shared?.isConnected())` guard, both launch, and the second assignment
// overwrites `shared` — the first Chromium is now referenced by nobody and is never closed: an
// orphan process. And every browser's `disconnected` handler sets `shared = null` unconditionally,
// so when an orphan (or any older browser) finally exits it blanks `shared` while the newer, healthy
// browser is still in use — the next snapshot launches again and orphans that one too.
//
// THE FIX: single-flight the launch (a `launching` promise every concurrent caller awaits) and let
// each browser's disconnect handler null `shared` ONLY if it is still the current one.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch } }));

const assertPublicHttpTarget = vi.hoisted(() => vi.fn());
vi.mock('../net-guard.js', () => {
  class NetGuardError extends Error {}
  return { assertPublicHttpTarget, NetGuardError };
});

let captureSiteScreenshot: typeof import('../site-snapshot.js').captureSiteScreenshot;

// A fake browser whose launch we resolve (or reject) by hand, and whose `isConnected` we can flip.
// The module calls `b.on('disconnected', cb)`, so the callback is captured through `on`.
function makeBrowser() {
  const browser = {
    connected: true,
    isConnected() { return browser.connected; },
    on: vi.fn(),
    newContext: vi.fn().mockRejectedValue(new Error('stop here')),
  };
  return browser;
}
type FakeBrowser = ReturnType<typeof makeBrowser>;

// Every `launch()` call records its browser and the resolve/reject handles of the promise it
// returned, so a test can drive the launch to a decision at its own pace.
const pending: { browser: FakeBrowser; resolve: (b: FakeBrowser) => void; reject: (e: unknown) => void }[] = [];

function armManualLaunch() {
  pending.length = 0;
  launch.mockReset();
  launch.mockImplementation(() => {
    const browser = makeBrowser();
    let resolve!: (b: FakeBrowser) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<FakeBrowser>((res, rej) => { resolve = res; reject = rej; });
    pending.push({ browser, resolve, reject });
    return promise;
  });
}

// Drain the microtask queue (macrotask turn): both concurrent captures get past their
// `await assertPublicHttpTarget(...)` and into `getBrowser`, so `launch` has actually been called
// before a test resolves the launch. Not a delay that hides a race — the very next tick.
function flush() { return new Promise<void>((r) => setTimeout(r, 0)); }
function resolveAllPending() { for (const p of pending) p.resolve(p.browser); }
// Attach both settle handlers synchronously at creation, so a capture's expected `newContext`
// rejection is never momentarily unhandled between a resolve-by-hand and the next await.
function settled(p: Promise<unknown>): Promise<void> {
  return p.then(() => undefined, () => undefined);
}
function disconnectCb(b: FakeBrowser) {
  const call = b.on.mock.calls.find((c) => c[0] === 'disconnected');
  return call ? (call[1] as (() => void) | undefined) : undefined;
}

beforeEach(async () => {
  // The shared browser is a module variable: a fresh module registry per clause so each test's
  // launch stub is genuinely dialled again and `shared`/`launching` start null.
  vi.resetModules();
  pending.length = 0;
  launch.mockReset();
  launch.mockResolvedValue({ isConnected: () => true, on: vi.fn(), newContext: vi.fn() });
  assertPublicHttpTarget.mockReset();
  assertPublicHttpTarget.mockResolvedValue({ href: 'https://example.com/', address: '93.184.216.34' });
  ({ captureSiteScreenshot } = await import('../site-snapshot.js'));
});

describe('getBrowser launches a single shared browser', () => {
  it('two captures arriving during one launch share a single browser', async () => {
    armManualLaunch();

    const s1 = settled(captureSiteScreenshot('https://example.com/'));
    const s2 = settled(captureSiteScreenshot('https://example.com/'));
    await flush();                 // both reach getBrowser and (before the fix) both call launch
    resolveAllPending();
    await Promise.all([s1, s2]);

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("an older browser's disconnect does not blank the newer one", async () => {
    armManualLaunch();

    // Browser A launches and becomes the shared browser.
    const sA = settled(captureSiteScreenshot('https://example.com/'));
    await flush();
    pending[0].resolve(pending[0].browser);
    await flush();                 // `shared` = A and A's disconnect handler is attached
    const cbA = disconnectCb(pending[0].browser);
    expect(cbA).toBeTypeOf('function');
    await sA;

    // A reports disconnected, so the next capture launches browser B — the new `shared`.
    pending[0].browser.connected = false;
    const sB = settled(captureSiteScreenshot('https://example.com/'));
    await flush();
    pending[1].resolve(pending[1].browser);
    await flush();                 // `shared` = B (B still connected)
    await sB;

    // The late orphan (A) finally exits. Its handler must NOT blank the healthy B.
    cbA!();

    // A third capture must therefore reuse B, not launch a third browser.
    const sC = settled(captureSiteScreenshot('https://example.com/'));
    await flush();
    resolveAllPending();           // no-op unless (before the fix) a third launch happened
    await sC;

    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('a rejected launch clears the in-flight slot so the next call tries again', async () => {
    armManualLaunch();

    const p1 = captureSiteScreenshot('https://example.com/');
    await flush();
    expect(launch).toHaveBeenCalledTimes(1);
    pending[0].reject(new Error('launch boom'));
    await expect(p1).rejects.toThrow('launch boom');

    // `launching` was cleared and `shared` left as it was, so the next capture launches again.
    const p2 = captureSiteScreenshot('https://example.com/');
    await flush();
    expect(launch).toHaveBeenCalledTimes(2);
    pending[1].resolve(pending[1].browser);
    // It gets past the launch to a browser (reaching newContext), i.e. the retry succeeded.
    await expect(p2).rejects.toThrow('stop here');
  });
});
