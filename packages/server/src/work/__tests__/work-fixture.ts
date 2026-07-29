// PHASE-2 T8b — the shared `work` fixture for unit tests.
//
// Twelve test files carried their own hand-rolled `legacy_tasks` / `legacy_projects` CREATE
// TABLE and seeded rows straight into them. The tracker's storage moved to `work` in this
// task, so those fixtures were seeding a table nothing reads any more — the harness half of
// the same change (roadmap non-negotiable #4: a task that changes schema updates its harness
// INSIDE the task, never after).
//
// One fixture, one place. A test that needs a tracker row calls `seedTrackerTask`; a test
// that needs the columns a specific reader names passes them. The DDL below is a SUBSET of
// migration `135` + `137` — deliberately, because a fixture that drifts from the real schema
// is worse than no fixture: `work-spine-schema.test.ts` asserts against the migration itself,
// and this file exists so unit tests can seed rows, not to restate the schema.

import type DatabaseType from 'better-sqlite3';

/** The columns any tracker-reading unit test has needed so far. */
export function createWorkTable(db: DatabaseType.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      parent_id TEXT,
      agent_id TEXT NOT NULL,
      assignee_agent TEXT,
      requester TEXT NOT NULL DEFAULT 'agent',
      requester_id TEXT,
      conversation_id TEXT,
      root_kind TEXT NOT NULL DEFAULT 'tracker',
      root_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open',
      claimed_by_turn INTEGER,
      result_delivery_id TEXT,
      intent TEXT NOT NULL DEFAULT 'tracker',
      wakes INTEGER NOT NULL DEFAULT 0,
      closes_thread INTEGER NOT NULL DEFAULT 0,
      hop_count INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      title TEXT, goal TEXT, priority TEXT DEFAULT 'normal', notes TEXT,
      remaining_children INTEGER,
      compile_pending INTEGER NOT NULL DEFAULT 0,
      ttl_at INTEGER, reply_conversation_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
      schedule_json TEXT, tz TEXT, anchor_local TEXT, next_run_at INTEGER, sequence INTEGER,
      opened_at INTEGER NOT NULL DEFAULT 1700000000000,
      closed_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 1700000000000,
      provenance TEXT NOT NULL DEFAULT 'live',
      description TEXT, original_description TEXT, completion_summary TEXT,
      result TEXT, evidence_json TEXT,
      step_number INTEGER, total_steps INTEGER, phase INTEGER,
      depends_on TEXT DEFAULT '[]', assigned_to_group TEXT, task_kind TEXT,
      level INTEGER, phase_count INTEGER, current_phase INTEGER, group_id TEXT,
      source_message_id TEXT, origin_turn INTEGER, origin_conv_key TEXT, origin_kind TEXT,
      deliverable_shown INTEGER NOT NULL DEFAULT 0, a2a_thread_id TEXT, last_smell_flag TEXT,
      scheduled_start INTEGER, repeat_interval INTEGER, repeat_unit TEXT,
      repeat_end_type TEXT, repeat_end_value TEXT, repeat_days_of_week TEXT,
      schedule_status TEXT, is_paused INTEGER NOT NULL DEFAULT 0,
      paused_until INTEGER, status_before_pause TEXT,
      last_run_at INTEGER, missed_runs_paused_at INTEGER,
      last_activity_turn INTEGER, last_activity_at INTEGER, last_activity_outcome TEXT,
      last_answered_turn INTEGER, last_answered_at INTEGER, last_delivery_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS work_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adjudications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL,
      claim_state TEXT NOT NULL, verdict TEXT NOT NULL,
      by_agent TEXT NOT NULL, evidence_ref TEXT, note TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_work_a2a ON work(a2a_thread_id);
  `);
}

/** `datetime('now')`-form TEXT -> epoch ms, so a fixture can keep writing readable instants. */
export const ms = (text: string | number | null | undefined): number | null => {
  if (text == null) return null;
  if (typeof text === 'number') return text;
  return Date.parse(/[TZ]/.test(text) ? text : `${text}Z`);
};

export interface SeedTask {
  id: string;
  title?: string;
  status?: string;
  agentId?: string;
  createdBy?: string;
  projectId?: string | null;
  [col: string]: unknown;
}

const STATUS_TO_STATE: Record<string, string> = {
  on_deck: 'on_deck', in_progress: 'claimed', complete: 'done', blocked: 'blocked',
  fallen: 'failed', paused: 'paused', active: 'open', cancelled: 'abandoned',
};

/** Seed one tracker task row. Extra keys are written as-is to their `work` column, so a test
 *  that needs `source_message_id` or `repeat_interval` just names it. */
export function seedTrackerTask(db: DatabaseType.Database, t: SeedTask): void {
  const {
    id, title = 'task', status = 'in_progress', agentId = 'a1', createdBy = agentId,
    projectId = null, ...rest
  } = t;
  const cols = ['id', 'kind', 'parent_id', 'agent_id', 'assignee_agent', 'requester', 'requester_id',
    'root_kind', 'root_id', 'state', 'intent', 'wakes', 'closes_thread', 'title',
    'opened_at', 'updated_at'];
  const vals: unknown[] = [id, 'task', projectId, agentId, agentId, 'agent', createdBy,
    'tracker', id, STATUS_TO_STATE[status] ?? status, 'tracker', 0, 0, title,
    1700000000000, 1700000000000];
  applyExtras(cols, vals, rest);
  db.prepare(`INSERT INTO work (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}

/** A named column OVERRIDES the default rather than being appended twice — a duplicate
 *  column name in one INSERT is a silent-wrong-row bug, and it bit this fixture once. */
function applyExtras(cols: string[], vals: unknown[], rest: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(rest)) {
    const at = cols.indexOf(k);
    if (at >= 0) vals[at] = v ?? null;
    else { cols.push(k); vals.push(v ?? null); }
  }
}

/** Seed one tracker project row. */
export function seedTrackerProject(db: DatabaseType.Database, t: SeedTask): void {
  const { id, title = 'project', status = 'active', agentId = 'a1', createdBy = agentId, ...rest } = t;
  const cols = ['id', 'kind', 'agent_id', 'requester', 'requester_id', 'root_kind', 'root_id',
    'state', 'intent', 'wakes', 'closes_thread', 'title', 'level', 'phase_count',
    'current_phase', 'opened_at', 'updated_at'];
  const vals: unknown[] = [id, 'project', agentId, 'agent', createdBy, 'tracker', id,
    STATUS_TO_STATE[status] ?? status, 'tracker', 0, 0, title, 1, 1, 1,
    1700000000000, 1700000000000];
  const { projectId: _ignored, ...extras } = rest as Record<string, unknown>;
  void _ignored;
  applyExtras(cols, vals, extras);
  db.prepare(`INSERT INTO work (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}
