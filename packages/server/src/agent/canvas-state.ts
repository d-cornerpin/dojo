// ════════════════════════════════════════
// The right-dock canvas, PER AGENT — what is on it, and whether it is showing.
//
// Each agent owns its own dock slot, keyed by agentId. A background agent
// finishing a delegated job opens ITS slot; the dashboard shows only the slot of
// the agent the user is currently viewing (client-side, off the agentId stamped
// on every dock event), so a background open can never replace the viewed
// agent's canvas. (No GC of per-agent rows when an agent is deleted; that's an
// accepted choice at this scale, one small config row per agent.)
//
// This module touches NO file. It was separated out of `canvas-view.ts`
// (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM 3(3)) because that module held
// three different things behind one `node:fs` import: the dispatch-only viewer,
// this state, and the disk watcher whose callback fires outside any dispatch.
// ════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
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

export function resolveHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * THE ONE RESOLUTION POINT for *which file is this agent's canvas showing?*
 * (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM 3(1)(b)).
 *
 * `canvas_read` takes a `prompt` and nothing else — its schema names no path and
 * its one production call site passes none — so the resource is the file the
 * agent put on its own canvas EARLIER, and the CALL'S OWN AGENT IDENTITY is the
 * only key there is. The gate loop resolves it with this function, which is the
 * handler's own reader (`getCurrentCanvas`) followed by the handler's own home
 * expansion, so the two cannot answer differently.
 *
 * An agent with nothing on its canvas resolves to `null` and gets no grant,
 * which leaves the handler's own "nothing is open in the canvas" message intact.
 */
export function canvasFilePath(agentId: string): { path: string } | null {
  const state = getCurrentCanvas(agentId);
  return state?.path ? { path: resolveHome(state.path) } : null;
}
