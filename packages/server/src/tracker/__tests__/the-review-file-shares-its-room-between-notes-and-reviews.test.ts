// The review file gives its notes and its reviews and questions each half the room, and what one does not use goes to
// the other: long notes never push out a past decision, and few or no notes leave the room to the decisions.
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

const MANY = 120;
const ASKS = 60;

const PROJECT = 'proj-monthly-totals';
const plan = { approach: 'Build the monthly totals report from the exports, one sheet a step.', steps: [] };
const OLD_REASON = 'Sheet 1 totals follow the fiscal calendar export';

function seedTask(id: string, parent: string | null): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
    VALUES (?, 'task', ?, ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The sheet is filled', ?, ?)`).run(id, parent, WORKER, id, `Sheet ${id}`, at, at);
}

function seedProject(source: string, tasks: string[]): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, plan_json, source_message_id, opened_at, updated_at)
    VALUES (?, 'project', ?, 'owner', ?, 'tracker', ?, 'claimed', 'task', 1, 0, 'Monthly totals', ?, ?, ?, ?)`).run(PROJECT, MAIN, MAIN, PROJECT, JSON.stringify(plan), source, at, at);
  for (const id of tasks) seedTask(id, PROJECT);
}

async function handIn(id: string): Promise<void> {
  const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner(WORKER) }], note: 'Filled' });
  if (r.isError) throw new Error(r.content);
}

async function decide(id: string, verdict: 'approve' | 'send_back', reason: string): Promise<void> {
  await handIn(id);
  await review(PM, async () => {
    await call(PM, 'work_validate', { action: 'open_proof', task_id: id, item: 0 });
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: id, verdict, reason });
    expect(r.isError, r.content).toBe(false);
  });
}

/** A project whose first task was approved long ago, then `later` tasks sent back, and a last task handed in. */
async function projectWithHistory(later: number, notes: number, noteText: string): Promise<string> {
  resetLadderWorld(); freshBoard(); pmCanRun(PM);
  const ids = Array.from({ length: later }, (_, i) => `later-${String(i).padStart(3, '0')}`);
  seedProject(insertMessage({ agentId: MAIN, role: 'user', content: 'Build the monthly totals report.', conversationId: 'conv-owner', senderId: 'owner', authorized: true }).id, ['task-1', ...ids, 'task-last']);
  await decide('task-1', 'approve', OLD_REASON);
  for (const id of ids) await decide(id, 'send_back', `Missing totals for ${id}`);
  for (let i = 0; i < notes; i += 1) writeTaskLog({ taskId: PROJECT, fromEntity: MAIN, entryKind: 'observation', note: `Working note ${i}: ${noteText}` });
  await handIn('task-last');
  return review(PM);
}

/** A task with no project, handed in, whose newest review asks the worker `asks` questions. */
async function loneTaskAsking(asks: number, answers: number): Promise<string> {
  resetLadderWorld(); freshBoard(); pmCanRun(PM);
  seedTask('solo', null);
  await handIn('solo');
  const threads: string[] = [];
  await review(PM, async () => {
    await call(PM, 'work_validate', { action: 'open_proof', task_id: 'solo', item: 0 });
    for (let i = 0; i < asks; i += 1) {
      expect((await call(PM, 'send_to_agent', { agent: WORKER, intent: 'QUESTION', payload: `Question ${i}: does the solo sheet use fiscal weeks` })).isError).toBe(false);
      threads.push((doneDb().prepare('SELECT thread_id FROM tool_receipts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(PM) as { thread_id: string }).thread_id);
    }
    expect((await call(PM, 'work_validate', { action: 'decide', task_id: 'solo', verdict: 'send_back', reason: 'Say which weeks' })).isError).toBe(false);
  });
  for (const thread of threads.slice(0, -1)) await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'Fiscal weeks.', thread_id: thread });
  for (let i = 0; i < answers; i += 1) {
    await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: `Answer ${i}: ${'fiscal weeks 14 to 17, '.repeat(40)}`, thread_id: threads[threads.length - 1] });
  }
  if (answers === 0) await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'Fiscal weeks.', thread_id: threads[threads.length - 1] });
  await handIn('solo');
  return review(PM);
}

describe('the review file shares its room between notes and reviews', () => {
  it('very long notes: the earlier decision is still shown, and the oldest notes are left out', async () => {
    const report = await projectWithHistory(3, 600, 'sheet detail');
    expect(report).toMatch(/\d+ older notes left out/);
    expect(report).toContain(OLD_REASON);
    expect(report).toContain('Missing totals for later-002');
  });

  it('short notes and many reviews: the reviews use more than half the room and the old decision is shown', async () => {
    const report = await projectWithHistory(MANY, 3, 'sheet detail');
    expect(report).toContain(OLD_REASON);
    expect(report).toContain(`Missing totals for later-${String(MANY - 1).padStart(3, '0')}`);
  });

  it('no notes and many questions: the questions use the whole room and the oldest is shown', async () => {
    const report = await loneTaskAsking(ASKS, 0);
    expect(report).toContain('Question 0:');
    expect(report).toContain(`Question ${ASKS - 1}:`);
  });

  it('a newest exchange longer than its room leaves the notes their half', async () => {
    await projectWithHistory(1, 600, 'sheet detail');
    let thread = '';
    await review(PM, async () => {
      expect((await call(PM, 'send_to_agent', { agent: WORKER, intent: 'QUESTION', payload: 'Question 0: does the last sheet use fiscal weeks' })).isError).toBe(false);
      thread = (doneDb().prepare('SELECT thread_id FROM tool_receipts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(PM) as { thread_id: string }).thread_id;
      expect((await call(PM, 'work_validate', { action: 'decide', task_id: 'task-last', verdict: 'send_back', reason: 'Say which weeks' })).isError).toBe(false);
    });
    await new Promise((r) => setTimeout(r, 1000));   // the answers come a second after the decision, as they do on a box
    for (let i = 0; i < 40; i += 1) {
      insertMessage({ agentId: PM, role: 'user', lane: 'a2a', sourceAgentId: WORKER, a2aThreadId: thread, content: `Answer ${i}: ${'fiscal weeks 14 to 17, '.repeat(40)}` });
    }
    await handIn('task-last');
    const report = await review(PM);
    expect(report).toContain('Answer 39:');
    expect(report.match(/Working note \d+/g)?.length ?? 0).toBeGreaterThan(100);
  });

  it('a newest exchange longer than its room is shown, its answers cut', async () => {
    const report = await loneTaskAsking(1, 30);
    expect(report).toContain('Question 0:');
    expect(report).toContain('Answer 0:');
  });
});
