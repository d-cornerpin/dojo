// PHASE-1 T6 cluster 1 — the obligation reads, on one table and one lane column.
//
// These are the behaviour-critical queries: "which human conversations still owe a reply"
// and "which engine event is pending". Before T4 the protection was PHYSICAL — peer A2A
// traffic lived in a second table, so `SELECT ... FROM messages` could not see it and the
// only exclusion these queries needed was `origin_kind != 'engine'`. T4 folded that traffic
// into `messages`, so the separation is now a COLUMN, and T6 re-points the predicates onto
// it. Every assertion below is the requirement that separation encoded, expressed against
// the surface a human or a turn actually sees — so the re-point cannot quietly change WHICH
// rows the agent believes it owes a reply to.
//
// Runs against the REAL migration chain in an in-memory database (the pattern
// message-store.test.ts and lane-readers.test.ts use): the subject is what the readers see,
// and a hand-built fixture would let a wrong predicate pass unnoticed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

// The agent-notice path posts a real row on expiry; keep it out of the fixture's way.
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));

import { insertMessage, insertEngineEvent } from '../../../memory/message-store.js';
import {
  getWaitingHumanConversations,
  getPendingEngineEvent,
  findUnservedTerminalWake,
  quarantineWaitingConversation,
} from '../counterparty.js';
import { runMigrations } from '../../../db/migrations.js';
import { claimAsk } from '../../../work/store.js';

const AGENT = 'agent-obligation';
const PEER = 'agent-obligation-peer';

/** Every eligibility read is scoped to the session boundary, so the fixture needs one. */
const SESSION_START = '2000-01-01 00:00:00';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const ins = mockDb.current.prepare(
    "INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', ?)",
  );
  ins.run(AGENT, 'Obligation', SESSION_START);
  ins.run(PEER, 'Obligation Peer', SESSION_START);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** An authorized human ask over a real channel — the ONLY shape that owes a reply. */
function humanAsk(content: string, sender = '+15550001111'): string {
  return insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', channel: 'imessage',
    senderId: sender, authorized: true, content,
    inboundMeta: JSON.stringify({ channel: 'imessage', sender, authorized: true }),
  }).id;
}

describe('the waiting set is the OWNER lane, and nothing else', () => {
  it('an authorized human ask is a waiting conversation', () => {
    humanAsk('can you pull the burnwood ledger?');
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].oldest.content).toContain('burnwood ledger');
  });

  it('an ENGINE event never counts as a human conversation the agent owes a reply', () => {
    humanAsk('the real ask');
    insertEngineEvent({
      work: null,
      agentId: AGENT, content: '[SOURCE: scheduler] your 3pm reminder fired',
      originIntent: 'scheduler',
    });
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].oldest.content).toBe('the real ask');
  });

  it('an inbound PEER A2A message never counts as a human conversation', () => {
    humanAsk('the real ask');
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a',
      sourceAgentId: PEER, a2aThreadId: 'thr-1', a2aIntent: 'QUESTION', a2aRequiresResponse: true,
      content: '[A2A:QUESTION thread:thr-1 from:Obligation Peer] who owns the ledger?',
    });
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].oldest.content).toBe('the real ask');
  });

  it("the agent's OWN a2a output never counts (it is not an inbound ask at all)", () => {
    insertMessage({
      agentId: AGENT, role: 'assistant', lane: 'a2a',
      content: 'on it, checking the ledger now',
    });
    expect(getWaitingHumanConversations(AGENT)).toHaveLength(0);
  });

  it('an UNAUTHORIZED inbound is awareness, never an obligation', () => {
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'owner', channel: 'email',
      senderId: 'noreply@marketing.example', authorized: false,
      content: 'your weekly digest is ready',
      inboundMeta: JSON.stringify({ channel: 'email', sender: 'noreply@marketing.example', authorized: false }),
    });
    expect(getWaitingHumanConversations(AGENT)).toHaveLength(0);
  });

  // PHASE-2 T3: the requirement is unchanged and the fixture had to move with the
  // mechanism. "Claimed" used to be faked by stamping conv_key on the message; it is a
  // STATE on the ask now, so the fixture claims the ask. A fixture still writing conv_key
  // would have gone on passing while asserting nothing.
  it('a CLAIMED ask leaves the waiting set; an unclaimed sibling stays', () => {
    humanAsk('first ask');
    humanAsk('second ask', '+15550002222');
    const head = getWaitingHumanConversations(AGENT)[0];
    expect(head.oldest.content).toBe('first ask');
    expect(claimAsk(head.workId, AGENT).kind).toBe('applied');
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].oldest.content).toBe('second ask');
  });

  it('waiting conversations come back OLDEST-first (FIFO), across conversations', () => {
    humanAsk('older, from A', '+15550001111');
    humanAsk('newer, from B', '+15550002222');
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting.map((w) => w.oldest.content)).toEqual(['older, from A', 'newer, from B']);
  });

  // ── THE INCIDENT THIS PREDICATE EXISTS TO PREVENT (inv 2, the C1 comment in
  // counterparty.ts) ──
  // The narrowing lives in the WHERE, not in the JS filter below it, and the reason is
  // the LIMIT: engine steers, tracker/scheduler notices and inbound A2A are ALL
  // `role='user'`, so without the lane predicate they consume the whole window and a
  // human ask BEHIND the oldest 50 non-owner rows falls out and is PERMANENTLY
  // forgotten. The per-row authorization gate cannot save it — the row never reaches it.
  // This is the assertion that fails if the lane predicate is dropped from the SQL.
  it('a human ask survives a flood of engine rows — the LIMIT window is owner-lane only', () => {
    // The window is ASC + LIMIT 50, so the ask at RISK is one that arrives BEHIND a
    // backlog of non-owner `role='user'` rows — exactly the shape a busy tracker or a
    // fan-out burst produces.
    for (let i = 0; i < 60; i++) {
      insertEngineEvent({
        work: null,
        agentId: AGENT, content: `[SOURCE: tracker] notice ${i}`, originIntent: 'tracker',
      });
    }
    humanAsk('the ask that must not be forgotten');
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].oldest.content).toBe('the ask that must not be forgotten');
  });

  it('quarantine hides exactly one conversation and leaves the other waiting', () => {
    humanAsk('poisoned conversation', '+15550001111');
    humanAsk('healthy conversation', '+15550002222');
    const key = getWaitingHumanConversations(AGENT)[0].key;
    expect(quarantineWaitingConversation(AGENT, key)).toBe(1);
    const waiting = getWaitingHumanConversations(AGENT);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].oldest.content).toBe('healthy conversation');
  });
});

describe('the engine-event queue is the EVENTS lane, and it is one keyspace', () => {
  it('a queued engine event is pending, and carries its own row identity', () => {
    const ev = insertEngineEvent({
      work: null,
      agentId: AGENT, content: '[SOURCE: tracker] task 7 needs a status',
      originIntent: 'tracker',
    });
    const pending = getPendingEngineEvent(AGENT);
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(ev.id);
    expect(pending!.originIntent).toBe('tracker');
  });

  it('an OWNER-lane user row is never picked up as an engine event', () => {
    humanAsk('please do the thing');
    expect(getPendingEngineEvent(AGENT)).toBeNull();
  });

  it('non-deliverable intents (thrash_gate / hint / system) never drive a turn', () => {
    insertEngineEvent({ agentId: AGENT, content: '[Engine hint] slow down', originIntent: 'hint', work: null });
    insertEngineEvent({ agentId: AGENT, content: '[Engine] thrash gate', originIntent: 'thrash_gate', work: null });
    expect(getPendingEngineEvent(AGENT)).toBeNull();
  });

  it('the pending pick is INSERTION-ordered — the oldest queued event goes first', () => {
    // Both rows land in the same clock second, which is the common case for a scheduler
    // tick: the pick must fall back on the insertion key, never on a second-granular
    // TEXT clock that cannot separate them.
    const first = insertEngineEvent({ agentId: AGENT, content: '[SOURCE: scheduler] first', originIntent: 'scheduler', work: null });
    insertEngineEvent({ agentId: AGENT, content: '[SOURCE: scheduler] second', originIntent: 'scheduler', work: null });
    expect(getPendingEngineEvent(AGENT)!.id).toBe(first.id);
  });

  it('THE ROWID CONTRACT: the pending event\'s rowid addresses a row in `messages`', () => {
    // The pick returns a rowid that the loop's claim UPDATE then addresses. rowid is
    // PER-TABLE: a pick that reports a foreign table's rowid claims the wrong row, or
    // no row, and the event re-delivers forever. This asserts the keyspace, not the value.
    const ev = insertEngineEvent({ agentId: AGENT, content: '[SOURCE: healer] check in', originIntent: 'healer', work: null });
    const pending = getPendingEngineEvent(AGENT)!;
    const byRowid = mockDb.current!.prepare('SELECT id FROM messages WHERE rowid = ?')
      .get(pending.rowid) as { id: string } | undefined;
    expect(byRowid?.id).toBe(ev.id);
  });
});

describe('the terminal-wake finder reads one lane and one keyspace', () => {
  it('finds an unserved DELIVERABLE peer row, addressed in `messages`', () => {
    const wake = insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a',
      sourceAgentId: PEER, a2aThreadId: 'thr-9', a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true,
      content: '[A2A:DELIVERABLE thread:thr-9 from:Obligation Peer] ledger attached',
    });
    const found = findUnservedTerminalWake(AGENT);
    expect(found).not.toBeNull();
    const byRowid = mockDb.current!.prepare('SELECT id FROM messages WHERE rowid = ?')
      .get(found!.rowid) as { id: string } | undefined;
    expect(byRowid?.id).toBe(wake.id);
  });

  // PHASE-2 T4: "unserved" is the SERVE edge now, not a fake conversation key. Both
  // directions, because the rekey could be wrong either way: a served row must disappear from
  // the finder, and the OLD claim (conv_key='a2a') must no longer hide an unserved one.
  it('T4: a row SERVED by a turn is no longer a terminal wake', () => {
    const wake = insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a',
      sourceAgentId: PEER, a2aThreadId: 'thr-served', a2aIntent: 'ANSWER', a2aRequiresResponse: true,
      content: '[A2A:ANSWER thread:thr-served from:Obligation Peer] the code is 4417',
    });
    expect(findUnservedTerminalWake(AGENT)).not.toBeNull();
    mockDb.current!.prepare('UPDATE messages SET served_by_turn = 12 WHERE id = ?').run(wake.id);
    expect(findUnservedTerminalWake(AGENT)).toBeNull();
  });

  // ── RETIRED DELIBERATELY AND RE-EXPRESSED STRONGER (PHASE-2 T10I) ──
  // T4's control wrote the retired sentinel (`UPDATE messages SET conv_key = 'a2a'`) and
  // asserted the finder still returned the wake. Migration `148` DROPPED `messages.conv_key`,
  // so that UPDATE would now throw and this control would die of a missing column rather than
  // prove anything — the failure mode PINNED §12 named and asked to be handled deliberately
  // rather than discovered.
  //
  // The requirement it protected is that the OLD claim cannot hide an unserved wake, and after
  // the drop that is true by CONSTRUCTION: the sentinel is unwritable because the column is
  // gone. Asserted at the schema level, which no source scan could establish — plus the
  // positive half, because "the column is gone" must not become a clause that passes while the
  // finder has quietly stopped finding anything.
  it('T4 NEGATIVE CONTROL, re-expressed: the retired sentinel is UNREPRESENTABLE, and the finder still finds', () => {
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a',
      sourceAgentId: PEER, a2aThreadId: 'thr-sentinel', a2aIntent: 'COMPLETE', a2aRequiresResponse: true,
      content: '[A2A:COMPLETE thread:thr-sentinel from:Obligation Peer] done',
    });
    expect(mockDb.current!.prepare(
      "SELECT count(*) AS c FROM pragma_table_info('messages') WHERE name = 'conv_key'",
    ).get()).toEqual({ c: 0 });
    expect(findUnservedTerminalWake(AGENT)).not.toBeNull();
  });

  it('an ENGINE row is never a terminal wake', () => {
    insertEngineEvent({ agentId: AGENT, content: '[SOURCE: scheduler] fired', originIntent: 'scheduler', work: null });
    expect(findUnservedTerminalWake(AGENT)).toBeNull();
  });
});
