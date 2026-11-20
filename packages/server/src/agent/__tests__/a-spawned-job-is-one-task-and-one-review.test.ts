// A helper made for a job is given it the way any agent is: one ASSIGN on its own thread carrying the job's
// rules, which is one task on the board, handed in by its reply. A transfer's task rides that ASSIGN; a task
// that already has a thread is refused before any agent is made, with a way forward; a kept helper's work is
// its own task and it can finish; a helper spawned with a narrow tool list can still reply and finish; and an
// undeclared task_id on send_to_agent is never read.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {},
}));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { runMigrations } from '../../db/migrations.js';
import { executeTool, toolResultOf } from '../tools/index.js';
import { getFilteredTools } from '../tools/surface.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { workersOf } from '../../work/done/record.js';

const db = (): Database.Database => mockDb.current!;
const call = async (agentId: string, name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(agentId, { id: `tc-${Math.random()}`, name, arguments: args }));
const spawn = (args: Record<string, unknown>) =>
  call('main', 'spawn_agent', { name: 'Helper', system_prompt: 'Write the report.', timeout_minutes: 10, ...args });
const helperId = (): string | undefined => (db().prepare("SELECT id FROM agents WHERE name = 'Helper'").get() as { id: string } | undefined)?.id;
const assignsTo = (agentId: string) => db().prepare(
  "SELECT a2a_thread_id AS thread, content FROM messages WHERE agent_id = ? AND a2a_intent = 'ASSIGN'",
).all(agentId) as Array<{ thread: string; content: string }>;
const tasksHeldBy = (agentId: string) => db().prepare(
  "SELECT id, a2a_thread_id AS thread, state FROM work WHERE kind = 'task' AND COALESCE(assignee_agent, agent_id) = ?",
).all(agentId) as Array<{ id: string; thread: string | null; state: string }>;
const threadOf = (taskId: string): string | null =>
  (db().prepare('SELECT a2a_thread_id AS t FROM work WHERE id = ?').get(taskId) as { t: string | null }).t;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'cloud', 'M', 'm', '["chat","tools"]', 128000, 1)`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config)
    VALUES ('main', 'Main', 'm', 'idle', '{}'), ('peer', 'Peer', 'm', 'idle', '{}')`).run();
  seedTrackerTask(db(), { id: 'task-mine-0001', title: 'Write the report', agentId: 'main' });
});

describe('a spawned job is one task and one review', () => {
  it('a transferred task rides the one ASSIGN, and the reply hands it in', async () => {
    const r = await spawn({ task_id: 'task-mine-0001', task_handling: 'transfer' });
    expect(r.isError, r.content).toBeFalsy();
    const helper = helperId()!;
    const [assign, ...more] = assignsTo(helper);
    expect(more).toHaveLength(0);
    expect(assign.content).toContain('Write the report.');
    expect(assign.content).toContain('complete_task');
    expect(assign.content).toContain('reply on this thread with the result (COMPLETE, or FAIL if it cannot be done); that reply hands the task in.');
    expect(r.content).toMatch(/is the board task for this work, held by ".+"\. Their final reply on this thread is the answer, and it wakes you\./);
    expect(assign.content).toContain('reply on this thread with send_to_agent(intent="COMPLETE", thread_id=<the thread_id named at the end of this message>, payload=<your full result>). That reply hands your task in.');
    expect(threadOf('task-mine-0001')).toBe(assign.thread);
    expect(tasksHeldBy(helper).map((t) => t.id)).toEqual(['task-mine-0001']);
    expect(db().prepare("SELECT COUNT(*) AS n FROM messages WHERE origin_intent = 'spawn_kickoff'").get()).toEqual({ n: 0 });

    const reply = await call(helper, 'send_to_agent', {
      agent: 'main', intent: 'COMPLETE', thread_id: assign.thread, payload: 'The report is written.',
    });
    expect(reply.isError, reply.content).toBeFalsy();
    expect(tasksHeldBy(helper)[0].state).toBe('handed_in');
    expect([...workersOf('task-mine-0001')], 'handing a task to a helper is not working it').toEqual([helper]);
  });

  it('a task that already has a thread is refused before any agent is made, and keep still works', async () => {
    db().prepare("UPDATE work SET a2a_thread_id = 'thr-from-peer' WHERE id = 'task-mine-0001'").run();
    const refused = await spawn({ task_id: 'task-mine-0001', task_handling: 'transfer' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('already has its own thread');
    expect(refused.content).toContain('task_handling="keep"');
    expect(helperId()).toBeUndefined();
    expect(threadOf('task-mine-0001')).toBe('thr-from-peer');

    const kept = await spawn({ task_id: 'task-mine-0001', task_handling: 'keep' });
    expect(kept.isError, kept.content).toBeFalsy();
    expect(helperId()).toBeDefined();
  });

  it("a kept helper's work is its own task: its reply hands it in, and complete_task then ends it", async () => {
    const r = await spawn({ task_id: 'task-mine-0001', task_handling: 'keep' });
    expect(r.content).toContain("Helper's work for it is its own task");
    const helper = helperId()!;
    const [own] = tasksHeldBy(helper);
    expect(own.thread).toBe(assignsTo(helper)[0].thread);
    expect(tasksHeldBy('main').map((t) => t.id)).toEqual(['task-mine-0001']);

    await call(helper, 'send_to_agent', { agent: 'main', intent: 'COMPLETE', thread_id: own.thread, payload: 'The report is written.' });
    expect(tasksHeldBy(helper)[0].state).toBe('handed_in');
    const done = await call(helper, 'complete_task', { status: 'complete', summary: 'The report is written.' });
    expect(done.isError, done.content).toBeFalsy();
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(helper) as { status: string }).status).toBe('terminated');
    const words = db().prepare(
      "SELECT a2a_thread_id AS thread FROM messages WHERE agent_id = 'main' AND source_agent_id = ? AND a2a_intent = 'COMPLETE'",
    );
    expect(words.all(helper), 'its reply was its answer; complete_task sends no second copy').toEqual([{ thread: own.thread }]);
  });

  it('a helper whose result is only text is told the one step that works, and finishes in it', async () => {
    await spawn({});
    const helper = helperId()!;
    const thread = assignsTo(helper)[0].thread;
    const refused = await call(helper, 'complete_task', { status: 'complete', summary: 'The report is written.' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain(`send_to_agent(intent="COMPLETE", thread_id="${thread}"`);
    await call(helper, 'send_to_agent', { agent: 'main', intent: 'COMPLETE', thread_id: thread, payload: 'The report is written.' });
    const done = await call(helper, 'complete_task', { status: 'complete', summary: 'The report is written.' });
    expect(done.isError, done.content).toBeFalsy();
    expect(tasksHeldBy(helper)[0].state).toBe('handed_in');
    const words = db().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'main' AND source_agent_id = ? AND a2a_intent = 'COMPLETE'");
    expect(words.get(helper)).toEqual({ n: 1 });
  });

  it('a helper spawned with a narrow tool list still holds send_to_agent and finishes a text-only job', async () => {
    const r = await spawn({ tools: { allow: ['file_read', 'complete_task'], deny: [] } });
    expect(r.isError, r.content).toBeFalsy();
    const helper = helperId()!;
    expect(getFilteredTools(helper).map((t) => t.name)).toEqual(expect.arrayContaining(['file_read', 'complete_task', 'send_to_agent']));
    expect(getFilteredTools(helper).map((t) => t.name)).not.toContain('file_write');
    const thread = assignsTo(helper)[0].thread;
    const reply = await call(helper, 'send_to_agent', { agent: 'main', intent: 'COMPLETE', thread_id: thread, payload: 'The report is written.' });
    expect(reply.isError, reply.content).toBeFalsy();
    const done = await call(helper, 'complete_task', { status: 'complete', summary: 'The report is written.' });
    expect(done.isError, done.content).toBeFalsy();
    expect(tasksHeldBy(helper)[0].state).toBe('handed_in');
  });

  it('an undeclared task_id on send_to_agent is never read', async () => {
    const r = await call('main', 'send_to_agent', {
      agent: 'peer', intent: 'ASSIGN', payload: 'Pull the numbers.', task_id: 'task-mine-0001',
    });
    expect(r.isError, r.content).toBeFalsy();
    expect(threadOf('task-mine-0001')).toBeNull();
    expect(tasksHeldBy('peer')).toHaveLength(1);
  });
});
