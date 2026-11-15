// A hand-in waits while the project manager asks about it (the owner's back-and-forth with several agents): each
// question is tied to the hand-in when it is sent; while one is open the hand-in is in no review and no review
// counts against it; once every question is answered the PM decides it. An asked agent that ends a turn without
// answering releases it one patience bound later, and then the ordinary rule applies.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { runPMReview } from '../../../tracker/pm-agent.js';
import { whoDecides } from '../who-decides.js';
import { insertMessage } from '../../../memory/message-store.js';
import { openTurnContext, endTurnContext } from '../../../agent/turn-context.js';
import type { TurnAddress } from '../../../agent/v2/turn-address.js';
import { patienceBoundMs } from '../../../tracker/assignee-patience.js';
import { freshBoard, handedIn, call, deliveredToOwner, stateOf, PM, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { pmCanRun, turn, entries, lastReport, resetLadderWorld } from './helpers/ladder-world.js';

let turnNo = 0;
/** One PM turn as the runtime runs it: its own bag, answering `thread` when it is an agent's message. */
async function pmTurn(act: () => Promise<void>, thread: string | null = null): Promise<void> {
  const ctx = openTurnContext(PM);
  ctx.turnNumber = ++turnNo;
  if (thread) ctx.address = { kind: 'agent', threadId: thread } as TurnAddress;
  try { await act(); } finally { endTurnContext(PM); }
}

const ask = async (agent: string, payload: string): Promise<string> => {
  const r = await call(PM, 'send_to_agent', { agent, intent: 'QUESTION', payload });
  expect(r.isError, r.content).toBe(false);
  return (doneDb().prepare("SELECT thread_id FROM tool_receipts WHERE agent_id = ? AND tool = 'send_to_agent' ORDER BY rowid DESC LIMIT 1").get(PM) as { thread_id: string }).thread_id;
};
const answer = (from: string, thread: string, payload: string) => call(from, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload, thread_id: thread });

async function unrelatedHandIn(i: number): Promise<string> {
  const id = `task-other-${i}`;
  const at = Date.now() - 60_000;
  doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
    VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The owner has it', ?, ?)`).run(id, OTHER, id, `Unrelated report ${i}`, at, at);
  const r = await call(OTHER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner(OTHER) }], note: 'Sent' });
  if (r.isError) throw new Error(r.content);
  return id;
}

const reports = (): number => (doneDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'pm_review'").get(PM) as { n: number }).n;

/** A review whose PM turn runs `act`; returns its report, or '' when nothing waited for one. */
async function review(act: () => Promise<void> = async () => {}): Promise<string> {
  const before = reports();
  turn.during = async (agentId) => { if (agentId === PM) await pmTurn(act); };
  await runPMReview();
  turn.during = () => {};
  return reports() > before ? lastReport(PM) : '';
}

beforeEach(() => { resetLadderWorld(); turnNo = 0; freshBoard(); pmCanRun(PM); });
afterEach(() => vi.restoreAllMocks());

describe('a hand-in waits while the PM asks', () => {
  it('a back-and-forth with three agents across forty unrelated reviews ends with the PM deciding', async () => {
    await handedIn();
    let w1 = '';
    await review(async () => { w1 = await ask(WORKER, 'Which sheet holds the totals, and were the March rows included?'); });
    expect(entries(TASK, 'review_miss'), 'the review that asked counts no miss').toBe(0);

    for (let i = 1; i <= 40; i += 1) {
      const other = await unrelatedHandIn(i);
      const report = await review(async () => { await call(PM, 'work_validate', { action: 'decide', task_id: other, verdict: 'send_back', reason: 'The totals are missing' }); });
      expect(report, `review ${i} held the hand-in that waits on its answer`).not.toContain(TASK);
      insertMessage({ agentId: PM, role: 'user', lane: 'a2a', sourceAgentId: OTHER, a2aThreadId: `chat-${i}`, content: `Unrelated note ${i}: the filing run is on schedule.` });
      insertMessage({ agentId: PM, role: 'assistant', lane: 'a2a', subjectKind: 'a2a_thread', a2aThreadId: `chat-${i}`, content: `Noted ${i}.` });
    }
    expect(entries(TASK, 'review_miss')).toBe(0);
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: PM });

    let w2 = '', m = '';
    turn.during = async (agentId) => {
      if (agentId !== PM) return;
      await pmTurn(async () => { w2 = await ask(OTHER, 'Did the March export finish on your side?'); m = await ask(MAIN, 'Did the owner ask for March to be left out?'); }, w1);
      turn.during = () => {};
    };
    expect((await answer(WORKER, w1, 'Sheet 3. The March rows are missing; the export failed.')).isError).toBe(false);
    await vi.waitFor(() => { if (!m) throw new Error('the answer turn has not asked yet'); });
    const tied = doneDb().prepare("SELECT COUNT(*) AS n FROM tool_receipts WHERE agent_id = ? AND task_id = ? AND thread_id IN (?, ?)").get(PM, TASK, w2, m) as { n: number };
    expect(tied.n, 'both new questions are tied to the hand-in the turn answered about').toBe(2);

    expect((await answer(OTHER, w2, 'The March export failed twice; I stopped it.')).isError).toBe(false);
    expect(await review(), 'a question to the main agent is still open').not.toContain(TASK);
    expect((await answer(MAIN, m, 'The owner wants March included.')).isError).toBe(false);

    const report = await review(async () => {
      expect((await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 })).isError).toBe(false);
      const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'March is missing; the owner wants it included' });
      expect(r.isError, r.content).toBe(false);
    });
    expect(report, 'every answer is in: the hand-in is the PM\'s again').toContain(TASK);
    expect(stateOf()).toBe('sent_back');
  });

  it('an asked agent that ends a turn without answering releases the hand-in one bound later', async () => {
    await handedIn();
    await review(async () => { await ask(WORKER, 'Which sheet holds the totals?'); });
    expect(await review(), 'held while the question is open').not.toContain(TASK);
    doneDb().prepare("INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered) VALUES (?, 1, 'a2a', datetime('now'), datetime('now'), 'answered', 1)").run(WORKER);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + patienceBoundMs(WORKER) + 2_000);
    expect(await review(), 'one bound after the asked agent\'s turn the hand-in is back').toContain(TASK);
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: PM });
    await review();
    expect(whoDecides(TASK), 'two verdictless reviews: the main agent decides').toEqual({ kind: 'agent', agentId: MAIN });
  });
});
