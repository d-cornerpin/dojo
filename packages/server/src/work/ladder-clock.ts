import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import { AUDIT_KIND } from './audit-trail.js';

// THE LADDER'S CLOCK (t151) — split from `poke-ladder.ts`, which keeps the rung and the pokes.
//
// DOES NOT RUN WHILE THE PM IS NOT ALLOWED TO POKE.
//
// The sweep leaves a task alone while its assignee is working (a long job keeps it `working` from
// the first call to the last park). The idle clock is the task's age, so the first sweep after the
// job found the whole job's length as idleness and sent the TOP rung — an escalation "after 2 pokes"
// with none on the record (t143 live walk, items 3 and 10). Time spent behind the agent's own work
// is not time the task sat ignored. The sweep that first leaves a task alone notes the instant
// (process memory: a stretch is as long as the process that observed it); the first sweep that may
// poke again closes the stretch, and a stretch that was long enough to have mattered (as long as the
// ladder's own first rung) is written to the task's record as ONE `resumed` row. The ladder's idle is
// its age minus the closed stretches. Nothing is counted, nothing is a dial; shorter stretches are
// simply ordinary idleness, as before. Rows ride `kind='audit'` (no new event kind, no migration).

export const LADDER_RESUMED_ENTRY = 'ladder_resumed';

const heldSince = new Map<string, number>();

/** The sweep is leaving this task alone because its assignee is busy. Remembered from the first sweep. */
export function holdLadder(workId: string): void {
  if (!heldSince.has(workId)) heldSince.set(workId, Date.now());
}

/** The sweep may poke this task again. Closes an open stretch; writes it down when it was a long one. */
export function resumeLadder(workId: string, actorId: string, longEnoughMs: number): void {
  const since = heldSince.get(workId);
  if (since === undefined) return;
  heldSince.delete(workId);
  if (Date.now() - since < longEnoughMs) return;
  appendWorkEvent(workId, AUDIT_KIND, actorId, {
    entry_kind: LADDER_RESUMED_ENTRY, from_status: null, to_status: null,
    reason: 'the assignee is free again; the idle clock did not run while it was working',
    action_taken: null, note: null, evidence_json: null, held_since: since,
  });
}

/** Milliseconds of `[sinceMs, now]` the ladder spent held (closed stretches only: an open one is
 *  the sweep that is skipping the task, and never reaches the clock). */
export function heldMsSince(workId: string, sinceMs: number): number {
  const rows = getDb().prepare(
    `SELECT created_at AS at, json_extract(payload, '$.held_since') AS held_since
       FROM work_events
      WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.entry_kind') = ? AND created_at > ?`,
  ).all(workId, AUDIT_KIND, LADDER_RESUMED_ENTRY, sinceMs) as Array<{ at: number; held_since: number | null }>;
  return rows.reduce((sum, r) => sum + (r.at - Math.max(r.held_since ?? r.at, sinceMs)), 0);
}
