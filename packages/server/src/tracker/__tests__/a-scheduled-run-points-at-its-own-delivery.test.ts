// C3 (PM-CANNOT-APPROVE.md, v3.5 field fix 3 evidence round): A RUN POINTS AT ITS OWN DELIVERY.
//
// Measured on the owner's box: a test helper's daily reminder ("Reminder: drink water", repeat 1
// day) was closed by the engine during its 10-13 run, whose own turns all hit provider errors. The
// PM's review then printed "DELIVERED ANSWER ON RECORD ... This IS the dereference" over the setup
// confirmation "Reminder set ... every day at 9:30 AM": the receipt of the ask that CREATED the
// schedule (arm (a), the task's `source_message_id` ask), a day before the run. That line is never
// a run's delivery, so the PM was shown an answer it could not honestly uphold or reject on.
//
// The rows below rebuild that shape: the setup ask and its receipt, the recurring task, the run's
// occurrence (opened by the scheduler, nothing delivered), and the close on the task after it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-run-pointer-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { appendWorkEvent } from '../../work/store.js';
import { resolveTaskAnswerPointer } from '../delivery-evidence.js';

const HELPER = 'helper-agent';
const CONV = 'conv-owner';
const SETUP_MSG = 'msg-setup-ask';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 7, 48, 24);   // the setup ask, 10-12 07:48 UTC
const RUN_AT = Date.UTC(2026, 9, 13, 16, 30, 28);   // the 10-13 run fired
const CLOSE_AT = Date.UTC(2026, 9, 13, 16, 46, 27);   // the close on the task, during that run

const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
let seq = 0;

function message(id: string, role: 'user' | 'assistant', content: string, at: number): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)`,
  ).run(id, HELPER, role, content, CONV, at + (++seq));
}
function delivery(id: string, messageId: string, at: number): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, ?, 'delivered', ?)`,
  ).run(id, HELPER, CONV, messageId, sqlTime(at));
}

/** The owner's setup ask, answered by the setup confirmation (the ask's own settlement receipt). */
function seedSetupAsk(): void {
  message(SETUP_MSG, 'user', 'Remind me to drink water every day at 9:30.', T0);
  message('msg-setup-confirm', 'assistant', 'Reminder set, drink water, every day at 9:30 AM.', T0 + 1000);
  delivery('d-setup-confirm', 'msg-setup-confirm', T0 + 1000);
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, conversation_id, root_kind, root_id, state, result_delivery_id, intent, wakes, closes_thread, hop_count, compile_pending, attempts, provenance, opened_at, updated_at, closed_at)
     VALUES (?, 'ask', ?, 'owner', ?, 'ask', ?, 'done', 'd-setup-confirm', 'ask', 1, 0, 0, 0, 0, 'live', ?, ?, ?)`,
  ).run(`ask:${SETUP_MSG}`, HELPER, CONV, `ask:${SETUP_MSG}`, T0, T0 + 1000, T0 + 1000);
}

function seedTask(recurring: boolean): string {
  const t = openTrackerTask({
    title: 'Reminder: drink water', status: 'in_progress', assignedTo: HELPER, createdBy: HELPER,
    origin: { kind: 'agent', sourceMessageId: SETUP_MSG, turn: null, convKey: null },
  });
  if (recurring) {
    mockDb.current!.prepare(`UPDATE work SET repeat_interval = 1, repeat_unit = 'days', schedule_status = 'completed' WHERE id = ?`).run(t);
  }
  return t;
}

/** The run's occurrence as the scheduler opens it; `deliveryId` is what the run settled on. */
function seedRun(taskId: string, openedAt: number, deliveryId: string | null): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, result_delivery_id, intent, wakes, closes_thread, hop_count, compile_pending, attempts, provenance, opened_at, updated_at, closed_at)
     VALUES (?, 'occurrence', ?, ?, 'schedule', 'schedule', ?, ?, ?, 'occurrence', 0, 0, 0, 0, 0, 'live', ?, ?, ?)`,
  ).run(`occ-${++seq}`, taskId, HELPER, taskId, deliveryId ? 'done' : 'abandoned', deliveryId, openedAt, openedAt + 30_000, openedAt + 30_000);
}

function fileClose(taskId: string, at: number): void {
  appendWorkEvent(taskId, 'validation_requested', 'engine', { requested_state: 'done', reason: 'close on receipt', from: 'claimed', result_delivery_id: 'd-setup-confirm' }, at);
}

beforeEach(() => {
  seq = 0;
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Helper', 'idle', '1970-01-01')`).run(HELPER);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, HELPER);
  seedSetupAsk();
});

describe('C3: a scheduled run\'s review never shows the setup confirmation as the run\'s work', () => {
  it('THE OWNER\'S BOX: a run that delivered nothing has no delivered answer on record, not the setup line', () => {
    const t = seedTask(true);
    seedRun(t, RUN_AT - DAY, null);   // an earlier run, irrelevant to this close
    seedRun(t, RUN_AT, null);   // the 10-13 run: provider errors, nothing delivered
    fileClose(t, CLOSE_AT);
    expect(resolveTaskAnswerPointer(t)).toBeNull();
  });

  it('a run that DID deliver points at that run\'s own receipt', () => {
    const t = seedTask(true);
    message('msg-run-line', 'assistant', 'Time to drink some water.', RUN_AT + 5000);
    delivery('d-run-line', 'msg-run-line', RUN_AT + 5000);
    seedRun(t, RUN_AT, 'd-run-line');
    fileClose(t, CLOSE_AT);
    const p = resolveTaskAnswerPointer(t);
    expect(p?.deliveryId).toBe('d-run-line');
    expect(p?.basis).toBe('run-delivery');
    expect(p?.excerpt).toBe('Time to drink some water.');
  });

  it('NEGATIVE CONTROL: an earlier run\'s delivery is not this run\'s (the close is about the newest run before it)', () => {
    const t = seedTask(true);
    message('msg-old-run', 'assistant', 'Time to drink some water.', RUN_AT - DAY + 5000);
    delivery('d-old-run', 'msg-old-run', RUN_AT - DAY + 5000);
    seedRun(t, RUN_AT - DAY, 'd-old-run');
    seedRun(t, RUN_AT, null);
    fileClose(t, CLOSE_AT);
    expect(resolveTaskAnswerPointer(t)).toBeNull();
  });

  it('a scheduled task that has not run yet has no answer at all', () => {
    const t = seedTask(true);
    expect(resolveTaskAnswerPointer(t)).toBeNull();
  });

  it('CONTROL: a task that is not scheduled still reads the ask it exists for (arm (a) unchanged)', () => {
    const t = seedTask(false);
    const p = resolveTaskAnswerPointer(t);
    expect(p?.deliveryId).toBe('d-setup-confirm');
    expect(p?.basis).toBe('parent-ask-receipt');
  });
});
