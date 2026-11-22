// A task the main agent opened for a person's request, then handed out in the same turn (an ASSIGN to an agent, or
// a spawn with no task named), is the helper's job task: one task on the board, handed in by the helper's reply and
// reviewed once, only after the person has the answer. A helper's job born of the ASSIGN waits the same way. In a
// fan-out only the first helper gets the opened task; a work_open after delegating names the helper's task instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.mock('../../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.setConfig({ testTimeout: 120_000 });

import { recordDelivery } from '../../../agent/v2/deliveries.js';
import { openTurnContext, endTurnContext } from '../../../agent/turn-context.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin } from '../../store.js';
import { insertMessage } from '../../../memory/message-store.js';
import { newestPutBack, recordPiecesShown } from '../../ask-settlement.js';
import { freshBoard, call, PM, MAIN, WORKER, OTHER } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { pmCanRun, resetLadderWorld, review } from './helpers/ladder-world.js';

const ASK = askIdForMessage('m-ask');
const closes = () => doneDb().prepare(
  "SELECT json_extract(payload, '$.to') AS \"to\" FROM work_events WHERE work_id = ? AND kind = 'transition' AND json_extract(payload, '$.to') IN ('done', 'failed', 'abandoned')").all(ASK);
const inTurn = (): void => {
  Object.assign(openTurnContext(MAIN), { turnNumber: 7, root: { kind: 'ask', id: 'm-ask', sourceMessageId: 'm-ask', conversationId: 'conv-dash' } });
};
const jobTasks = () => doneDb().prepare(
  "SELECT id, agent_id AS holder, a2a_thread_id AS thread, state FROM work WHERE kind = 'task' AND root_kind <> 'a2a_thread' AND id <> 'task-decide-0001' ORDER BY opened_at, rowid",
).all() as Array<{ id: string; holder: string; thread: string | null; state: string }>;
const assignThread = (to: string): string => (doneDb().prepare(
  "SELECT a2a_thread_id AS t FROM messages WHERE agent_id = ? AND a2a_intent = 'ASSIGN' ORDER BY rowid DESC LIMIT 1").get(to) as { t: string }).t;
const openForRequest = () => call(MAIN, 'work_open', { kind: 'task', title: 'Beach packing list', goal: 'The owner has a beach packing list' });
const spawnedHelper = (): string => (doneDb().prepare("SELECT id FROM agents WHERE name = 'Packer'").get() as { id: string }).id;
const delegate = async (door: 'send_to_agent' | 'spawn_agent', to = WORKER): Promise<string> => {
  const r = door === 'send_to_agent'
    ? await call(MAIN, 'send_to_agent', { agent: to, intent: 'ASSIGN', payload: 'Write a beach packing list.' })
    : await call(MAIN, 'spawn_agent', { name: 'Packer', system_prompt: 'Write a beach packing list.', timeout_minutes: 10 });
  expect(r.isError, r.content).toBe(false);
  return door === 'send_to_agent' ? to : spawnedHelper();
};
/** The turn ends as delegated: the request's piece on each thread it sent, as the delegation exit opens it. */
const turnEndsDelegated = (helpers: string[]): void => {
  openDelegationJoin({ parentWorkId: ASK, agentId: MAIN, replyConversationId: 'conv-dash', ttlAt: Date.now() + 3_600_000,
    threads: helpers.map((h) => ({ threadId: assignThread(h), assigneeAgent: h, intent: 'ASSIGN', hopCount: 0 })) });
  endTurnContext(MAIN);
};
const helperCompletes = async (helper: string): Promise<void> => {
  const r = await call(helper, 'send_to_agent', { agent: MAIN, intent: 'COMPLETE', thread_id: assignThread(helper), payload: 'Sunscreen, towels, water.' });
  expect(r.isError, r.content).toBe(false);
};
/** The relay turn, shown the helper's answer (as its steer records on reaching the model), answers the owner. */
const ownerIsAnswered = (): void => {
  inTurn();
  const putBack = newestPutBack(ASK);
  if (putBack) recordPiecesShown(ASK, MAIN, 7, putBack.id);
  expect(recordDelivery({ agentId: MAIN, tool: 'dashboard', channel: 'dashboard', outcome: 'delivered', conversationId: 'conv-dash', messageId: 'm-reply', recipientDisplay: 'the owner' }).kind).toBe('applied');
  endTurnContext(MAIN);
};

beforeEach(() => {
  resetLadderWorld(); freshBoard(); pmCanRun(PM); pmCanRun(MAIN);
  doneDb().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-dash', ?, 'dashboard', 'owner')").run(MAIN);
  insertMessage({
    id: 'm-ask', agentId: MAIN, role: 'user', content: 'Make me a beach packing list', lane: 'owner', channel: 'dashboard',
    senderId: 'owner', authorized: true, conversationId: 'conv-dash', inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as Parameters<typeof insertMessage>[0]);
  claimAsk(ASK, MAIN);
  stampClaimingTurn(ASK, 7);
  inTurn();
});
afterEach(() => { endTurnContext(MAIN); vi.restoreAllMocks(); });

describe('a task opened for a request, then delegated, is the helper\'s task', () => {
  for (const door of ['send_to_agent', 'spawn_agent'] as const) {
    it(`work_open then ${door} in one turn: one task, the helper's, handed in by its reply and reviewed once after the owner has the answer`, async () => {
      expect((await openForRequest()).isError).toBe(false);
      const helper = await delegate(door);
      turnEndsDelegated([helper]);
      const [job, ...more] = jobTasks();
      expect(more, 'no second task for the same job').toEqual([]);
      expect([job.holder, job.thread]).toEqual([helper, assignThread(helper)]);

      await helperCompletes(helper);
      expect(jobTasks().map((t) => t.state)).toEqual(['handed_in']);
      expect(await review(PM), 'no review while the owner has not been answered').toBe('');
      ownerIsAnswered();
      expect(closes(), 'the request closes once, on the answer').toEqual([{ to: 'done' }]);
      const report = await review(PM);
      expect(report).toContain(`[${job.id}]`);
      expect(report).toMatch(/The request this was opened for: answered to the owner at/);
    });
  }

  it('a job born of the ASSIGN, with no task opened first, also waits until the owner has the answer', async () => {
    const helper = await delegate('spawn_agent');
    turnEndsDelegated([helper]);
    const [job] = jobTasks();
    await helperCompletes(helper);
    expect(await review(PM), 'its request is reached through its piece').toBe('');
    ownerIsAnswered();
    expect(await review(PM)).toContain(`[${job.id}]`);
  });

  it('a fan-out gives the opened task to the first helper only; the second gets its own', async () => {
    const [opened] = (await openForRequest()).content.match(/[0-9a-f]{8}-[0-9a-f-]{27}/) ?? [];
    await delegate('send_to_agent', WORKER);
    await delegate('send_to_agent', OTHER);
    const tasks = jobTasks();
    expect(tasks.map((t) => t.holder)).toEqual([WORKER, OTHER]);
    expect(tasks[0].id).toBe(opened);
    expect(new Set(tasks.map((t) => t.thread)).size).toBe(2);
  });

  it('a work_open after delegating names the helper\'s task and opens nothing, unless allowed', async () => {
    const helper = await delegate('send_to_agent');
    turnEndsDelegated([helper]);
    inTurn();
    const [job] = jobTasks();
    const r = await openForRequest();
    expect(r.content).toContain(`this request is already task ${job.id.slice(0, 8)}, held by ${helper}; nothing opened`);
    expect(jobTasks()).toHaveLength(1);
    expect((await call(MAIN, 'work_open', { kind: 'task', title: 'Beach packing list', goal: 'The owner has it', allow_duplicate: true })).isError).toBe(false);
    expect(jobTasks()).toHaveLength(2);
  });
});
