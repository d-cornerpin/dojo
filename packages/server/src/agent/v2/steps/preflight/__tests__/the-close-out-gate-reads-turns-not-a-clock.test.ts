// v3.5 field fix 3, audit round (#8). The owner (2026-10-13, verbatim): "I don't want to put hard limits
// on the dojo. The dojo should be smart enough to know when enough is enough." and (2026-10-12): "we
// can't have the dojo panick every 15 minutes because an agent isn't responding". The close-out gate
// armed on a task "not touched in the last 10 minutes" (a fixed clock), so a slow model that simply had
// not finished its call yet was treated as having abandoned the task. The real signal: the agent has
// had a whole turn since the task last moved and did not touch it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-closeout-signal', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { runCloseoutGate } from '../closeout-gate.js';
import { initState } from '../../../state.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';

const AGENT = 'agent-slow';
const db = (): Database.Database => mockDb.current!;
const MIN = 60_000;

function task(movedMsAgo: number): string {
  const id = openTrackerTask({ title: 'sort the inbox', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT, origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null } });
  db().prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now() - movedMsAgo, id);
  db().prepare('UPDATE work_events SET created_at = ? WHERE work_id = ?').run(Date.now() - movedMsAgo, id);
  return id;
}
const sqlTime = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
function finishedTurn(n: number, startedMsAgo: number, endedMsAgo: number): void {
  db().prepare(`INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, started_at, ended_at, exit_reason)
    VALUES (?, ?, 'user', 'conv', 1, ?, ?, 'answered')`).run(AGENT, n, sqlTime(startedMsAgo), sqlTime(endedMsAgo));
}
async function armed(): Promise<readonly string[]> {
  const turnCtx = { state: initState(AGENT, 'm') } as never as { state: { danglingTaskIds: readonly string[] } };
  await runCloseoutGate(turnCtx as never, { agentId: AGENT } as never, { db: db() as never, triggerRow: null } as never);
  return turnCtx.state.danglingTaskIds;
}

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Slow', 'idle')`).run(AGENT);
});

describe('the close-out gate reads turns, not a clock', () => {
  it('THE RED: a task idle for 40 minutes while its slow agent ran no whole turn since is NOT a dangler', async () => {
    finishedTurn(1, 60 * MIN, 45 * MIN);   // the last finished turn ended BEFORE the task last moved
    const id = task(40 * MIN);
    expect(await armed()).not.toContain(id);
  });

  it('a task the agent ran a whole turn past without touching IS a dangler, however recent the turn', async () => {
    const id = task(5 * MIN);
    finishedTurn(1, 3 * MIN, 1 * MIN);   // a whole turn after the task last moved, and it did not touch it
    expect(await armed()).toContain(id);
  });

  it('CONTROL: an agent with no finished turn has no danglers', async () => {
    const id = task(90 * MIN);
    expect(await armed()).not.toContain(id);
  });
});
