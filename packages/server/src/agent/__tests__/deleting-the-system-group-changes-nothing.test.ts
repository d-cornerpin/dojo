// Deleting the System group is refused even from the main agent with terminate_members=true: no member is ended and no row changes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: () => false,
  isDreamerAgent: () => false,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getTrainerAgentId: () => 'trainer',
  getHealerAgentId: () => 'healer',
  getDreamerAgentId: () => 'dreamer',
}));

vi.mock('../runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn() }),
}));

vi.mock('../spawner.js', () => ({
  spawnAgent: vi.fn(async () => ({ agentId: 'x', name: 'x', status: 'idle', persist: false })),
  terminateAgent: vi.fn(),
  completeAgent: vi.fn(async () => {}),
  applySpawnTimeoutDecision: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      model_id TEXT,
      permissions TEXT DEFAULT '{}',
      spawn_depth INTEGER DEFAULT 0,
      created_by TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}',
      group_id TEXT,
      classification TEXT,
      task_id TEXT,
      status TEXT DEFAULT 'idle',
      config TEXT NOT NULL DEFAULT '{}',
      max_runtime INTEGER,
      timeout_at TEXT,
      timeout_decision_pending INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('primary', 'Primary', 'system', 'sensei')").run();
  mockDb.current = db;
  db.prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('system-group', 'System', 'system')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status, group_id) VALUES ('sys-member', 'SysMember', 'primary', 'apprentice', 'idle', 'system-group')").run();
  vi.mocked(terminateAgent).mockClear();
});

import { executeTool, toolResultOf } from '../tools/index.js';
import { terminateAgent } from '../spawner.js';

describe('deleting the System group changes nothing', () => {
  it('the main agent asking to delete it with its members is refused and no member is ended', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-1',
      name: 'delete_group',
      arguments: { group_id: 'system-group', terminate_members: true },
    }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Cannot delete the System group. Nothing was changed.');
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(0);
  });

  it('the group and its member are still there', async () => {
    await executeTool('primary', {
      id: 'tc-1',
      name: 'delete_group',
      arguments: { group_id: 'system-group', terminate_members: true },
    });
    expect(
      mockDb.current!.prepare("SELECT group_id FROM agents WHERE id = 'sys-member'").get()
    ).toEqual({ group_id: 'system-group' });
    expect(
      mockDb.current!.prepare("SELECT id FROM agent_groups WHERE id = 'system-group'").get()
    ).toEqual({ id: 'system-group' });
  });
});
