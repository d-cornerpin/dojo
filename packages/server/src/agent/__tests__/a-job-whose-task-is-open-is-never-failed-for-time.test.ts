// A request waiting on a helper's job is never failed for time while the job's task is open and the helper is not
// ended, however long it runs; a plain question with no task on its thread still fails at its deadline.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { sweepExpiredJoins } from '../a2a-transport.js';
import { freshAgentsDb, testDb, askerDelegates, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-long-job';
const HOUR = 3_600_000;
/** The request was delegated `hours` ago and its deadline passed a minute ago. */
const aged = (ask: string, hours: number): void => {
  testDb().prepare('UPDATE work SET opened_at = ?, ttl_at = ? WHERE id = ?').run(Date.now() - hours * HOUR, Date.now() - 60_000, ask);
};
const requestState = (ask: string): string => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(ask) as { state: string }).state;
const deadline = (ask: string): number => (testDb().prepare('SELECT ttl_at FROM work WHERE id = ?').get(ask) as { ttl_at: number }).ttl_at;

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a job whose task is open is never failed for time', () => {
  it('five hours in, with the helper idle between steps, the request is kept and its deadline moves on', async () => {
    const ask = await askerDelegates('ASSIGN', THREAD);
    aged(ask, 5);
    const out = await sweepExpiredJoins();
    expect(out.failedClosed).toBe(0);
    expect(out.extendedForLiveAssignee).toBe(1);
    expect(requestState(ask)).toBe('claimed');
    expect(deadline(ask)).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('a job whose helper has ended fails at the deadline', async () => {
    const ask = await askerDelegates('ASSIGN', THREAD);
    testDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(HELPER);
    aged(ask, 2);
    expect((await sweepExpiredJoins()).failedClosed).toBe(1);
    expect(requestState(ask)).toBe('failed');
  });

  it('a plain question with no task on its thread fails at the deadline even while the helper is busy', async () => {
    const ask = await askerDelegates('QUESTION', THREAD);
    testDb().prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(HELPER);
    aged(ask, 1);
    expect((await sweepExpiredJoins()).failedClosed).toBe(1);
    expect(requestState(ask)).toBe('failed');
  });
});
