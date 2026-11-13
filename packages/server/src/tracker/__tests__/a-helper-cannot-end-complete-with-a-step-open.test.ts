// A spawned helper that owns several tasks cannot end itself "complete" while any of them is open.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-helper-ends-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { agentsHandlers } from '../../agent/tools/cat/agents.js';

const AGENT = 'agent-helper';
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const completeTask = (status: string): Promise<Out> =>
  (agentsHandlers['complete_task'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args: { status, summary: 'my part is done' } });
const db = (): Database.Database => mockDb.current!;
const agentStatus = (): string => (db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status;
const stateOf = (id: string): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

async function openStep(title: string): Promise<string> {
  const id = /task_id=([0-9a-f-]{36})/.exec((await call('work_open:task', { title, goal: `${title} done` })).content)![1];
  await call('work_update:status', { task_id: id, status: 'in_progress' });
  return id;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, classification, created_at, updated_at)
    VALUES (?, 'Helper', 'm1', 'idle', '{}', 1, 'owner', 'apprentice', datetime('now'), datetime('now'))`).run(AGENT);
});

describe('a helper cannot end "complete" with a step open', () => {
  it('several owned steps, one paused: refused, the helper stays, both steps untouched', async () => {
    const measure = await openStep('Measure the shed');
    const order = await openStep('Order the lumber');
    expect((await call('work_update:status', { task_id: order, status: 'paused', notes: 'waiting for the owner to approve the quote' })).isError).toBe(false);
    const out = await completeTask('complete');
    expect(out.isError).toBe(true);
    expect(out.content).toContain('"Measure the shed"');
    expect(out.content).toContain('"Order the lumber"');
    expect(agentStatus()).not.toBe('terminated');
    expect([stateOf(measure), stateOf(order)]).toEqual(['claimed', 'claimed']);
  });

  it('with every step handed in, complete ends it', async () => {
    for (const id of [await openStep('Measure the shed'), await openStep('Order the lumber')]) {
      const handIn = await call('work_update:hand_in', { task_id: id, outcome: 'cant_be_done', proof: [{ kind: 'remainder', ref: 'the whole step', reason: 'the owner cancelled the shed project' }], note: 'cancelled' });
      expect(handIn.isError, handIn.content).toBe(false);
    }
    expect((await completeTask('complete')).content).toMatch(/Task completion reported: complete/);
  });
});
