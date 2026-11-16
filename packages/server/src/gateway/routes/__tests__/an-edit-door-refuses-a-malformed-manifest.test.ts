// The dashboard's save and the main agent's update_agent check a permission manifest before writing it:
// a malformed one is refused with the field named and the stored scope is left as it was.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, getAgentUptime: () => 0 }), stopAgent: vi.fn() }));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { executeTool, toolResultOf } from '../../../agent/tools/index.js';

const STORED = JSON.stringify({ file_read: ['/tmp/**'], file_write: [], exec_allow: [], exec_deny: [], network_domains: 'none', can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES ('main', 'Main', 'idle', '{}')").run();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config, permissions, spawn_depth, created_by) VALUES ('helper', 'Helper', 'idle', '{}', ?, 1, 'main')").run(STORED);
});
const stored = () => (mockDb.current!.prepare("SELECT permissions FROM agents WHERE id = 'helper'").get() as { permissions: string }).permissions;

describe('an edit door refuses a malformed manifest', () => {
  it('the dashboard save', async () => {
    const res = await agentsRouter.request('/helper', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permissions: { file_read: 42 } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/file_read/);
    expect(stored()).toBe(STORED);
  });

  it('update_agent', async () => {
    const r = toolResultOf(await executeTool('main', { id: 'tc-1', name: 'update_agent', arguments: { agent_id: 'helper', permissions: { exec_allow: 'git' } } }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exec_allow/);
    expect(stored()).toBe(STORED);
  });
});
