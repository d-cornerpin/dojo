// A project's file is shown once per review and inside one room: ten hand-ins of one project carry one file, and a
// long project's file stays inside its room by leaving out its oldest reviews and questions, never its notes or its
// newest exchange.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { estimateTokens, contextWindowPolicy } from '../../memory/budget.js';
import { agentTurnWindow } from '../../router/router-window.js';
import { reviewLedgerRoomTokens } from '../job-loop-facts.js';
import { freshBoard, call, deliveredToOwner, PM, MAIN, WORKER } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { pmCanRun, resetLadderWorld, review } from '../../work/done/__tests__/helpers/ladder-world.js';

const PROJECT = 'proj-totals';
const APPROACH = 'Build the totals report one sheet a step.';
const taskId = (n: number): string => `sheet-task-${String(n).padStart(2, '0')}`;

function seedProject(tasks: number): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, plan_json, opened_at, updated_at)
    VALUES (?, 'project', ?, 'owner', ?, 'tracker', ?, 'claimed', 'task', 1, 0, 'Totals', ?, ?, ?)`).run(PROJECT, MAIN, MAIN, PROJECT, JSON.stringify({ approach: APPROACH, steps: [{ title: 'Sheet', how: 'Copy', done: 'Copied' }] }), at, at);
  for (let n = 1; n <= tasks; n += 1) {
    doneDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
      VALUES (?, 'task', ?, ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The sheet is filled', ?, ?)`).run(taskId(n), PROJECT, WORKER, taskId(n), `Sheet ${n}`, at, at);
  }
}

async function handIn(id: string): Promise<void> {
  const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Filled' });
  if (r.isError) throw new Error(r.content);
}

/** The newest row of each table the file reads, so a cycle's rows can be dated as if it ran `days` days ago. */
const marks = (): number[] => ['tool_receipts', 'messages', 'work_events'].map((t) => (doneDb().prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${t}`).get() as { n: number }).n);
function ageSince([receipts, messages, events]: number[], days: number): void {
  doneDb().prepare('UPDATE tool_receipts SET created_at = datetime(created_at, ?) WHERE rowid > ?').run(`-${days} days`, receipts);
  doneDb().prepare('UPDATE messages SET created_at = created_at - ? WHERE rowid > ?').run(days * 86_400_000, messages);
  doneDb().prepare('UPDATE work_events SET created_at = created_at - ? WHERE rowid > ?').run(days * 86_400_000, events);
}

const fileOf = (report: string): string => report.slice(report.indexOf(`Project "Totals"`), report.indexOf('[Engine hint'));

beforeEach(() => { resetLadderWorld(); freshBoard(); pmCanRun(PM); });

describe('a project file is shown once inside its room', () => {
  it('ten hand-ins of one project carry one file', async () => {
    seedProject(10);
    for (let n = 1; n <= 10; n += 1) await handIn(taskId(n));
    const report = await review(PM);
    expect(report.split(APPROACH).length - 1).toBe(1);
  });

  it("a long project's file keeps its notes and newest exchange, leaves out the oldest, and stays inside its room", async () => {
    seedProject(13);
    expect((await call(MAIN, 'work_note', { task_id: PROJECT, notes: 'Decision: every total follows the fiscal calendar.' })).isError).toBe(false);
    for (let n = 1; n <= 12; n += 1) {
      const from = marks();
      await handIn(taskId(n));
      let thread = '';
      await review(PM, async () => {
        await call(PM, 'send_to_agent', { agent: WORKER, intent: 'QUESTION', payload: `Question ${n}: which rows of sheet ${n} came from the March export?` });
        thread = (doneDb().prepare('SELECT thread_id FROM tool_receipts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(PM) as { thread_id: string }).thread_id;
      });
      await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: `Answer ${n}: ${'rows twelve to forty came from the March export, the rest from April. '.repeat(12)}`, thread_id: thread });
      await review(PM, async () => { await call(PM, 'work_validate', { action: 'decide', task_id: taskId(n), verdict: 'send_back', reason: `Sheet ${n}: ${'the April rows are missing their totals. '.repeat(6)}` }); });
      ageSince(from, 13 - n);
    }
    await handIn(taskId(13));
    const report = await review(PM);
    const file = fileOf(report);
    const room = reviewLedgerRoomTokens(contextWindowPolicy(agentTurnWindow(PM, 'm'), { toolPayloadTokens: 0 }).assemblyBudgetTokens, 2);
    expect(estimateTokens(file), 'the file is inside its room').toBeLessThanOrEqual(room);
    expect(file, 'the past decision').toContain('Decision: every total follows the fiscal calendar.');
    expect(file, 'the newest exchange').toContain('Question 12:');
    expect(file, 'the newest answer').toContain('Answer 12:');
    expect(file, 'the oldest exchange is left out first').not.toContain('Question 1:');
    expect(file).toContain('older lines left out');
  });
});
