// ════════════════════════════════════════════════════════════════════════════════════════
// t148 — THE LIGHT HALF OF THE HONEST STOP: "is anything parked?", and the calls the doors make.
//
// The doors that lift an honest stop (the limit route, the models/tier/agent routes, the scheduler
// tick that runs every 30 seconds) ask here first. This file touches only the database, so a door
// with nothing parked pays one indexed read and loads nothing of the engine; the engine half
// (`honest-stop.ts`) is loaded only when an agent is actually parked. The tag in `last_error` is
// the lock's whole record (see `honest-stop.ts` for what it means and how it is released).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import type { HonestStopKind } from './error-format.js';

const logger = createLogger('honest-stop');

export const lockTag = (kind: HonestStopKind): string => `[${kind}]`;

/** The agents the lock holds for `kind` (optionally just one). */
export function parkedAgents(kind: HonestStopKind, agentId?: string): string[] {
  const tag = lockTag(kind);
  try {
    return (getDb().prepare(
      `SELECT id FROM agents WHERE status = 'paused' AND substr(last_error, 1, ?) = ? AND (? IS NULL OR id = ?)`,
    ).all(tag.length, tag, agentId ?? null, agentId ?? null) as Array<{ id: string }>).map((r) => r.id);
  } catch { return []; }
}

async function releaseIfParked(kind: HonestStopKind, opts: { agentId?: string; onlyWhereCleared?: boolean }): Promise<string[]> {
  if (parkedAgents(kind, opts.agentId).length === 0) return [];
  try {
    return await (await import('./honest-stop.js')).releaseHonestStops(kind, opts);
  } catch (err) {
    // The change that called this is already saved; a failed release is logged, never a failed save.
    logger.warn('honest stop: could not release', { kind, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** A limit was raised or a window turned over: release the agents it no longer stops. */
export const releaseClearedBudgetStops = (): Promise<string[]> => releaseIfParked('budget_stop', { onlyWhereCleared: true });

/** A model, tier, window or tool list changed: every no-fit lock (or one agent's) gets another look. */
export const noteModelsChanged = async (agentId?: string): Promise<void> => { await releaseIfParked('no_model_fits', { agentId }); };
