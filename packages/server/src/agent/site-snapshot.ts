// SITE SNAPSHOT: sites refuse iframe rendering via X-Frame-Options or CSP frame-ancestors
// (browser-enforced, no client-side override). When blocked, render in headless Chromium.

import { chromium, type Browser, type BrowserContext } from 'playwright';
import { createLogger } from '../logger.js';
import { openAgentCall, STOPPED_BY_USER } from './abortable-call.js';
import { assertPublicHttpTarget, NetGuardError } from './net-guard.js';

const logger = createLogger('site-snapshot');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Whether a plain iframe can show this URL; false only when a header clearly blocks it. */
export async function isEmbeddable(url: string, agentId?: string): Promise<boolean> {
  // A NetGuardError must LEAVE this function: the catch below answers "let the iframe try",
  // and for a loopback/LAN URL that would hand the target to the dashboard, not refuse it.
  await assertPublicHttpTarget(url);
  const slot = agentId === undefined
    ? null
    : openAgentCall(agentId, 'turn', AbortSignal.timeout(8000));
  // A stop standing at the door answers true: a screenshot is MORE work for a just-stopped agent.
  if (slot?.refused) { slot.release(); return true; }
  try {
    // Follow redirects MANUALLY, re-checking each hop: an open redirect could reach private space.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      // One slot for the whole hop loop: this agent's stop composes with the 8 s hop clock.
      const hopRes = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
        signal: slot?.signal ?? AbortSignal.timeout(8000),
      });
      const loc = hopRes.status >= 300 && hopRes.status < 400 ? hopRes.headers.get('location') : null;
      if (!loc) { res = hopRes; break; }
      current = new URL(loc, current).href;
      await assertPublicHttpTarget(current);
    }
    if (!res) return true; // redirect budget exhausted, let the iframe try
    // We only need the headers; let the body be GC'd / connection closed.
    const xfo = res.headers.get('x-frame-options');
    if (xfo && /\b(deny|sameorigin|allow-from)\b/i.test(xfo)) return false;

    const csp = res.headers.get('content-security-policy');
    if (csp && /frame-ancestors/i.test(csp)) {
      const m = csp.match(/frame-ancestors([^;]*)/i);
      const value = (m?.[1] ?? '').trim();
      // Only a bare `*` is embeddable anywhere; an allowlist won't include the dojo's origin.
      const allowsAny = /(^|\s)\*(\s|$)/.test(value);
      if (!allowsAny) return false;
    }
    return true;
  } catch (err) {
    if (err instanceof NetGuardError) throw err; // never downgrade a refusal
    // Unreachable / blocked by CORS preflight / timeout: let the iframe try.
    logger.debug('isEmbeddable check failed; defaulting to iframe', {
      url, error: err instanceof Error ? err.message : String(err),
    });
    return true;
  } finally {
    slot?.release();
  }
}

// One shared headless Chromium (relaunch is ~1-2s); a fresh context+page per capture isolates.
let shared: Browser | null = null;
// Single-flight: callers that all see `shared` null await THIS launch, not their own.
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (shared?.isConnected()) return shared;
  if (launching) return launching;
  launching = (async () => {
    try {
      logger.info('Launching snapshot browser');
      const b = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
      // Only THIS browser leaving may blank `shared`; a stale exit must not orphan the newer one.
      b.on('disconnected', () => { if (shared === b) shared = null; });
      shared = b;
      return b;
    } finally {
      launching = null;
    }
  })();
  return launching;
}

export async function captureSiteScreenshot(url: string, agentId?: string): Promise<Buffer> {
  // Checked before launch; Playwright follows redirects itself, so this covers the request only.
  await assertPublicHttpTarget(url);
  const browser = await getBrowser();
  // goto takes no AbortSignal: the stop is ENACTED by closing the capture's context, rejecting it.
  const slot = agentId === undefined ? null : openAgentCall(agentId, 'turn');
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: BROWSER_UA,
    });
    if (slot) {
      slot.signal.addEventListener('abort', () => { void context?.close().catch(() => {}); }, { once: true });
      if (slot.refused) { slot.release(); await context.close().catch(() => {}); throw new Error(STOPPED_BY_USER); }
    }
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // networkidle never settles on some pages (ads, long-poll): fall back.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(600);
    const png = await page.screenshot({ type: 'png', fullPage: true });
    logger.info('Captured site screenshot', { url, bytes: png.length });
    return png;
  } finally {
    slot?.release();
    await context?.close().catch(() => { /* already gone */ });
  }
}
