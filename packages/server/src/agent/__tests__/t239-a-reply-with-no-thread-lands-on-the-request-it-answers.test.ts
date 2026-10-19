// ════════════════════════════════════════════════════════════════════════════════════════
// t239 (a) — A REPLY THAT NAMES NO THREAD LANDS ON THE REQUEST IT ANSWERS.
//
// THE INCIDENT, REPLAYED. The owner asked the main agent for two things; it delegated one
// piece to each of two helpers (an ASSIGN on its own thread each). The first helper answered on
// its thread and its piece landed. The second helper's reply was a DELIVERABLE sent with NO
// `thread_id`: the transport minted a brand-new thread, the join never saw it, the second
// helper's ASSIGN stayed unreplied (so the runtime kept retrying it), and the owner's ask sat
// `blocked` until a timeout told them something false.
//
// THE RULE UNDER TEST (one rule, at the one thread-resolution line): a reply-intent send
// (ANSWER / DELIVERABLE / COMPLETE / FAIL) with no thread, to an agent from which the sender
// holds an UNREPLIED QUESTION / ASSIGN / BLOCK, goes on that thread. Opening intents still open
// a thread. There is no second join key: the join still matches by the exact thread.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 15_000 });

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t239-served-thread-test', 'dojo.db'),
  };
});
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false, isPMAgent: () => false, isHealerAgent: () => false,
  isDreamerAgent: () => false, getOwnerName: () => 'Owner', getPrimaryAgentId: () => 'primary',
}));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }) }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, openDelegationJoin, joinPieces } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { recordA2AReply, findUnrepliedAssignForAgent } from '../a2a-replies.js';
import { runEmptyResponse } from '../v2/steps/post-call-classify/empty-response.js';
import { advance, initState } from '../v2/state.js';
import type { PostCallClassifyContext } from '../v2/steps/post-call-classify/index.js';
import type { ToolCall } from '@dojo/shared';

const MAIN = 'mainagent';
const FAST = 'fasthelper';
const SLOW = 'slowhelper';
const CONV = 'conv-1';
const T_FAST = 'thread-fastfast-1111';
const T_SLOW = 'thread-slowslow-2222';

const db = (): Database.Database => mockDb.current!;

async function deliver(o: {
  from: string; to: string; intent: string; payload: string; threadId?: string;
}): Promise<Awaited<ReturnType<typeof import('../a2a-transport.js').deliverA2AMessage>>> {
  const { deliverA2AMessage } = await import('../a2a-transport.js');
  return deliverA2AMessage({
    intent: o.intent as never, threadId: o.threadId ?? '', requiresResponse: true,
    payload: o.payload, toAgent: o.to, fromAgent: o.from,
  });
}

/** The owner asks; the main agent delegates one piece to each helper (real ASSIGN deliveries) and opens the join. */
async function seedFanOut(): Promise<string> {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES ('m-ask', ?, 'user', 'get the sum and write a story, then tell me', 'owner', 'dashboard', ?, ?, NULL)`,
  ).run(MAIN, CONV, Date.now() - 5 * 60_000);
  const ask = openAsk({
    agentId: MAIN, messageId: 'm-ask', conversationId: CONV, requesterId: 'owner',
    openedAt: Date.now() - 5 * 60_000, title: 'sum and story',
  });
  claimAsk(ask, MAIN);
  await deliver({ from: MAIN, to: FAST, intent: 'ASSIGN', payload: 'compute 36 + 36', threadId: T_FAST });
  await deliver({ from: MAIN, to: SLOW, intent: 'ASSIGN', payload: 'write a five chapter story about a bus', threadId: T_SLOW });
  openDelegationJoin({
    parentWorkId: ask, agentId: MAIN, replyConversationId: CONV, ttlAt: Date.now() + 60 * 60_000,
    threads: [
      { threadId: T_FAST, assigneeAgent: FAST, intent: 'ASSIGN', hopCount: 0 },
      { threadId: T_SLOW, assigneeAgent: SLOW, intent: 'ASSIGN', hopCount: 0 },
    ],
  });
  return ask;
}

const compileSteers = (): number =>
  (db().prepare(
    `SELECT count(*) c FROM messages WHERE agent_id = ? AND lane = 'events' AND origin_intent = 'fanout_join'`,
  ).get(MAIN) as { c: number }).c;

/** A piece's state by its thread (read off the ask's pieces, which also lists settled ones). */
const pieceState = (threadId: string): string => {
  const ask = (db().prepare(`SELECT id FROM work WHERE kind = 'ask' AND agent_id = ?`).get(MAIN) as { id: string }).id;
  return joinPieces(ask).find((p) => p.threadId === threadId)!.state;
};

beforeEach(() => {
  endTurnContext(SLOW);
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
  d.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, 'Main', 'idle', '1970-01-01'), (?, 'Fast', 'idle', '1970-01-01'), (?, 'Slow', 'idle', '1970-01-01')`,
  ).run(MAIN, FAST, SLOW);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, MAIN);
});

describe('t239 (a) — a reply-intent send with no thread_id goes on the request the sender holds', () => {
  it('RED→GREEN: a DELIVERABLE with no thread_id to the agent that assigned the work lands on the assignment\'s thread', async () => {
    await seedFanOut();
    const r = await deliver({ from: SLOW, to: MAIN, intent: 'DELIVERABLE', payload: 'Chapter one. Chapter two. The end.' });
    expect(r.delivered).toBe(true);
    expect(r.threadId).toBe(T_SLOW);
    expect(r.answeredRequestOnThread, 'the tool result must be able to say so in plain words').toBe(true);
    expect(pieceState(T_SLOW)).toBe('done');
  });

  it.each(['ANSWER', 'COMPLETE', 'FAIL'])('%s with no thread_id resolves the same way', async (intent) => {
    await seedFanOut();
    const r = await deliver({ from: SLOW, to: MAIN, intent, payload: 'the reply' });
    expect(r.threadId).toBe(T_SLOW);
  });

  it('NEGATIVE: QUESTION / ASSIGN / BLOCK with no thread_id still open a NEW thread', async () => {
    await seedFanOut();
    for (const intent of ['QUESTION', 'ASSIGN', 'BLOCK']) {
      const r = await deliver({ from: SLOW, to: MAIN, intent, payload: `a fresh ${intent} about something else entirely` });
      expect(r.delivered).toBe(true);
      expect(r.threadId, intent).not.toBe(T_SLOW);
      expect(r.answeredRequestOnThread).toBeFalsy();
    }
  });

  it('NEGATIVE: an explicit thread_id is honoured exactly as before', async () => {
    await seedFanOut();
    const r = await deliver({ from: SLOW, to: MAIN, intent: 'DELIVERABLE', payload: 'sent on a thread I named', threadId: 'thread-chosen-9999' });
    expect(r.threadId).toBe('thread-chosen-9999');
    expect(r.answeredRequestOnThread).toBeFalsy();
  });

  it('NEGATIVE: no unreplied request from that target means no inference (an unprompted DELIVERABLE is a new thread, as today)', async () => {
    await seedFanOut();
    const r = await deliver({ from: SLOW, to: FAST, intent: 'DELIVERABLE', payload: 'something nobody asked for' });
    expect(r.threadId).not.toBe(T_SLOW);
    expect(r.threadId).not.toBe(T_FAST);
  });

  it('NEGATIVE: a request that was already replied to is not resolved to', async () => {
    await seedFanOut();
    const owed = findUnrepliedAssignForAgent(SLOW)!;
    recordA2AReply({ assignMessageId: owed.messageId, agentId: SLOW, threadId: T_SLOW, replyIntent: 'DELIVERABLE' });
    const r = await deliver({ from: SLOW, to: MAIN, intent: 'DELIVERABLE', payload: 'a second, unrelated delivery' });
    expect(r.threadId).not.toBe(T_SLOW);
  });

  it('AMBIGUOUS: two unreplied requests from the same agent and no turn that serves either is today\'s behaviour (a new thread)', async () => {
    await seedFanOut();
    await deliver({ from: MAIN, to: SLOW, intent: 'QUESTION', payload: 'and what is the title?', threadId: 'thread-second-3333' });
    const r = await deliver({ from: SLOW, to: MAIN, intent: 'ANSWER', payload: 'the title is The Bus' });
    expect(r.threadId).not.toBe(T_SLOW);
    expect(r.threadId).not.toBe('thread-second-3333');
  });

  it('AMBIGUOUS: with two unreplied requests, the one the sender\'s CURRENT turn serves wins', async () => {
    await seedFanOut();
    await deliver({ from: MAIN, to: SLOW, intent: 'QUESTION', payload: 'and what is the title?', threadId: 'thread-second-3333' });
    // The runtime serves the newest unreplied request on a dedicated A2A turn that begins after it landed.
    const bag = openTurnContext(SLOW);
    bag.kind = 'a2a';
    bag.pickupSeq = (db().prepare('SELECT MAX(seq) s FROM messages WHERE agent_id = ?').get(SLOW) as { s: number }).s;
    const r = await deliver({ from: SLOW, to: MAIN, intent: 'ANSWER', payload: 'the title is The Bus' });
    endTurnContext(SLOW);
    expect(r.threadId).toBe('thread-second-3333');
  });

  it('a request that awaits its OWN turn is not answered from an unrelated turn (the t165 rule holds for the inferred thread too)', async () => {
    await seedFanOut();
    const bag = openTurnContext(SLOW);
    bag.kind = 'user';   // e.g. the owner's conversation, not the turn that serves the assignment
    const r = await deliver({ from: SLOW, to: MAIN, intent: 'DELIVERABLE', payload: 'unrelated delivery from an owner turn' });
    endTurnContext(SLOW);
    expect(r.threadId).not.toBe(T_SLOW);
  });
});

describe('t239 — replay of the incident: a cut DELIVERABLE never runs; the whole one settles the piece and the join compiles once', () => {
  it('after the fix the cut call does not run, and a later complete DELIVERABLE with no thread_id completes the join exactly once', async () => {
    const ask = await seedFanOut();

    // The fast helper answers properly, on its thread.
    await deliver({ from: FAST, to: MAIN, intent: 'DELIVERABLE', payload: '72', threadId: T_FAST });
    expect(pieceState(T_FAST)).toBe('done');
    expect(pieceState(T_SLOW)).toBe('open');
    expect(compileSteers()).toBe(0);

    // The slow helper's reply is CUT mid-sentence with its tool call already parsed. The engine
    // must not run it: the post-call rung sends the model back (continue), so nothing is delivered.
    const cut = {
      content: 'Chapter two. The bus waited for the light to change',
      toolCalls: [{ id: 'tc-1', name: 'send_to_agent', arguments: { agent: MAIN, intent: 'DELIVERABLE', payload: 'chapters 1-2 of 5, cut off' } }] as ToolCall[],
      inputTokens: 22_396, outputTokens: 8_324, stopReason: 'length', outputRoom: { sent: 8_192, ceiling: 32_768 },
    } as unknown as PostCallClassifyContext['result'];
    const state = advance(initState({
      agentId: SLOW, contextWindow: 30_720, isAutoRouted: false, configuredModelId: 'm', turnNumber: 9,
      triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'x', lastUserMessageId: 'u',
    } as Parameters<typeof initState>[0]), { phase: 'postCallClassify', loopCount: 1, modelId: 'm' });
    const out = runEmptyResponse(state, {
      agentId: SLOW, turnNumber: 9, chosenConvKey: null, result: cut, reArmIfStrandedNoAnswer: () => {},
      turnCtx: { startAckSteerRequested: false, startAckSteerArmedThisTurn: false, engineStartAckDeliveredThisTurn: false, root: null },
      isA2ATurn: true, isEngineTurn: false, counterpartyIsAgentSender: true, hasUnansweredUser: false, triggerRow: null,
    } as unknown as PostCallClassifyContext);
    expect(out.directive, 'the cut response is sent back, not executed').toBe('continue');
    expect(pieceState(T_SLOW), 'nothing was delivered, so the piece is still open').toBe('open');
    expect(compileSteers()).toBe(0);

    // The re-sent, COMPLETE deliverable omits thread_id again: it still settles the piece.
    const whole = await deliver({ from: SLOW, to: MAIN, intent: 'DELIVERABLE', payload: 'The whole story, all five chapters. The end.' });
    expect(whole.threadId).toBe(T_SLOW);
    expect(pieceState(T_SLOW)).toBe('done');
    expect(joinPieces(ask).map((p) => p.state)).toEqual(['done', 'done']);
    expect(compileSteers(), 'the join compiles once to the owner').toBe(1);
  });
});
