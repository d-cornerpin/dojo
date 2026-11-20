// The main agent widens one helper for one job through spawn_agent's permissions: the helper gets what it
// was given and, for everything not named, the small default, never the main agent's own reach.
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
import { checkPermission } from '../permissions.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'cloud', 'M', 'm', '["chat","tools"]', 128000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('main', 'Main', 'm', 'idle', '{}')").run();
});

describe('the main agent widens a helper for one job', () => {
  it('the named folder and spawn power are granted; the rest stays small', async () => {
    const { agentId } = await spawnAgent({
      parentId: 'main', name: 'Site builder', systemPrompt: 'Build the site.',
      permissions: { file_read: ['~/Projects/site/**'], file_write: ['~/Projects/site/**'], can_spawn_agents: true } as never,
    });
    const may = (type: 'file_read' | 'file_write' | 'exec' | 'spawn', target = '') =>
      checkPermission(agentId, type === 'exec' ? { type, command: target } : type === 'spawn' ? { type } : { type, path: target }).allowed;
    expect(may('file_write', '~/Projects/site/index.html')).toBe(true);
    expect(may('file_read', '~/Projects/other/secret-plan.md')).toBe(false);
    expect(may('spawn')).toBe(true);
    expect(may('exec', 'git status')).toBe(true);
    expect(may('exec', 'curl https://example.com')).toBe(false);
  });
});
