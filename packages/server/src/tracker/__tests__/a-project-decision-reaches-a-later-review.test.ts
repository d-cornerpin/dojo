// A project decision reaches a later review (a six-week project): what the main agent notes on the project, the
// owner's words the engine records there, an earlier task's approval and a question asked about another task all
// show in the review of a task handed in weeks later, after thousands of unrelated rows. A helper cannot note on
// a project.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { insertMessage } from '../../memory/message-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { freshBoard, call, deliveredToOwner, PM, MAIN, WORKER, OTHER } from '../../work/done/__tests__/helpers/decision-world.js';
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

async function handIn(id: string, worker = WORKER): Promise<void> {
  const r = await call(worker, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner(worker) }], note: 'Filled' });
  if (r.isError) throw new Error(r.content);
}

describe('a project decision reaches a later review', () => {
  it('the week-5 review shows the plan, the note, the owner words, an earlier reason and an earlier exchange', async () => {
    resetLadderWorld(); freshBoard(); pmCanRun(PM);
    const first = insertMessage({ agentId: MAIN, role: 'user', content: 'Build the monthly totals report.', conversationId: 'conv-owner', senderId: 'owner', authorized: true });
    seedProject(first.id);
    const later = insertMessage({ agentId: MAIN, role: 'user', content: 'Use the fiscal calendar, never the calendar month.', conversationId: 'conv-owner', senderId: 'owner', authorized: true });
    const ctx = openTurnContext(MAIN);
    ctx.root = { kind: 'ask', id: later.id, sourceMessageId: later.id };
    const noted = await call(MAIN, 'work_note', { task_id: PROJECT, notes: 'Decision: every total follows the fiscal calendar.' });
    endTurnContext(MAIN);
    expect(noted.isError, noted.content).toBe(false);

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
      thread = (doneDb().prepare("SELECT thread_id FROM tool_receipts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1").get(PM) as { thread_id: string }).thread_id;
    });
    expect((await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'Yes, sheet 4 is in fiscal weeks 14 to 17.', thread_id: thread })).isError).toBe(false);

    for (let i = 0; i < 3000; i += 1) insertMessage({ agentId: PM, role: 'user', lane: 'a2a', sourceAgentId: OTHER, a2aThreadId: `noise-${i % 50}`, content: `Unrelated note ${i}.` });
    for (let i = 0; i < 20; i += 1) {
      const id = `noise-task-${i}`;
      doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
        VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, ?, ?)`).run(id, OTHER, id, `Unrelated ${i}`, Date.now(), Date.now());
      await handIn(id, OTHER);
      await review(PM, async () => { await call(PM, 'work_validate', { action: 'decide', task_id: id, verdict: 'send_back', reason: 'Missing totals' }); });
    }

    await handIn('task-35');
    const report = await review(PM);
    expect(report).toContain('Sheet 35');
    expect(report, 'the approach').toContain(plan.approach);
    expect(report, 'its step line').toContain('Sheet 35 totals match the export');
    expect(report, 'the note on the project').toContain('Decision: every total follows the fiscal calendar.');
    expect(report, "the owner's words").toContain('Use the fiscal calendar, never the calendar month.');
    expect(report, "task 1's reason").toContain('Sheet 1 totals follow the fiscal calendar export');
    expect(report, 'the question about task 4').toContain('Does sheet 4 use fiscal weeks?');
    expect(report, 'its answer').toContain('sheet 4 is in fiscal weeks 14 to 17');
  });

  it("a helper's note on a project is refused; the PM's is written", async () => {
    resetLadderWorld(); freshBoard();
    seedProject(insertMessage({ agentId: MAIN, role: 'user', content: 'Build it.', conversationId: 'conv-owner', senderId: 'owner', authorized: true }).id);
    expect((await call(WORKER, 'work_note', { task_id: PROJECT, notes: 'Skip sheet 2.' })).content).toContain("a project's notes are written by the project manager or the main agent");
    expect((await call(PM, 'work_note', { task_id: PROJECT, notes: 'Sheet 2 waits on the export.' })).isError).toBe(false);
  });
});
