// v3.5 live check of preflight.4, row 5b. A worker filed its close ("[FILED] ... the PM validates the
// request ... Nothing further is needed from you") and the PM's own check-in ladder held it
// (`tracker/__tests__/a-filed-close-is-not-checked-in-on.test.ts`). But two minutes later the turn-start
// tracker check told the same worker the task "has not moved for a while" and refused its other tools
// until it said where the task stands. The ball was the PM's. The gate now asks the same question the
// ladder asks (`closeRequestFiledExpr`, `work/tracker-view.ts`): a close filed and awaiting its verdict
// is not the worker's dangler. A close the PM REJECTED is open work again, and the gate sees it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-closeout-filed', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { runCloseoutGate } from '../closeout-gate.js';
import { initState } from '../../../state.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';
import { seedTrackerTask, seedTrackerProject } from '../../../../../work/__tests__/work-fixture.js';
import { appendWorkEvent } from '../../../../../work/store.js';

const AGENT = 'agent-worker';
const db = (): Database.Database => mockDb.current!;
const MIN = 60_000;

function task(movedMsAgo: number, status = 'in_progress'): string {
  const id = openTrackerTask({ title: 'sort the inbox', status, assignedTo: AGENT, createdBy: AGENT, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } });
  db().prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now() - movedMsAgo, id);
  db().prepare('UPDATE work_events SET created_at = ? WHERE work_id = ?').run(Date.now() - movedMsAgo, id);
  return id;
}
/** The worker's Key-1 filing, as `transition()`'s G9 writes it. */
const fileClose = (id: string, msAgo: number): void => {
  appendWorkEvent(id, 'validation_requested', AGENT,
    { requested_state: 'done', reason: 'done', from: 'claimed', result_delivery_id: null }, Date.now() - msAgo);
};
/** The PM's verdict throwing the close back (`rejectClaim`'s event), the row left where it was. */
const rejectClose = (id: string, msAgo: number): void => {
  appendWorkEvent(id, 'claim_rejected', 'pm', { claim_state: 'done', note: 'two labels are left' }, Date.now() - msAgo);
};
const sqlTime = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
function finishedTurn(n: number, startedMsAgo: number, endedMsAgo: number): void {
  db().prepare(`INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, started_at, ended_at, exit_reason)
    VALUES (?, ?, 'user', 'conv', 1, ?, ?, 'answered')`).run(AGENT, n, sqlTime(startedMsAgo), sqlTime(endedMsAgo));
}
async function armed(): Promise<readonly string[]> {
  const turnCtx = { state: initState(AGENT, 'm') } as never as { state: { danglingTaskIds: readonly string[] } };
  await runCloseoutGate(turnCtx as never, { agentId: AGENT } as never, { db: db() as never, triggerRow: null } as never);
  return turnCtx.state.danglingTaskIds ?? [];
}

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Worker', 'idle')`).run(AGENT);
});

describe('a filed close is not nagged at turn start', () => {
  it.skip('2d: THE RED: the close is filed and no verdict has landed: the gate does not name the task', async () => {
    const id = task(10 * MIN);
    fileClose(id, 9 * MIN);
    finishedTurn(1, 5 * MIN, 3 * MIN);   // a whole turn after the filing, the task untouched in it
    expect(await armed()).not.toContain(id);
  });

  it.skip('2d: a filed close on a queued step of a walked-away project is not named either', async () => {
    const tenAgo = Date.now() - 10 * MIN;
    seedTrackerProject(db(), { id: 'proj-1', title: 'tidy the drive', agentId: AGENT, status: 'active', opened_at: tenAgo, updated_at: tenAgo });
    const step = 'step-1';
    seedTrackerTask(db(), { id: step, title: 'step one', agentId: AGENT, status: 'on_deck', projectId: 'proj-1', schedule_status: 'unscheduled', opened_at: tenAgo, updated_at: tenAgo });
    finishedTurn(1, 5 * MIN, 3 * MIN);
    const control = await armed();
    expect(control).toContain(step);   // the stranded arm sees it before anything is filed
    fileClose(step, 9 * MIN);
    expect(await armed()).not.toContain(step);
  });

  it('CONTROL: the PM rejected the close and the worker left it: it is open work again and IS named', async () => {
    const id = task(10 * MIN);
    fileClose(id, 9 * MIN);
    rejectClose(id, 8 * MIN);
    finishedTurn(1, 5 * MIN, 3 * MIN);
    expect(await armed()).toContain(id);
  });

  it('CONTROL: the same task with no close filed IS named', async () => {
    const id = task(10 * MIN);
    finishedTurn(1, 5 * MIN, 3 * MIN);
    expect(await armed()).toContain(id);
  });
});
