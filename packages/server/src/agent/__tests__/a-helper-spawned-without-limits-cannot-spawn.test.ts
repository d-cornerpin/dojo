// A helper the main agent spawns with no limits cannot make helpers or hand out permissions, and the
// refusal it meets names what the main agent would grant to let it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { runMigrations } from '../../db/migrations.js';
import { spawnAgent } from '../spawner.js';
import { getAgentPermissions } from '../permissions.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'cloud', 'M', 'm', '["chat","tools"]', 128000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('main', 'Main', 'm', 'idle', '{}')").run();
});

describe('a helper spawned without limits cannot spawn', () => {
  it('its own spawn is refused with the grant to ask for, and it cannot assign permissions', async () => {
    const { agentId } = await spawnAgent({ parentId: 'main', name: 'Helper', systemPrompt: 'Sort files.' });
    expect(getAgentPermissions(agentId).can_assign_permissions).toBe(false);
    await expect(spawnAgent({ parentId: agentId, name: 'Grandchild', systemPrompt: 'Help.' }))
      .rejects.toThrow(/can_spawn_agents/);
  });
});
