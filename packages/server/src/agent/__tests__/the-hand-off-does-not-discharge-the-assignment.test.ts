// UX-REPAIR ROUND 11 · T43 leg (c), THROUGH THE DOOR — the transport half.
//
// The spine half (`repointJoinPieceToHandOff` and every refusal it makes) is
// `work/__tests__/a-hand-off-repoints-the-join-edge.test.ts`. This file drives the REAL
// `deliverA2AMessage` and pins the three things only the transport can answer:
//
//   1. the DECLARATION — `send_to_agent` advertises `hands_off_thread`, optional, so a model
//      that passes it is not met with the engine's unknown-argument warning (which is what
//      W30 measured when it tried the undeclared form);
//   2. the DECISION MOMENT — the ASSIGN footer, the one text the assignee reads while
//      deciding what to do with the work, says the affordance exists;
//   3. the REPLY that does NOT settle — kelly's hand-off note leaves her piece outstanding
//      and moves the edge onto kevin's thread, while a plain ANSWER on the same shape settles
//      it exactly as it does today (the 341-case flow, byte-identical).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Same measured reason as the sibling join tests: the first clause in a file that imports
// `a2a-transport.js` pays the migration chain plus that module's whole import graph.
vi.setConfig({ testTimeout: 20_000 });

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-a2a-handoff-test', 'dojo.db'),
  };
});

const broadcast = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => {
    const v = new Float32Array(8);
    for (let i = 0; i < 8; i++) v[i] = i + 1;
    return v;
  }),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false, isPMAgent: () => false, isHealerAgent: () => false,
  isDreamerAgent: () => false, getOwnerName: () => 'Owner', getPrimaryAgentId: () => 'primary',
}));
const handleMessage = vi.fn(async () => {});
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));
vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: vi.fn(() => 'conv-1'),
}));

/** Every inbound body the transport composed, in order — this is where the footer lives. */
const persistedBodies: string[] = [];
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertMessageIfAbsent: vi.fn((m: { content?: string }) => {
    persistedBodies.push(m.content ?? '');
    return {
      seq: persistedBodies.length, id: 'stub', lane: 'a2a', displayKind: 'a2a',
      displayTier: 'agent-only', tokenCount: 1,
      createdAt: '2026-08-15 00:00:00', sentAt: Date.now(),
    };
  }),
}));

/** The assignee's Key-1 close request. A hand-off must NOT file one — the work is not done.
 *  Mocked WITHOUT `importOriginal`: `tracker/tools.js` drags in the Google auth graph, which
 *  reaches back into `gateway/ws.js` while this file's own mock of it is still initializing.
 *  `a2a-transport.ts` imports exactly one name from this module, dynamically, so a bare
 *  factory is the whole contract. */
const fileAssignDeliverableCloseRequest = vi.fn(async () => {});
vi.mock('../../tracker/tools.js', () => ({ fileAssignDeliverableCloseRequest }));

import { runMigrations } from '../../db/migrations.js';
import {
  openAsk, claimAsk, openDelegationJoin, findJoinChildByThread, joinState, THREAD_HOP_CAP,
} from '../../work/store.js';
// `agent/tools/definitions.ts` is deliberately NOT imported here: it pulls the Google and
// Microsoft definition modules, whose graph reaches `gateway/ws.js` while this file's mock of
// it is still initializing. The declaration clauses live beside the declaration, in
// `agent/tools/__tests__/the-hand-off-argument-is-declared.test.ts`.

const OWNER_AGENT = 'behaviorbot';
const PUNTER = 'kelly';
const DOER = 'kevin';
const T_ASSIGN = 'thread-aaaaaaaa-1111';
const T_HANDOFF = 'thread-bbbbbbbb-2222';

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

async function deliver(over: Record<string, unknown>) {
  const { deliverA2AMessage } = await import('../a2a-transport.js');
  return deliverA2AMessage({
    intent: 'ANSWER' as never,
    threadId: T_ASSIGN,
    requiresResponse: false,
    payload: 'I have passed this to Kevin, he has the web tools for it.',
    toAgent: OWNER_AGENT,
    fromAgent: PUNTER,
    ...over,
  } as never);
}

/** The state the incident opens in: BehaviorBot's ask, delegated to kelly on T_ASSIGN. */
function seedJoin(opts: { hopCount?: number } = {}): { parent: string; childId: string } {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES ('m-ask', ?, 'user', 'compare the two options for me', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
  ).run(OWNER_AGENT, Date.now());
  const parent = openAsk({
    agentId: OWNER_AGENT, messageId: 'm-ask', conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now(), title: 'compare the two options',
  });
  claimAsk(parent, OWNER_AGENT);
  openDelegationJoin({
    parentWorkId: parent, agentId: OWNER_AGENT, replyConversationId: 'conv-1',
    ttlAt: Date.now() + 60 * 60_000,
    threads: [{ threadId: T_ASSIGN, assigneeAgent: PUNTER, intent: 'ASSIGN', hopCount: opts.hopCount ?? 1 }],
  });
  return { parent, childId: findJoinChildByThread(OWNER_AGENT, T_ASSIGN)!.id };
}

/** Kelly's own ASSIGN to kevin — the send whose thread id the hand-off argument names. It is
 *  seeded directly because this fixture stubs the message writer. */
function seedHandOffSend(over: Record<string, unknown> = {}): void {
  const r = {
    id: `m-${Math.random().toString(36).slice(2)}`, agent_id: DOER, role: 'user',
    content: '[A2A:ASSIGN thread:bbbbbbbb from:Kelly] please research the two options',
    lane: 'a2a', source_agent_id: PUNTER, a2a_thread_id: T_HANDOFF, a2a_intent: 'ASSIGN',
    created_at: Date.now(), ...over,
  };
  const cols = Object.keys(r);
  mockDb.current!.prepare(
    `INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(r);
}

beforeEach(() => {
  persistedBodies.length = 0;
  handleMessage.mockClear();
  fileAssignDeliverableCloseRequest.mockClear();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'BehaviorBot', 'idle', '1970-01-01'), (?, 'Kelly', 'idle', '1970-01-01'),
            (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(OWNER_AGENT, PUNTER, DOER);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(OWNER_AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 — THE DECISION MOMENT: the ASSIGN footer
// ════════════════════════════════════════════════════════════════════════════════

describe('the assign-thread footer advertises the affordance', () => {
  it('an ASSIGN tells its receiver how to hand the work on', async () => {
    const r = await deliver({
      intent: 'ASSIGN', threadId: '', toAgent: PUNTER, fromAgent: OWNER_AGENT,
      requiresResponse: true, payload: 'research the two options and report back',
    });
    expect(r.delivered).toBe(true);
    const body = persistedBodies.at(-1)!;
    expect(body).toContain('hands_off_thread');
    expect(body).toContain('FAIL');
    // The pre-existing footer is untouched, in the same message.
    expect(body).toContain('Reply on this thread, use send_to_agent with thread_id=');
  });

  it('CONTROL — a closed-thread ANSWER footer is untouched, byte for byte', async () => {
    const r = await deliver({
      intent: 'ANSWER', threadId: '', toAgent: PUNTER, fromAgent: OWNER_AGENT,
      requiresResponse: false, payload: 'here you go',
    });
    expect(r.delivered).toBe(true);
    const body = persistedBodies.at(-1)!;
    expect(body).toContain('Closed, use the content above (do NOT reply on this thread).');
    expect(body).not.toContain('hands_off_thread');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — THE REPLY THAT DOES NOT SETTLE
// ════════════════════════════════════════════════════════════════════════════════

describe('a declared hand-off does not discharge the assignment', () => {
  it('THE FIX — the piece stays outstanding and the edge moves to the new thread', async () => {
    const { parent, childId } = seedJoin();
    seedHandOffSend();

    const r = await deliver({ handsOffThread: T_HANDOFF });

    expect(r.delivered).toBe(true);
    expect(r.handOff?.applied).toBe(true);
    const after = workRow(childId);
    expect(after.state).toBe('open');
    expect(after.root_id).toBe(T_HANDOFF);
    expect(after.assignee_agent).toBe(DOER);
    expect(after.agent_id).toBe(PUNTER);
    // The countdown never moved: the join still owes one piece.
    expect(joinState(parent)!.landed).toBe(0);
    expect(joinState(parent)!.complete).toBe(false);
    // …and the punter's own assignment task is NOT filed for close-out.
    expect(fileAssignDeliverableCloseRequest).not.toHaveBeenCalled();
  });

  it('the sender is TOLD what happened, at the moment it happened', async () => {
    seedJoin();
    seedHandOffSend();
    const r = await deliver({ handsOffThread: T_HANDOFF });
    expect(r.handOff?.message).toBeTruthy();
    expect(r.handOff!.message).toContain('Kevin');
  });

  it('CONTROL — the SAME reply without the argument settles the piece, exactly as today', async () => {
    const { parent, childId } = seedJoin();
    seedHandOffSend();

    const r = await deliver({});

    expect(r.delivered).toBe(true);
    expect(r.handOff).toBeUndefined();
    expect(workRow(childId).state).toBe('done');
    expect(joinState(parent)!.landed).toBe(1);
    expect(joinState(parent)!.complete).toBe(true);
  });

  it('CONTROL — the FAIL path is untouched by the argument being present', async () => {
    const { parent, childId } = seedJoin();
    seedHandOffSend();
    const r = await deliver({ intent: 'FAIL', payload: 'I cannot do this one.' });
    expect(r.delivered).toBe(true);
    expect(workRow(childId).state).toBe('failed');
    expect(joinState(parent)!.complete).toBe(true);
  });

  it('HOP CAP — past the cap the chain stops and the refusal names FAIL', async () => {
    // CAP - 1, not CAP: at the cap the TRANSPORT's own gate refuses the message outright
    // (HOP_LIMIT_EXCEEDED) and there is no reply to hand off. The interesting state is the
    // last deliverable hop — this delivery bumps the count to the cap, so the hand-off would
    // be hop CAP + 1 and the chain stops.
    const { childId } = seedJoin({ hopCount: THREAD_HOP_CAP - 1 });
    seedHandOffSend();

    const r = await deliver({ handsOffThread: T_HANDOFF });

    expect(r.handOff?.applied).toBe(false);
    expect(r.handOff!.message).toContain('FAIL');
    // The refusal is not a hold: the reply still lands, and the piece settles as it would
    // have without the argument. A refused hand-off must not strand the owner's ask.
    expect(workRow(childId).root_id).toBe(T_ASSIGN);
    expect(workRow(childId).state).toBe('done');
  });

  it('A THREAD THE SENDER NEVER SENT ON is refused — the edge cannot be aimed anywhere', async () => {
    const { childId } = seedJoin();
    // No `seedHandOffSend()`: kelly never opened T_HANDOFF.
    const r = await deliver({ handsOffThread: T_HANDOFF });
    expect(r.handOff?.applied).toBe(false);
    expect(workRow(childId).root_id).toBe(T_ASSIGN);
  });

  it('A NON-ASSIGNEE passing the argument changes nothing', async () => {
    const { childId } = seedJoin();
    seedHandOffSend({ source_agent_id: DOER, a2a_thread_id: 'thread-dddddddd-4444' });
    const r = await deliver({ handsOffThread: 'thread-dddddddd-4444', fromAgent: DOER });
    expect(r.handOff?.applied).toBe(false);
    expect(workRow(childId).root_id).toBe(T_ASSIGN);
  });

  it('with NO join at all the argument is a no-op that says so, and the reply stands', async () => {
    seedHandOffSend();
    const r = await deliver({ handsOffThread: T_HANDOFF });
    expect(r.delivered).toBe(true);
    expect(r.handOff?.applied).toBe(false);
    expect(r.handOff!.message).toBeTruthy();
  });
});
