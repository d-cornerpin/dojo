// A project whose notes alone would fill the review file still shows its earlier decision and newest exchange.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { insertMessage } from '../../memory/message-store.js';
import { writeTaskLog } from '../task-log.js';
import { freshBoard, call, deliveredToOwner, PM, MAIN, WORKER } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { pmCanRun, resetLadderWorld, review } from '../../work/done/__tests__/helpers/ladder-world.js';

const PROJECT = 'proj-monthly-totals';
const plan = { approach: 'Build the monthly totals report from the exports, one sheet a step.', steps: Array.from({ length: 35 }, (_, i) => ({ title: `Sheet ${i + 1}`, how: 'Copy the export rows', done: `Sheet ${i + 1} totals match the export` })) };

function seedProject(source: string): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, plan_json, source_message_id, opened_at, updated_at)
    VALUES (?, 'project', ?, 'owner', ?, 'tracker', ?, 'claimed', 'task', 1, 0, 'Monthly totals', ?, ?, ?, ?)`).run(PROJECT, MAIN, MAIN, PROJECT, JSON.stringify(plan), source, at, at);
  for (const n of [1, 4, 35]) {
    doneDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, step_number, total_steps, opened_at, updated_at)
      VALUES (?, 'task', ?, ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The sheet is filled', ?, 35, ?, ?)`).run(`task-${n}`, PROJECT, WORKER, `task-${n}`, `Sheet ${n}`, n, at, at);
}

  }
async function handIn(id: string): Promise<void> {
  const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner(WORKER) }], note: 'Filled' });
  if (r.isError) throw new Error(r.content);
}

describe('a project with very long notes still shows its past decision', () => {
  it('the later review shows the earlier approval and the newest exchange, and says the oldest notes were left out', async () => {
    resetLadderWorld(); freshBoard(); pmCanRun(PM);
    seedProject(insertMessage({ agentId: MAIN, role: 'user', content: 'Build the monthly totals report.', conversationId: 'conv-owner', senderId: 'owner', authorized: true }).id);

    await handIn('task-1');
    await review(PM, async () => {
      await call(PM, 'work_validate', { action: 'open_proof', task_id: 'task-1', item: 0 });
      const r = await call(PM, 'work_validate', { action: 'decide', task_id: 'task-1', verdict: 'approve', reason: 'Sheet 1 totals follow the fiscal calendar export' });
      expect(r.isError, r.content).toBe(false);
    });
    await handIn('task-4');
    let thread = '';
    await review(PM, async () => {
      expect((await call(PM, 'send_to_agent', { agent: WORKER, intent: 'QUESTION', payload: 'Does sheet 4 use fiscal weeks?' })).isError).toBe(false);
      thread = (doneDb().prepare('SELECT thread_id FROM tool_receipts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(PM) as { thread_id: string }).thread_id;
    });
    expect((await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'Yes, sheet 4 is in fiscal weeks 14 to 17.', thread_id: thread })).isError).toBe(false);

    for (let i = 0; i < 600; i += 1) writeTaskLog({ taskId: PROJECT, fromEntity: MAIN, entryKind: 'observation', note: `Working note ${i}: sheet detail` });

    await handIn('task-35');
    const report = await review(PM);
    expect(report, 'the oldest notes were left out').toMatch(/\d+ older notes left out/);
    expect(report, "task 1's reason").toContain('Sheet 1 totals follow the fiscal calendar export');
    expect(report, 'the question about task 4').toContain('Does sheet 4 use fiscal weeks?');
    expect(report, 'its answer').toContain('sheet 4 is in fiscal weeks 14 to 17');
  });
});
