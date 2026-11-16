// Opening a technique to edit starts the Trainer on a fresh session through the same door as Reset: the
// earlier conversation is kept (behind the session boundary), and no door deletes it.

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

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}`, 'content-type': 'application/json' };
const TRAINER = 'agent-trainer';
const count = (): number =>
  (mockDb.current!.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role <> 'system'").get(TRAINER) as { n: number }).n;

describe('opening a technique to edit keeps the Trainer\'s history', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    const db = mockDb.current;
    db.prepare("INSERT INTO agents (id, name, status, config, classification, spawn_depth) VALUES (?, 'trainer', 'idle', '{}', 'sensei', 1)").run(TRAINER);
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('trainer_agent_id', ?)").run(TRAINER);
    clearPlatformConfigCache();
    const add = db.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)");
    add.run('m1', TRAINER, 'user', 'build a new technique for the weekly report', Date.now() - 60_000);
    add.run('m2', TRAINER, 'assistant', 'Draft saved.', Date.now() - 50_000);
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('the fresh start keeps every earlier message and sets the session boundary', async () => {
    const res = await app.request(`/api/chat/${TRAINER}/new-session`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(count()).toBe(2);
    const row = mockDb.current!.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(TRAINER) as { session_started_at: string | null };
    expect(row.session_started_at).not.toBeNull();
  });

  it('no technique door wipes the Trainer\'s messages', async () => {
    await app.request('/api/techniques/clear-session', { method: 'POST', headers: auth });
    expect(count()).toBe(2);
  });
});
