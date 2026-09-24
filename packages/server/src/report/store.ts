// ════════════════════════════════════════════════════════════════════════════
// THE REPORT STORE — ONE DOOR PER TRANSITION, EVERY ONE ATOMIC (DOJO-REPORT T2)
//
// `drafting → awaiting_approval → approved → posted`, plus `cancelled`. The state
// machine IS the privacy model, so every rule below is owner ruling D4 rather than
// bookkeeping:
//
//  1. EVERY TRANSITION IS A CONDITIONAL UPDATE, never a read-then-write. The guard lives
//     in the `WHERE`, so the DATABASE decides who won; `info.changes` is the verdict and
//     `null` means "the row was not in the state this door serves". A `SELECT` + `if` is
//     the whole bug: two Post clicks, two GitHub issues. Same shape
//     `destructive_approvals` + `consumeApproval` settled on, for the same reason.
//
//  2. THE APPROVER SEES THE TEXT THAT POSTS. `attachDraft` is legal only from `drafting`
//     — before any human has looked — and `editBrief` only from `awaiting_approval`, the
//     human's own edit door. Neither is legal from `approved`: text that can change
//     between the click and the post makes the preview decoration. That is D4.
//
//  3. POSTED IS TERMINAL, by both doors. `markExported` consumes the approval exactly as
//     `markPosted` does — D4 binds the export path too, so one approval is one delivery
//     whichever way the report leaves.
//
//  4. AN UNKNOWN STATUS IS TERMINAL. A hand-edited database, a restored backup or a
//     future writer can put a value here this release never approved (no CHECK,
//     deliberately — migration 169 argues why). Such a row reads back as `cancelled`:
//     never listed, named by no transition, never postable. That is the safe direction.
// ════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { isFailureLane, type FailureLane } from './signature.js';

export type ReportStatus = 'drafting' | 'awaiting_approval' | 'approved' | 'posted' | 'cancelled';

export interface ReportBrief {
  title: string; whatHappened: string; whatShouldHaveHappened: string;
  whyItWentWrong: string; fixIdeas: string;
}

export interface ReportRow {
  id: string; agentId: string; status: ReportStatus; lane: FailureLane; signature: string;
  brief: ReportBrief | null; telemetry: Record<string, unknown> | null;
  bundlePath: string | null; createdAt: string; updatedAt: string;
  approvedAt: string | null; postedAt: string | null;
  issueUrl: string | null; issueNumber: number | null; exportPath: string | null;
}

/** The five fields a brief has. An edit carries these and nothing else. */
const BRIEF_KEYS = ['title', 'whatHappened', 'whatShouldHaveHappened', 'whyItWentWrong', 'fixIdeas'] as const;
const STATUSES: readonly string[] = ['drafting', 'awaiting_approval', 'approved', 'posted', 'cancelled'];

interface DbRow {
  id: string; agent_id: string; status: string; lane: string; signature: string;
  brief_json: string | null; telemetry_json: string | null; bundle_path: string | null;
  export_path: string | null; issue_url: string | null; issue_number: number | null;
  created_at: string; updated_at: string; approved_at: string | null; posted_at: string | null;
}

/** A column this module wrote is valid JSON; a column a human edited may not be. */
function parseJson<T>(text: string | null): T | null {
  try { return text === null ? null : JSON.parse(text) as T; } catch { return null; }
}

function toReport(row: DbRow): ReportRow {
  return {
    id: row.id, agentId: row.agent_id, signature: row.signature,
    // See header rule 4: anything this release does not recognise reads as terminal.
    status: (STATUSES.includes(row.status) ? row.status : 'cancelled') as ReportStatus,
    lane: (isFailureLane(row.lane) ? row.lane : 'other'),
    brief: parseJson<ReportBrief>(row.brief_json),
    telemetry: parseJson<Record<string, unknown>>(row.telemetry_json),
    bundlePath: row.bundle_path, exportPath: row.export_path,
    issueUrl: row.issue_url, issueNumber: row.issue_number,
    createdAt: row.created_at, updatedAt: row.updated_at,
    approvedAt: row.approved_at, postedAt: row.posted_at,
  };
}

const COLUMNS = `id, agent_id, status, lane, signature, brief_json, telemetry_json, bundle_path,
                 export_path, issue_url, issue_number, created_at, updated_at, approved_at, posted_at`;

export function getReport(id: string): ReportRow | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM dojo_reports WHERE id = ?`).get(id) as DbRow | undefined;
  return row ? toReport(row) : null;
}

/**
 * Every transition in this module funnels through here. One statement, one bound
 * `WHERE`, one verdict — so no door can accidentally grow a read-then-write.
 *
 * `id` is a NAMED parameter and not `params[params.length - 1]`, which is what it was:
 * every door happens to bind the id last, so reading it back by position was correct
 * today and silently wrong the first time a door appended a parameter after it — the
 * right UPDATE, then the WRONG row handed back as the post-transition state.
 */
function transition(sql: string, params: unknown[], id: string): ReportRow | null {
  const info = getDb().prepare(sql).run(...params as never[]);
  if (info.changes !== 1) return null;
  return getReport(id);
}

export function createReport(agentId: string, lane: FailureLane, signature: string): ReportRow {
  if (!isFailureLane(lane)) throw new Error(`not a failure lane: ${JSON.stringify(lane)}`);
  const id = uuidv4();
  getDb().prepare(
    `INSERT INTO dojo_reports (id, agent_id, status, lane, signature) VALUES (?, ?, 'drafting', ?, ?)`,
  ).run(id, agentId, lane, signature);
  const row = getReport(id);
  if (!row) throw new Error(`report ${id} vanished between its INSERT and its read-back`);
  return row;
}

/**
 * Rows a human still has to decide. Deliberately `awaiting_approval` ONLY: a
 * `drafting` row has no brief to show and an `approved` one is already decided —
 * listing either puts a card in front of someone with no decision in it, which is
 * how a consent gate becomes a habit.
 */
export function listOpenReports(limit = 50): ReportRow[] {
  return (getDb().prepare(
    `SELECT ${COLUMNS} FROM dojo_reports WHERE status = 'awaiting_approval'
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(limit) as DbRow[]).map(toReport);
}

/** The agent's one write. Legal only while nobody has seen the report yet. */
export function attachDraft(
  id: string, brief: ReportBrief, telemetry: Record<string, unknown>, bundlePath: string,
): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET brief_json = ?, telemetry_json = ?, bundle_path = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'drafting'`,
    [JSON.stringify(brief), JSON.stringify(telemetry), bundlePath, id], id,
  );
}

/**
 * The HUMAN's edit door. Legal only while the row is awaiting their decision, and it
 * carries the five brief fields only — anything else in the patch lands on the floor
 * rather than in a public issue body. The read and the write share one transaction so the
 * merge sees a CONSISTENT brief; the state guard is still the UPDATE's own `WHERE`. ⚠ It
 * is the one door that can THROW rather than answer: in WAL a deferred transaction writing
 * after another connection committed raises SQLITE_BUSY_SNAPSHOT. A caller needs a catch as
 * well as a null branch (contract line C8 for T6).
 */
export function editBrief(id: string, patch: Partial<ReportBrief>): ReportRow | null {
  const db = getDb();
  const changed = db.transaction((): boolean => {
    const row = db.prepare('SELECT brief_json, status FROM dojo_reports WHERE id = ?').get(id) as
      { brief_json: string | null; status: string } | undefined;
    if (!row || row.status !== 'awaiting_approval') return false;
    const current = parseJson<ReportBrief>(row.brief_json);
    if (!current) return false;
    const next: ReportBrief = { ...current };
    for (const key of BRIEF_KEYS) {
      const value = patch[key];
      if (typeof value === 'string') next[key] = value;
    }
    return db.prepare(
      `UPDATE dojo_reports SET brief_json = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'awaiting_approval'`,
    ).run(JSON.stringify(next), id).changes === 1;
  })();
  return changed ? getReport(id) : null;
}

/** Ask a human. Refused when there is no brief: nobody may be asked to approve nothing. */
export function submitForApproval(id: string): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'awaiting_approval', updated_at = datetime('now')
      WHERE id = ? AND status = 'drafting' AND brief_json IS NOT NULL`,
    [id], id,
  );
}

/** ONE-SHOT. Flips awaiting_approval → approved. A second call on the same id returns null. */
export function approveOnce(id: string): ReportRow | null {
  const db = getDb();
  const info = db.prepare(
    `UPDATE dojo_reports
        SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_approval'`,
  ).run(id);
  if (info.changes !== 1) return null;
  return getReport(id);
}

/** ONE-SHOT. Flips approved → posted. Returns null unless the row is currently `approved`. */
export function markPosted(id: string, issueUrl: string, issueNumber: number): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'posted', issue_url = ?, issue_number = ?, posted_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ? AND status = 'approved'`,
    [issueUrl, issueNumber, id], id,
  );
}

/** ONE-SHOT, the D2 export door. Consumes the approval exactly as `markPosted` does. */
export function markExported(id: string, exportPath: string): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'posted', export_path = ?, posted_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ? AND status = 'approved'`,
    [exportPath, id], id,
  );
}

/** The safe direction, legal from anywhere a report has not yet been delivered. */
export function cancelReport(id: string): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'cancelled', updated_at = datetime('now')
      WHERE id = ? AND status IN ('drafting', 'awaiting_approval', 'approved')`,
    [id], id,
  );
}
