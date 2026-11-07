// PM-CANNOT-APPROVE C1: the approve door threw away the PM's verdict on a finished recurring
// task. A row the ENGINE closed (unvalidated `done`) whose schedule had ended (`completed`) or had
// no run in flight was answered "[NO-OP] No open run to validate" and no verdict was written, so
// the row sat in the PM's queue forever. A verdict on a row that owes one is always recorded, run
// in flight or not; only the schedule advance is skipped when there is no run to advance.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-finished-recurring-verdict-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerTask, setTrackerStatus } from '../../work/tracker-store.js';
import { unvalidatedCloseExpr, validatedExpr } from '../../work/tracker-view.js';
import { trackerValidateComplete } from '../tools.js';

const AGENT = 'helper-agent';
const PM = 'pm-agent';
const CONV = 'conv-owner';
const ORIGIN = { kind: 'agent' as const, sourceMessageId: null, turn: null, convKey: null };

const db = (): Database.Database => mockDb.current!;

function seedDelivery(id: string): string {
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(id, AGENT, CONV);
  return id;
}

/** A daily recurring task the ENGINE closed on a receipt: `done`, no PM verdict, no run in flight. */
function engineClosedRecurring(scheduleStatus: 'completed' | 'waiting'): string {
  const id = openTrackerTask({
    title: 'Daily reminder', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT, origin: ORIGIN,
  });
  db().prepare(
    `UPDATE work SET repeat_interval = 1, repeat_unit = 'days', schedule_status = 'waiting',
                     next_run_at = ?, scheduled_start = ? WHERE id = ?`,
  ).run(Date.now() + 3_600_000, Date.now() - 86_400_000, id);
  const closed = setTrackerStatus(id, 'complete', {
    by: 'engine', actorId: 'engine', resultDeliveryId: seedDelivery(`d-${id}`), evidenceRef: `d-${id}`,
    reason: 'engine receipt close',
  });
  expect(['applied', 'no_change'], JSON.stringify(closed)).toContain(closed.kind);
  if (scheduleStatus === 'completed') {
    db().prepare(`UPDATE work SET schedule_status = 'completed', is_paused = 1 WHERE id = ?`).run(id);
  }
  return id;
}

const owesVerdict = (id: string): number =>
  (db().prepare(`SELECT ${unvalidatedCloseExpr('w')} AS o FROM work w WHERE w.id = ?`).get(id) as { o: number }).o;
const upheld = (id: string): number =>
  (db().prepare(`SELECT ${validatedExpr('w', 'done')} AS v FROM work w WHERE w.id = ?`).get(id) as { v: number }).v;
const row = (id: string) =>
  db().prepare('SELECT state, schedule_status, next_run_at FROM work WHERE id = ?').get(id) as
    { state: string; schedule_status: string; next_run_at: number | null };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Helper', 'idle', '1970-01-01')`).run(AGENT);
  db().prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'PM', 'idle', '1970-01-01')`).run(PM);
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('C1: a verdict on a finished recurring task is recorded', () => {
  it('the PM upholding an engine close on a finished (completed) schedule records the verdict and leaves the queue', async () => {
    const id = engineClosedRecurring('completed');
    expect(owesVerdict(id), 'precondition: the row owes the PM a verdict').toBe(1);
    const out = await trackerValidateComplete(PM, { task_id: id, valid: true });
    expect(out, out).toMatch(/^\[OK\]/);
    expect(upheld(id), 'the PM verdict is on record').toBe(1);
    expect(owesVerdict(id), 'the row no longer owes a verdict').toBe(0);
    expect(row(id).state).toBe('done');
  });

  it('the PM upholding an engine close on a live schedule with no run in flight records the verdict and leaves the schedule as it was', async () => {
    const id = engineClosedRecurring('waiting');
    const before = row(id);
    const out = await trackerValidateComplete(PM, { task_id: id, valid: true });
    expect(out, out).toMatch(/^\[OK\]/);
    expect(upheld(id)).toBe(1);
    expect(owesVerdict(id)).toBe(0);
    const after = row(id);
    expect({ ss: after.schedule_status, n: after.next_run_at }, 'only the advance is skipped').toEqual({ ss: before.schedule_status, n: before.next_run_at });
  });

  it('the PM rejecting an engine close on a finished schedule records the rejection and sends the row back', async () => {
    const id = engineClosedRecurring('completed');
    const out = await trackerValidateComplete(PM, { task_id: id, valid: false, reject_reason: 'the close used a receipt from before the run fired' });
    expect(out, out).toMatch(/^\[OK\] Complete rejected/);
    expect(owesVerdict(id)).toBe(0);
    expect(row(id).state).not.toBe('done');
  });

  it('CONTROL: a verdict on a row that owes none is still a no-op and writes nothing', async () => {
    const id = engineClosedRecurring('completed');
    expect((await trackerValidateComplete(PM, { task_id: id, valid: true })).startsWith('[OK]')).toBe(true);
    const events = (db().prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?').get(id) as { n: number }).n;
    const again = await trackerValidateComplete(PM, { task_id: id, valid: true });
    expect(again, again).toMatch(/already complete_validated=1\. No-op\./);
    expect((db().prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?').get(id) as { n: number }).n).toBe(events);
  });
});
