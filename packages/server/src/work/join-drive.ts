// ════════════════════════════════════════════════════════════════════════════════
// THE GRIND-VS-TELL LADDER — SWEEP-A TB2 (`DESIGN-2BUGS/DESIGN.md` §2), OR2's own shape.
//
// ── THE THESIS THIS SERVES (owner ruling, 2026-08-05) ──
// The platform exists to make models FINISH long jobs. THE SYSTEM owns the job's convergence:
// a weak model only ever takes one bounded step, and coming back for the next one is the
// engine's work, not the model's memory. A long-job failure is never written off as "model
// limitation" while the system still has drives left.
//
// ── THE LADDER, AND EVERY BOUND IS STATED BESIDE ITS REASON ──
//   rungs 1..N   RE-DRIVE.  The engine wakes the agent and puts the owed step back in front
//                of it WITH the join's own results quoted. This is a REAL DRIVE, not a note
//                filed somewhere: `resolveCompilePendingJoins` re-issues the compile steer
//                and asks the runtime for a wakeup, so the model gets an actual turn.
//   rungs N+1..M THE AGENT TELLS THE OWNER.  The drives are spent; the person who asked is
//                owed the truth that the job is stuck. THE AGENT SAYS IT, in its own words —
//                the engine only steers, and VERIFIES via the delivery ledger. Retried to its
//                own bound because one steer can be missed.
//   last rung    PLATFORM TROUBLE.  The agent could not deliver even that: it is fully
//                unresponsive, which is a PLATFORM fault, and the platform's existing
//                watchdog/health surface is what says so. No new voice is built here.
//
// ── WHY THE NUMBERS ARE WHAT THEY ARE ──
// N = 3 is the orchestrator's stated judgment call under the Phase-0 standing authority
// (DESIGN §2), revisable by the owner: at the join sweep's 10-minute cadence three failed
// drives reach him inside roughly half an hour of a genuinely stuck job, and the turn-end
// drain runs the same ladder far faster when the agent is active at all. M = 2 is carried
// from `MAX_FLOOR_STEER_ATTEMPTS` (`agent/v2/floor-ghost.ts`), the platform's existing answer
// to "how many steers before silence is a fault": one to catch a distracted model, one to
// catch a model that read the first and did nothing. It is READ from that module rather than
// restated, so the two cannot drift.
//
// ── WHERE THE STATE LIVES, AND WHY THERE IS NO NEW COLUMN AND NO NEW EVENT KIND ──
// `work_events.kind` carries a CHECK (migration `152`) against the declared list in
// `event-kinds.ts`; a new kind is a table rebuild on every lived-in body, which this task is
// not allowed to spend. The ladder therefore rides `kind='audit'` with its own `entry_kind`
// inside the payload — the landing place migration `152`'s own header names for exactly this:
// *"`kind='audit'` is read in one module and nowhere else — so nothing filed there can answer
// a predicate that decides whether work counts as validated, escalated or poked."* The
// counter is a COUNT over those rows, never a maintained integer: it survives a restart, it
// cannot drift from the events that caused it, and `work.attempts` (the recurrence fire
// count) is left alone for the reason `work-reaper.ts` records at length.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { MAX_FLOOR_STEER_ATTEMPTS } from '../agent/v2/floor-ghost.js';
import { appendAuditEntry, AUDIT_KIND } from './audit-trail.js';

const logger = createLogger('join-drive');

/** How many REAL DRIVES back to the owed step the system spends before it stops grinding and
 *  starts telling. Orchestrator's judgment call, stated and revisable (DESIGN §2). */
export const JOIN_REDRIVE_BOUND = 3;

/** How many times the "tell the owner it is stuck" steer is retried before the silence is a
 *  platform fault. CARRIED, not chosen: `MAX_FLOOR_STEER_ATTEMPTS`, the platform's existing
 *  bounded-re-steer number, read from its own module so the two copies cannot drift. */
export const STUCK_NOTICE_RETRY_BOUND = MAX_FLOOR_STEER_ATTEMPTS;

/** The ladder's markers. Free strings inside the `audit` payload — see the header. */
export const JOIN_DRIVE_ENTRY = {
  /** One real drive back to the owed compile, with the join's results in front of the model. */
  redrive: 'join_redrive',
  /** One steer asking the AGENT to tell the owner the job is stuck. */
  stuckNotice: 'join_stuck_notice',
  /** The agent could not deliver even the notice; the platform surface was handed the fault. */
  ghosted: 'join_drive_ghosted',
} as const;

export type JoinDriveEntry = (typeof JOIN_DRIVE_ENTRY)[keyof typeof JOIN_DRIVE_ENTRY];

export type JoinDriveRung = 'redrive' | 'stuck-notice' | 'platform-trouble';

export interface JoinDriveDecision {
  rung: JoinDriveRung;
  /** 1-based, WITHIN the rung — "this is drive 2 of 3", not "this is step 2 of the ladder". */
  attempt: number;
  /** The bound this rung is spending against, so a log line can state it. */
  bound: number;
  redrives: number;
  stuckNotices: number;
}

/** How many of this marker are on the row. A COUNT over the log, never a stored integer. */
export function joinDriveCount(workId: string, entryKind: JoinDriveEntry): number {
  try {
    const r = getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events
        WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.entry_kind') = ?`,
    ).get(workId, AUDIT_KIND, entryKind) as { n: number } | undefined;
    return r?.n ?? 0;
  } catch (err) {
    // A ladder that cannot read its own counter must not spend an unbounded number of drives.
    // Reporting the count as already AT the bound is the safe direction: it escalates rather
    // than grinds, and the owner hears something rather than nothing.
    logger.warn('join drive: the ladder could not read its own counter; treating it as spent', {
      workId, entryKind, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Record one rung's spend on the row's own durable history. Returns the event rowid. */
export function recordJoinDrive(
  workId: string, entryKind: JoinDriveEntry, detail: { attempt: number; bound: number; note?: string },
): number {
  return appendAuditEntry(workId, 'engine', {
    entryKind,
    actionTaken: `${entryKind} ${detail.attempt}/${detail.bound}`,
    reason: detail.note ?? null,
  });
}

/**
 * WHAT THE LADDER DOES NEXT for this row, read entirely from the row's own history.
 *
 * Pure: it decides, it never spends. The caller performs the rung and then records it, so a
 * drive that could not actually be issued does not burn the bound.
 */
export function nextJoinDriveRung(workId: string): JoinDriveDecision {
  const redrives = joinDriveCount(workId, JOIN_DRIVE_ENTRY.redrive);
  if (redrives < JOIN_REDRIVE_BOUND) {
    return {
      rung: 'redrive', attempt: redrives + 1, bound: JOIN_REDRIVE_BOUND,
      redrives, stuckNotices: 0,
    };
  }
  const stuckNotices = joinDriveCount(workId, JOIN_DRIVE_ENTRY.stuckNotice);
  if (stuckNotices < STUCK_NOTICE_RETRY_BOUND) {
    return {
      rung: 'stuck-notice', attempt: stuckNotices + 1, bound: STUCK_NOTICE_RETRY_BOUND,
      redrives, stuckNotices,
    };
  }
  return { rung: 'platform-trouble', attempt: 1, bound: 1, redrives, stuckNotices };
}
