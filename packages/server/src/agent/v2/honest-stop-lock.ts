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
import { budgetStopCardsLifted } from '../../healer/owner-notices.js';

const logger = createLogger('honest-stop');

/** Thrown by the t140 no-pick exit, which has already named the cause. */
export const BUDGET_STOP_CODE = 'BUDGET_STOP';
export const NO_MODEL_FITS_CODE = 'NO_MODEL_FITS';
/** t149 round 3: the limit is reached AND no free model answered (the wall's redirect, or the router's own free picks). */
export const FREE_FALLBACK_DOWN_CODE = 'BUDGET_FREE_FALLBACK_DOWN';
/** The park's record of WHY, right after its tag: the free fallback did not answer (a free model existing is not enough to release it). */
export const FREE_DOWN_TAG = '[free_down]';

export const lockTag = (kind: HonestStopKind): string => `[${kind}]`;

/** The owner-facing cause of a park, for the dashboard: the words after the tag, neutralised (control
 *  characters and angle brackets out, one line, capped). null for anything that is not a park. */
export function parkedCauseOf(status: unknown, lastError: unknown): string | null {
  if (status !== 'paused' || typeof lastError !== 'string') return null;
  const m = /^\[(?:budget_stop|no_model_fits)\]\s*(?:\[free_down\]\s*)?(.+)$/s.exec(lastError);
  return m ? m[1].replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : null;
}

/** The agents the lock holds for `kind` (optionally just one). */
export function parkedAgents(kind: HonestStopKind, agentId?: string): string[] {
  const tag = lockTag(kind);
  try {
    return (getDb().prepare(
      `SELECT id FROM agents WHERE status = 'paused' AND substr(last_error, 1, ?) = ? AND (? IS NULL OR id = ?)`,
    ).all(tag.length, tag, agentId ?? null, agentId ?? null) as Array<{ id: string }>).map((r) => r.id);
  } catch { return []; }
}

/** Is this agent's budget park the "free fallback did not answer" kind? */
export function parkedForFreeDown(agentId: string): boolean {
  try {
    const row = getDb().prepare('SELECT status, last_error FROM agents WHERE id = ?').get(agentId) as { status: string; last_error: string | null } | undefined;
    return row?.status === 'paused' && !!row.last_error?.startsWith(`${lockTag('budget_stop')} ${FREE_DOWN_TAG}`);
  } catch { return false; }
}

async function releaseIfParked(kind: HonestStopKind, opts: { agentId?: string; onModelsChange?: boolean }): Promise<string[]> {
  if (parkedAgents(kind, opts.agentId).length === 0) return [];
  try {
    const released = await (await import('./honest-stop.js')).releaseHonestStops(kind, opts);
    if (kind === 'budget_stop' && released.length > 0 && parkedAgents(kind).length === 0) budgetStopCardsLifted();   // t167: the last one is out, so the window's card leaves
    return released;
  } catch (err) {
    // The change that called this is already saved; a failed release is logged, never a failed save.
    logger.warn('honest stop: could not release', { kind, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** A limit was raised or a window turned over: release the agents it no longer stops. */
export const releaseClearedBudgetStops = (): Promise<string[]> => releaseIfParked('budget_stop', {});

/** A model, tier, window or tool list changed: every no-fit lock (or one agent's) gets another look. */
export const noteModelsChanged = async (agentId?: string): Promise<void> => {
  await releaseIfParked('no_model_fits', { agentId });
  await releaseIfParked('budget_stop', { agentId, onModelsChange: true });   // t149: only a "free fallback did not answer" park listens to this
};
