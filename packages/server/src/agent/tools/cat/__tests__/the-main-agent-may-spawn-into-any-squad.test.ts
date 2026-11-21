// The main agent may spawn a helper into any squad; any other agent only into one it made or a project's.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: (id: string) => id === 'pm',
  isDreamerAgent: () => false,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getTrainerAgentId: () => 'trainer',
  getHealerAgentId: () => 'healer',
  getDreamerAgentId: () => 'dreamer',
  getOwnerName: () => 'the owner',
}));
vi.mock('../../../runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn() }),
}));
const spawned = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../spawner.js', () => ({
  spawnAgent: vi.fn(async (opts: Record<string, unknown>) => {
    spawned.push(opts);
    mockDb.current!.prepare("INSERT INTO agents (id, name, created_by, classification, status) VALUES ('new-agent', 'helper', ?, 'apprentice', 'idle')")
      .run(opts.parentId as string);
    return { agentId: 'new-agent', name: 'helper', status: 'idle', persist: false, warnings: [] };
  }),
  terminateAgent: vi.fn(),
  completeAgent: vi.fn(async () => {}),
  applySpawnTimeoutDecision: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

import { createWorkTable } from '../../../../work/__tests__/work-fixture.js';
import { executeTool, toolResultOf } from '../../index.js';

beforeEach(() => {
  spawned.length = 0;
  const db = new Database(':memory:');
  createWorkTable(db);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, model_id TEXT, permissions TEXT DEFAULT '{}',
      spawn_depth INTEGER DEFAULT 0, created_by TEXT, tools_policy TEXT NOT NULL DEFAULT '{}',
      group_id TEXT, classification TEXT, task_id TEXT, status TEXT DEFAULT 'idle',
      config TEXT NOT NULL DEFAULT '{}', max_runtime INTEGER, timeout_at TEXT,
      timeout_decision_pending INTEGER DEFAULT 0, parent_agent TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT, created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('primary', 'p', 'system', 'sensei')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification, permissions) VALUES ('peer', 'q', 'primary', 'sensei', ?)")
    .run(JSON.stringify({ file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], network_domains: '*', max_processes: 5, can_spawn_agents: true, can_assign_permissions: false, system_control: [] }));
  db.prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('g-theirs', 'their squad', 'someone-else')").run();
  mockDb.current = db;
});

const spawnAs = async (caller: string) => toolResultOf(await executeTool(caller, {
  id: `tc-${Math.random()}`,
  name: 'spawn_agent',
  arguments: { name: 'Helper', system_prompt: 'Help with the task.', timeout_minutes: 10, group_id: 'g-theirs', auto_start: false },
}));

describe('spawning into a squad the caller did not create', () => {
  it('the main agent may', async () => {
    const r = await spawnAs('primary');
    expect(r.isError, r.content).toBeFalsy();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.groupId).toBe('g-theirs');
  });

  it('another agent is refused and nothing is spawned', async () => {
    const r = await spawnAs('peer');
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only spawn into a squad you created/);
    expect(spawned).toHaveLength(0);
  });
});
