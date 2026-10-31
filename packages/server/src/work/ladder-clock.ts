import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import { AUDIT_KIND, LADDER_HELD_ENTRY } from './audit-trail.js';

// THE LADDER'S CLOCK (t151) — split from `poke-ladder.ts`, which keeps the rung and the pokes.
//
// DOES NOT RUN WHILE THE PM IS NOT ALLOWED TO POKE.
//
// The sweep leaves a task alone while its assignee is working (a long job keeps it `working` from
// the first call to the last park). The idle clock is the task's age, so the first sweep after the
// job found the whole job's length as idleness and sent the TOP rung — an escalation "after 2 pokes"
// with none on the record (t143 live walk, items 3 and 10). Time spent behind the agent's own work
// is not time the task sat ignored. The sweep that first leaves a task alone writes the instant
// down as ONE `ladder_held` marker row on the task's own record (so a restart in the middle of a long job
// resumes the stretch, never re-counts it as idleness; the marker is hidden from the task log); the first sweep that may
// poke again closes the stretch, and a stretch that was long enough to have mattered (as long as the
// ladder's own first rung) is written to the task's record as ONE `resumed` row. The ladder's idle is
// its age minus the closed stretches. Nothing is counted, nothing is a dial; shorter stretches are
// simply ordinary idleness, as before. Rows ride `kind='audit'` (no new event kind, no migration).

export const LADDER_RESUMED_ENTRY = 'ladder_resumed';

/** The open stretch's marker for this task, if the sweep is holding it. */
function openMarker(workId: string): { id: number; since: number } | null {
  const row = getDb().prepare(
    `SELECT id, COALESCE(json_extract(payload, '$.held_since'), created_at) AS since
       FROM work_events
      WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.entry_kind') = ?
      ORDER BY id LIMIT 1`,
  ).get(workId, AUDIT_KIND, LADDER_HELD_ENTRY) as { id: number; since: number } | undefined;
  return row ?? null;
}

/** The sweep is leaving this task alone because its assignee is busy. Remembered from the first sweep,
 *  across restarts: the marker is on the task's record. */
export function holdLadder(workId: string, actorId: string): void {
  if (openMarker(workId)) return;
  appendWorkEvent(workId, AUDIT_KIND, actorId, {
    entry_kind: LADDER_HELD_ENTRY, from_status: null, to_status: null,
    reason: null, action_taken: null, note: null, evidence_json: null, held_since: Date.now(),
  });
}

/** The sweep may poke this task again. Closes an open stretch; writes it down when it was a long one. */
export function resumeLadder(workId: string, actorId: string, longEnoughMs: number): void {
  const marker = openMarker(workId);
  if (!marker) return;
  getDb().prepare('DELETE FROM work_events WHERE id = ?').run(marker.id);
  if (Date.now() - marker.since < longEnoughMs) return;
  appendWorkEvent(workId, AUDIT_KIND, actorId, {
    entry_kind: LADDER_RESUMED_ENTRY, from_status: null, to_status: null,
    reason: 'the assignee is free again; the idle clock did not run while it was working',
    action_taken: null, note: null, evidence_json: null, held_since: marker.since,
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
