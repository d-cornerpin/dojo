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
import { AUDIT_KIND } from './audit-trail.js';
import { appendWorkEvent } from './store.js';

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
  /** A drive pass that landed on a turn a rung was ALREADY spent on — the model has not had a
   *  turn since the last steer, so this pass is not a chance and does not spend one. Recorded
   *  so the deferral is a fact on the row rather than an absence in the log. */
  redriveDeferred: 'join_redrive_deferred',
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

/** How many of this marker are on the row. A COUNT over the log, never a stored integer.
 *
 *  UX-REPAIR round 2 T10 note: this stayed a plain COUNT, deliberately. The sibling ladder
 *  (`work/run-deliver-drive.ts:76-92`) counts DISTINCT TURNS because every one of its passes
 *  originates in a turn, so a turn key that never moves means no pass ever happens. This
 *  ladder's second driver is the 10-minute reaper, which fires whether the agent runs turns or
 *  not — so a DISTINCT-turn count here would stall the ladder for exactly the agent it exists
 *  to catch: one that has stopped running turns altogether, whose owner is then never told.
 *  The same discipline is applied one layer up instead, where it cannot stall: a pass that is
 *  not a real chance is RECORDED as `redriveDeferred` rather than `redrive`
 *  (`joinRedriveIsBlind`), so the rung is not spent and the deferral is still visible. */
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

/** Record one rung's spend on the row's own durable history. Returns the event rowid.
 *
 *  `turnNumber` is what the bound is counted in (see `joinDriveCount`) — the turn the agent was
 *  on when the drive was issued. It is written through `appendWorkEvent` rather than
 *  `appendAuditEntry` only because the trail's field set is fixed; every key `appendAuditEntry`
 *  writes is written here byte-identically, so `readAuditTrail` renders these rows unchanged. */
export function recordJoinDrive(
  workId: string, entryKind: JoinDriveEntry,
  detail: { attempt: number; bound: number; note?: string; turnNumber?: number | null },
): number {
  return appendWorkEvent(workId, AUDIT_KIND, 'engine', {
    entry_kind: entryKind,
    from_status: null,
    to_status: null,
    reason: detail.note ?? null,
    action_taken: `${entryKind} ${detail.attempt}/${detail.bound}`,
    note: null,
    evidence_json: null,
    turn_number: detail.turnNumber ?? null,
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

/**
 * IS THIS PASS A REAL CHANCE, OR A RE-RUN AGAINST A TURN THAT HAS ALREADY HAD ONE?
 *
 * ── WHAT IT IS FOR (measured, S4 2026-08-10) ──
 * Two drive passes landed either side of one turn boundary with no turn in between: the
 * 10-minute reaper at 06:17:10, with turn 4553 already in flight and its context long since
 * assembled, and the turn-end drain of that SAME turn at 06:18:01. Two of three rungs, 51
 * seconds apart, against a model that had not run once since the first steer. That is the same
 * class `work/run-deliver-drive.ts:76-92` fixed for the run ladder after `bmslqef2w3r`: a rung
 * is meant to be a DRIVE — a separate attempt with a turn in between for the agent to act on
 * the steer — so the unit is the turn.
 *
 * ── AND WHY THE GRACE IS EXACTLY ONE PASS ──
 * The ladder's LAST rung exists for an agent that is not speaking at all, and that agent's turn
 * key never moves. An unbounded "wait for a new turn" would therefore silence the ladder for
 * precisely the case it was built to catch. So a turn gets ONE deferral: the pass that finds a
 * rung already spent here and no deferral yet recorded here. The next pass accepts that the key
 * is not going to move and spends. Worst case the ladder takes one extra pass per rung; the
 * platform rung stays reachable, which the governing priority ("it never errs toward silence")
 * requires. `selfWakeStandDown`'s burn is covered by the same rule — standing the wake down
 * means no turn happens, so the key does not move.
 */
export function joinRedriveIsBlind(workId: string, turnNumber: number | null): boolean {
  if (turnNumber === null) return false;
  try {
    const seen = getDb().prepare(
      `SELECT json_extract(payload, '$.entry_kind') AS entry_kind
         FROM work_events
        WHERE work_id = ? AND kind = ?
          AND json_extract(payload, '$.turn_number') = ?
          AND json_extract(payload, '$.entry_kind') IN (?, ?)`,
    ).all(
      workId, AUDIT_KIND, turnNumber,
      JOIN_DRIVE_ENTRY.redrive, JOIN_DRIVE_ENTRY.redriveDeferred,
    ) as Array<{ entry_kind: string }>;
    const spentHere = seen.some((r) => r.entry_kind === JOIN_DRIVE_ENTRY.redrive);
    const deferredHere = seen.some((r) => r.entry_kind === JOIN_DRIVE_ENTRY.redriveDeferred);
    return spentHere && !deferredHere;
  } catch (err) {
    // Unreadable history: treat the pass as a real one. Spending a rung keeps the ladder MOVING
    // toward telling the owner, which is the safe direction for this failure.
    logger.warn('join drive: could not read the turn the last rung was spent on; treating this pass as a real drive', {
      workId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * THE COMPILE ORDER, as text. Pure, and exported for the same reason `runDeliverSteerText` is:
 * the wording is incident-derived and belongs beside the ladder that spends it, where a test
 * can read it without driving a turn.
 *
 * ── WHY THE IMPERATIVE COMES FIRST (UX-REPAIR round 2 T10) ──
 * This row reaches the model through the EVENTS & NOTICES lane, which renders each row as a
 * 400-char gist (`memory/lanes.ts:308`, applied at `memory/assembler.ts:1099-1111`). The
 * original wording put "Compose ONE reply to the owner now" AFTER two piece quotes capped at
 * 1,200 chars each — i.e. past the cut, every time. Measured on S4 (2026-08-10): the model
 * quoted only the opening sentence back in its own reasoning and went to `history_get` for the
 * rest. Order first, quotes after: the cap is untouched (#14 / O15's refusal stands) and the
 * order survives it.
 *
 * ── WHAT IS CARRIED UNCHANGED ──
 * Every clause below is incident-derived and stays: the pieces are quoted VERBATIM because the
 * separate-lane architecture keeps A2A deliverables out of the chat store, so "read the
 * messages above" pointed at content the model could not reach (run bmrpxzuhxvh: four empty
 * history_search calls and no compile); tools are FORBIDDEN because an earlier wording that
 * said "verify each piece's ACTUAL content" made the floor model exec a blocked loop and spin
 * 45 tool calls (run bmrplgdg33l).
 *
 * `attempt` null = the steer issued at join completion, before any rung has been spent.
 */
export function compileSteerText(p: {
  total: number; pieces: string[]; attempt: number | null; bound: number;
}): string {
  const attemptLine = p.attempt === null
    ? ''
    : ` (steer ${p.attempt} of ${p.bound}; after that the platform asks you to tell the owner `
      + `the job is stuck, and then reports it as a platform fault.)`;
  return (
    `All ${p.total} delegated pieces for the owner's request are now back. `
    + `The owner has NOT been answered yet.\n\n`
    + `Compose ONE reply to the owner now that carries each piece's content exactly as delivered `
    + `below (quote the key results, e.g. any codes or figures, character for character; do not `
    + `summarize them away, and do not trust a tracker row that says "complete" over the delivered `
    + `text itself). Do NOT search, open files, run commands, or call any tools first — not the `
    + `tracker, not the vault, not a peer notification; everything you need is quoted below. `
    + `If a piece reads as a failure, say so honestly in the same reply.${attemptLine}\n\n`
    + `Here is each piece's delivered content, verbatim:\n\n`
    + p.pieces.join('\n')
  );
}
