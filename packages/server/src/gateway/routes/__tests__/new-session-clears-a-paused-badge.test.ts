// The dashboard's New Session goes through the one reset function, and a reset clears the
// badge behind it: a paused or errored agent comes back idle with its error gone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current, closeDb: () => undefined, getDbPath: () => ':memory:' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../config/loader.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/loader.js')>()),
  getJwtSecret: () => 'test-secret',
}));

import { runMigrations } from '../../../db/migrations.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { createServer } from '../../server.js';
import { activeRuns } from '../../../agent/shared-state.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}`, 'content-type': 'application/json' };
const AGENT = 'agent-stuck';
const row = (): { status: string; last_error: string | null; session_started_at: string | null } =>
  mockDb.current!.prepare('SELECT status, last_error, session_started_at FROM agents WHERE id = ?').get(AGENT) as { status: string; last_error: string | null; session_started_at: string | null };

describe('new session clears a paused badge', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    clearPlatformConfigCache();
    mockDb.current.prepare("INSERT INTO agents (id, name, status, config, last_error) VALUES ('agent-stuck', 'Helper One', 'paused', '{}', 'paused after repeated errors')").run();
  });
  afterEach(async () => {
    activeRuns.delete(AGENT);
    const { drainRecoveryNotices } = await import('../../../healer/injury-recovery.js');
    await drainRecoveryNotices();
    mockDb.current?.close();
    mockDb.current = null;
  });

  it('new session clears a paused badge', async () => {
    const res = await app.request(`/api/chat/${AGENT}/new-session`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(row().status).toBe('idle');
    expect(row().last_error).toBeNull();
  });

  it('new session clears an error badge', async () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'error' WHERE id = 'agent-stuck'").run();
    const res = await app.request(`/api/chat/${AGENT}/new-session`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(row().status).toBe('idle');
    expect(row().last_error).toBeNull();
  });
});
