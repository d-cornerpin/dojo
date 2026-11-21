// v3.5 DONE IS MEASURED, Task A5 — the agent's own task board shows measured progress: what its
// calls touched (the engine's ledger) and what the measure still returns, under the task's State
// line, from the records alone. Through the REAL board builder on the real migration chain.
import { setHold } from '../../work/done/hold.js';
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
import { createTask } from '../../tracker/schema.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { updateTask } from '../../tracker/schema.js';
import { setMeasure, recordMeasured, recordTouched } from '../../work/ledger-store.js';
import { buildWorkBoardLane, activeTasksWorstCaseTokens } from '../work-board-lane.js';
import { POST_BUDGET_LANES } from '../lanes.js';
import { recordedInstant } from '../message-stamp.js';
import { estimateTokens } from '../budget.js';
import type { Measure } from '../../work/measure.js';

const AGENT = 'agent-measure-line';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const MEASURE: Measure = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };

function task(title: string): string {
  const id = createTask({
    title, assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'model', sourceMessageId: null, turn: 1, convKey: null },
  });
  setTrackerStatus(id, 'in_progress', { by: 'agent', actorId: AGENT, reason: 'started' });
  return id;
}
function touch(id: string, n: number): void {
  recordTouched(id, 'gmail_label', Array.from({ length: n }, (_, i) => `gmail:msg:m${i}`), NOW - 60_000);
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

describe('the task board shows measured progress', () => {
  it('a measured task: what was touched, what the measure still returns, of what, and when it was read — after State, before Last note', async () => {
    const id = task('Sort the inbox');
    setMeasure(id, MEASURE, { ok: true, count: 10551 }, NOW - 600_000, { setBy: AGENT });
    touch(id, 139);
    recordMeasured(id, { ok: true, count: 10412 }, NOW - 120_000);
    updateTask(id, { notes: 'halfway through the newsletters' });
    const block = lineOf((await buildWorkBoardLane(AGENT)).activeTasks!, 'Sort the inbox');
    const expected = `Progress: 139 messages touched; measure gmail_search "in:inbox -label:Done" returned 10,412 remaining (of 10,551 at start), measured ${recordedInstant(NOW - 120_000)}`;
    expect(block).toContain(`\n  ${expected}`);
    expect(block.indexOf('State:')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('State:')).toBeLessThan(block.indexOf('Progress:'));
    expect(block.indexOf('Progress:')).toBeLessThan(block.indexOf('Last note:'));
  });

  it('a measure that could not be read says so, with when', async () => {
    const id = task('Sort the inbox');
    setMeasure(id, MEASURE, { ok: true, count: 80 }, NOW - 600_000, { setBy: AGENT });
    recordMeasured(id, { ok: false, error: '503' }, NOW - 60_000);
    const block = lineOf((await buildWorkBoardLane(AGENT)).activeTasks!, 'Sort the inbox');
    expect(block).toContain(`Progress: 0 messages touched; measure gmail_search "in:inbox -label:Done" could not be read at ${recordedInstant(NOW - 60_000)} (80 at start)`);
  });

  it('touched items and no measure: the count, and that no measure is set', async () => {
    const id = task('Tidy the labels');
    touch(id, 139);
    const block = lineOf((await buildWorkBoardLane(AGENT)).activeTasks!, 'Tidy the labels');
    expect(block).toContain('Progress: 139 items touched (no measure set — set one with work_update(action="edit", measure=…) if this task covers a set of mailbox messages)');
  });

  it('neither a measure nor a touched item: no Progress line at all', async () => {
    task('Write the summary');
    expect((await buildWorkBoardLane(AGENT)).activeTasks!).not.toContain('Progress:');
  });

  it('a waiting (paused or blocked) task prints no Progress line', async () => {
    const id = task('Sort the inbox');
    setMeasure(id, MEASURE, { ok: true, count: 10 }, NOW - 600_000, { setBy: AGENT });
    touch(id, 3);
    setHold(id, 'blocked', 'the mailbox sign-in expired', AGENT);
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain('Sort the inbox');
    expect(block).not.toContain('Progress:');
  });

  it('the declared reserve still covers the list: a flooded measure line on every row stays inside it', async () => {
    expect(POST_BUDGET_LANES.find((l) => l.id === 'lane.active-tasks')!.reserveTokens).toBe(activeTasksWorstCaseTokens());
    const long: Measure = { tool: 'gmail_search', args: { query: 'q'.repeat(5000) }, unit: 'u'.repeat(5000) };
    for (let i = 0; i < 5; i++) {
      const id = task(`Job ${i}`);
      setMeasure(id, long, { ok: true, count: 9_999_999 }, NOW - 600_000, { setBy: AGENT });
      touch(id, 5);
    }
    const block = (await buildWorkBoardLane(AGENT)).activeTasks!;
    expect(block).toContain('Progress:');
    expect(estimateTokens(block)).toBeLessThanOrEqual(activeTasksWorstCaseTokens());
  });
});
