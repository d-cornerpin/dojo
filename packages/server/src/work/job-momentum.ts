// v3.5 DONE IS MEASURED, Task D1 — the two records a turn end leaves on a job's task, and the one
// read of them. Written by the engine (`'engine'`), so neither reads as the task moving
// (`taskMovedAtSql`), and the park that writes `continued` does not touch the task's last-moved time
// either (`engine-checkpoint-note.ts`): a continuation is not progress, and a stall is its absence.
//
//   `continued` — the turn ended mid-job WITH momentum and the engine continued it
//                 (`agent/v2/steps/post-call-classify/job-continues.ts`);
//   `stalled`   — a turn the engine continued came back with NO momentum. Nothing is parked or
//                 closed; the PM's check-in ladder takes the task, and its closeout-miss report
//                 names the stall and the count (`tracker/pm-agent.ts`).
import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import type { WorkEventKind } from './event-kinds.js';

export const CONTINUED_EVENT = 'continued' as const satisfies WorkEventKind;
export const STALLED_EVENT = 'stalled' as const satisfies WorkEventKind;

/** `remaining` is the measure's count (or its last stored reading). */
export interface ContinuedFacts { remaining: number; touchedThisTurn: number; novelCallsThisTurn: number; turnNumber: number }
export interface StalledFacts { remaining: number; turnNumber: number }

export function recordContinued(taskId: string, f: ContinuedFacts): void {
  appendWorkEvent(taskId, CONTINUED_EVENT, 'engine', f);
}

export function recordStalled(taskId: string, f: StalledFacts): void {
  appendWorkEvent(taskId, STALLED_EVENT, 'engine', f);
}

/** How the task's last turn ended, as its spine records it: the latest `continued`, `stalled` or
 *  `claim_turn` event (the plan's "previous turn's kind"), with its payload and when it was written.
 *  null when none. */
export function lastTurnEnd(taskId: string): { kind: 'continued' | 'stalled' | 'claim_turn'; payload: Record<string, unknown>; at: number } | null {
  const r = getDb().prepare(
    `SELECT kind, payload, created_at AS at FROM work_events WHERE work_id = ? AND kind IN ('continued', 'stalled', 'claim_turn') ORDER BY id DESC LIMIT 1`,
  ).get(taskId) as { kind: 'continued' | 'stalled' | 'claim_turn'; payload: string | null; at: number } | undefined;
  if (!r) return null;
  let payload: Record<string, unknown> = {};
  try { payload = r.payload ? JSON.parse(r.payload) as Record<string, unknown> : {}; } catch { /* an unreadable payload reads as empty */ }
  return { kind: r.kind, payload, at: r.at };
}
