// The dashboard's New Session goes through the one reset function: an agent stuck at
// 'working' with no live run resets and goes idle; an agent in a real live turn is refused.

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

describe('new session on an agent stuck working', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    clearPlatformConfigCache();
    mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-stuck', 'Helper One', 'working', '{}')").run();
  });
  afterEach(async () => {
    activeRuns.delete(AGENT);
    const { drainRecoveryNotices } = await import('../../../healer/injury-recovery.js');
    await drainRecoveryNotices();
    mockDb.current?.close();
    mockDb.current = null;
  });

  it('new session on an agent stuck working with no live run resets it and sets it idle', async () => {
    const res = await app.request(`/api/chat/${AGENT}/new-session`, { method: 'POST', headers: auth });
    const body = await res.json() as { ok: boolean; error?: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(row().session_started_at).not.toBeNull();
    expect(row().status).toBe('idle');
  });

  it('new session on an agent in a live turn is refused and changes nothing', async () => {
    activeRuns.add(AGENT);
    const res = await app.request(`/api/chat/${AGENT}/new-session`, { method: 'POST', headers: auth });
    const body = await res.json() as { ok: boolean; error?: string };
    expect(res.status).toBe(400);
    expect(body.error).toContain('in the middle of a live turn');
    expect(row().session_started_at).toBeNull();
    expect(row().status).toBe('working');
  });
});
