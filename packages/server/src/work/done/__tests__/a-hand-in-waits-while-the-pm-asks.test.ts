// A hand-in waits while the project manager asks about it (the owner's back-and-forth with several agents): each
// question is tied to the hand-in when it is sent; while one is open the hand-in is in no review and no review
// counts against it; the turn an answer starts shows the hand-in's file with the question, and once every question
// is answered the review shows the whole exchange and the PM decides it. A question no one answers releases it 30
// minutes after it was asked, and then the ordinary rule applies. A card opened for a request its requester still
// owes waits, for the review and the ladder alike, until that answer is delivered or the request is stood down.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { whoDecides, QUEUED_TURN_BOUND_MS } from '../who-decides.js';
import { runLadder } from '../ladder.js';
import { recordDelivery } from '../../../agent/v2/deliveries.js';
import { openTurnContext, endTurnContext } from '../../../agent/turn-context.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../store.js';
import { assembleContext } from '../../../memory/assembler.js';
import { insertMessage } from '../../../memory/message-store.js';
import { freshBoard, handedIn, call, deliveredToOwner, stateOf, PM, MAIN, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { pmCanRun, turn, entries, resetLadderWorld, pmTurn, answerCounterparty, review as reviewBy, MIN } from './helpers/ladder-world.js';

const review = (act?: () => Promise<void>): Promise<string> => reviewBy(PM, act);

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

const ASK = askIdForMessage('m-ask');
const askIs = (state: string, compilePending = 0): void => { doneDb().prepare('UPDATE work SET state = ?, compile_pending = ? WHERE id = ?').run(state, compilePending, ASK); };

/** The owner's request to the main agent, claimed, and the hand-in of the card it opened for it. */
async function cardForOwedRequest(): Promise<void> {
  doneDb().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-dash', ?, 'dashboard', 'owner')").run(MAIN);
  insertMessage({
    id: 'm-ask', agentId: MAIN, role: 'user', content: 'Make me a beach packing list', lane: 'owner', channel: 'dashboard',
    senderId: 'owner', authorized: true, conversationId: 'conv-dash', inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as Parameters<typeof insertMessage>[0]);
  claimAsk(ASK, MAIN);
  stampClaimingTurn(ASK, 7);
  await handedIn();
  doneDb().prepare("UPDATE work SET requester = 'agent', requester_id = ?, source_message_id = 'm-ask' WHERE id = ?").run(MAIN, TASK);
}

beforeEach(() => { resetLadderWorld(); freshBoard(); pmCanRun(PM); });
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

    // A second hand-in waits too, worked by the agent asked next: only the thread can tie the next questions to P.
    await unrelatedHandIn(41);
    let w2 = '', m = '', seen = '';
    turn.during = async (agentId) => {
      if (agentId !== PM) return;
      turn.during = () => {};
      await pmTurn(PM, async () => {
        const view = await assembleContext(PM, 'm', { latestUserSource: null, isA2ATurn: true, counterparty: await answerCounterparty(w1, WORKER) });
        seen = JSON.stringify(view.messages);
        w2 = await ask(OTHER, 'Did the March export finish on your side?');
        m = await ask(MAIN, 'Did the owner ask for March to be left out?');
      }, w1, WORKER);
    };
    expect((await answer(WORKER, w1, 'Sheet 3. The March rows are missing; the export failed.')).isError).toBe(false);
    await vi.waitFor(() => { if (!m) throw new Error('the answer turn has not asked yet'); });
    expect(seen, 'the answer turn shows the question it answers, by the hand-in it is tied to').toContain('Which sheet holds the totals, and were the March rows included?');
    expect(seen, 'and the hand-in itself').toContain(`[${TASK}]`);
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
    expect(report, 'a card with no request of its requester behind it').not.toContain('The request this was opened for');
    for (const words of ['were the March rows included?', 'the export failed', 'Did the March export finish', 'I stopped it', 'Did the owner ask for March', 'The owner wants March included.']) {
      expect(report, 'the review shows the whole exchange').toContain(words);
    }
    expect(stateOf()).toBe('sent_back');
  });

  it('an asked agent that never answers releases the hand-in 30 minutes after the question', async () => {
    await handedIn();
    await review(async () => { await ask(WORKER, 'Which sheet holds the totals?'); });
    expect(await review(), 'held while the question is open').not.toContain(TASK);
    const t = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t + QUEUED_TURN_BOUND_MS - 60_000);
    expect(await review(), 'still held a minute before the bound').not.toContain(TASK);
    vi.spyOn(Date, 'now').mockReturnValue(t + QUEUED_TURN_BOUND_MS + 2_000);
    expect(await review(), 'past the bound the hand-in is back').toContain(TASK);
    expect(whoDecides(TASK)).toEqual({ kind: 'agent', agentId: PM });
    await review();
    expect(whoDecides(TASK), 'two verdictless reviews: the main agent decides').toEqual({ kind: 'agent', agentId: MAIN });
  });

  it('the hold only delays: once the hand-in has gone to the main agent a late answer never takes it back', async () => {
    await handedIn();
    let thread = '';
    await review(async () => { thread = await ask(WORKER, 'Which sheet holds the totals?'); });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + QUEUED_TURN_BOUND_MS + 60_000);
    await review();
    await review();
    expect(whoDecides(TASK), 'the question stopped holding at its bound; two reviews passed it on').toEqual({ kind: 'agent', agentId: MAIN });
    expect((await answer(WORKER, thread, 'Sheet 3 holds the totals.')).isError).toBe(false);
    expect(whoDecides(TASK), 'a late answer does not bring it back').toEqual({ kind: 'agent', agentId: MAIN });
    expect((await call(MAIN, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 })).isError).toBe(false);
    const r = await call(MAIN, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report is in the shared folder' });
    expect(r.isError, r.content).toBe(false);
  });

  it('a PM that asks again after every answer still lets the hand-in escalate: only the first 30 minutes of questions hold it', async () => {
    await handedIn();
    let thread = '';
    await review(async () => { thread = await ask(WORKER, 'Which sheet holds the totals?'); });
    expect((await answer(WORKER, thread, 'Sheet 3.')).isError).toBe(false);
    // The hand-in reached the PM more than 30 minutes ago.
    doneDb().prepare("UPDATE work_events SET created_at = created_at - ? WHERE work_id = ? AND kind = 'handed_in'").run(QUEUED_TURN_BOUND_MS + 60_000, TASK);
    const askAgain = async (): Promise<void> => { thread = await ask(WORKER, `And the next sheet? (${Date.now()})`); };
    await pmTurn(PM, askAgain, thread, WORKER);
    expect(await review(askAgain), 'a question after the window does not hold it').toContain(TASK);
    await review(askAgain);
    expect(whoDecides(TASK), 'two reviews that only asked again: the main agent decides').toEqual({ kind: 'agent', agentId: MAIN });
  });

  it('a card opened for a request its requester still owes waits for the review and the ladder until the answer is delivered', async () => {
    await cardForOwedRequest();
    expect(await review(), 'no review while the owner has not been answered').toBe('');
    await runLadder(Date.now() + 6 * MIN);
    expect(entries(TASK, 'ladder_pm'), 'the ladder waits on the same hold').toBe(0);
    askIs('blocked', 1);
    expect(await review(), 'held on its helper\'s compile, the answer is still coming').toBe('');
    askIs('claimed');
    Object.assign(openTurnContext(MAIN), { turnNumber: 7, root: { kind: 'ask', id: ASK, sourceMessageId: 'm-ask', conversationId: 'conv-dash' } });
    const sent = recordDelivery({ agentId: MAIN, tool: 'dashboard', channel: 'dashboard', outcome: 'delivered', conversationId: 'conv-dash', messageId: 'm-reply', recipientDisplay: 'the owner' });
    endTurnContext(MAIN);
    expect(sent.kind).toBe('applied');
    expect(await review()).toMatch(/The request this was opened for: answered to the owner at .+ UTC \(delivery .+\)/);
  });

  it('a request stood down unanswered releases its card to the PM', async () => {
    await cardForOwedRequest();
    askIs('blocked');
    const report = await review();
    expect(report).toContain(`[${TASK}]`);
    expect(report).toContain('The request this was opened for: not answered');
  });
});
