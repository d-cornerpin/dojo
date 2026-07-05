// ════════════════════════════════════════
// canvas_read, let the agent "look at" the right-dock canvas.
//
// The canvas is a client-side surface, so the server tracks the most recent
// thing the agent put there (setCurrentCanvas, called from canvas_render /
// open_browser). canvas_read then renders that content and routes it through
// the platform vision model:
//   - HTML (inline / .html file / any URL) -> headless Chromium screenshot
//   - image file                            -> the image itself
//   - PDF file                              -> Chromium screenshot (first view)
//   - text / markdown / code file           -> returned as text (cheaper +
//                                              more accurate than a screenshot)
//
// Vision uses getEffectiveVisionModel: the agent's own model if it is
// vision-capable, otherwise the configured fallback vision model, so this
// works even when the calling agent can't see images itself.
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createLogger } from '../logger.js';
import { callModel } from './model.js';
import { getEffectiveVisionModel } from '../services/vision-model.js';
import { inlineHtmlAssets } from '../services/canvas-html.js';
import { renderOfficeToHtml, isOfficeRenderable } from '../services/office-render.js';
import { broadcast } from '../gateway/ws.js';
import { getDb } from '../db/connection.js';

const logger = createLogger('canvas-view');

export interface CanvasState {
  kind: 'canvas' | 'iframe' | 'screenshot';
  html?: string;
  url?: string;
  path?: string;
  title?: string;
  /** screenshot: the original website URL behind the captured PNG. */
  sourceUrl?: string;
}

// The canvas is PER AGENT: each agent owns its own dock slot, keyed by agentId.
// A background agent finishing a delegated job opens ITS slot; the dashboard
// shows only the slot of the agent the user is currently viewing (client-side,
// off the agentId stamped on every dock event), so a background open can never
// replace the viewed agent's canvas. Updated whenever an agent opens something.
// (No GC of per-agent rows when an agent is deleted; that's an accepted choice
// at this scale, one small config row per agent.)
const currentCanvasByAgent = new Map<string, CanvasState>();

// Live re-render: watch the file currently shown in an agent's canvas and tell
// the client to re-fetch whenever it changes on disk, NO MATTER how it was
// edited. The proper edit tools (file_write/file_patch, office_*) already ping
// the canvas, but weak models routinely reach for shell hacks instead (sed -i,
// python-docx, a heredoc redirect). Those bypass the in-tool ping, so without a
// disk watcher the canvas would show stale content after such an edit. Polling
// stat() (vs fs.watch) catches in-place writes AND atomic rename-replaces, on
// every platform. One watcher PER AGENT, and the canvas:updated it emits carries
// the agentId, so an edit to agent B's file can never refresh agent A's canvas.
const watchedPathByAgent = new Map<string, string>();
function stopCanvasWatch(agentId: string): void {
  const watched = watchedPathByAgent.get(agentId);
  if (watched) {
    try { fs.unwatchFile(watched); } catch { /* best effort */ }
    watchedPathByAgent.delete(agentId);
  }
}
function startCanvasWatch(agentId: string, filePath: string): void {
  if (watchedPathByAgent.get(agentId) === filePath) return;
  stopCanvasWatch(agentId);
  try {
    fs.watchFile(filePath, { interval: 700 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        try { broadcast({ type: 'canvas:updated', agentId, data: { path: filePath } }); } catch { /* best effort */ }
      }
    });
    watchedPathByAgent.set(agentId, filePath);
  } catch { /* best effort, never let watching break a canvas open */ }
}

// Canvas status: once a canvas exists it is either OPEN (dock showing) or
// COLLAPSED (minimised to the edge handle; content retained). Persisted to the
// DB so the canvas survives a browser refresh, a server restart, and follows the
// user from one device to another (the dashboard reads GET /api/canvas on mount).
// Per agent, like the canvas state itself.
export type CanvasStatus = 'open' | 'collapsed';
const canvasStatusByAgent = new Map<string, CanvasStatus>();
const hydratedAgents = new Set<string>();
// One config row per agent: `current_canvas:<agentId>`.
const canvasConfigKey = (agentId: string): string => `current_canvas:${agentId}`;

function persistCanvas(agentId: string): void {
  try {
    const state = currentCanvasByAgent.get(agentId) ?? null;
    const value = state
      ? JSON.stringify({ state, status: canvasStatusByAgent.get(agentId) ?? 'collapsed' })
      : '';
    getDb().prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(canvasConfigKey(agentId), value);
  } catch { /* best effort, never let persistence break a canvas open */ }
}

// Lazily rehydrate one agent's in-memory canvas from the DB on first access, so a
// server restart doesn't drop an open canvas the user expects to still be there.
function hydrateCanvas(agentId: string): void {
  if (hydratedAgents.has(agentId)) return;
  hydratedAgents.add(agentId);
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?')
      .get(canvasConfigKey(agentId)) as { value: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { state: CanvasState; status: CanvasStatus };
      if (parsed?.state) {
        currentCanvasByAgent.set(agentId, parsed.state);
        canvasStatusByAgent.set(agentId, parsed.status === 'open' ? 'open' : 'collapsed');
        if (parsed.state.kind === 'canvas' && parsed.state.path) startCanvasWatch(agentId, parsed.state.path);
      }
    }
  } catch { /* best effort */ }
}

export function setCurrentCanvas(agentId: string, state: CanvasState | null): void {
  hydrateCanvas(agentId);
  if (state) currentCanvasByAgent.set(agentId, state);
  else currentCanvasByAgent.delete(agentId);
  // Opening a canvas always brings it to the OPEN state (the agent put something
  // there for the user to see). Clearing it resets to collapsed.
  canvasStatusByAgent.set(agentId, state ? 'open' : 'collapsed');
  if (state?.kind === 'canvas' && state.path) startCanvasWatch(agentId, state.path);
  else stopCanvasWatch(agentId);
  persistCanvas(agentId);
}
export function getCurrentCanvas(agentId: string): CanvasState | null {
  hydrateCanvas(agentId);
  return currentCanvasByAgent.get(agentId) ?? null;
}
/** Full persisted shape for the dashboard's load-on-mount (GET /api/canvas). */
export function getPersistedCanvas(agentId: string): { state: CanvasState; status: CanvasStatus } | null {
  hydrateCanvas(agentId);
  const state = currentCanvasByAgent.get(agentId);
  return state ? { state, status: canvasStatusByAgent.get(agentId) ?? 'collapsed' } : null;
}
/** Update just the open/collapsed status (user collapsed or re-opened the dock). */
export function setCanvasStatus(agentId: string, status: CanvasStatus): void {
  hydrateCanvas(agentId);
  if (!currentCanvasByAgent.has(agentId)) return;
  canvasStatusByAgent.set(agentId, status);
  persistCanvas(agentId);
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.csv', '.tsv', '.log',
  '.xml', '.yaml', '.yml', '.css', '.js', '.ts', '.jsx', '.tsx', '.py',
  '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.sql', '.toml',
  '.ini', '.env',
]);
const TEXT_MAX_BYTES = 200 * 1024;

function resolveHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Render an HTML string or a URL to a PNG screenshot via headless Chromium.
async function renderToPng(opts: { html?: string; url?: string }): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    if (opts.html != null) {
      await page.setContent(opts.html, { waitUntil: 'networkidle', timeout: 15000 }).catch(async () => {
        await page.setContent(opts.html!, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      });
    } else if (opts.url) {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(async () => {
        await page.goto(opts.url!, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
      });
    }
    // A short settle for fonts/late paint.
    await page.waitForTimeout(350);
    return await page.screenshot({ type: 'png', fullPage: true });
  } finally {
    await browser.close().catch(() => {});
  }
}

// Send an image to the vision model and return its description.
async function describeImage(
  agentId: string,
  base64: string,
  mediaType: string,
  userPrompt: string | undefined,
): Promise<string> {
  const visionModel = getEffectiveVisionModel(agentId);
  if (!visionModel) {
    return 'A snapshot of the canvas was captured, but no vision-capable model is configured to read it. ' +
      'Pick a fallback vision model in Settings -> Dojo -> Fallback vision model, or switch this agent to a vision-capable model in Settings -> Models.';
  }
  const accuracy =
    ' Report only what is actually rendered. If an image is missing, broken, or shows a' +
    ' broken-image placeholder / empty box (no real picture), say so explicitly, do NOT' +
    ' describe an absent or failed image as if it were present. Do not assume content you' +
    ' cannot see.';
  const instruction = userPrompt && userPrompt.trim()
    ? `Look at this canvas (a document/render the user and I are viewing together) and answer: ${userPrompt.trim()}.${accuracy}`
    : `Describe what is shown in this canvas in detail, layout, text, visuals, and anything notable.${accuracy}`;
  try {
    const result = await callModel({
      agentId,
      modelId: visionModel.modelId,
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: instruction },
        ] as never,
      }],
      systemPrompt: 'You are looking at a canvas the user is viewing in their dojo. Be literal and precise about what is and is not actually visible; never claim an image or element is present if it did not render. Describe concisely; answer any question asked.',
      tools: false,
    });
    return result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Vision model failed for canvas_read', { error: msg }, agentId);
    return `A snapshot of the canvas was captured, but vision analysis failed: ${msg}`;
  }
}

export async function viewCanvas(agentId: string, args: Record<string, unknown>): Promise<string> {
  // Explicit target overrides the currently-shown canvas.
  const argHtml = typeof args.html === 'string' ? args.html : undefined;
  const argUrl = typeof args.url === 'string' ? args.url : undefined;
  const argPath = typeof args.path === 'string' ? args.path : undefined;
  const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;

  let target: CanvasState | null;
  if (argHtml || argUrl || argPath) {
    target = { kind: 'canvas', html: argHtml, url: argUrl, path: argPath };
  } else {
    target = getCurrentCanvas(agentId);
  }
  if (!target || (!target.html && !target.url && !target.path)) {
    return 'Error: nothing is open in the canvas. Show something first with canvas_render (or pass html / url / path to view a specific thing).';
  }

  logger.info('canvas_read', { kind: target.kind, hasHtml: !!target.html, hasUrl: !!target.url, hasPath: !!target.path }, agentId);

  try {
    // File-backed canvas: branch by type.
    if (target.path) {
      const filePath = resolveHome(target.path);
      if (!fs.existsSync(filePath)) {
        return `Error: the canvas file no longer exists on disk (${filePath}).`;
      }
      const ext = path.extname(filePath).toLowerCase();

      // Image -> feed the pixels straight to the vision model.
      if (IMAGE_MIME[ext]) {
        const base64 = (await fs.promises.readFile(filePath)).toString('base64');
        return await describeImage(agentId, base64, IMAGE_MIME[ext], prompt);
      }
      // Text / markdown / code -> return the text (more accurate than a shot).
      if (TEXT_EXTS.has(ext)) {
        const stat = await fs.promises.stat(filePath);
        let text = await fs.promises.readFile(filePath, 'utf-8');
        let truncated = '';
        if (stat.size > TEXT_MAX_BYTES) {
          text = text.slice(0, TEXT_MAX_BYTES);
          truncated = `\n\n[...truncated, file is ${stat.size} bytes; showing the first ${TEXT_MAX_BYTES}.]`;
        }
        return `The canvas is showing ${path.basename(filePath)} (${ext} file). Its current contents:\n\n${text}${truncated}`;
      }
      // Word / Excel -> render the SAME HTML preview the canvas shows.
      if (isOfficeRenderable(ext)) {
        const officeHtml = await renderOfficeToHtml(filePath);
        if (officeHtml) {
          const png = await renderToPng({ html: officeHtml });
          return await describeImage(agentId, png.toString('base64'), 'image/png', prompt);
        }
        return `The canvas is showing ${path.basename(filePath)} (${ext}). It can't be rendered for preview; it's available to download.`;
      }
      // HTML -> render the SAME self-contained markup the canvas iframe shows
      // (relative assets inlined), so what the agent sees here matches exactly
      // what the user sees in the dock, including a missing image that failed
      // to resolve, rather than file:// quietly loading a sibling the dock can't.
      if (ext === '.html' || ext === '.htm') {
        const png = await renderToPng({ html: inlineHtmlAssets(filePath) });
        return await describeImage(agentId, png.toString('base64'), 'image/png', prompt);
      }
      // PDF / other -> render the file directly.
      const png = await renderToPng({ url: 'file://' + filePath });
      return await describeImage(agentId, png.toString('base64'), 'image/png', prompt);
    }

    // Inline HTML.
    if (target.html != null) {
      const png = await renderToPng({ html: target.html });
      return await describeImage(agentId, png.toString('base64'), 'image/png', prompt);
    }

    // A URL (external site or a hosted doc).
    const png = await renderToPng({ url: target.url! });
    return await describeImage(agentId, png.toString('base64'), 'image/png', prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('canvas_read failed', { error: msg }, agentId);
    return `Error viewing the canvas: ${msg}`;
  }
}
