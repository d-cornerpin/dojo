// ════════════════════════════════════════
// The right-dock canvas, PER AGENT: what is on it, and whether the dock shows it.
// A background agent opens its own slot; the dashboard shows only the viewed agent's, so a background
// open can never replace it. No GC of per-agent rows: accepted at this scale. This module touches no file.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { resolveHomePath } from './path-resolve.js';
import { startCanvasWatch, stopCanvasWatch } from './canvas-watch.js';

export interface CanvasState {
  kind: 'canvas' | 'iframe' | 'screenshot';
  html?: string;
  url?: string;
  path?: string;
  title?: string;
  /** screenshot: the original website URL behind the captured PNG. */
  sourceUrl?: string;
}

const currentCanvasByAgent = new Map<string, CanvasState>();

// OPEN (dock showing) or COLLAPSED (edge handle, content kept); persisted per agent so it survives restart.
export type CanvasStatus = 'open' | 'collapsed';
const canvasStatusByAgent = new Map<string, CanvasStatus>();
const hydratedAgents = new Set<string>();
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

// Rehydrate from the DB on first access, so a restart does not drop an open canvas.
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
  // Opening brings the dock OPEN (the agent put it there to be seen); clearing resets to collapsed.
  canvasStatusByAgent.set(agentId, state ? 'open' : 'collapsed');
  if (state?.kind === 'canvas' && state.path) startCanvasWatch(agentId, state.path);
  else stopCanvasWatch(agentId);
  persistCanvas(agentId);
}
export function getCurrentCanvas(agentId: string): CanvasState | null {
  hydrateCanvas(agentId);
  return currentCanvasByAgent.get(agentId) ?? null;
}
export function getPersistedCanvas(agentId: string): { state: CanvasState; status: CanvasStatus } | null {
  hydrateCanvas(agentId);
  const state = currentCanvasByAgent.get(agentId);
  return state ? { state, status: canvasStatusByAgent.get(agentId) ?? 'collapsed' } : null;
}
export function setCanvasStatus(agentId: string, status: CanvasStatus): void {
  hydrateCanvas(agentId);
  if (!currentCanvasByAgent.has(agentId)) return;
  canvasStatusByAgent.set(agentId, status);
  persistCanvas(agentId);
}

// THE one resolution point for "which file is this agent's canvas showing?"; null when nothing is open.
// canvas_read takes a prompt, no path: the file the agent put on its own canvas earlier, keyed by its id.
// The gate loop resolves it with THIS function: the handler's own reader plus its own home expansion,
// so the two cannot answer differently; null means no grant, leaving the handler's own message intact.
export function canvasFilePath(agentId: string): { path: string } | null {
  const state = getCurrentCanvas(agentId);
  return state?.path ? { path: resolveHomePath(state.path) } : null;
}
