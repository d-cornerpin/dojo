// v3.5 live check of preflight.4, "Unexpected" 4. The main agent called
// work_update(action="close_project", status="complete") and was answered "[OK] ... Project ... closed.
// Tasks closed by this call: 0", while the log shows every close refused (`bulk close refused ...
// done-requires-delivery`) and the project and its five tasks stayed open. The agent then told the owner
// the work was finished. The engine reports facts to the model: when the project did not close, the
// result says so, names what refused and why (the product's own refusal words), and what is still open.
// When it really closes, the result is unchanged.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-project-close-truth', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';

const AGENT = 'agent-closer';
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;
const stateOf = (id: string): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const tasksOf = (project: string): Array<{ id: string; title: string; state: string }> =>
  db().prepare("SELECT id, title, state FROM work WHERE parent_id = ? AND kind = 'task' ORDER BY opened_at, id").all(project) as never;

const bulkClosedNotes = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%was bulk-closed%'").get() as { n: number }).n;

async function openProject(): Promise<string> {
  const out = await call('work_open:project', {
    title: 'Fix the stuck schedule', level: 1, allow_duplicate: true,
    plan: { approach: 'Find why it froze, then unpause it.', steps: [
      { title: 'Find the cause', how: 'read the schedule rows', done: 'the cause is written down' },
      { title: 'Unpause the schedule', how: 'work_schedule resume', done: 'the next run is in the future' },
    ] },
    tasks: [{ title: 'Find the cause' }, { title: 'Unpause the schedule' }],
  });
  const m = /project_id=([0-9a-f-]{36})/.exec(out.content);
  if (!m) throw new Error(`no project id in: ${out.content}`);
  return m[1];
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Closer', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES ('primary', 'Main', 'm1', 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))`).run();
});

describe('a project close that closed nothing says so', () => {
  it('THE RED: every close refused (nothing delivered): the result does not say OK or closed, and names what is still open and why', async () => {
    const project = await openProject();
    const before = tasksOf(project);
    expect(before.length).toBe(2);
    const out = await call('work_update:close_project', { project_id: project, status: 'complete', reason: 'all five steps are satisfied' });

    // Nothing moved: the project and its tasks are where they were.
    expect(stateOf(project)).toBe('open');
    for (const t of before) expect(stateOf(t.id)).toBe(t.state);

    // The result tells the truth.
    expect(out.content).not.toMatch(/^\[OK\]/);
    expect(out.content).not.toMatch(/Project "[^"]*" closed\./);
    expect(out.content).toMatch(/did not close/);
    expect(out.isError).toBe(true);
    for (const t of before) {
      expect(out.content).toContain(`"${t.title}" (${t.id.slice(0, 8)}`);
    }
    // The product's own refusal words, per row: a task closes on a delivery.
    expect(out.content).toContain('a task closes on a delivery');
    // And the main agent is not told the project was bulk-closed.
    expect(bulkClosedNotes()).toBe(0);
  });

  it('tasks whose close is FILED (each holds a delivery) are listed as waiting on the PM, never as closed', async () => {
    const project = await openProject();
    const tasks = tasksOf(project);
    for (const t of tasks) {
      const d = `d-${t.id.slice(0, 8)}`;
      db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
        VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'conv-owner', 'delivered', datetime('now'))`).run(d, AGENT);
      db().prepare('UPDATE work SET result_delivery_id = ? WHERE id = ?').run(d, t.id);
    }
    const out = await call('work_update:close_project', { project_id: project, status: 'complete', reason: 'all five steps are satisfied' });
    expect(out.content).not.toMatch(/^\[OK\]/);
    expect(out.content).toMatch(/did not close/);
    expect(out.content).toContain(`Close requested, waiting on the PM's verdict, still open (${tasks.length}):`);
    for (const t of tasks) {
      expect(out.content).toContain(`"${t.title}" (${t.id.slice(0, 8)}`);
      expect(stateOf(t.id)).not.toBe('done');
    }
    expect(stateOf(project)).toBe('open');
    expect(bulkClosedNotes()).toBe(0);
  });

  it('CONTROL: a project that really closes (cancelled) is answered exactly as before', async () => {
    const project = await openProject();
    const out = await call('work_update:close_project', { project_id: project, status: 'cancelled', reason: 'scope changed this week' });
    expect(stateOf(project)).toBe('abandoned');
    for (const t of tasksOf(project)) expect(t.state).toBe('abandoned');
    expect(out.content).toBe([
      `[OK] project_id=${project} | status=cancelled`,
      ``,
      `Project "Fix the stuck schedule" closed.`,
      `Tasks closed by this call: 2`,
      `Tasks already in a terminal state (skipped): 0`,
      `Reason recorded on each closed task: scope changed this week`,
    ].join('\n'));
    expect(out.isError).toBe(false);
    expect(bulkClosedNotes()).toBe(1);   // the main agent is told, as before
  });
});
