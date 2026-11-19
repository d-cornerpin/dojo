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
  `);
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('primary', 'Primary', 'system', 'sensei')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('creator', 'Creator', 'primary', 'apprentice')").run();
  mockDb.current = db;
  db.prepare(`INSERT INTO agents (id, name, created_by, classification, status) VALUES ('${LIVE_ID}', 'IdAgent', 'creator', 'apprentice', 'idle')`).run();
  db.prepare(`INSERT INTO agents (id, name, created_by, classification, status) VALUES ('${ENDED_ID}', 'EndedAgent', 'primary', 'apprentice', 'terminated')`).run();
  vi.mocked(terminateAgent).mockClear();
});

import { executeTool, toolResultOf } from '../tools/index.js';
import { terminateAgent } from '../spawner.js';
import { randomUUID } from 'node:crypto';

// Ids shaped like real agent ids: one that is in no row, one live agent, one ended agent.
const MISSING_ID = randomUUID();
const LIVE_ID = randomUUID();
const ENDED_ID = randomUUID();

describe('an agent id that does not exist is not terminated', () => {
  it('the main agent ending an id that names no agent is told it does not exist', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-1',
      name: 'kill_agent',
      arguments: { agent_id: MISSING_ID },
    }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("doesn't exist");
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(0);
  });

  it('a real agent named by its id is still ended', async () => {
    const r = toolResultOf(await executeTool('creator', {
      id: 'tc-2',
      name: 'kill_agent',
      arguments: { agent_id: LIVE_ID },
    }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/terminated/i);
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(terminateAgent).mock.calls[0][0]).toBe(LIVE_ID);
  });

  it('an ended agent named by its id gets the already-ended answer', async () => {
    const r = toolResultOf(await executeTool('primary', {
      id: 'tc-3',
      name: 'kill_agent',
      arguments: { agent_id: ENDED_ID },
    }));
    expect(r.content).toContain('already terminated');
    expect(vi.mocked(terminateAgent)).toHaveBeenCalledTimes(0);
  });
});
