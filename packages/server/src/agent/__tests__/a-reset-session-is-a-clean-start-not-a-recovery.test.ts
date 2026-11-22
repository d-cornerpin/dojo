// New Session is a clean start: a job parked in the old session loses its due, so nothing is owed for it after. It is
// not a recovery: a reset heals a paused agent's status, but only a completed turn proves it works again, so the
// Healer's attempt count and the owner's "stuck" record stand and the next failure does not text him a second time.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { resetSession } from '../reset-session.js';
import { nextOwed, dueOf } from '../v2/owed.js';
import { freshAgentsDb, testDb, ASKER, HELPER } from './helpers/agent-requests.js';
import { TOLD } from '../../healer/owner-notices.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a reset session is a clean start, not a recovery', () => {
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

  it('another agent resets a paused agent: it goes idle, its attempts and the stuck record stand', async () => {
    testDb().prepare("UPDATE agents SET status = 'paused', recovery_attempts = 3 WHERE id = ?").run(HELPER);
    testDb().prepare('INSERT INTO healer_state (scope, key, at_ms, value) VALUES (?, ?, ?, ?)')
      .run(TOLD, `stuck:${HELPER}`, Date.now(), 'The helper has been stuck for a few tries.');
    const r = await resetSession(HELPER, { callerAgentId: ASKER });
    expect(r.ok && r.healed).toBe(true);
    const row = testDb().prepare('SELECT status, recovery_attempts AS attempts FROM agents WHERE id = ?').get(HELPER);
    expect(row).toEqual({ status: 'idle', attempts: 3 });
    expect(testDb().prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get(TOLD, `stuck:${HELPER}`)).toBeDefined();
  });
});
