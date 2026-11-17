// A lived-in box as the chain leaves it just before 901, and its upgrade through the real runner.
//
//   vi.mock('<path>/db/connection.js', async () => (await import('<path>/work/done/__tests__/helpers/done-db.js')).connectionMock());
//
// `boxBefore901()` applies every file before 901; `seedRow` plants one old-shape row with its records;
// `upgrade()` runs the runner again, so 901 and the files after it are the pending ones.
import { runMigrations, migrationFileNames } from '../../migrations.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { freshDoneDb, doneDb } from '../../../work/done/__tests__/helpers/done-db.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

export const FILE = '901_task_done_one_path.sql';
export const DAY = 24 * 3_600_000;
export const PM = FXID.n1;
export const MAIN = FXID.n2;
export const HELPER = FXID.n3;
export const GONE = FXID.n4;
/** A worker with no agents row at all. */
export const DELETED = FXID.n5;
export const SENSEI = FXID.n6;

/** A database at the state every file before 901 leaves, with the box's agents. */
export function boxBefore901(): void {
  freshDoneDb();
  doneDb().exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const owed = migrationFileNames().filter((f) => f >= FILE);
  for (const f of owed) doneDb().prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
  runMigrations();
  for (const f of owed) doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(f);
  for (const [k, v] of [['pm_agent_id', PM], ['primary_agent_id', MAIN]]) {
    doneDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(k, v);
  }
  clearPlatformConfigCache();
  const agent = doneDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, ?, ?)");
  agent.run(PM, PM, 'idle', 'sensei');
  agent.run(MAIN, MAIN, 'idle', 'standard');
  agent.run(HELPER, HELPER, 'idle', 'ronin');
  agent.run(GONE, GONE, 'terminated', 'standard');
  agent.run(SENSEI, SENSEI, 'idle', 'sensei');
}

/** Apply 901 and the files after it the way a boot does. */
export function upgrade(): void { runMigrations(); }

let n = 0;
/** A delivered message's record, for a done row to stand on. */
export function delivery(agent = MAIN): string {
  const id = `dlv-901-${++n}`;
  doneDb().prepare("INSERT INTO deliveries (id, agent_id, tool, channel, outcome) VALUES (?, ?, 'auto-route', 'dashboard', 'delivered')").run(id, agent);
  return id;
}

export function event(workId: string, kind: string, payload: object, at: number, actor = 'agent'): number {
  return Number(doneDb().prepare('INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(workId, kind, JSON.stringify(payload), actor, at).lastInsertRowid);
}

export interface RowSpec {
  id: string; kind?: 'task' | 'project' | 'occurrence' | 'ask' | 'commitment'; state: string; worker?: string;
  root?: string; parent?: string; idleDays?: number; recurring?: boolean; nextRunAt?: number | null; isPaused?: 0 | 1;
  scheduleStatus?: string | null; title?: string | null; goal?: string | null; description?: string | null;
  measured?: boolean; sequence?: number; scheduledStart?: number | null; missedRunsPausedAt?: number | null; pausedUntil?: number | null;
  notes?: string;
}

/** One old-shape row. A terminal row is closed on its own delivery when it is done. */
export function seedRow(s: RowSpec, now = Date.now()): string {
  const at = now - (s.idleDays ?? 1) * DAY;
  const terminal = ['done', 'failed', 'abandoned'].includes(s.state);
  doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread,
       title, goal, description, opened_at, updated_at, closed_at, result_delivery_id, repeat_interval, repeat_unit,
       schedule_status, next_run_at, is_paused, measure_json, sequence, scheduled_start, missed_runs_paused_at, paused_until, notes)
     VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, 'task', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id, s.kind ?? 'task', s.parent ?? null, s.worker ?? MAIN, s.root ?? 'tracker', s.id, s.state,
    s.title === undefined ? `Job ${s.id}` : s.title, s.goal === undefined ? 'The owner has it' : s.goal, s.description ?? null,
    at, at, terminal ? at : null, s.state === 'done' ? delivery(s.worker) : null,
    s.recurring ? 1 : null, s.recurring ? 'day' : null, s.scheduleStatus ?? (s.recurring ? 'waiting' : null),
    s.nextRunAt ?? null, s.isPaused ?? 0, s.measured ? '{"kind":"label","target":0}' : null, s.sequence ?? null,
    s.scheduledStart ?? null, s.missedRunsPausedAt ?? null, s.pausedUntil ?? null, s.notes ?? null,
  );
  event(s.id, 'opened', {}, at, s.worker ?? MAIN);
  return s.id;
}

/** A worker's close filed and not yet decided (Key 1). */
export const fileClose = (id: string, at: number): number => event(id, 'validation_requested', { requested_state: 'done', reason: 'finished', from: 'claimed' }, at);
/** A move into `state` with its reason, as the old transition() recorded it. */
export const enter = (id: string, from: string, state: string, reason: string, at: number): number =>
  event(id, 'transition', { from, to: state, by: 'agent', reason }, at);

/** The lived-in seed: one or more rows of every class the mapping knows, by class. */
export function seedLivedInBox(now = Date.now()): Record<string, string[]> {
  const ids: Record<string, string[]> = {};
  const put = (cls: string, s: RowSpec): string => { (ids[cls] ??= []).push(seedRow(s, now)); return s.id; };
  const t = now - DAY;

  // Finished history.
  const validated = put('history_done', { id: 't-done-validated', state: 'done' });
  doneDb().prepare("INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at) VALUES (?, 'done', 'upheld', ?, ?)").run(validated, PM, t);
  put('history_done', { id: 't-done-engine', state: 'done', worker: HELPER, recurring: true, scheduleStatus: 'completed' });
  put('history_done', { id: 't-done-measured', state: 'done', measured: true, goal: null });
  put('history_done', { id: 't-done-scaffold', state: 'done', root: 'engine_scaffold', worker: GONE });
  put('history_done', { id: 't-done-legacy', state: 'done', root: 'legacy', worker: HELPER });
  for (let i = 0; i < 100; i++) put('history_done', { id: `t-bulk-${i}`, state: 'done', worker: GONE, idleDays: 30 });
  put('history_failed', { id: 't-failed', state: 'failed', worker: HELPER });
  put('history_abandoned', { id: 't-cancelled-owner', state: 'abandoned' });
  put('history_abandoned', { id: 't-cancelled-agent', state: 'abandoned', worker: GONE });
  put('history_abandoned', { id: 't-cancelled-scaffold', state: 'abandoned', root: 'engine_scaffold', worker: GONE });

  // Live tasks: holds and On deck.
  enter(put('blocked', { id: 't-blocked-reason', state: 'blocked' }), 'claimed', 'blocked', 'waiting on the owner\'s login', t);
  put('blocked', { id: 't-blocked-bare', state: 'blocked', goal: null, description: 'Fix the printer queue' });
  enter(put('blocked', { id: 't-blocked-unvalidated', state: 'blocked', worker: HELPER, goal: null, title: 'Book the venue' }), 'claimed', 'blocked', 'the venue is closed\non weekends', t);
  put('project_working', { id: 'p-with-paused-step', kind: 'project', state: 'open' });
  put('paused', { id: 't-paused-step', state: 'paused', parent: 'p-with-paused-step', isPaused: 1 });
  put('paused', { id: 't-paused-gone-1', state: 'paused', worker: GONE });
  put('paused', { id: 't-paused-gone-2', state: 'paused', worker: GONE });
  put('paused', { id: 't-paused-scaffold', state: 'paused', root: 'engine_scaffold', worker: HELPER, idleDays: 47, isPaused: 1 });
  put('on_deck', { id: 't-daily-overdue', state: 'on_deck', worker: HELPER, recurring: true, nextRunAt: now - 3_600_000 });
  put('on_deck', { id: 't-daily-long-overdue', state: 'on_deck', worker: HELPER, recurring: true, nextRunAt: now - 3 * DAY });
  put('on_deck', { id: 't-missed-runs', state: 'on_deck', worker: HELPER, recurring: true, nextRunAt: now - 5 * DAY, isPaused: 1, scheduleStatus: 'paused', missedRunsPausedAt: now - 2 * DAY });
  put('on_deck', { id: 't-future-one-off', state: 'on_deck', scheduledStart: now + 2 * DAY });
  put('paused', { id: 't-paused-until', state: 'paused', pausedUntil: now + DAY });
  enter(put('blocked', { id: 't-blocked-tool-reason', state: 'blocked', notes: 'Started the draft.\nwaiting for the vendor quote\n\n' }),
    'claimed', 'blocked', 'work_update(action="status") -> blocked', t);
  enter(put('blocked', { id: 't-blocked-dashboard', state: 'blocked' }), 'claimed', 'blocked', 'dashboard PUT /tracker/tasks/:id', t);
  enter(put('paused', { id: 't-paused-named', state: 'paused' }), 'claimed', 'paused', 'paused', t);
  put('paused', { id: 't-piece-paused', state: 'paused', root: 'a2a_thread', worker: HELPER });
  for (const [cls, state] of [['paused', 'paused'], ['blocked', 'blocked']]) {
    const id = put(cls, { id: `t-${state}-pm-confirmed`, state });
    event(id, 'validation_requested', { requested_state: state, reason: 'confirm the hold', from: 'claimed' }, t - 1000);
    event(id, 'claim_upheld', { claim_state: state, note: 'confirmed' }, t, PM);
  }

  // Live tasks that keep their state.
  put('claimed', { id: 't-claimed-fresh', state: 'claimed' });
  put('claimed', { id: 't-claimed-60d', state: 'claimed', idleDays: 60 });
  put('open', { id: 't-open', state: 'open' });
  put('claimed', { id: 't-measured-mid', state: 'claimed', measured: true });
  const running = put('claimed', { id: 't-recurring-mid-run', state: 'claimed', worker: HELPER, recurring: true, nextRunAt: now + DAY });
  put('claimed', { id: 't-deleted-worker', state: 'claimed', worker: DELETED });
  put('claimed', { id: 't-pm-worked', state: 'claimed', worker: PM });
  put('claimed', { id: 't-sensei-worked', state: 'claimed', worker: SENSEI });
  put('claimed', { id: 't-legacy-live', state: 'claimed', root: 'legacy', worker: HELPER });

  // Filed closes and open requests: back to Working with a hint.
  fileClose(put('rehandin', { id: 't-close-on-claimed', state: 'claimed' }), t);
  fileClose(put('rehandin', { id: 't-close-on-paused', state: 'paused', idleDays: 20 }), t);
  fileClose(put('rehandin', { id: 't-close-on-blocked', state: 'blocked' }), t);
  fileClose(put('rehandin_recurring', { id: 't-recurring-stop', state: 'claimed', worker: HELPER, recurring: true, nextRunAt: now + DAY }), t);
  event(put('rehandin', { id: 't-override-open', state: 'claimed' }), 'override_request', { reason: 'please close it' }, t);
  event(put('rehandin', { id: 't-verdict-open', state: 'blocked' }), 'user_verdict_requested', { question: 'is it done?' }, t);
  const rejected = put('sent_back', { id: 't-done-rejected', state: 'claimed' });
  fileClose(rejected, t - 1000);
  event(rejected, 'claim_rejected', { claim_state: 'done', note: 'the file is empty' }, t, PM);

  // Projects.
  put('project_empty', { id: 'p-empty', kind: 'project', state: 'open', worker: HELPER, idleDays: 30, goal: null, description: 'Plan the move' });
  put('project_done', { id: 'p-all-done', kind: 'project', state: 'open' });
  put('history_done', { id: 't-child-done-1', state: 'done', parent: 'p-all-done', idleDays: 2 });
  put('history_done', { id: 't-child-done-2', state: 'done', parent: 'p-all-done' });
  put('project_paused', { id: 'p-paused-empty', kind: 'project', state: 'paused', worker: GONE });
  put('project_abandoned', { id: 'p-all-cancelled', kind: 'project', state: 'open' });
  put('history_abandoned', { id: 't-child-cancelled', state: 'abandoned', parent: 'p-all-cancelled' });
  put('project_blocked', { id: 'p-blocked-empty', kind: 'project', state: 'blocked' });
  put('project_done', { id: 'p-on-deck-all-done', kind: 'project', state: 'on_deck' });
  put('history_done', { id: 't-on-deck-child-done', state: 'done', parent: 'p-on-deck-all-done' });
  put('project_abandoned', { id: 'p-on-deck-all-cancelled', kind: 'project', state: 'on_deck' });
  put('history_abandoned', { id: 't-on-deck-child-cancelled', state: 'abandoned', parent: 'p-on-deck-all-cancelled' });
  put('history_done', { id: 'p-done', kind: 'project', state: 'done', worker: HELPER });
  put('history_done', { id: 'p-legacy-done', kind: 'project', state: 'done', root: 'legacy', worker: HELPER });
  put('history_abandoned', { id: 'p-cancelled', kind: 'project', state: 'abandoned' });
  put('history_done', { id: 'p-done-one-cancelled-child', kind: 'project', state: 'done' });
  put('history_abandoned', { id: 't-only-child-cancelled', state: 'abandoned', parent: 'p-done-one-cancelled-child' });

  // Rows that are not board work, which the upgrade leaves exactly as they are.
  const rest = (s: RowSpec): void => { (ids.not_board ??= []).push(seedRow(s, now)); };
  rest({ id: 'piece-live', state: 'claimed', root: 'a2a_thread', worker: HELPER });
  rest({ id: 'piece-done', state: 'done', root: 'a2a_thread', worker: GONE });
  rest({ id: 'run-open', kind: 'occurrence', state: 'open', root: 'tracker', parent: running, sequence: 1, worker: HELPER });
  rest({ id: 'run-done', kind: 'occurrence', state: 'done', root: 'tracker', parent: running, sequence: 0, worker: HELPER });
  rest({ id: 'ask-blocked', kind: 'ask', state: 'blocked', root: 'message' });
  rest({ id: 'commitment-cancelled', kind: 'commitment', state: 'abandoned', root: 'message' });

  // Orphans the upgrade carries as they are: events whose row is gone, and a verdict on finished work.
  doneDb().pragma('foreign_keys = OFF');
  event('ask-long-gone-1', 'transition', { from: 'open', to: 'done' }, t);
  event('ask-long-gone-2', 'opened', {}, t);
  doneDb().pragma('foreign_keys = ON');
  doneDb().prepare("INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at) VALUES ('t-failed', 'failed', 'upheld', ?, ?)").run(PM, t);

  // Retired switches.
  for (const k of ['pm_agent_enabled', 'trainer_agent_enabled', 'imaginer_enabled']) {
    doneDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, 'true')").run(k);
  }
  doneDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_mode', 'off')").run();
  // The decision model's unread records.
  doneDb().prepare("INSERT INTO decision_shadow (purpose, question, turn_id, rule_said, created_at) VALUES ('inbound_routing', 'multi_step', 'x', 'false', 1)").run();
  for (const k of ['decision_switch.memory_shape.filler', 'decision_mode.inbound_routing.deliverable', 'decide_pace.m-decision', 'token_density.m-decision']) {
    doneDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '[]')").run(k);
  }
  doneDb().prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('summary_check_version', 'k', 1), ('summary_check_kept', 'k', 1), ('summary_span_refused', 'k', 1)").run();
  return ids;
}
