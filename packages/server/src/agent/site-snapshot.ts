// ════════════════════════════════════════════════════════════════════════
// Site snapshot — the canvas's "show this website" fallback.
//
// Many sites refuse to render in an iframe via `X-Frame-Options` or CSP
// `frame-ancestors` (browser-enforced; no client-side override exists). When a
// site blocks embedding we instead render it server-side with the same headless
// Chromium the web_browse tool uses and hand the canvas a full-page PNG, with an
// "Open in new window" affordance for real interaction.
//
//   isEmbeddable(url)        → can the canvas iframe load it directly?
//   captureSiteScreenshot()  → full-page PNG of the rendered page
// ════════════════════════════════════════════════════════════════════════

import { chromium, type Browser } from 'playwright';
import { createLogger } from '../logger.js';
import { assertPublicHttpTarget, NetGuardError } from './net-guard.js';

const logger = createLogger('site-snapshot');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Decide whether a URL can be shown in a plain iframe. Errs toward `false`
 * (screenshot) only when a header clearly blocks embedding — anything
 * ambiguous or unreachable returns `true` so we still try the live iframe.
 */
export async function isEmbeddable(url: string): Promise<boolean> {
  // T11 (SSRF): a refusal must LEAVE this function. The catch below defaults to
  // "let the iframe try", which for a loopback/LAN URL would hand the target to
  // the dashboard instead of refusing it — so NetGuardError is re-thrown there.
  await assertPublicHttpTarget(url);
  try {
    // Follow redirects MANUALLY and re-check each hop: an open redirect on a
    // public host could otherwise walk this fetch onto a private address.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      const hopRes = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(8000),
      });
      const loc = hopRes.status >= 300 && hopRes.status < 400 ? hopRes.headers.get('location') : null;
      if (!loc) { res = hopRes; break; }
      current = new URL(loc, current).href;
      await assertPublicHttpTarget(current);
    }
    if (!res) return true; // redirect budget exhausted — let the iframe try
    // We only need the headers; let the body be GC'd / connection closed.
    const xfo = res.headers.get('x-frame-options');
    if (xfo && /\b(deny|sameorigin|allow-from)\b/i.test(xfo)) return false;

    const csp = res.headers.get('content-security-policy');
    if (csp && /frame-ancestors/i.test(csp)) {
      const m = csp.match(/frame-ancestors([^;]*)/i);
      const value = (m?.[1] ?? '').trim();
      // Embeddable anywhere only if a bare `*` is allowed; a specific allowlist
      // (or 'none'/'self') won't include the dojo's origin.
      const allowsAny = /(^|\s)\*(\s|$)/.test(value);
      if (!allowsAny) return false;
    }
    return true;
  } catch (err) {
    if (err instanceof NetGuardError) throw err; // never downgrade a refusal
    // Unreachable / blocked by CORS preflight / timeout — let the iframe try.
    logger.debug('isEmbeddable check failed; defaulting to iframe', {
      url, error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

// Reuse one headless Chromium across snapshots (relaunch is ~1-2s). A fresh
// context+page per capture keeps them isolated.
let shared: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (shared?.isConnected()) return shared;
  logger.info('Launching snapshot browser');
  shared = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
  shared.on('disconnected', () => { shared = null; });
  return shared;
}

/**
 * Render `url` in headless Chromium and return a full-page PNG. Throws on
 * navigation failure (caller falls back to a plain iframe).
 */
export async function captureSiteScreenshot(url: string): Promise<Buffer> {
  // T11 (SSRF): checked before a browser is launched. Playwright follows
  // redirects and sub-resources itself, so this covers the requested URL only;
  // per-hop enforcement inside the browser is Phase 5's net broker.
  await assertPublicHttpTarget(url);
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: BROWSER_UA,
  });
  const page = await context.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // networkidle never settles on some pages (ads, long-poll) — fall back.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    // Give late-rendering content a moment to paint.
    await page.waitForTimeout(600);
    const png = await page.screenshot({ type: 'png', fullPage: true });
    logger.info('Captured site screenshot', { url, bytes: png.length });
    return png;
  } finally {
    await context.close().catch(() => { /* already gone */ });
  }
}
