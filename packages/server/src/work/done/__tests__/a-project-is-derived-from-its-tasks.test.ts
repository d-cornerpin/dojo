// A project is its tasks (owner rule D-K): a task closed as can't be done keeps its project working; all
// tasks done (or done and cancelled) makes it done when the last decision lands; all cancelled cancels it;
// a project with no tasks keeps the state it has. Driven through real decisions.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { decide } from '../decide.js';
import { deriveProjectState } from '../project-state.js';
import { freshBoard, handedIn, call, stateOf, PM, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const PROJECT = 'proj-derived';

function underAProject(extraTaskStates: string[] = []): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'project', ?, 'owner', 'tracker', ?, 'open', 'task', 1, 0, 'The launch', ?, ?)`,
  ).run(PROJECT, WORKER, PROJECT, at, at);
  doneDb().prepare('UPDATE work SET parent_id = ? WHERE id = ?').run(PROJECT, TASK);
  extraTaskStates.forEach((state, i) => doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, closed_at, updated_at)
     VALUES (?, 'task', ?, ?, 'owner', 'tracker', ?, ?, 'task', 1, 0, 'a sibling', ?, ?, ?)`,
  ).run(`sib-${i}`, PROJECT, WORKER, `sib-${i}`, state, at, at, at));
}

async function approve(): Promise<void> {
  await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
  const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report reached the owner' });
  expect(r.isError, r.content).toBe(false);
}

describe('a project is derived from its tasks', () => {
  it('its last task approved, the project is done', async () => {
    freshBoard();
    underAProject();
    await handedIn();
    expect(stateOf(PROJECT)).toBe('open');
    await approve();
    expect(stateOf(PROJECT)).toBe('done');
  });

  it('a sibling closed as can\'t be done keeps the project working after the last approval', async () => {
    freshBoard();
    underAProject(['failed']);
    await handedIn();
    await approve();
    expect(deriveProjectState(PROJECT)).toBe('working');
    expect(stateOf(PROJECT)).toBe('open');
  });

  it('a cancelled sibling still counts as complete; every task cancelled cancels the project', async () => {
    freshBoard();
    underAProject(['abandoned']);
    await handedIn();
    await approve();
    expect(stateOf(PROJECT)).toBe('done');
    freshBoard();
    underAProject(['abandoned']);
    expect(decide({ workId: TASK, deciderAgentId: null, verdict: 'cancel', reason: 'The owner called it off' }).kind).toBe('decided');
    expect(stateOf(PROJECT)).toBe('abandoned');
  });

  it('a project with no tasks keeps its stored state', () => {
    freshBoard();
    underAProject();
    doneDb().prepare('UPDATE work SET parent_id = NULL WHERE id = ?').run(TASK);
    expect(deriveProjectState(PROJECT)).toBeNull();
    expect(stateOf(PROJECT)).toBe('open');
  });
});
