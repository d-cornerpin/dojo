// A spawn that names a model which is not a chat model is refused, for the main agent and for a helper.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../permissions.js', async (orig) => ({ ...(await orig<typeof import('../permissions.js')>()), checkPermission: () => ({ allowed: true }) }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
const primary = vi.hoisted(() => ({ id: 'parent' }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === primary.id, getPrimaryAgentId: () => primary.id,
}));

import { runMigrations } from '../../db/migrations.js';
import { spawnAgent } from '../spawner.js';

const spawn = (modelId: string) => spawnAgent({ parentId: 'parent', name: 'Helper', systemPrompt: 'Sort files.', modelId } as never);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  for (const [id, caps] of [['m-chat', '["chat","tools"]'], ['m-video', '["video_generation"]']] as const) {
    db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
      VALUES (?, 'cloud', ?, ?, ?, 128000, 1)`).run(id, id, id, caps);
  }
  db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('parent', 'Parent', 'm-chat', 'idle', '{}')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; primary.id = 'parent'; });

describe('a spawn on a model that is not a chat model', () => {
  it('is refused for the main agent', async () => {
    await expect(spawn('m-video')).rejects.toThrow(/Spawn denied: m-video is not a chat model/);
  });
  it('is refused for a helper', async () => {
    primary.id = 'someone-else';
    await expect(spawn('m-video')).rejects.toThrow(/not a chat model/);
  });
  it('a chat model still spawns', async () => {
    await expect(spawn('m-chat')).resolves.toBeTruthy();
  });
});
