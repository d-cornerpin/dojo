// Turn-end records on a job's task, both engine-written so `taskMovedAtSql` never reads them as a move:
// `continued` (ended mid-job with momentum, written by `agent/v2/steps/post-call-classify/job-continues.ts`)
// and `stalled` (a continued turn came back with none; `work/done/ladder.ts` takes it from there).
import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import type { WorkEventKind } from './event-kinds.js';

export const CONTINUED_EVENT = 'continued' as const satisfies WorkEventKind;
export const STALLED_EVENT = 'stalled' as const satisfies WorkEventKind;

export interface ContinuedFacts { remaining: number; touchedThisTurn: number; novelCallsThisTurn: number; turnNumber: number }
export interface StalledFacts { remaining: number | null; turnNumber: number }

export function recordContinued(taskId: string, f: ContinuedFacts): void {
  appendWorkEvent(taskId, CONTINUED_EVENT, 'engine', f);
}

export function recordStalled(taskId: string, f: StalledFacts): void {
  appendWorkEvent(taskId, STALLED_EVENT, 'engine', f);
}

/** How the task's last turn ended: its latest `continued` or `stalled` event, payload and time, or null. ONLY
 *  those two: a `claim_turn` or a note says a turn worked the task, not how it ended. */
export function lastTurnEnd(taskId: string): { kind: 'continued' | 'stalled'; payload: Record<string, unknown>; at: number } | null {
  const r = getDb().prepare(
    `SELECT kind, payload, created_at AS at FROM work_events WHERE work_id = ? AND kind IN ('continued', 'stalled') ORDER BY id DESC LIMIT 1`,
  ).get(taskId) as { kind: 'continued' | 'stalled'; payload: string | null; at: number } | undefined;
  if (!r) return null;
  let payload: Record<string, unknown> = {};
  try { payload = r.payload ? JSON.parse(r.payload) as Record<string, unknown> : {}; } catch { /* an unreadable payload reads as empty */ }
  return { kind: r.kind, payload, at: r.at };
}
