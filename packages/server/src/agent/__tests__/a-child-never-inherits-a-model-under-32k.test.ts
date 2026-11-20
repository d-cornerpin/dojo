// A spawned agent with no model named takes its parent's; when that model is under the 32K floor the spawn is
// refused with the floor's sentence, whatever model the parent itself keeps, the main agent included.
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
const primary = vi.hoisted(() => ({ id: 'someone-else' }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === primary.id, getPrimaryAgentId: () => primary.id,
}));

import { runMigrations } from '../../db/migrations.js';
import { spawnAgent } from '../spawner.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m-small', 'cloud', 'Small', 'small', '["chat","tools"]', 8192, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('parent', 'Parent', 'm-small', 'idle', '{}')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; primary.id = 'someone-else'; });

describe('a child never inherits a model under 32K', () => {
  it('the spawn is refused and no child row is written', async () => {
    await expect(spawnAgent({ parentId: 'parent', name: 'Helper', systemPrompt: 'Sort files.' } as never)).rejects.toThrow(/too small for an agent's main model/);
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM agents WHERE id != 'parent'").get()).toEqual({ n: 0 });
  });

  it('the main agent is refused too', async () => {
    primary.id = 'parent';
    await expect(spawnAgent({ parentId: 'parent', name: 'Helper', systemPrompt: 'Sort files.' } as never)).rejects.toThrow(/too small for an agent's main model/);
  });

  it('a big model named by the caller is accepted', async () => {
    mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
      VALUES ('m-big', 'cloud', 'Big', 'big', '["chat","tools"]', 128000, 1)`).run();
    const r = await spawnAgent({ parentId: 'parent', name: 'Helper', systemPrompt: 'Sort files.', modelId: 'm-big' } as never);
    expect(r.warnings).toEqual([]);
  });
});
