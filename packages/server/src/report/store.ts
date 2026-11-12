// One door per transition, each a conditional UPDATE whose `WHERE` guard lets the database decide
// who won (`null` means the row was not in the state this door serves), never a read-then-write.
// The state machine is the privacy model: `attachDraft` only from `drafting` and `editBrief` only
// from `awaiting_approval`, so the approver sees the text that posts; `posted` is terminal by both
// `markPosted` and `markExported`; an unknown status (no CHECK, deliberately) reads back `cancelled`.

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
  /** The ask this report answers (`messages.id`); NULL when none was bound. */
  askId: string | null;
}

const BRIEF_KEYS = ['title', 'whatHappened', 'whatShouldHaveHappened', 'whyItWentWrong', 'fixIdeas'] as const;
const STATUSES: readonly string[] = ['drafting', 'awaiting_approval', 'approved', 'posted', 'cancelled'];

interface DbRow {
  id: string; agent_id: string; status: string; lane: string; signature: string;
  brief_json: string | null; telemetry_json: string | null; bundle_path: string | null;
  export_path: string | null; issue_url: string | null; issue_number: number | null;
  created_at: string; updated_at: string; approved_at: string | null; posted_at: string | null;
  ask_id: string | null;
}

function parseJson<T>(text: string | null): T | null {
  try { return text === null ? null : JSON.parse(text) as T; } catch { return null; }
}

function toReport(row: DbRow): ReportRow {
  return {
    id: row.id, agentId: row.agent_id, signature: row.signature,
    status: (STATUSES.includes(row.status) ? row.status : 'cancelled') as ReportStatus,
    lane: (isFailureLane(row.lane) ? row.lane : 'other'),
    brief: parseJson<ReportBrief>(row.brief_json),
    telemetry: parseJson<Record<string, unknown>>(row.telemetry_json),
    bundlePath: row.bundle_path, exportPath: row.export_path,
    issueUrl: row.issue_url, issueNumber: row.issue_number,
    createdAt: row.created_at, updatedAt: row.updated_at,
    approvedAt: row.approved_at, postedAt: row.posted_at,
    askId: row.ask_id,
  };
}

const COLUMNS = `id, agent_id, status, lane, signature, brief_json, telemetry_json, bundle_path,
                 export_path, issue_url, issue_number, created_at, updated_at, approved_at, posted_at,
                 ask_id`;

export function getReport(id: string): ReportRow | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM dojo_reports WHERE id = ?`).get(id) as DbRow | undefined;
  return row ? toReport(row) : null;
}

/** Every transition funnels here. `id` is passed by name, not read off the end of `params`, so a
 *  door that appends a parameter cannot hand back the wrong row. */
function transition(sql: string, params: unknown[], id: string): ReportRow | null {
  const info = getDb().prepare(sql).run(...params as never[]);
  if (info.changes !== 1) return null;
  return getReport(id);
}

/**
 * The ask this report answers (`messages.id`) or `null`, bound at mint time because the answer row
 * does not exist yet. The latest `role='user'` row can be a message that arrived mid-turn (the chat
 * route writes it before queueing); the ask truly answered then falls to containment in
 * `withdrawn-claim.ts`. `null` is handled like a row predating the column.
 */
function askIdForNow(agentId: string): string | null {
  try {
    const row = getDb().prepare(
      `SELECT id FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
    ).get(agentId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    // No `messages` table (a hand-built fixture) means no asks on the box, so `null` is true.
    return null;
  }
}

export function createReport(agentId: string, lane: FailureLane, signature: string): ReportRow {
  if (!isFailureLane(lane)) throw new Error(`not a failure lane: ${JSON.stringify(lane)}`);
  const id = uuidv4();
  getDb().prepare(
    `INSERT INTO dojo_reports (id, agent_id, status, lane, signature, ask_id)
     VALUES (?, ?, 'drafting', ?, ?, ?)`,
  ).run(id, agentId, lane, signature, askIdForNow(agentId));
  const row = getReport(id);
  if (!row) throw new Error(`report ${id} vanished between its INSERT and its read-back`);
  return row;
}

/** Only `awaiting_approval`: `drafting` has no brief and `approved` is decided, and a card with no
 *  decision in it turns the consent gate into a habit. */
export function listOpenReports(limit = 50): ReportRow[] {
  return (getDb().prepare(
    `SELECT ${COLUMNS} FROM dojo_reports WHERE status = 'awaiting_approval'
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(limit) as DbRow[]).map(toReport);
}

/** The agent's one write: its lane and derived digest replace `createReport`'s provisional pair in the same
 *  call as the telemetry they must agree with. One object, so `signature` and `bundlePath` cannot swap. */
export interface ReportDraft {
  lane: FailureLane;
  signature: string;
  brief: ReportBrief;
  telemetry: Record<string, unknown>;
  bundlePath: string;
}

export function attachDraft(id: string, draft: ReportDraft): ReportRow | null {
  if (!isFailureLane(draft.lane)) throw new Error(`not a failure lane: ${JSON.stringify(draft.lane)}`);
  return transition(
    `UPDATE dojo_reports
        SET lane = ?, signature = ?, brief_json = ?, telemetry_json = ?, bundle_path = ?,
            updated_at = datetime('now')
      WHERE id = ? AND status = 'drafting'`,
    [draft.lane, draft.signature, JSON.stringify(draft.brief), JSON.stringify(draft.telemetry),
      draft.bundlePath, id], id,
  );
}

/**
 * The human's edit door, carrying the five brief fields only. The read and write share one
 * transaction; it is the one door that can THROW (SQLITE_BUSY_SNAPSHOT in WAL), so callers catch.
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

export function submitForApproval(id: string): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'awaiting_approval', updated_at = datetime('now')
      WHERE id = ? AND status = 'drafting' AND brief_json IS NOT NULL`,
    [id], id,
  );
}

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

export function markPosted(id: string, issueUrl: string, issueNumber: number): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'posted', issue_url = ?, issue_number = ?, posted_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ? AND status = 'approved'`,
    [issueUrl, issueNumber, id], id,
  );
}

/**
 * The delivery did not happen, so hand the decision back (the one backwards transition): otherwise a
 * failed send leaves the row in `approved` forever. Safe only because the `WHERE` binds `approved`.
 */
export function releaseApproval(id: string): ReportRow | null {
  return transition(
    `UPDATE dojo_reports
        SET status = 'awaiting_approval', approved_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'approved'`,
    [id], id,
  );
}

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
