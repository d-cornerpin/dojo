// ════════════════════════════════════════
// Headless Browser Session Manager (Phase 5B)
// Playwright-backed web_browse tool
// ════════════════════════════════════════

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createLogger } from '../logger.js';
import { callModel } from './model.js';
import { getDb } from '../db/connection.js';
import { getEffectiveVisionModel } from '../services/vision-model.js';

const logger = createLogger('browser');

// ── Per-Agent Session Map ──

const sessions = new Map<string, BrowserSession>();

// ── Rate Limiting ──

const actionTimestamps = new Map<string, number[]>();
const RATE_LIMIT = 30; // actions per minute
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(agentId: string): boolean {
  const now = Date.now();
  let timestamps = actionTimestamps.get(agentId);
  if (!timestamps) {
    timestamps = [];
    actionTimestamps.set(agentId, timestamps);
  }

  // Prune old timestamps
  while (timestamps.length > 0 && timestamps[0] < now - RATE_WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE_LIMIT) {
    return false;
  }

  timestamps.push(now);
  return true;
}

// Vision-model resolution now lives in services/vision-model.ts so a
// single helper governs every place on the platform that needs to
// route an image through a vision-capable model. See the rationale at
// the top of that module: the old auto-pick heuristic that lived here
// hid an important config decision (which model is doing the seeing?
// at what cost?) and is replaced by an explicit user-set fallback.

// ── Browser Session ──

class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && this.browser?.isConnected()) {
      return this.page;
    }

    // Launch new browser
    logger.info('Launching headless browser', {}, this.agentId);
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-gpu', '--no-sandbox'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'DOJO/1.0 (Headless Browser)',
    });
    this.page = await this.context.newPage();

    // Log memory usage of the Chromium process
    this.browser.on('disconnected', () => {
      logger.info('Browser disconnected', {}, this.agentId);
      this.browser = null;
      this.context = null;
      this.page = null;
    });

    return this.page;
  }

  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage();

    logger.info('Browser navigate', { url }, this.agentId);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (err) {
      // networkidle can timeout on busy pages — try domcontentloaded
      if (String(err).includes('Timeout')) {
        logger.warn('networkidle timeout, retrying with domcontentloaded', { url }, this.agentId);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } else {
        throw err;
      }
    }

    const title = await page.title();
    const currentUrl = page.url();
    return `Navigated to "${title}" (${currentUrl})`;
  }

  async screenshot(agentId: string): Promise<string> {
    if (!this.page) {
      return 'Error: No browser session. Use action "navigate" first.';
    }

    logger.info('Browser screenshot', {}, agentId);

    const buffer = await this.page.screenshot({ type: 'png', fullPage: false });
    const base64 = buffer.toString('base64');

    // Try to get a vision model description. Uses the platform-wide
    // resolution helper: agent's own model if vision-capable, otherwise
    // the configured fallback vision model. If neither is available we
    // return a degraded text response with a clear pointer at the
    // Settings → Dojo control so the user can fix it.
    const visionModel = getEffectiveVisionModel(agentId);
    if (!visionModel) {
      const currentUrl = this.page.url();
      const title = await this.page.title();
      return `Screenshot captured of "${title}" (${currentUrl}). No vision-capable model is configured to describe the page. Pick a fallback vision model in Settings → Dojo → Fallback vision model, or switch the calling agent to a vision-capable model in Settings → Models.`;
    }

    try {
      const result = await callModel({
        agentId,
        modelId: visionModel.modelId,
        messages: [{
          role: 'user' as const,
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64,
              },
            },
            {
              type: 'text',
              text: 'Describe this web page screenshot. Identify interactive elements (buttons, links, text fields, menus) with their CSS selectors where possible, or describe their position. Be concise but thorough.',
            },
          ] as never,
        }],
        systemPrompt: 'You are a web page analyzer. Describe what you see precisely. Focus on interactive elements and their selectors.',
        tools: false,
      });

      return result.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Vision model failed for browser screenshot', { error: msg }, agentId);
      const currentUrl = this.page.url();
      const title = await this.page.title();
      return `Screenshot captured of "${title}" (${currentUrl}). Vision analysis failed: ${msg}`;
    }
  }

  async click(selector: string): Promise<string> {
    if (!this.page) {
      return 'Error: No browser session. Use action "navigate" first.';
    }

    logger.info('Browser click', { selector }, this.agentId);

    try {
      await this.page.click(selector, { timeout: 5000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error clicking "${selector}": ${msg}`;
    }

    // Wait for potential navigation/ajax
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // networkidle timeout is fine — page might have long-polling
    }

    const currentUrl = this.page.url();
    return `Clicked "${selector}". Current page: ${currentUrl}`;
  }

  async type(selector: string, text: string): Promise<string> {
    if (!this.page) {
      return 'Error: No browser session. Use action "navigate" first.';
    }

    logger.info('Browser type', { selector, textLength: text.length }, this.agentId);

    try {
      await this.page.fill(selector, text);
      return `Typed "${text.length > 100 ? text.slice(0, 100) + '...' : text}" into ${selector}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error typing into "${selector}": ${msg}`;
    }
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<string> {
    if (!this.page) {
      return 'Error: No browser session. Use action "navigate" first.';
    }

    const delta = direction === 'down' ? amount : -amount;
    await this.page.mouse.wheel(0, delta);
    // Brief wait for lazy-loaded content
    await this.page.waitForTimeout(500);

    return `Scrolled ${direction} ${amount}px`;
  }

  async extract(): Promise<string> {
    if (!this.page) {
      return 'Error: No browser session. Use action "navigate" first.';
    }

    logger.info('Browser extract', {}, this.agentId);

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const text = await this.page.evaluate('document.body.innerText') as string;
    const currentUrl = this.page.url();
    const title = await this.page.title();

    const maxChars = 50000;
    const truncated = text.length > maxChars;
    const content = truncated
      ? text.substring(0, maxChars) + `\n\n[Content truncated at ${maxChars} characters]`
      : text;

    return `Page: "${title}" (${currentUrl})\n\n${content}`;
  }

  async close(): Promise<string> {
    if (this.browser) {
      logger.info('Closing browser session', {}, this.agentId);
      try {
        await this.browser.close();
      } catch {
        // Best-effort close
      }
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    return 'Browser session closed.';
  }

  isOpen(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }
}

// ── Public API ──

export function getOrCreateSession(agentId: string): BrowserSession {
  let session = sessions.get(agentId);
  if (!session) {
    session = new BrowserSession(agentId);
    sessions.set(agentId, session);
  }
  return session;
}

export async function closeSession(agentId: string): Promise<void> {
  const session = sessions.get(agentId);
  if (session) {
    await session.close();
    sessions.delete(agentId);
  }
}

// Close all sessions on agent termination
export async function closeAllSessions(): Promise<void> {
  for (const [agentId, session] of sessions) {
    await session.close();
    sessions.delete(agentId);
  }
}

// ── Tool Executor ──

export async function executeWebBrowse(
  agentId: string,
  args: {
    action: string;
    url?: string;
    selector?: string;
    text?: string;
    scroll_direction?: string;
    scroll_amount?: number;
    goal?: string;
  },
): Promise<string> {
  const { action, url, selector, text, scroll_direction, scroll_amount = 500, goal } = args;

  // Rate limit check
  if (!checkRateLimit(agentId)) {
    return 'Error: Browser action rate limit exceeded (30 actions/minute). Wait before trying again.';
  }

  const session = getOrCreateSession(agentId);

  try {
    switch (action) {
      case 'navigate':
        if (!url) return 'Error: url is required for navigate action';
        return await session.navigate(url);

      case 'screenshot':
        return await session.screenshot(agentId);

      case 'click':
        if (!selector) return 'Error: selector is required for click action';
        return await session.click(selector);

      case 'type':
        if (!selector) return 'Error: selector is required for type action';
        if (!text) return 'Error: text is required for type action';
        return await session.type(selector, text);

      case 'scroll':
        return await session.scroll(
          (scroll_direction as 'up' | 'down') || 'down',
          scroll_amount,
        );

      case 'extract': {
        // Phase 3.5 (2026-05-04) — `goal` is required for the extract
        // action. Without it the page would dump raw HTML/text into context.
        // Other actions (navigate, click, type, scroll, screenshot, close)
        // don't return page content so they don't need goal.
        if (!goal || goal.trim().length === 0) {
          return (
            'Error: web_browse(action="extract") requires a `goal` parameter ' +
            'describing what to extract from the page. Example: ' +
            'web_browse({ action: "extract", goal: "the article headline and first paragraph" }). ' +
            'A required goal keeps the result small (~1-2K tokens) instead of dumping the raw page.'
          );
        }
        const raw = await session.extract();
        if (goal && goal.trim().length > 0) {
          try {
            const { selectModel } = await import('../router/selector.js');
            const { callModel } = await import('./model.js');
            const lightModel = selectModel('light', agentId);
            if (lightModel?.modelId) {
              const snippet = raw.length > 50_000 ? raw.slice(0, 50_000) : raw;
              const result = await callModel({
                agentId,
                modelId: lightModel.modelId,
                systemPrompt:
                  'You are a focused web page extractor. Return ONLY the information described by the goal, ' +
                  'in a compact, structured form. No preamble, no recap of the goal. If the page does not ' +
                  'contain the requested information, say so in one sentence.',
                messages: [
                  { role: 'user', content: `Goal: ${goal}\n\nPage content:\n${snippet}` },
                ],
                tools: false,
              });
              const extract = result.content?.trim();
              if (extract && extract.length > 0) {
                return `Extracted (goal: ${goal}):\n\n${extract}`;
              }
              logger.warn('web_browse extract: extractor returned empty content — falling back to raw', { agentId });
            }
          } catch (err) {
            logger.warn('web_browse extract: goal extraction failed — falling back to raw', {
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
        return raw;
      }

      case 'close':
        const result = await session.close();
        sessions.delete(agentId);
        return result;

      default:
        return `Error: Unknown action "${action}". Valid actions: navigate, screenshot, click, type, scroll, extract, close`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('web_browse action failed', { action, error: msg }, agentId);
    return `Error: Browser action "${action}" failed: ${msg}`;
  }
}
