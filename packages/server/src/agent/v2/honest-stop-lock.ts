// THE LIGHT HALF OF THE HONEST STOP: "is anything parked?", and the calls the doors make.
// Nothing parked costs one indexed read; the engine (`honest-stop.ts`) loads only via dynamic import.

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import type { HonestStopKind } from './error-format.js';
import { budgetStopCardsLifted } from '../../healer/owner-notices.js';
import { clearOn } from '../../memory/writer.js';

const logger = createLogger('honest-stop');

/** Thrown by the no-pick exit, which has already named the cause. */
export const BUDGET_STOP_CODE = 'BUDGET_STOP';
export const NO_MODEL_FITS_CODE = 'NO_MODEL_FITS';
/** The limit is reached AND no free model answered (the wall's redirect, or the router's own free picks). */
export const FREE_FALLBACK_DOWN_CODE = 'BUDGET_FREE_FALLBACK_DOWN';
/** The park's record of WHY after its tag: a free model existing is not enough to release this park. */
export const FREE_DOWN_TAG = '[free_down]';

export const lockTag = (kind: HonestStopKind): string => `[${kind}]`;

/** The owner-facing cause of a park: the words after the tag, neutralised to one line; else null. */
export function parkedCauseOf(status: unknown, lastError: unknown): string | null {
  if (status !== 'paused' || typeof lastError !== 'string') return null;
  const m = /^\[(?:budget_stop|no_model_fits)\]\s*(?:\[free_down\]\s*)?(.+)$/s.exec(lastError);
  return m ? m[1].replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : null;
}

export function parkedAgents(kind: HonestStopKind, agentId?: string): string[] {
  const tag = lockTag(kind);
  try {
    return (getDb().prepare(
      `SELECT id FROM agents WHERE status = 'paused' AND substr(last_error, 1, ?) = ? AND (? IS NULL OR id = ?)`,
    ).all(tag.length, tag, agentId ?? null, agentId ?? null) as Array<{ id: string }>).map((r) => r.id);
  } catch { return []; }
}

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
    if (kind === 'budget_stop' && released.length > 0 && parkedAgents(kind).length === 0) budgetStopCardsLifted();   // the last one is out, so the window's card leaves
    return released;
  } catch (err) {
    // The change that called this is already saved; a failed release is logged, never a failed save.
    logger.warn('honest stop: could not release', { kind, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** A limit was raised or a window turned over: release the agents it no longer stops. */
export const releaseClearedBudgetStops = (): Promise<string[]> => releaseIfParked('budget_stop', {});

export const noteModelsChanged = async (agentId?: string): Promise<void> => {
  clearOn({ kind: 'own-model-changed', agentId });
  await releaseIfParked('no_model_fits', { agentId });
  await releaseIfParked('budget_stop', { agentId, onModelsChange: true });   // only a "free fallback did not answer" park listens to this
};
