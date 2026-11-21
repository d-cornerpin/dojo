// A named local model too big for this Mac's memory refuses a helper's spawn and only warns the main agent's;
// a model under the 32K floor is refused for both.
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
vi.mock('../local-model-fit.js', async (orig) => ({
  ...(await orig<typeof import('../local-model-fit.js')>()),
  refuseUnfitLocalModel: async (id: string) => (id === 'm-huge' ? 'This model needs more memory than this Mac has.' : null),
}));
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
  for (const [id, window] of [['m-huge', 128_000], ['m-small', 8192]] as const) {
    db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
      VALUES (?, 'cloud', ?, ?, '["chat","tools"]', ?, 1)`).run(id, id, id, window);
  }
  db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('parent', 'Parent', 'm-huge', 'idle', '{}')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; primary.id = 'parent'; });

describe('a spawn on a model too big for memory', () => {
  it('the main agent spawns, warned', async () => {
    expect((await spawn('m-huge')).warnings.join(' ')).toMatch(/more memory/);
  });
  it("a helper's spawn is refused", async () => {
    primary.id = 'someone-else';
    await expect(spawn('m-huge')).rejects.toThrow(/more memory/);
  });
  it('a model under the floor is refused for the main agent and a helper alike', async () => {
    await expect(spawn('m-small')).rejects.toThrow(/too small/);
    primary.id = 'someone-else';
    await expect(spawn('m-small')).rejects.toThrow(/too small/);
  });
});
