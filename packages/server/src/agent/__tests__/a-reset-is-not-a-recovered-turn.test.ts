// A reset heals a paused agent's status, but only a completed turn proves it works again: the Healer's
// attempt count and the owner's "stuck" record stand, so the next failure does not text him a second time.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { resetSession } from '../reset-session.js';
import { freshAgentsDb, testDb, ASKER, HELPER } from './helpers/agent-requests.js';
import { TOLD } from '../../healer/owner-notices.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a reset is not a recovered turn', () => {
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
