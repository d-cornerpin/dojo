// An agent whose model row is gone is moved to auto-routing through the one model setter: the row says auto,
// the model-change note is written, and a parked turn is looked at again. Through the real startup sweep.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-orphan-model', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
const looked = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('../v2/honest-stop-lock.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  noteModelsChanged: async (agentId?: string) => { looked.push(agentId); },
}));

import { runMigrations } from '../../db/migrations.js';
import { runStartupRecoverySweep } from '../runtime.js';

const AGENT = randomUUID();

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.pragma('foreign_keys = OFF');   // the model row is gone, which the foreign key would refuse
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Helper', 'gone-model', 'idle', '{}')").run(AGENT);
  looked.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('an agent whose model is gone is moved to auto through the one setter', () => {
  it('the row says auto, the change note is written, and its parked turn is looked at again', async () => {
    runStartupRecoverySweep();
    expect(mockDb.current!.prepare('SELECT model_id FROM agents WHERE id = ?').get(AGENT)).toEqual({ model_id: 'auto' });
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system' AND content LIKE '%Model just changed%'").get(AGENT)).toEqual({ n: 1 });
    await vi.waitFor(() => expect(looked).toEqual([AGENT]));
  });
});
