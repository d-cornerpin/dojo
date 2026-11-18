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

// Stub the spawner so refusal/error paths never reach the real spawn/terminate
// machinery. applySpawnTimeoutDecision / spawnAgent are not called on the paths
// under test; terminateAgent is a no-op for the positive kill_agent control.
vi.mock('../spawner.js', () => ({
  spawnAgent: vi.fn(async () => ({ agentId: 'x', name: 'x', status: 'idle', persist: false })),
  terminateAgent: vi.fn(),
  completeAgent: vi.fn(async () => {}),
  applySpawnTimeoutDecision: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

beforeEach(() => {
  const db = new Database(':memory:');
  // Full agents column set the executor prelude reads (fingerprint + resolvers).
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
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      action_type TEXT,
      target TEXT,
      result TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Callers.
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('primary', 'Primary', 'system', 'sensei')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('worker', 'Worker', 'primary', 'apprentice')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('creator', 'Creator', 'primary', 'apprentice')").run();
  // Targets.
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status) VALUES ('a-user', 'UserAgent', 'dashboard', 'apprentice', 'idle')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status) VALUES ('a-own', 'OwnedAgent', 'creator', 'apprentice', 'idle')").run();
  // Groups: one user-created, one primary-created.
  db.prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('g-user', 'UserSquad', 'dashboard')").run();
  db.prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('g-mine', 'MySquad', 'primary')").run();
  mockDb.current = db;
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status) VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'IdAgent', 'creator', 'apprentice', 'idle')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status) VALUES ('bbbbbbbb-cccc-dddd-eeee-ffffffffffff', 'EndedAgent', 'primary', 'apprentice', 'terminated')").run();
  vi.mocked(terminateAgent).mockClear();
});

import { executeTool, toolResultOf } from '../tools/index.js';
import { terminateAgent } from '../spawner.js';

describe('an agent id that does not exist is not terminated', () => {
  it('the main agent ending an id that names no agent is told it does not exist', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-1',
      name: 'kill_agent',
      arguments: { agent_id: '11111111-2222-3333-4444-555555555555' },
    }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("doesn't exist");
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(0);
  });

  it('a real agent named by its id is still ended', async () => {
    const r = toolResultOf(await executeTool('creator', {
      id: 'tc-2',
      name: 'kill_agent',
      arguments: { agent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/terminated/i);
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(terminateAgent).mock.calls[0][0]).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('an ended agent named by its id gets the already-ended answer', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-3',
      name: 'kill_agent',
      arguments: { agent_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' },
    }));
    expect(r.content).toContain('already terminated');
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(0);
  });
});
