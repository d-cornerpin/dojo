// t161 — AN A2A TURN SEES ITS OWN TOOL WORK FOR THIS THREAD ONLY, never another thread's.
//
// ── THE WITNESS (ritual run 7, S3, measured from a box's rows) ──
// An agent answered a QUESTION on thread A with three tool calls (docs load, a mailbox search, a
// send). Its next turn was woken by an ANSWER on thread B. The first model call held thread A's
// six tool rows plus thread B's trigger, and NOT thread A's question that explains them:
// `scopeToA2AThread` kept an own tool row whatever thread it was stamped for, while it scoped the
// INBOUND rows to the live thread. The model was handed another conversation's tool output with
// the question removed.
//
// ── THE RULE ──
// An own row stamped (`a2a_thread_id`) for a DIFFERENT A2A thread is dropped from an A2A turn, the
// way an own row stamped for a human conversation already is. THIS thread's own rows stay (short
// and full id forms both match). A row with no thread stamp is judged as it always was: kept.
//
// Driven through the real assembler (`assembleContext`) on the measured row shapes, with the real
// migrations on a fixture database. Fingerprints are tokens the test put in the rows, so "did it
// reach the model" is a substring test on the assembled messages.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'x', toolCalls: [], usage: {} }),
  getContextWindow: () => CONTEXT_WINDOW,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));
vi.mock('../vector-search.js', () => ({ vectorSearch: async () => [] }));

import { assembleContext, scopeToA2AThread, scopeToHumanConversation } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';
import type { Message, MessageOrigin } from '@dojo/shared';

const AGENT = 'agent-t161-main';
const PEER = 'agent-t161-peer';
const MODEL = 'model-t161';
const CONTEXT_WINDOW = 200000;
const T0 = Date.parse('2026-10-13T22:10:00Z');

const THREAD_A = 'cd111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THREAD_B = '19f9d59f-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const short = (t: string): string => t.slice(0, 8);

const B_EARLIER_FP = 'THREAD-B-EARLIER-MESSAGE-FINGERPRINT-6e07';
const A_QUESTION_FP = 'THREAD-A-QUESTION-FINGERPRINT-71c2';
const A_TOOL_FP = 'THREAD-A-TOOL-RESULT-FINGERPRINT-5d90';
const B_TRIGGER_FP = 'THREAD-B-TRIGGER-FINGERPRINT-a4e8';
const B_TOOL_FP = 'THREAD-B-TOOL-RESULT-FINGERPRINT-2f13';
const NO_STAMP_FP = 'UNSTAMPED-TOOL-RESULT-FINGERPRINT-9b66';

let tseq = 0;

function insertRow(p: {
  role: 'user' | 'assistant' | 'tool'; content: string; turn: number; threadId?: string | null;
  fromPeer?: boolean; intent?: string; subjectKind?: string | null;
  lane?: 'a2a' | 'events'; originIntent?: string | null; id?: string;
}): void {
  tseq += 1;
  const a2a = p.threadId != null || p.fromPeer;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at,
                           source_agent_id, a2a_thread_id, a2a_intent, subject_kind, origin_intent)
     VALUES (?, ?, ?, ?, ?, ?, 'agent-only', ?, 'live', 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id ?? `t161-${tseq}`, AGENT, p.role, p.lane ?? 'a2a', p.content, p.lane === 'events' ? 'engine-note' : 'a2a', p.turn,
    Math.max(1, Math.ceil(p.content.length / 4)), T0 + tseq * 1000,
    p.fromPeer ? PEER : null, p.threadId ?? null, p.fromPeer ? (p.intent ?? 'QUESTION') : null,
    p.subjectKind ?? (a2a && p.role !== 'user' ? 'a2a_thread' : null), p.originIntent ?? null,
  );
}

const toolUse = (id: string, name: string): string =>
  JSON.stringify([{ type: 'tool_use', id, name, input: { q: 'x' } }]);
const toolResult = (id: string, text: string): string =>
  JSON.stringify([{ type: 'tool_result', tool_use_id: id, is_error: false, content: text }]);

/** Own tool work: a call and its result, both stamped for `threadId` (null: no stamp). */
function ownToolWork(p: { id: string; name: string; fp: string; turn: number; threadId: string | null }): void {
  insertRow({ role: 'assistant', content: toolUse(p.id, p.name), turn: p.turn, threadId: p.threadId, subjectKind: p.threadId ? 'a2a_thread' : 'a2a_thread' });
  insertRow({ role: 'tool', content: toolResult(p.id, p.fp), turn: p.turn, threadId: p.threadId, subjectKind: 'a2a_thread' });
}

function seedAgents(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:8000/v1')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'm', 'M', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, CONTEXT_WINDOW);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'T161Main', 'idle', ?, '{}')").run(AGENT, MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'T161Peer', 'idle', ?, '{}')").run(PEER, MODEL);
}

/** Thread B already had a message in view (the turn's served ask rides the front of the view the
 *  same way in the measured shape); the integrity pass strips a view that opens with tool rows, so
 *  without a user-role row first the other thread's tool work would be shifted off by accident, not
 *  by the scoper. */
function seedEarlierThreadBMessage(): void {
  insertRow({ role: 'user', content: `[A2A:QUESTION thread:${short(THREAD_B)} from T161Peer] ${B_EARLIER_FP}`, turn: 0, threadId: THREAD_B, fromPeer: true });
}

/** Turn 1 answered a QUESTION on thread A with tool work. Turn 2 is woken by an ANSWER on thread B. */
function seedTwoThreadsInARow(): void {
  seedAgents();
  seedEarlierThreadBMessage();
  insertRow({ role: 'user', content: `[A2A:QUESTION thread:${short(THREAD_A)} from T161Peer] ${A_QUESTION_FP}`, turn: 1, threadId: THREAD_A, fromPeer: true });
  ownToolWork({ id: 'call_a1', name: 'load_tool_docs', fp: A_TOOL_FP, turn: 1, threadId: THREAD_A });
  ownToolWork({ id: 'call_a2', name: 'email_search', fp: `${A_TOOL_FP}-2`, turn: 1, threadId: THREAD_A });
  ownToolWork({ id: 'call_a3', name: 'send_to_agent', fp: `${A_TOOL_FP}-3`, turn: 1, threadId: THREAD_A });
  insertRow({ role: 'user', content: `[A2A:ANSWER thread:${short(THREAD_B)} from T161Peer] ${B_TRIGGER_FP}`, turn: 2, threadId: THREAD_B, fromPeer: true, intent: 'ANSWER' });
}

const peerOn = (threadId: string): TurnCounterparty => ({
  kind: 'agent', name: 'T161Peer', relation: 'agent', channel: 'a2a',
  senderId: PEER, threadId, senderIsAgent: true,
});

const textOf = (msgs: Array<{ content: unknown }>): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
  tseq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t161 (i): two A2A threads in a row — the second turn does not carry the first thread\'s tool work', () => {
  it('the trigger and the live thread are in view; the other thread\'s own tool rows are not', async () => {
    seedTwoThreadsInARow();
    const ctx = await assembleContext(AGENT, MODEL, { counterparty: peerOn(short(THREAD_B)) });
    const seen = textOf(ctx.messages);
    expect(seen).toContain(B_TRIGGER_FP);
    expect(seen).toContain(B_EARLIER_FP);
    expect(seen).not.toContain(A_TOOL_FP);
    expect(seen).not.toContain('load_tool_docs');
    expect(seen).not.toContain('email_search');
    expect(ctx.messageEntryIds).not.toContain('lane.empty-context-fallback');
  });

  it('thread B\'s OWN tool rows (written after its trigger) stay beside the trigger', async () => {
    seedTwoThreadsInARow();
    ownToolWork({ id: 'call_b1', name: 'work_open', fp: B_TOOL_FP, turn: 2, threadId: THREAD_B });
    const ctx = await assembleContext(AGENT, MODEL, { counterparty: peerOn(short(THREAD_B)) });
    const seen = textOf(ctx.messages);
    expect(seen).toContain(B_TRIGGER_FP);
    expect(seen).toContain(B_TOOL_FP);
    expect(seen).not.toContain(A_TOOL_FP);
  });

  it('the full-id counterparty form drops the other thread the same way', async () => {
    seedTwoThreadsInARow();
    const ctx = await assembleContext(AGENT, MODEL, { counterparty: peerOn(THREAD_B) });
    const seen = textOf(ctx.messages);
    expect(seen).toContain(B_TRIGGER_FP);
    expect(seen).not.toContain(A_TOOL_FP);
  });

  it('a tool-only remainder cannot starve the turn: the trigger is the first row and survives the integrity pass', async () => {
    seedAgents();
    // Only tool work for the other thread, then the trigger: the shape the integrity pass empties
    // if the trigger were ever lost with the tool rows.
    ownToolWork({ id: 'call_a1', name: 'email_search', fp: A_TOOL_FP, turn: 1, threadId: THREAD_A });
    insertRow({ role: 'user', content: `[A2A:ANSWER thread:${short(THREAD_B)} from T161Peer] ${B_TRIGGER_FP}`, turn: 2, threadId: THREAD_B, fromPeer: true, intent: 'ANSWER' });
    const ctx = await assembleContext(AGENT, MODEL, { counterparty: peerOn(short(THREAD_B)) });
    expect(ctx.messageEntryIds).not.toContain('lane.empty-context-fallback');
    expect(textOf(ctx.messages)).toContain(B_TRIGGER_FP);
    expect(textOf(ctx.messages)).not.toContain(A_TOOL_FP);
  });
});

describe('t161 (ii): a same-thread continuation still sees its own tool work', () => {
  for (const [stampForm, cpForm] of [['full', 'short'], ['short', 'full'], ['full', 'full'], ['short', 'short']] as const) {
    it(`rows stamped with the ${stampForm} id, counterparty carrying the ${cpForm} id`, async () => {
      seedAgents();
      const stamp = stampForm === 'full' ? THREAD_A : short(THREAD_A);
      const cp = cpForm === 'full' ? THREAD_A : short(THREAD_A);
      insertRow({ role: 'user', content: `[A2A:QUESTION thread:${short(THREAD_A)} from T161Peer] ${A_QUESTION_FP}`, turn: 1, threadId: THREAD_A, fromPeer: true });
      ownToolWork({ id: 'call_a1', name: 'email_search', fp: A_TOOL_FP, turn: 1, threadId: stamp });
      const ctx = await assembleContext(AGENT, MODEL, { counterparty: peerOn(cp) });
      const seen = textOf(ctx.messages);
      expect(seen).toContain(A_QUESTION_FP);
      expect(seen).toContain(A_TOOL_FP);
    });
  }
});

describe('t161 (iii): own rows with no thread stamp behave as before', () => {
  it('an unstamped own tool pair on the a2a lane stays in an A2A turn\'s view', async () => {
    seedAgents();
    seedEarlierThreadBMessage();
    ownToolWork({ id: 'call_u1', name: 'email_search', fp: NO_STAMP_FP, turn: 1, threadId: null });
    insertRow({ role: 'user', content: `[A2A:ANSWER thread:${short(THREAD_B)} from T161Peer] ${B_TRIGGER_FP}`, turn: 2, threadId: THREAD_B, fromPeer: true, intent: 'ANSWER' });
    const ctx = await assembleContext(AGENT, MODEL, { counterparty: peerOn(short(THREAD_B)) });
    const seen = textOf(ctx.messages);
    expect(seen).toContain(NO_STAMP_FP);
    expect(seen).toContain(B_TRIGGER_FP);
  });

  it('with no live thread id at all (terminal wake shape) nothing is dropped for its stamp', () => {
    const own = (id: string, threadId: string | null): Message => ({
      id, agentId: AGENT, role: 'tool', content: toolResult(id, 'x'),
      tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-10-13 22:10:00',
      origin: selfOrigin(threadId),
    } as Message);
    const kept = scopeToA2AThread([own('stamped-a', THREAD_A), own('unstamped', null)], null).map((m) => m.id);
    expect(kept).toEqual(['stamped-a', 'unstamped']);
  });
});

function selfOrigin(threadId: string | null): MessageOrigin {
  return { kind: 'self', relation: 'agent', channel: 'a2a', senderName: null, senderId: null, threadId, intent: null, authorized: true };
}

describe('t161 (iv): the human-conversation and engine scopers are unchanged', () => {
  const stampedToThread = (id: string): Message => ({
    id, agentId: AGENT, role: 'tool', content: toolResult(id, 'x'),
    tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-10-13 22:10:00',
    origin: selfOrigin(THREAD_A), subjectKind: 'a2a_thread',
  } as unknown as Message);

  it('the human scoper keeps an own row stamped for an A2A thread (it only drops a person\'s other conversation)', () => {
    const cp: TurnCounterparty = { kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
    expect(scopeToHumanConversation([stampedToThread('x')], cp, 'conv-1', null).map((m) => m.id)).toEqual(['x']);
  });

  it('an engine turn still keeps own rows stamped for an A2A thread', async () => {
    seedAgents();
    insertRow({ id: 't161-engine-trigger', role: 'user', lane: 'events', originIntent: 'scheduler', content: 'A scheduled task fired: ENGINE-TRIGGER-FINGERPRINT-3c19', turn: 0 });
    ownToolWork({ id: 'call_a1', name: 'email_search', fp: A_TOOL_FP, turn: 1, threadId: THREAD_A });
    const ctx = await assembleContext(AGENT, MODEL, { isEngineTurn: true, engineEventKeepFullId: 't161-engine-trigger' });
    const seen = textOf(ctx.messages);
    expect(seen).toContain('ENGINE-TRIGGER-FINGERPRINT-3c19');
    expect(seen).toContain(A_TOOL_FP);
  });
});
