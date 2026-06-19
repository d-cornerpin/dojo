// ════════════════════════════════════════
// view_canvas — let the agent "look at" the right-dock canvas.
//
// The canvas is a client-side surface, so the server tracks the most recent
// thing the agent put there (setCurrentCanvas, called from show_canvas /
// open_browser). view_canvas then renders that content and routes it through
// the platform vision model:
//   - HTML (inline / .html file / any URL) -> headless Chromium screenshot
//   - image file                            -> the image itself
//   - PDF file                              -> Chromium screenshot (first view)
//   - text / markdown / code file           -> returned as text (cheaper +
//                                              more accurate than a screenshot)
//
// Vision uses getEffectiveVisionModel: the agent's own model if it is
// vision-capable, otherwise the configured fallback vision model — so this
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

const logger = createLogger('canvas-view');

export interface CanvasState {
  kind: 'canvas' | 'iframe';
  html?: string;
  url?: string;
  path?: string;
  title?: string;
}

// The dojo has a single dock surface, so a single "current canvas" matches the
// UI. Updated whenever the agent opens something in the dock.
let currentCanvas: CanvasState | null = null;

// Live re-render: watch the file currently shown in the canvas and tell the
// client to re-fetch whenever it changes on disk — NO MATTER how it was edited.
// The proper edit tools (file_write/file_patch, office_*) already ping the
// canvas, but weak models routinely reach for shell hacks instead (sed -i,
// python-docx, a heredoc redirect). Those bypass the in-tool ping, so without a
// disk watcher the canvas would show stale content after such an edit. Polling
// stat() (vs fs.watch) catches in-place writes AND atomic rename-replaces, on
// every platform.
let watchedPath: string | null = null;
function stopCanvasWatch(): void {
  if (watchedPath) {
    try { fs.unwatchFile(watchedPath); } catch { /* best effort */ }
    watchedPath = null;
  }
}
function startCanvasWatch(filePath: string): void {
  if (watchedPath === filePath) return;
  stopCanvasWatch();
  try {
    fs.watchFile(filePath, { interval: 700 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        try { broadcast({ type: 'canvas:updated', data: { path: filePath } }); } catch { /* best effort */ }
      }
    });
    watchedPath = filePath;
  } catch { /* best effort — never let watching break a canvas open */ }
}

export function setCurrentCanvas(state: CanvasState | null): void {
  currentCanvas = state;
  if (state?.kind === 'canvas' && state.path) startCanvasWatch(state.path);
  else stopCanvasWatch();
}
export function getCurrentCanvas(): CanvasState | null {
  return currentCanvas;
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
    ' broken-image placeholder / empty box (no real picture), say so explicitly — do NOT' +
    ' describe an absent or failed image as if it were present. Do not assume content you' +
    ' cannot see.';
  const instruction = userPrompt && userPrompt.trim()
    ? `Look at this canvas (a document/render the user and I are viewing together) and answer: ${userPrompt.trim()}.${accuracy}`
    : `Describe what is shown in this canvas in detail — layout, text, visuals, and anything notable.${accuracy}`;
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
    logger.warn('Vision model failed for view_canvas', { error: msg }, agentId);
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
    target = currentCanvas;
  }
  if (!target || (!target.html && !target.url && !target.path)) {
    return 'Error: nothing is open in the canvas. Show something first with show_canvas (or pass html / url / path to view a specific thing).';
  }

  logger.info('view_canvas', { kind: target.kind, hasHtml: !!target.html, hasUrl: !!target.url, hasPath: !!target.path }, agentId);

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
          truncated = `\n\n[...truncated — file is ${stat.size} bytes; showing the first ${TEXT_MAX_BYTES}.]`;
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
      // what the user sees in the dock — including a missing image that failed
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
    logger.warn('view_canvas failed', { error: msg }, agentId);
    return `Error viewing the canvas: ${msg}`;
  }
}
