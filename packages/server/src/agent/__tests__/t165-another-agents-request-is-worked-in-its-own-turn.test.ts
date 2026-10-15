// ════════════════════════════════════════════════════════════════════════════════════════
// t165 — ANOTHER AGENT'S REQUEST IS WORKED IN ITS OWN CONVERSATION, NEVER INSIDE THE OWNER'S.
//
// OWNER RULING 2026-10-14, "Keep it separate": the owner's chat shows only work done for the
// owner. A peer's request is handled in its own conversation.
//
// ── THE WITNESS (release run 9, scenario S3, attempt 1; rows read, not recalled) ──
// A peer's A2A QUESTION arrived on its own thread while the agent was busy with an OWNER turn.
// Its wake was deferred ("standing down, a human is waiting"). The owner turn's model then found
// the question through its own history tool — the result printed the neighbouring rows, including
// `[A2A:QUESTION thread:… from:…] please search mail for …` — searched the mail inside the owner
// turn and answered the peer with `send_to_agent` ANSWER on that thread. Every row was an
// owner-lane tool turn; no A2A turn ever ran for that thread.
//
// ── THE TWO HALVES OF THE FIX, both read from the engine's own state ──
// 1. LABEL, never hide: wherever the history tools print the request while it is still awaiting
//    its own turn, the row carries a clause saying so (the row is still printed).
// 2. STRUCTURAL BACKSTOP: a `send_to_agent` that continues that thread from a turn whose subject is
//    NOT that thread is refused as a guard refusal (not a tool error), delivers nothing, and leaves
//    the request unserved — so the dedicated A2A turn the runtime queues for it still runs.
//
// "Awaiting its own turn" is `findUnrepliedAssignForAgent` — the question the runtime itself asks
// at every turn end to queue that dedicated turn — so these tests drive the REAL preflight
// (`runPreflight`) to open an owner turn and then the request's own A2A turn on a fixture database
// with the real migrations; the transport hop is the one dial the test controls.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 20_000 });

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));

vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return {
    ...actual,
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

/** THE TRANSPORT HOP, the one dial this file controls: a send either reaches the peer (the spy
 *  is called) or it does not. Everything on this side of the hop is real. */
const deliverSpy = vi.fn();
vi.mock('../a2a-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../a2a-transport.js')>()),
  deliverA2AMessage: (...a: unknown[]) => deliverSpy(...(a as [])),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { openTurnContext, endTurnContext, turnContext } from '../turn-context.js';
import { runPreflight, type PreflightContext } from '../v2/steps/preflight/index.js';
import { forceA2ATurn, lastTurnWasA2A } from '../turn-state.js';
import { findUnrepliedAssignForAgent, recordA2AReply } from '../a2a-replies.js';
import { agentsHandlers } from '../tools/cat/agents.js';
import { recallHandlers } from '../tools/cat/recall.js';
import { classifyToolResult } from '../tool-outcome.js';
import { memoryDescribe, memoryGrep } from '../../memory/retrieval.js';

const AGENT = 'primary';
const PEER = 'peer-agent-1';
const OTHER = 'peer-agent-2';
const THREAD = 'thread-t165-aaaa-bbbb-cccc-0001';
const OTHER_THREAD = 'thread-t165-aaaa-bbbb-cccc-0002';
const REQUEST_FP = 'please look up the quarterly figures CODEWORD-T165';

let requestId = '';

function seed(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`,
  ).run();
  for (const [id, name] of [[AGENT, 'Primary'], [PEER, 'Peer One'], [OTHER, 'Peer Two']] as const) {
    db.prepare(
      `INSERT INTO agents (id, name, model_id, status, config, classification, session_started_at)
       VALUES (?, ?, 'm', 'idle', '{}', ?, '1970-01-01')`,
    ).run(id, name, id === AGENT ? 'sensei' : 'apprentice');
  }
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-1', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
  return db;
}

function ctx(): PreflightContext {
  return {
    agentId: AGENT,
    setAgentStatus: vi.fn(),
    startStatusHeartbeat: vi.fn(),
    stopStatusHeartbeat: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
    engineBlockEscapeHatch: 'escape-hatch',
    engineStartAckAfterMs: 30_000,
  };
}

/** The owner's message, as the dashboard ingest writes it (opens the ask ticket). */
function ownerAsks(text: string): void {
  insertMessage({
    agentId: AGENT, role: 'user', content: text, lane: 'owner', conversationId: 'conv-1',
    channel: 'dashboard', senderId: 'owner',
  });
}

/** A peer's inbound A2A request, as the transport lands it. */
function peerAsks(threadId: string, from: string, text: string, intent = 'QUESTION'): string {
  return insertMessage({
    agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: from, a2aThreadId: threadId,
    a2aIntent: intent, a2aRequiresResponse: true,
    content: `[A2A:${intent} thread:${threadId.slice(0, 8)} from:${from}] ${text}`,
  }).id;
}

/** Open the OWNER's turn through the real preflight; the peer's request arrives AFTER it began. */
async function openOwnerTurn(): Promise<void> {
  ownerAsks('How is the roadmap looking this week?');
  endTurnContext(AGENT);
  const bag = openTurnContext(AGENT);
  const out = await runPreflight(bag, ctx());
  if (out.directive !== 'proceed') throw new Error('preflight abandoned unexpectedly');
  expect(bag.kind).toBe('user');
}

const sendToAgent = (args: Record<string, unknown>) =>
  agentsHandlers['send_to_agent']({ agentId: AGENT, args } as unknown as Parameters<(typeof agentsHandlers)['send_to_agent']>[0]);
const recall = (args: Record<string, unknown> = {}) =>
  recallHandlers['recall_recent_thread']({ agentId: AGENT, args: { turn_count: 6, ...args } } as unknown as Parameters<(typeof recallHandlers)['recall_recent_thread']>[0]);

const LABEL = /this request belongs to agent thread .* it is handled on its own turn/;

beforeEach(() => {
  mockDb.current?.close();
  seed();
  vi.clearAllMocks();
  endTurnContext(AGENT);
  forceA2ATurn.delete(AGENT);
  lastTurnWasA2A.delete(AGENT);
  deliverSpy.mockResolvedValue({ delivered: true, threadId: THREAD, messageId: 'a2a-out-1' });
});

// ── (i) the measured shape: an owner turn's history result shows the pending request, labelled ──

describe('(i) an owner turn that reads a peer\'s pending request is told whose it is', () => {
  beforeEach(async () => {
    await openOwnerTurn();
    requestId = peerAsks(THREAD, PEER, REQUEST_FP);
  });

  it('recall_recent_thread prints the row AND says it belongs to its own turn', async () => {
    const r = await recall({ scope: 'all' });
    expect(r.isError).toBe(false);
    expect(r.content).toContain(REQUEST_FP);                        // labelled, never hidden
    const line = r.content.split('\n').find((l) => l.includes(REQUEST_FP))!;
    expect(line).toMatch(LABEL);
    expect(line).toContain('do not work on it here');
    expect(line.indexOf('this request belongs to')).toBeLessThan(line.indexOf(REQUEST_FP)); // bound to the row
  });

  it('the default (conversation-scoped) recall carries it too — the row was in view there', async () => {
    const r = await recall();
    expect(r.content).toContain(REQUEST_FP);
    expect(r.content).toMatch(LABEL);
  });

  it('history_search and history_get label the same row', async () => {
    const found = await memoryGrep(AGENT, { pattern: 'CODEWORD-T165', mode: 'full_text' });
    expect(found).toContain(REQUEST_FP);
    expect(found).toMatch(LABEL);
    const got = memoryDescribe(AGENT, { id: requestId });
    expect(got).toContain(REQUEST_FP);
    expect(got).toMatch(LABEL);
    // the regex (LIKE) arm too
    const like = await memoryGrep(AGENT, { pattern: 'CODEWORD-T165', mode: 'regex' });
    expect(like).toMatch(LABEL);
  });

  it('the owner\'s own rows are not labelled', async () => {
    const r = await recall({ scope: 'all' });
    const ownerLine = r.content.split('\n').find((l) => l.includes('How is the roadmap'))!;
    expect(ownerLine).not.toMatch(/this request belongs to/);
  });
});

// ── (ii) the owner turn tries to ANSWER on that thread: refused, then its own turn answers ──

describe('(ii) an owner turn cannot answer the peer; the request\'s own A2A turn does', () => {
  it('is refused as a GUARD refusal, delivers nothing, leaves the request unserved — then the A2A turn answers', async () => {
    await openOwnerTurn();
    peerAsks(THREAD, PEER, REQUEST_FP);
    expect(findUnrepliedAssignForAgent(AGENT)?.threadId).toBe(THREAD);

    // The owner turn's model answers on the peer's thread.
    const refused = await sendToAgent({ agent: PEER, intent: 'ANSWER', thread_id: THREAD, payload: 'Here are the figures.' });
    expect(refused.isError).toBe(true);
    expect(refused.errorCode).toBe('PERMISSION_DENIED');
    expect(refused.content).toMatch(/handled on its own turn, right after this one/);
    expect(refused.content).toMatch(/Nothing was sent/);
    // …classed as the door REFUSING (blocked), not a tool that broke (crashed).
    const outcome = classifyToolResult({ toolCallId: 't', name: 'send_to_agent', ...refused });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toBe('blocked');
    // Nothing reached the peer; no reply was recorded; the request is still owed.
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM a2a_replies').get()).toEqual({ n: 0 });
    expect(findUnrepliedAssignForAgent(AGENT)?.threadId).toBe(THREAD);
    // The short thread token is the same thread: refused too.
    const viaShort = await sendToAgent({ agent: PEER, intent: 'ANSWER', thread_id: THREAD.slice(0, 8), payload: 'again' });
    expect(viaShort.isError).toBe(true);
    // Any intent that continues the thread is refused, not only ANSWER.
    expect((await sendToAgent({ agent: PEER, intent: 'STATUS', thread_id: THREAD, payload: 'working on it' })).isError).toBe(true);
    expect(deliverSpy).not.toHaveBeenCalled();

    // The owner turn ends. The runtime's turn-end check (`runtime.ts`, A2A re-trigger) asks exactly
    // `findUnrepliedAssignForAgent`, finds the request owed, and queues a dedicated A2A turn.
    const owed = findUnrepliedAssignForAgent(AGENT);
    expect(owed).not.toBeNull();
    endTurnContext(AGENT);
    forceA2ATurn.add(AGENT);                                         // what that re-trigger sets

    // …and that turn runs, through the real preflight, as an A2A turn for THAT thread…
    const a2aBag = openTurnContext(AGENT);
    const out = await runPreflight(a2aBag, ctx());
    expect(out.directive).toBe('proceed');
    expect(a2aBag.kind).toBe('a2a');
    expect(a2aBag.state?.triggeredByA2AReplyIntent?.intent).toBe('QUESTION');
    // …where the request is its own work: no label, and the answer goes through.
    const seen = await recall({ scope: 'all' });
    expect(seen.content).toContain(REQUEST_FP);
    expect(seen.content).not.toMatch(/this request belongs to/);
    const sent = await sendToAgent({ agent: PEER, intent: 'ANSWER', thread_id: THREAD, payload: 'Here are the figures.' });
    expect(sent.isError).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0][0]).toMatchObject({ intent: 'ANSWER', threadId: THREAD, toAgent: PEER, fromAgent: AGENT });
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM a2a_replies').get()).toEqual({ n: 1 });
    expect(findUnrepliedAssignForAgent(AGENT)).toBeNull();
  });

  it('an A2A turn for ANOTHER thread cannot answer this one either', async () => {
    // Thread A's request is the one served; thread B's is the newer request awaiting its own turn.
    peerAsks(OTHER_THREAD, OTHER, 'first thing');
    endTurnContext(AGENT);
    forceA2ATurn.add(AGENT);
    const bag = openTurnContext(AGENT);
    expect((await runPreflight(bag, ctx())).directive).toBe('proceed');
    expect(bag.kind).toBe('a2a');
    // The owed request is the OTHER thread's; this turn's subject IS it, so it may answer it …
    expect((await sendToAgent({ agent: OTHER, intent: 'ANSWER', thread_id: OTHER_THREAD, payload: 'ok' })).isError).toBe(false);
    // …but once a second request lands on a different thread mid-turn, this turn does not serve it.
    peerAsks(THREAD, PEER, REQUEST_FP);
    expect(findUnrepliedAssignForAgent(AGENT)?.threadId).toBe(THREAD);
    const r = await sendToAgent({ agent: PEER, intent: 'ANSWER', thread_id: THREAD, payload: 'wrong turn' });
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe('PERMISSION_DENIED');
    expect(deliverSpy).toHaveBeenCalledTimes(1);                     // only the legitimate one
  });
});

// ── (iii) what the owner asked for is untouched ──

describe('(iii) the owner\'s own delegation is unaffected', () => {
  it('a NEW question to a peer (no thread) is delivered while another peer\'s request awaits its turn', async () => {
    await openOwnerTurn();
    peerAsks(THREAD, PEER, REQUEST_FP);
    deliverSpy.mockResolvedValue({ delivered: true, threadId: 'thread-new-0001-xxxx', messageId: 'a2a-out-2' });
    const r = await sendToAgent({ agent: OTHER, intent: 'QUESTION', payload: 'Can you pull the owner\'s numbers?' });
    expect(r.isError).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0][0]).toMatchObject({ intent: 'QUESTION', toAgent: OTHER, threadId: '' });
    // …and a NEW question to the SAME peer that asked (still its own, fresh thread) is delivered too.
    const same = await sendToAgent({ agent: PEER, intent: 'QUESTION', payload: 'Separate matter: the owner wants X.' });
    expect(same.isError).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(2);
    // The waiting request is untouched by either.
    expect(findUnrepliedAssignForAgent(AGENT)?.threadId).toBe(THREAD);
  });

  it('a send on a thread with NO awaiting request, from an owner turn, is delivered', async () => {
    await openOwnerTurn();
    deliverSpy.mockResolvedValue({ delivered: true, threadId: OTHER_THREAD, messageId: 'a2a-out-3' });
    const r = await sendToAgent({ agent: OTHER, intent: 'ASSIGN', thread_id: OTHER_THREAD, payload: 'next step' });
    expect(r.isError).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it('outside any turn the door cannot say whose turn it is, so it does not refuse', async () => {
    peerAsks(THREAD, PEER, REQUEST_FP);
    expect(turnContext(AGENT)).toBeUndefined();
    const r = await sendToAgent({ agent: PEER, intent: 'ANSWER', thread_id: THREAD, payload: 'direct' });
    expect(r.isError).toBe(false);
  });
});

// ── (iv) an A2A turn answering its own thread still works ──

describe('(iv) an A2A turn answers its own thread', () => {
  it('delivers, records the reply, and clears the obligation', async () => {
    peerAsks(THREAD, PEER, REQUEST_FP, 'ASSIGN');
    endTurnContext(AGENT);
    forceA2ATurn.add(AGENT);
    const bag = openTurnContext(AGENT);
    expect((await runPreflight(bag, ctx())).directive).toBe('proceed');
    expect(bag.kind).toBe('a2a');
    const r = await sendToAgent({ agent: PEER, intent: 'DELIVERABLE', thread_id: THREAD, payload: 'done' });
    expect(r.isError).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(findUnrepliedAssignForAgent(AGENT)).toBeNull();
  });
});

// ── (v) a history result whose a2a rows were already answered carries no label ──

describe('(v) an answered request carries no label', () => {
  it('after the reply is recorded, none of the history tools label the row', async () => {
    await openOwnerTurn();
    requestId = peerAsks(THREAD, PEER, REQUEST_FP);
    recordA2AReply({ assignMessageId: requestId, agentId: AGENT, threadId: THREAD, replyIntent: 'ANSWER' });
    expect(findUnrepliedAssignForAgent(AGENT)).toBeNull();
    const r = await recall({ scope: 'all' });
    expect(r.content).toContain(REQUEST_FP);
    expect(r.content).not.toMatch(/this request belongs to/);
    expect(await memoryGrep(AGENT, { pattern: 'CODEWORD-T165', mode: 'full_text' })).not.toMatch(/this request belongs to/);
    expect(memoryDescribe(AGENT, { id: requestId })).not.toMatch(/this request belongs to/);
    // …and the thread is open to the owner turn again (nothing awaits a turn of its own).
    const s = await sendToAgent({ agent: PEER, intent: 'FYI', thread_id: THREAD, payload: 'one more note' });
    expect(s.isError).toBe(false);
  });

  it('a request that is not a request (an ANSWER, an FYI) is never labelled', async () => {
    await openOwnerTurn();
    const fyi = peerAsks(THREAD, PEER, 'just so you know CODEWORD-T165', 'FYI');
    expect((await recall({ scope: 'all' })).content).not.toMatch(/this request belongs to/);
    expect(memoryDescribe(AGENT, { id: fyi })).not.toMatch(/this request belongs to/);
  });
});
