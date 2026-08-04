// ════════════════════════════════════════
// The canvas disk watcher — one watcher PER AGENT.
//
// Live re-render: watch the file currently shown in an agent's canvas and tell
// the client to re-fetch whenever it changes on disk, NO MATTER how it was
// edited. The proper edit tools (file_write/file_patch, office_*) already ping
// the canvas, but weak models routinely reach for shell hacks instead (sed -i,
// python-docx, a heredoc redirect). Those bypass the in-tool ping, so without a
// disk watcher the canvas would show stale content after such an edit. Polling
// stat() (vs fs.watch) catches in-place writes AND atomic rename-replaces, on
// every platform. The canvas:updated it emits carries the agentId, so an edit to
// agent B's file can never refresh agent A's canvas.
//
// ── WHY THIS PAIR KEEPS `node:fs` (PHASE-5 T8 Step 4, RULING P5-R15 ADDENDUM 3(3)) ──
// It takes the owner's DECIDED honest-label disposition — *agent-influenced
// resource, platform-timed execution: authorized when the agent asked, not
// re-checked when the platform acts* — and the measured reason is twofold:
//   * the watched path is set from BOTH populations (a tool opening a canvas and
//     the dashboard's own hydrate on mount), so there is no half to move; and
//   * the callback fires from a polling timer, outside any dispatch, so a
//     converted site would hold no capability and would refuse working behaviour
//     — a new refusal, which is never a worker's to invent (P5-R5).
// It is its own module so the residual is exactly these two calls rather than
// two calls hidden inside a 300-line one; the viewer and the state surface next
// door hold no restricted import at all.
// ════════════════════════════════════════

import fs from 'node:fs';
import { broadcast } from '../gateway/ws.js';

const watchedPathByAgent = new Map<string, string>();

export function stopCanvasWatch(agentId: string): void {
  const watched = watchedPathByAgent.get(agentId);
  if (watched) {
    try { fs.unwatchFile(watched); } catch { /* best effort */ }
    watchedPathByAgent.delete(agentId);
  }
}

export function startCanvasWatch(agentId: string, filePath: string): void {
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
