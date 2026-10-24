// v3.5 PLAN BEFORE PROJECT, Task B1 — the step of the plan an agent is on rides its task board every
// turn, from the records alone, so the plan survives a compaction. Through the REAL board builder on
// the real migration chain.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

import { runMigrations } from '../../db/migrations.js';
import { createProject, createTask, updateTask } from '../../tracker/schema.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { tasksFromPlan, type Plan } from '../../work/plan.js';
import { buildWorkBoardLane, activeTasksWorstCaseTokens } from '../work-board-lane.js';
import { POST_BUDGET_LANES } from '../lanes.js';
import { estimateTokens } from '../budget.js';

const AGENT = 'agent-plan-line';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const ORIGIN = { kind: 'model', sourceMessageId: null, turn: 1, convKey: null };
const PLAN: Plan = {
  approach: 'Count, label in pages, then verify.',
  steps: [
    { title: 'Count', how: 'gmail_search with max_results 1', done: 'the count is noted' },
    { title: 'Label in pages', how: 'gmail_search 500 per page; gmail_label with message_ids per batch', done: 'the search returns 0' },
    { title: 'Verify', how: 'gmail_search again', done: 'it still returns 0' },
  ],
};

function planned(plan: Plan): string[] {
  return createProject({ title: 'Clean the mailbox', level: 1, createdBy: AGENT, origin: ORIGIN, plan, tasks: tasksFromPlan(plan) }).taskIds;
}
const lineOf = (block: string, title: string): string => {
  const at = block.indexOf(`• ${title}`);
  const next = block.indexOf('\n• ', at + 1);
  return block.slice(at, next < 0 ? undefined : next);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Worker', 'idle', '{}')").run(AGENT);
});
afterEach(() => { vi.useRealTimers(); });

describe('the current step of the plan rides the task board', () => {
  it('a task of a planned project shows its step of the plan with its how and its done, after State and before Last note', async () => {
    const ids = planned(PLAN);
    updateTask(ids[1], { notes: 'page one is done' });
    const line = lineOf((await buildWorkBoardLane(AGENT)).activeTasks!, 'Label in pages');
    expect(line).toContain('\n  Plan step 2 of 3 — Label in pages: gmail_search 500 per page; gmail_label with message_ids per batch (done when: the search returns 0)');
    expect(line.indexOf('State:')).toBeLessThan(line.indexOf('Plan step'));
    expect(line.indexOf('Plan step')).toBeLessThan(line.indexOf('Last note:'));
  });

  it('after a rebuild from the rows alone (the compaction case) every task still has its own step', async () => {
    planned(PLAN);
    const first = (await buildWorkBoardLane(AGENT)).activeTasks!;
    const rebuilt = (await buildWorkBoardLane(AGENT)).activeTasks!;   // nothing is carried in memory: the lane reads the rows
    expect(rebuilt).toBe(first);
    expect(lineOf(rebuilt, 'Count')).toContain('Plan step 1 of 3 — Count: gmail_search with max_results 1 (done when: the count is noted)');
    expect(lineOf(rebuilt, 'Verify')).toContain('Plan step 3 of 3 — Verify: gmail_search again (done when: it still returns 0)');
  });

  it('a task with no project plan prints nothing extra: a standalone task, and an owner\'s project', async () => {
    const solo = createTask({ title: 'Write the summary', assignedTo: AGENT, createdBy: AGENT, origin: ORIGIN });
    setTrackerStatus(solo, 'in_progress', { by: 'agent', actorId: AGENT, reason: 'started' });
    createProject({ title: 'Owner project', level: 1, createdBy: AGENT, origin: ORIGIN, tasks: [{ title: 'Owner step', assignedTo: AGENT }] });
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain('Write the summary');
    expect(block).toContain('Owner step');
    expect(block).not.toContain('Plan step');
  });

  it('a waiting (blocked) task prints no plan line', async () => {
    const ids = planned(PLAN);
    setTrackerStatus(ids[0], 'blocked', { by: 'agent', actorId: AGENT, reason: 'the mailbox sign-in expired' });
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(lineOf(block, 'Count')).not.toContain('Plan step');
    expect(lineOf(block, 'Verify')).toContain('Plan step 3 of 3');
  });

  it('the declared reserve still covers the list: a flooded plan line on every row stays inside it', async () => {
    expect(POST_BUDGET_LANES.find((l) => l.id === 'lane.active-tasks')!.reserveTokens).toBe(activeTasksWorstCaseTokens());
    for (let i = 0; i < 5; i++) {
      planned({ approach: 'a', steps: [{ title: `Job ${i}`, how: 'h'.repeat(5000), done: 'd'.repeat(5000) }] });
    }
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain('Plan step 1 of 1');
    expect(estimateTokens(block)).toBeLessThanOrEqual(activeTasksWorstCaseTokens());
  });
});
