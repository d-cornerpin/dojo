// New Session is a clean start: a job parked in the old session loses its due, so nothing is owed for it after.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { resetSession } from '../reset-session.js';
import { nextOwed, dueOf } from '../v2/owed.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a reset session ends a parked job', () => {
  it('after New Session nothing is owed for the old job', async () => {
    await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    expect(nextOwed(HELPER).map((i) => i.kind)).toEqual(['job']);
    expect((await resetSession(HELPER, { callerAgentId: null, ownerRequested: true })).ok).toBe(true);
    expect(rowOf(task).due).toBeNull();
    expect(nextOwed(HELPER)).toEqual([]);
    expect(dueOf(HELPER).now).toBe(false);
  });
});
