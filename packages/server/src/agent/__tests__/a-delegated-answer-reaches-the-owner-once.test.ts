// A DELEGATED ANSWER REACHES THE OWNER ONCE, AFTER THE TURN THAT DELEGATED IT, IN THE AGENT'S OWN WORDS.
// The helper answers while the delegating turn still runs; that turn's own line ("nothing back yet") is not the
// answer, so at its end the request goes back to the owner's queue, due now; the next turn serving it is handed
// the answer and writes it. Nothing is relayed by the Dojo. Driven through the real runtime teardown, the real
// transport door, the real turn finalize and the real settlement; only the model loop is a script.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { startTurn, finalizeTurn } from '../v2/turn-record.js';
import { claimAsk, stampClaimingTurn, openDelegationJoin } from '../../work/store.js';
import { recordDelivery } from '../v2/deliveries.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { getAgentRuntime } from '../runtime.js';
import * as shared from '../shared-state.js';

vi.setConfig({ testTimeout: 30_000 });

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
const turnScript: Array<() => Promise<void>> = [];
let lastRunTouch = Date.now();
vi.mock('../v2/loop.js', () => ({
  runV2Turn: async () => {
    lastRunTouch = Date.now();
    try { const step = turnScript.shift(); if (step) await step(); } finally { lastRunTouch = Date.now(); }
  },
}));
vi.mock('../../services/imessage-bridge.js', () => ({
  sendAlert: vi.fn(), maybeForwardToImessage: vi.fn(),
}));

const AGENT = 'desk-owner';
const HELPER = 'desk-helper';
const CONV = 'conv-1';
const THREAD = 'thread-t163aaaa-0001';
const ASK_A_MSG = 'm-ask-a';
const ASK_A = `ask:${ASK_A_MSG}`;
const HELPER_ANSWER = 'No record of that identifier; I cannot give three facts about it.';

const db = (): Database.Database => mockDb.current!;

beforeEach(async () => {
  // ONE module instance for the file (no `resetModules`): a queued-wakeup timer left over from an
  // earlier test then fires into that same instance, which `afterEach` waits out below.
  turnScript.length = 0;
  shared.activeRuns.clear();
  shared.pendingWakeups.clear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
});
afterEach(async () => {
  // The runtime arms a 500 ms timer for a queued wakeup, and a run it starts can arm another. Let
  // the chain die out into THIS test's database (and the empty script), not the next test's: quiet
  // means no run started or ended for longer than the timer, and none in flight.
  lastRunTouch = Date.now();
  while (Date.now() - lastRunTouch < 900 || shared.activeRuns.size > 0) await new Promise((r) => setTimeout(r, 100));
  mockDb.current?.close();
  mockDb.current = null;
});

async function boot(): Promise<void> {
  // The runtime first: it initialises the module graph in the order production does (the work
  // store sits in an import cycle that a cold `message-store` import trips).
  runMigrations();
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Desk', 'idle', '1970-01-01'), (?, 'Helper', 'idle', '1970-01-01')`,
  ).run(AGENT, HELPER);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
}

/** An owner message through the real writer — which also opens the ask row, as in production. */
async function ownerSays(msgId: string, text: string): Promise<void> {
  insertMessage({
    id: msgId, agentId: AGENT, role: 'user', content: text, channel: 'dashboard', senderId: 'owner',
    conversationId: CONV, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
}

/** What the OWNER can see in his conversation, oldest first: the agent's bubbles and the
 *  platform's relay. (Engine steers and tool rows are not his.) */
const ownerFacing = (): string[] =>
  (db().prepare(
    `SELECT content FROM messages
      WHERE agent_id = ? AND conversation_id = ? AND role = 'assistant'
        AND display_kind = 'agent-text'
      ORDER BY rowid`,
  ).all(AGENT, CONV) as Array<{ content: string }>).map((r) => r.content);

const workRow = (id: string): { state: string; result_delivery_id: string | null } =>
  db().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(id) as never;
const relayDeliveries = (): Array<{ id: string }> =>
  db().prepare(`SELECT id FROM deliveries WHERE agent_id = ? AND tool = 'a2a-join-relay' AND outcome = 'delivered' ORDER BY rowid`).all(AGENT) as never;
const reServes = (id: string): number =>
  (db().prepare(
    `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = 'ct0_ask_re_served'
       AND COALESCE(json_extract(payload, '$.cause'), 'silence') = 'silence'`,
  ).get(id) as { n: number }).n;

/** The helper's ANSWER, through the REAL transport door. */
async function helperAnswers(): Promise<void> {
  const r = await deliverA2AMessage({
    intent: 'ANSWER' as never, threadId: THREAD, requiresResponse: false,
    payload: HELPER_ANSWER, toAgent: AGENT, fromAgent: HELPER,
  } as never);
  expect(r.delivered).toBe(true);
}

/** THE DELEGATING TURN: it delegates the request, the helper answers while it runs, and its own line goes out. */
function scriptDelegatingTurn(): () => Promise<void> {
  return async () => {
    const ctx = openTurnContext(AGENT);
    const turn = startTurn({
      agentId: AGENT, kind: 'user', subjectKind: 'conv', subjectId: CONV, rootKind: 'ask',
      rootId: ASK_A_MSG, sourceMessageId: ASK_A_MSG, convKey: CONV,
    });
    ctx.turnNumber = turn;
    claimAsk(ASK_A, AGENT);
    stampClaimingTurn(ASK_A, turn);
    try {
      openDelegationJoin({
        parentWorkId: ASK_A, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 60 * 60_000,
        threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }],
      });
      await helperAnswers();
      insertMessage({
        id: 'm-reply-1', agentId: AGENT, role: 'assistant', content: 'I have asked the helper; nothing back from it yet.',
        conversationId: CONV, turnNumber: turn, displayKind: 'agent-text',
      });
      recordDelivery({ agentId: AGENT, tool: 'dashboard', channel: 'dashboard', conversationId: CONV, messageId: 'm-reply-1', outcome: 'delivered' });
      finalizeTurn(AGENT, turn, 'answered', true, 'm-reply-1');
      settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
    } finally {
      endTurnContext(AGENT);
    }
  };
}

/** THE TURN THAT SERVES THE REQUEST AGAIN: it is handed the pieces (the steer's record) and writes the answer. */
function scriptAnsweringTurn(out: { done: boolean; ownerAtStart: string[] }): () => Promise<void> {
  return async () => {
    out.ownerAtStart = ownerFacing();
    const ctx = openTurnContext(AGENT);
    const turn = startTurn({
      agentId: AGENT, kind: 'user', subjectKind: 'conv', subjectId: CONV, rootKind: 'ask',
      rootId: ASK_A_MSG, sourceMessageId: ASK_A_MSG, convKey: CONV,
    });
    ctx.turnNumber = turn;
    claimAsk(ASK_A, AGENT);
    stampClaimingTurn(ASK_A, turn);
    try {
      recordPiecesShown(ASK_A, AGENT, turn, newestPutBack(ASK_A)!.id);
      insertMessage({
        id: 'm-reply-2', agentId: AGENT, role: 'assistant', content: 'The helper came back: no record of it.',
        conversationId: CONV, turnNumber: turn, displayKind: 'agent-text',
      });
      recordDelivery({ agentId: AGENT, tool: 'dashboard', channel: 'dashboard', conversationId: CONV, messageId: 'm-reply-2', outcome: 'delivered' });
      finalizeTurn(AGENT, turn, 'answered', true, 'm-reply-2');
      settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
    } finally {
      endTurnContext(AGENT);
      out.done = true;
    }
  };
}

describe('a delegated answer reaches the owner once, after the turn that delegated it', () => {
  it('the delegating turn\'s line is not the answer; the request goes back due now, and the next turn answers it', async () => {
    await boot();
    await ownerSays(ASK_A_MSG, 'Ask the helper for three facts and bring them back to me');
    const answering = { done: false, ownerAtStart: [] as string[] };
    turnScript.push(scriptDelegatingTurn());
    await getAgentRuntime().handleMessage(AGENT, '');
    const after = db().prepare('SELECT state, next_attempt_at AS due FROM work WHERE id = ?').get(ASK_A) as { state: string; due: number | null };
    expect(after.state).toBe('open');
    expect(after.due).not.toBeNull();
    expect(reServes(ASK_A), 'handed back uncounted').toBe(0);

    turnScript.push(scriptAnsweringTurn(answering));
    await getAgentRuntime().handleMessage(AGENT, '');
    await vi.waitFor(() => { expect(answering.done).toBe(true); }, { timeout: 8_000, interval: 50 });
    expect(answering.ownerAtStart).toEqual(['I have asked the helper; nothing back from it yet.']);
    const answer = db().prepare(`SELECT id FROM deliveries WHERE message_id = 'm-reply-2'`).get() as { id: string };
    expect(workRow(ASK_A)).toEqual({ state: 'done', result_delivery_id: answer.id });
    expect(relayDeliveries()).toHaveLength(0);
    expect(ownerFacing()).toHaveLength(2);
  });
});
