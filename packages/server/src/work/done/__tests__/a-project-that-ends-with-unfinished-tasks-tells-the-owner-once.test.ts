// A project that ends with tasks not done files ONE dashboard card for the owner naming them; a fully done
// project, a project the owner closed or cancelled himself, and a project closed again file none.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { decide } from '../decide.js';
import { freshBoard, handedIn, call, WORKER, PM, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const PROJECT = 'proj-ends';

function underAProject(siblingStates: string[] = []): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'project', ?, 'owner', 'tracker', ?, 'open', 'task', 1, 0, 'The launch', ?, ?)`,
  ).run(PROJECT, WORKER, PROJECT, at, at);
  doneDb().prepare('UPDATE work SET parent_id = ? WHERE id = ?').run(PROJECT, TASK);
  siblingStates.forEach((state, i) => doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, closed_at, updated_at)
     VALUES (?, 'task', ?, ?, 'owner', 'tracker', ?, ?, 'task', 1, 0, ?, ?, ?, ?)`,
  ).run(`sib-${i}`, PROJECT, WORKER, `sib-${i}`, state, `Sibling ${i}`, at, at, at));
}

const cards = (): string[] =>
  (doneDb().prepare("SELECT value FROM healer_state WHERE scope = 'owner_told' AND key LIKE 'projectend:%'").all() as Array<{ value: string }>).map((r) => r.value);

async function approveLastTask(): Promise<void> {
  await handedIn();
  await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
  const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report reached the owner' });
  expect(r.isError, r.content).toBe(false);
}

describe('a project that ends with unfinished tasks', () => {
  it('files one card naming the cancelled task', async () => {
    freshBoard();
    underAProject(['abandoned']);
    await approveLastTask();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toContain('"The launch"');
    expect(cards()[0]).toContain('"Sibling 0" (cancelled)');
  });

  it('a fully done project files none', async () => {
    freshBoard();
    underAProject();
    await approveLastTask();
    expect(cards()).toEqual([]);
  });

  for (const verdict of ['owner_done', 'cancel'] as const) {
    it(`the owner closing the whole project himself (${verdict}) files none`, () => {
      freshBoard();
      underAProject();
      expect(decide({ workId: PROJECT, deciderAgentId: null, verdict, reason: 'The launch is settled' }).kind).toBe('decided');
      expect(cards()).toEqual([]);
    });
  }

  it('closing it again files no second card', async () => {
    freshBoard();
    underAProject(['abandoned']);
    await approveLastTask();
    expect(decide({ workId: PROJECT, deciderAgentId: null, verdict: 'owner_done', reason: 'Again' }).kind).toBe('refused');
    expect(cards()).toHaveLength(1);
  });
});
