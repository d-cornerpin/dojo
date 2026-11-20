// A helper the owner makes on the dashboard without touching its permissions gets exactly the limits a
// helper the main agent spawns gets: one default, whichever door made it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, getAgentUptime: () => 0 }), stopAgent: vi.fn() }));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { spawnAgent } from '../../../agent/spawner.js';
import { getAgentPermissions } from '../../../agent/permissions.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'cloud', 'M', 'm', '["chat","tools"]', 128000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('main', 'Main', 'm', 'idle', '{}')").run();
});

/** The manifest with the agent's own id taken out, so two agents' limits can be compared. */
const limitsOf = (id: string) => JSON.parse(JSON.stringify(getAgentPermissions(id)).split(id).join('<self>'));

describe('a helper made on the dashboard gets the same default', () => {
  it('matches a spawned helper field for field', async () => {
    const res = await agentsRouter.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Clerk', systemPrompt: 'File receipts.', modelId: 'm' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const made = ((await res.json()) as { data: { id: string } }).data.id;
    const { agentId: spawned } = await spawnAgent({ parentId: 'main', name: 'Helper', systemPrompt: 'Sort files.' });
    expect(limitsOf(made)).toEqual(limitsOf(spawned));
    expect(getAgentPermissions(made).file_read).not.toBe('*');
  });
});
