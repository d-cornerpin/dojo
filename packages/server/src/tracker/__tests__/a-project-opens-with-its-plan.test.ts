// v3.5 PLAN BEFORE PROJECT, Task A1 — an agent cannot open a project without writing its plan into it.
//
// Driven through the work verbs' own door (`agent/tools/cat/tracker.ts`) against the real migration
// chain. Seams: the counter (no mailbox is read), the engine's PM spawn and the assignment notice
// (no agent runtime), and the agent's category grant.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-plan-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../pm-agent.js', () => ({ ensurePMAgentRunning: () => {}, noteTransitionForReview: () => {} }));
vi.mock('../notify.js', () => ({ injectTaskAssignmentNotification: () => {}, claimAssignmentNoticeForTerminalTask: () => false }));
const { countMeasure } = vi.hoisted(() => ({ countMeasure: vi.fn() }));
vi.mock('../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../work/measure.js')>()), countMeasure }));
// A2: the tools this agent holds. The facts themselves are read from the real definitions.
vi.mock('../../agent/tools/surface.js', () => ({ getFilteredTools: () => [{ name: 'gmail_search' }, { name: 'gmail_label' }, { name: 'get_current_time' }] }));
vi.mock('../../agent/access/read.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => true,
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { createProject } from '../schema.js';

const AGENT = 'agent-planner';
const MAILBOX_PLAN = {
  approach: 'Count what matches, then label in pages of 500 searched and up to 1,000 ids per label call.',
  steps: [
    { title: 'Count', how: 'gmail_search with the query, max_results 1, read the total', done: 'the count is noted' },
    {
      title: 'Label in pages',
      how: 'gmail_search 500 per page; gmail_label with message_ids per batch',
      done: 'the search returns 0',
      measure: { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' },
    },
  ],
};

type Out = { content: string; isError: boolean };
const open = async (args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers['work_open:project'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args: { kind: 'project', ...args } });
const getProject = async (id: string): Promise<Out> =>
  (trackerHandlers['work_update:get'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args: { action: 'get', project_id: id } });

const db = (): Database.Database => mockDb.current!;
const projectIdFrom = (o: Out): string => {
  const m = /project_id=([0-9a-f-]{36})/.exec(o.content);
  if (!m) throw new Error(`no project id in: ${o.content}`);
  return m[1];
};
const projects = (): number => (db().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'project'").get() as { n: number }).n;
const tasksOf = (pid: string) => db().prepare(
  'SELECT title, description, goal, step_number, total_steps, measure_json FROM work WHERE parent_id = ? ORDER BY step_number',
).all(pid) as Array<{ title: string; description: string; goal: string; step_number: number; total_steps: number; measure_json: string | null }>;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
  countMeasure.mockReset();
  countMeasure.mockResolvedValue({ ok: true, count: 1 });
});

describe('a project opens with its plan', () => {
  it('stores the plan on the project, makes one task per step, and carries each step into its task', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 4200 });
    const out = await open({ title: 'Clean the mailbox', plan: MAILBOX_PLAN });
    expect(out.content).toMatch(/^\[OK\] project_id=/);
    const pid = projectIdFrom(out);
    const row = db().prepare('SELECT plan_json, description FROM work WHERE id = ?').get(pid) as { plan_json: string; description: string };
    expect(JSON.parse(row.plan_json)).toMatchObject({ approach: MAILBOX_PLAN.approach, steps: [{ title: 'Count' }, { title: 'Label in pages' }] });
    expect(row.description).toContain(MAILBOX_PLAN.approach);
    expect(row.description).toContain('2. Label in pages: gmail_search 500 per page');
    const tasks = tasksOf(pid);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ title: 'Count', description: MAILBOX_PLAN.steps[0].how, goal: 'the count is noted', step_number: 1, total_steps: 2, measure_json: null });
    expect(tasks[1]).toMatchObject({ title: 'Label in pages', description: MAILBOX_PLAN.steps[1].how, goal: 'the search returns 0', step_number: 2 });
    expect(JSON.parse(tasks[1].measure_json!)).toMatchObject({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' } });
    expect(out.content).toContain('Label in pages: gmail_search 500 per page');
  });

  it('records on the project\'s opened event that it was planned', async () => {
    const pid = projectIdFrom(await open({ title: 'Report', plan: { approach: 'Write it.', steps: [{ title: 'Write', how: 'file_write', done: 'the file is handed over' }] } }));
    const ev = db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'opened'").get(pid) as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ kind: 'project', planned: true, steps: 1 });
  });

  it('work_update(get) on the project prints the plan', async () => {
    const pid = projectIdFrom(await open({ title: 'Clean the mailbox', plan: MAILBOX_PLAN }));
    const got = await getProject(pid);
    expect(got.content).toContain('Plan: Count what matches');
    expect(got.content).toContain('1. Count: gmail_search with the query');
    expect(got.content).toContain('(done when: the search returns 0)');
  });

  it('a project with no set of items (write a report) opens on a plan whose "done" names the deliverable', async () => {
    const out = await open({ title: 'Quarterly report', plan: { approach: 'Draft, then hand over.', steps: [{ title: 'Write the report', how: 'file_write the report', done: 'the file is handed over' }] } });
    expect(out.content).toMatch(/^\[OK\]/);
    expect(tasksOf(projectIdFrom(out))[0].measure_json).toBeNull();
  });

  it('the plan text passes through the same redaction door as every prose column', async () => {
    const { noteHandedCredentialValues } = await import('../../credentials/secret-values.js');
    const FAKE = 'key-a1-Qz8Lm3Vc7Xp2Rt5Nb';
    noteHandedCredentialValues(AGENT, [FAKE]);
    const pid = projectIdFrom(await open({ title: 'Use the key', plan: { approach: `Call the API with ${FAKE}.`, steps: [{ title: 'Call', how: `curl with ${FAKE}`, done: 'it answers' }] } }));
    const row = db().prepare('SELECT plan_json FROM work WHERE id = ?').get(pid) as { plan_json: string };
    expect(row.plan_json).not.toContain(FAKE);
  });
});

describe('a project does not open without its plan', () => {
  const EXAMPLE = /Example: plan=\{approach:/;

  it('no plan: refused with the three required parts and a one-step example; nothing is written', async () => {
    const out = await open({ title: 'Clean the users mailbox', tasks: [{ title: 'start' }] });
    expect(out.content).toMatch(/^Refused: a project opens with its plan/);
    expect(out.content).toContain('{approach, steps:[{title, how, done}]}');
    expect(out.content).toMatch(EXAMPLE);
    expect(out.isError).toBe(true);
    expect(projects()).toBe(0);
  });

  it('a floor model\'s plan as prose in "description" is refused the same way, so the next call succeeds', async () => {
    const out = await open({ title: 'Clean the mailbox', description: 'First count, then label in pages of 500, then verify.', tasks: [{ title: 'Count' }] });
    expect(out.content).toMatch(/^Refused: a project opens with its plan/);
    expect(out.content).toMatch(EXAMPLE);
    expect(projects()).toBe(0);
    const retry = await open({ title: 'Clean the mailbox', plan: MAILBOX_PLAN });
    expect(retry.content).toMatch(/^\[OK\]/);
  });

  it.each([
    ['no approach', { steps: MAILBOX_PLAN.steps }, 'plan.approach'],
    ['no steps', { approach: 'x', steps: [] }, 'plan.steps'],
    ['a step with no how', { approach: 'x', steps: [{ title: 't', done: 'd' }] }, 'plan.steps[0].how'],
    ['a step with no done', { approach: 'x', steps: [{ title: 't', how: 'h' }] }, 'plan.steps[0].done'],
    ['a step with no title', { approach: 'x', steps: [{ how: 'h', done: 'd' }] }, 'plan.steps[0].title'],
  ])('%s: refused, and the refusal names the missing part', async (_n, plan, part) => {
    const out = await open({ title: 'P', plan });
    expect(out.content).toMatch(/^Refused: a project opens with its plan/);
    expect(out.content).toContain(part);
    expect(projects()).toBe(0);
  });

  it('a plan with a measure the engine cannot count is refused naming the step, with nothing written', async () => {
    const out = await open({ title: 'P', plan: { approach: 'x', steps: [{ title: 't', how: 'h', done: 'd', measure: { tool: 'nope', args: { query: 'q' } } }] } });
    expect(out.content).toMatch(/^Refused: a project opens with its plan/);
    expect(out.content).toContain('plan.steps[0].measure');
    expect(projects()).toBe(0);
  });
});

describe('the agent sees what its tools do at scale exactly when it plans (A2)', () => {
  const SCALE = /What your tools do at scale:\ngmail_search: one call returns up to 500 results[^\n]*\ngmail_label: one call labels up to 1,000 messages \(message_ids\)/;

  it('the result of opening a project ends with the facts for the tools the agent holds, and none for tools that have none', async () => {
    const out = await open({ title: 'Clean the mailbox', plan: MAILBOX_PLAN });
    expect(out.content).toMatch(SCALE);
    expect(out.content).not.toContain('get_current_time:');
  });

  it('the refusal carries them too, so the next plan is written with them in view', async () => {
    const out = await open({ title: 'Clean the mailbox' });
    expect(out.content).toMatch(/^Refused: a project opens with its plan/);
    expect(out.content).toMatch(SCALE);
  });
});

describe('the other ways a project or a task comes to exist are unchanged', () => {
  it('the owner\'s dashboard project (createProject with tasks, no plan) opens as before and stores no plan', () => {
    const { projectId, taskIds } = createProject({
      title: 'Owner project', level: 1, createdBy: AGENT,
      origin: { kind: null, sourceMessageId: null, turn: null, convKey: null },
      tasks: [{ title: 'Do the thing', assignedTo: AGENT }],
    });
    expect(taskIds).toHaveLength(1);
    expect((db().prepare('SELECT plan_json FROM work WHERE id = ?').get(projectId) as { plan_json: string | null }).plan_json).toBeNull();
  });

  it('a standalone task (work_open kind=task) needs no plan', async () => {
    const out = await (trackerHandlers['work_open:task'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args: { kind: 'task', title: 'One thing', goal: 'it is done' } });
    expect(out.content).toMatch(/^\[OK\]/);
  });
});
