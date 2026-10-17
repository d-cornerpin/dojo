// t193 — owner decision 4: spawn_agent(task_id) with no explicit keep or transfer is REFUSED,
// before any agent is created. At v3.3.3 (`e63aa3d7`) the default silently TRANSFERRED the task,
// resolved the id with no ownership check (so a task another live agent held could be taken),
// logged no "from", recorded no reassignment event, and swallowed a failed transfer.
//
// Driven through the real executor, the same way `agent/__tests__/spawn-contract.test.ts` is.
// Roles are structural (the primary flag), never names.

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
  isImaginerAgent: () => false,
  isDreamerAgent: () => false,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getTrainerAgentId: () => 'trainer',
  getImaginerAgentId: () => 'imaginer',
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
    return { agentId: 'new-agent', name: 'helper', status: 'idle', persist: false };
  }),
  terminateAgent: vi.fn(),
  completeAgent: vi.fn(async () => {}),
  applySpawnTimeoutDecision: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

import { createWorkTable, seedTrackerTask } from '../../../../work/__tests__/work-fixture.js';
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
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, agent_id TEXT, action_type TEXT, target TEXT, result TEXT, detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY, id TEXT, agent_id TEXT, role TEXT, content TEXT, created_at TEXT
    );
  `);
  db.prepare("INSERT INTO agents (id, name, created_by, classification) VALUES ('primary', 'p', 'system', 'sensei')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status) VALUES ('worker', 'w', 'primary', 'apprentice', 'working')").run();
  db.prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('g-mine', 'squad', 'primary')").run();
  db.prepare("UPDATE agents SET group_id = 'g-mine'").run();
  seedTrackerTask(db, { id: 'task-mine-0001', title: 'Draft the summary', agentId: 'primary' });
  seedTrackerTask(db, { id: 'task-theirs-001', title: 'Pull the numbers', agentId: 'worker', createdBy: 'primary' });
  mockDb.current = db;
});

const spawn = async (args: Record<string, unknown>) => toolResultOf(await executeTool('primary', {
  id: `tc-${Math.random()}`,
  name: 'spawn_agent',
  arguments: { name: 'Helper', system_prompt: 'Help with the task.', timeout_minutes: 10, group_id: 'g-mine', ...args },
}));

const holderOf = (id: string) =>
  (mockDb.current!.prepare('SELECT agent_id, assignee_agent FROM work WHERE id = ?').get(id) as { agent_id: string; assignee_agent: string });

describe('dec 4 spawn_agent(task_id) needs an explicit keep or transfer', () => {
  it('RED: task_id with no task_handling is refused and NO agent is created', async () => {
    const r = await spawn({ task_id: 'task-mine-0001' });
    expect(r.isError, r.content).toBe(true);
    expect(r.content).toMatch(/task_handling/);
    expect(spawned, 'the refusal comes before the spawn').toHaveLength(0);
    expect(holderOf('task-mine-0001').agent_id).toBe('primary');
  });

  it("RED: a transfer of a task another LIVE agent holds is refused before the spawn", async () => {
    const r = await spawn({ task_id: 'task-theirs-001', task_handling: 'transfer' });
    expect(r.isError, r.content).toBe(true);
    expect(spawned).toHaveLength(0);
    expect(holderOf('task-theirs-001').agent_id).toBe('worker');
  });

  it('a transfer of your own task moves it and records cause, who, from and to', async () => {
    const r = await spawn({ task_id: 'task-mine-0001', task_handling: 'transfer' });
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toMatch(/transferred to helper \(cause: coordination\)/);
    expect(holderOf('task-mine-0001')).toEqual({ agent_id: 'new-agent', assignee_agent: 'new-agent' });
    const ev = mockDb.current!.prepare("SELECT actor, payload FROM work_events WHERE work_id = 'task-mine-0001' AND kind = 'audit'").all() as Array<{ actor: string; payload: string }>;
    const moved = ev.map((e) => JSON.parse(e.payload) as Record<string, string>).find((p) => p.entry_kind === 'reassignment');
    expect(moved?.reason).toContain('cause=coordination');
    expect(moved?.action_taken).toContain('primary');
    expect(moved?.action_taken).toContain('new-agent');
  });

  it('keep leaves the task where it is and puts the helper on the record', async () => {
    const r = await spawn({ task_id: 'task-theirs-001', task_handling: 'keep' });
    expect(r.isError, r.content).toBeFalsy();
    expect(holderOf('task-theirs-001').agent_id).toBe('worker');
    expect(r.content).toMatch(/stays with its current holder/);
  });
});
