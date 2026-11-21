// No agent decides its own work. The owner: "The entire point was to have the PM verify so that agents
// weren't just closing jobs on their own to get out of doing the work." The PM decides; the main agent
// decides another agent's task once the PM has not; a task the PM works is decided by the main agent.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, handedIn, call, stateOf, PM, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { whoDecides } from '../who-decides.js';
import { doneDb } from './helpers/done-db.js';

const openAll = async (agent: string): Promise<void> => {
  const r = await call(agent, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
  expect(r.isError).toBe(false);
};
const approve = (agent: string) => call(agent, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report the owner asked for reached him' });

describe('no agent decides its own work', () => {
  it('the worker approving its own hand-in is refused, and the task stays handed in', async () => {
    freshBoard();
    await handedIn();
    await openAll(WORKER);
    const r = await approve(WORKER);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/your own work/);
    expect(stateOf()).toBe('handed_in');
  });

  it('the main agent approving a task it works is refused', async () => {
    freshBoard(MAIN);
    await handedIn(MAIN);
    await openAll(MAIN);
    const r = await approve(MAIN);
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('handed_in');
  });

  it('the PM approving its own task is refused, and the main agent may approve it', async () => {
    freshBoard(PM);
    await handedIn(PM);
    await openAll(PM);
    expect((await approve(PM)).isError).toBe(true);
    await openAll(MAIN);
    const r = await approve(MAIN);
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('done');
  });

  it('the main agent cannot decide another agent\'s task while the PM still decides it', async () => {
    freshBoard();
    await handedIn();
    await openAll(MAIN);
    const r = await approve(MAIN);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`decided by ${PM}`);
  });

  it('a handed-in task is not moved to another agent', async () => {
    freshBoard(MAIN);
    await handedIn(MAIN);
    const r = await call(MAIN, 'work_update', { action: 'reassign', task_id: TASK, assigned_to: OTHER, cause: 'coordination' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/handed in and waits for a decision/);
  });

  it('an agent that only handed its own task on did not work it: past the PM it decides', async () => {
    freshBoard(MAIN);
    expect((await call(MAIN, 'work_update', { action: 'reassign', task_id: TASK, assigned_to: WORKER, cause: 'coordination' })).isError).toBe(false);
    await handedIn(WORKER);
    for (const n of [1, 2]) {
      doneDb().prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'audit', ?, 'engine', ?)")
        .run(TASK, JSON.stringify({ entry_kind: 'review_miss', n }), Date.now());
    }
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: MAIN });
    await openAll(MAIN);
    const r = await approve(MAIN);
    expect(r.isError, r.content).toBe(false);
    expect(stateOf()).toBe('done');
  });

  it('the PM approves another agent\'s task: Done, with the adjudication on record', async () => {
    freshBoard();
    await handedIn();
    await openAll(PM);
    const r = await approve(PM);
    expect(r.content).toMatch(/is Done/);
    expect(stateOf()).toBe('done');
    const adj = doneDb().prepare("SELECT verdict, by_agent FROM adjudications WHERE work_id = ?").get(TASK) as { verdict: string; by_agent: string };
    expect(adj).toEqual({ verdict: 'upheld', by_agent: PM });
  });
});
