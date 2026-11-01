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

/** How the task's last turn ended, as its spine records it (the plan's "previous turn's kind"): the
 *  `continued` or `stalled` that turn wrote, else the `claim_turn` that only says the turn worked the
 *  task (`work/task-turns.ts`). A turn's record is compared by TURN NUMBER, not by write order: the
 *  `claim_turn` is written at the turn's end, after its `continued`/`stalled`, and must not hide it.
 *  A later turn that wrote neither is the last turn, and reads `claim_turn`. null when none. */
export function lastTurnEnd(taskId: string): { kind: 'continued' | 'stalled' | 'claim_turn'; payload: Record<string, unknown>; at: number } | null {
  const db = getDb();
  type Row = { id: number; kind: 'continued' | 'stalled' | 'claim_turn'; payload: string | null; at: number };
  const pick = (kinds: string): Row | undefined => db.prepare(
    `SELECT id, kind, payload, created_at AS at FROM work_events WHERE work_id = ? AND kind IN (${kinds}) ORDER BY id DESC LIMIT 1`,
  ).get(taskId) as Row | undefined;
  const parse = (r: Row): Record<string, unknown> => {
    try { return r.payload ? JSON.parse(r.payload) as Record<string, unknown> : {}; } catch { return {}; }   // an unreadable payload reads as empty
  };
  const claim = pick("'claim_turn'");
  const end = pick("'continued', 'stalled'");
  if (!claim && !end) return null;
  let r: Row;
  if (!claim || !end) r = (claim ?? end)!;
  else {
    const endTurn = parse(end).turnNumber;
    const claimTurn = parse(claim).turn_number;
    const endIsLast = typeof endTurn === 'number' && typeof claimTurn === 'number' ? endTurn >= claimTurn : end.id > claim.id;
    r = endIsLast ? end : claim;
  }
  return { kind: r.kind, payload: parse(r), at: r.at };
}
