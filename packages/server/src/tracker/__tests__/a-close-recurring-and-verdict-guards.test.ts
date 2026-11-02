// proof-fix V round 2: F1 (recurring bless ends consistent) and F2 (block/pause verdicts never consume a filed close).

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-close-guards-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import {
  openTrackerProject, openTrackerTask, setTrackerStatus,
} from '../../work/tracker-store.js';
import {
  pendingCloseRequestExpr, closeRequestFiledExpr, unvalidatedCloseExpr,
} from '../../work/tracker-view.js';
import { trackerValidateComplete, trackerValidatePause, trackerValidateBlocked } from '../tools.js';

const AGENT = 'harnessbot';
const PM = 'pm-agent';
const CONV = 'conv-owner';

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(id, AGENT, CONV);
  return id;
}


const ORIGIN = { kind: 'agent' as const, sourceMessageId: null, turn: null, convKey: null };

const stateOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const pending = (id: string): number =>
  (mockDb.current!.prepare(`SELECT ${pendingCloseRequestExpr('w')} AS p FROM work w WHERE w.id = ?`)
    .get(id) as { p: number }).p;

function seedStep(title: string, recurring = false): { project: string; id: string } {
  const project = openTrackerProject({ title: 'plan', createdBy: AGENT, origin: ORIGIN });
  const id = openTrackerTask({
    projectId: project, title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT, origin: ORIGIN,
  });
  if (recurring) {
    mockDb.current!.prepare(
      `UPDATE work SET repeat_interval = 1, repeat_unit = 'days', schedule_status = 'waiting',
                       next_run_at = ?, scheduled_start = ?, task_kind = 'brief' WHERE id = ?`,
    ).run(Date.now() + 3_600_000, Date.now() - 86_400_000, id);
  }
  return { project, id };
}

function fileClose(id: string, tag: string): void {
  const r = setTrackerStatus(id, 'complete', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    resultDeliveryId: seedDelivery(`d-${tag}`), reason: 'agent asserts every run is done; the schedule stops here',
  });
  expect(r.kind).toBe('refused');
}

const setState = (id: string, s: string): void => {
  mockDb.current!.prepare('UPDATE work SET state = ? WHERE id = ?').run(s, id);
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'HarnessBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'PM', 'idle', '1970-01-01')`).run(PM);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('F1: a blessed close on a recurring row never leaves a done row with a live schedule', () => {
  for (const from of ['on_deck', 'open', 'blocked', 'claimed'] as const) {
    it(`stop request filed from ${from} with no run in flight: bless stops the schedule and closes the project`, async () => {
      const { project, id } = seedStep(`recurring from ${from}`, true);
      setState(id, from);
      fileClose(id, from);
      const out = await trackerValidateComplete(PM, { task_id: id, valid: true });
      expect(out.startsWith('[OK]'), out).toBe(true);
      expect(stateOf(id)).toBe('done');
      const row = mockDb.current!.prepare('SELECT schedule_status AS s FROM work WHERE id = ?').get(id) as { s: string };
      expect(row.s, 'a done row must not keep a live schedule').toBe('completed');
      expect(stateOf(project), 'the project check ran').toBe('done');
    });
  }
});

describe('F2: a block or pause verdict never consumes a filed close', () => {
  it('block REJECT on a row with a filed close is refused and the request stays pending', async () => {
    const { id } = seedStep('blocked then finished');
    setState(id, 'blocked');
    fileClose(id, 'b1');
    const out = await trackerValidateBlocked(PM, { task_id: id, valid: false, reject_reason: 'not really blocked' });
    expect(out.startsWith('Error:'), out).toBe(true);
    expect(out).toMatch(/kind="?complete/);
    expect(stateOf(id)).toBe('blocked');
    expect(pending(id)).toBe(1);
  });

  it('block BLESS on a row with a filed close is refused too', async () => {
    const { id } = seedStep('blocked then finished');
    setState(id, 'blocked');
    fileClose(id, 'b2');
    const out = await trackerValidateBlocked(PM, { task_id: id, valid: true });
    expect(out.startsWith('Error:'), out).toBe(true);
    expect(pending(id)).toBe(1);
  });

  it('pause REJECT on a row with a filed close is refused and the request stays pending', async () => {
    const { id } = seedStep('paused then finished');
    setState(id, 'paused');
    fileClose(id, 'p1');
    const out = await trackerValidatePause(PM, { task_id: id, valid: false, reject_reason: 'no wait' });
    expect(out.startsWith('Error:'), out).toBe(true);
    expect(stateOf(id)).toBe('paused');
    expect(pending(id)).toBe(1);
  });

  it('CONTROL: a block with no close filed is still rejectable', async () => {
    const { id } = seedStep('really blocked');
    setState(id, 'blocked');
    const out = await trackerValidateBlocked(PM, { task_id: id, valid: false, reject_reason: 'try again' });
    expect(out.startsWith('[OK]'), out).toBe(true);
  });
});
