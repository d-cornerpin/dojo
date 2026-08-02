// ════════════════════════════════════════
// Spawn contract (P3 timeout ownership + P4 mandatory squads) - dispatch tests
//
// Exercises the REAL executeTool dispatch path (not helpers in isolation), the
// same way squad-coordination does. Verifies the two engine-enforced rules the
// spawn contract adds:
//   - P3: a non-ronin spawn_agent with no timeout_minutes is refused with a
//     teaching error (the creator owns the timeout; there is no default).
//   - P4: an agent may dismiss (kill_agent / delete_group) ONLY targets it
//     created; a user/dashboard-created target refuses, naming the rule. An
//     agent CAN dismiss a target it created (positive control).
//
// spawner.js is mocked so these error/refusal paths never touch the heavy real
// spawn/terminate machinery; the tests assert the tools.ts gates alone.
// ════════════════════════════════════════

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
  isImaginerAgent: () => false,
  isDreamerAgent: () => false,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getTrainerAgentId: () => 'trainer',
  getImaginerAgentId: () => 'imaginer',
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
});

import { executeTool, toolResultOf } from '../tools.js';

describe('spawn contract - P3 timeout ownership', () => {
  it('spawn_agent for a non-ronin sub-agent with no timeout_minutes is refused with a teaching error', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-1',
      name: 'spawn_agent',
      arguments: { name: 'Dana', system_prompt: 'Do a thing.' },
    }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/timeout_minutes/);
    expect(r.content).toMatch(/ronin/);
  });
});

describe('spawn contract - P4 dismissal ownership', () => {
  it('an agent cannot delete a user-created squad', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-2',
      name: 'delete_group',
      arguments: { group_id: 'g-user' },
    }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only delete squads you created/i);
    expect(r.content).toMatch(/dashboard|user/i);
  });

  it('an agent cannot kill a user-created agent', async () => {
    const r = toolResultOf(await executeTool('worker', {
      id: 'tc-3',
      name: 'kill_agent',
      arguments: { agent_id: 'a-user' },
    }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only dismiss sub-agents you created/i);
  });

  it('an agent CAN kill an agent it created (positive control)', async () => {
    const r = toolResultOf(await executeTool('creator', {
      id: 'tc-4',
      name: 'kill_agent',
      arguments: { agent_id: 'a-own' },
    }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/terminated/i);
  });
});
