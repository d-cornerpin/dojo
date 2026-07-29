// PHASE-2 T8c — THE DRIVE LADDER'S MEMORY, ON THE SPINE.
//
// The escalation ladder used to remember which rung a task was on by counting rows in
// `poke_log`, and it re-armed the ladder by DELETING them (`clearPokeLog`). Two things were
// wrong with that, and both are requirements, not tidiness:
//
//   1. `poke_log` is a fifth parallel store of a fact the work spine already records. Research
//      19 §1c folds it into `work_events` with `task_log` and the override requests, and
//      Part III lists it under "deleted, permanently". A poke is an EVENT ON THE WORK, which
//      is precisely what `work_events` is.
//   2. Re-arming by DELETE destroys the history it re-arms past. After an auto-reset nobody
//      could answer "how many times has this task stalled" — the evidence had been removed to
//      make a counter read zero. The same shape as `revert_count`, which T8b already turned
//      from a maintained integer into `COUNT(adjudications rejected)` past a reset MARKER.
//
// So the rung is a QUERY, not a stored counter:
//
//     MAX(rung) FROM work_events WHERE kind='poke' AND created_at > <the last remediation>
//
// and a remediation is its own `work_events` row rather than a DELETE. The ladder re-arms
// because the window moved, and the pokes that came before it are still on the record.
//
// requirement preserved: (a) the cross-restart poke dedup — a rung already sent inside the
// current cycle is never re-sent, because the query sees it after any restart, exactly as the
// row count did; (b) re-arm happens ONLY at a remediation event (reassign, retask, auto-reset,
// receipt close), never mid-cycle, which is what `clearPokeLog`'s invariant comment said and
// what `recordRemediation` now says by being the only thing that moves the window.
//
// WRITER-MODULE LAW: this file lives under `work/` because it writes `work_events`
// (single-writer clause (a), T6 acceptance §3). It writes through `appendWorkEvent`, so
// `work_events` still has one writing FUNCTION.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { appendWorkEvent } from './store.js';

const logger = createLogger('poke-ladder');

/** The two event kinds this ladder owns. Declared once so a writer and a reader cannot
 *  disagree by typo — the failure mode research 03 catalogued. */
export const POKE_EVENT = 'poke';
export const REMEDIATION_EVENT = 'poke_remediation';

export interface PokeRecord {
  /** The ladder rung this poke was: 1 nudge, 2 urgent, 3 escalate_primary, 4 auto_reset. */
  rung: number;
  pokeType: string;
  /** epoch ms — the spine's time unit, so no reader has to parse a string. */
  sentAtMs: number;
}

/**
 * Where the current escalation cycle begins: the `work_events.id` of the last remediation, or
 * 0 when this work has never been remediated.
 *
 * ⚠ THE BOUNDARY IS THE EVENT ID, NOT `created_at`, AND THAT IS NOT A STYLE CHOICE. This
 * module's own test caught the clock version failing: `created_at` is `Date.now()`, so a
 * remediation and the very next poke can land in the SAME millisecond, and `created_at >
 * remediationAt` then excludes a poke that genuinely came after — the ladder would sit on
 * rung 0 forever while pokes were being sent. `work_events.id` is `INTEGER PRIMARY KEY
 * AUTOINCREMENT`: strictly increasing, never reused, immune to clock resolution. Same lesson
 * as the scheduler's millisecond-truncated CAS (item 4): when a sequence exists, do not
 * compare a clock.
 */
function cycleStartEventId(workId: string): number {
  const r = getDb().prepare(
    `SELECT MAX(id) AS id FROM work_events WHERE work_id = ? AND kind = ?`,
  ).get(workId, REMEDIATION_EVENT) as { id: number | null } | undefined;
  return r?.id ?? 0;
}

/**
 * The rung this work has already reached inside the CURRENT cycle.
 *
 * `MAX(rung)`, not `COUNT(*)`: the ladder skips rungs whenever a threshold is crossed while
 * the assignee was busy, and counting rows would let a skipped rung be re-served later. The
 * old code read `poke_log.poke_number DESC LIMIT 1`, which is the same MAX with the same
 * meaning — this is the rekey of that read, not a new rule.
 */
export function currentRung(workId: string): number {
  const r = getDb().prepare(
    `SELECT MAX(CAST(json_extract(payload, '$.rung') AS INTEGER)) AS rung
       FROM work_events
      WHERE work_id = ? AND kind = ? AND id > ?`,
  ).get(workId, POKE_EVENT, cycleStartEventId(workId)) as { rung: number | null } | undefined;
  return r?.rung ?? 0;
}

/** The most recent poke of the current cycle, or null when the cycle is fresh. */
export function lastPoke(workId: string): PokeRecord | null {
  const r = getDb().prepare(
    `SELECT payload, created_at FROM work_events
      WHERE work_id = ? AND kind = ? AND id > ?
      ORDER BY id DESC LIMIT 1`,
  ).get(workId, POKE_EVENT, cycleStartEventId(workId)) as
    { payload: string | null; created_at: number } | undefined;
  if (!r) return null;
  let rung = 0;
  let pokeType = '';
  try {
    const p = JSON.parse(r.payload ?? '{}') as { rung?: number; poke_type?: string };
    rung = p.rung ?? 0;
    pokeType = p.poke_type ?? '';
  } catch { /* a malformed payload is a poke with no rung, which the MAX above already skips */ }
  return { rung, pokeType, sentAtMs: r.created_at };
}

/** Record a poke that was just sent. The rung rides the payload because the rung IS the fact
 *  the ladder reads back; `actor` is the PM (or the engine) that sent it. */
export function recordPoke(
  workId: string, actorId: string, rung: number, pokeType: string, recipientId: string,
): void {
  appendWorkEvent(workId, POKE_EVENT, actorId, { rung, poke_type: pokeType, recipient: recipientId });
  logger.info('poke recorded', { workId, rung, pokeType, recipientId });
}

/**
 * Re-arm the ladder.
 *
 * INVARIANT, carried verbatim from `clearPokeLog`'s: call this ONLY at a remediation event
 * (reassign, retask, auto-reset, receipt close), never mid-cycle. Each remediation starts a
 * genuinely new escalation cycle, and moving the window here is what lets the deterministic
 * ladder start fresh from nudge(1) the next time the work stalls. Because nothing else moves
 * the window, the cross-restart poke dedup stays intact.
 *
 * The difference from the DELETE it replaces: the earlier cycle's pokes are still on the
 * record afterwards, so "this task has stalled three times" is answerable.
 */
export function recordRemediation(workId: string, actorId: string, reason: string): void {
  appendWorkEvent(workId, REMEDIATION_EVENT, actorId, { reason });
  logger.info('poke ladder re-armed (remediation, new escalation cycle)', { workId, reason });
}
