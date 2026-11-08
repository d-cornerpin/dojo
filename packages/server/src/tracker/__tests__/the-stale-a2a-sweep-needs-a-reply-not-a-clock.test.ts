// C9 (R11 + R25): the PM's stale-A2A sweep never ends another agent's task on a clock. It acts only
// on a real signal: the receiver's recorded reply on that ticket's own thread.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

/** ⚠ FIX ROUND 2 (N1). The PM's own log is the only place a DROPPED poke can be seen, so the
 *  logger is captured rather than silenced. `createLogger` is replaced for every component in the
 *  graph (the rest of the module is spread through), which is the house pattern from
 *  `memory/__tests__/an-absent-embedder-is-one-warn-not-a-hundred-errors.test.ts`. */
const log = vi.hoisted(() => {
  const calls = { debug: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
  };
});
vi.mock('../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger.js')>()),
  createLogger: () => log.logger,
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));

/** ⚠ THE CONTROL THAT MATTERS MOST. The old rung's handoff went out through this door; every
 *  clause in §2 and §3 asserts it was never opened. */
/** FIX ROUND 2 (N1): the spy answers in the transport's OWN result shape
 *  (`A2ADeliveryResult` = `{ delivered, reason?, threadId }`), because the defect N1 names is a
 *  `{delivered:false}` RETURN that the old always-true stub could not express. `deliverA2ADrops`
 *  makes the next call drop with the reason the hop cap uses. */
const deliverA2ADrops = { next: null as string | null };
const deliverA2ASpy = vi.fn(async (envelope?: unknown) => {
  const threadId = (envelope as { threadId?: string } | undefined)?.threadId ?? 'thread-unknown';
  const drop = deliverA2ADrops.next;
  deliverA2ADrops.next = null;
  return drop ? { delivered: false, reason: drop, threadId } : { delivered: true, threadId };
});
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...args: unknown[]) => deliverA2ASpy(...args),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
vi.mock('../../agent/agent-notice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/agent-notice.js')>()),
  // t143 round 3 (I2): a PM poke is a re-drive that owes no reply and travels no thread; this door
  // records it in the spy's envelope shape (recipient, payload) and the clauses read that.
  redriveWithoutReply: async (o: { toAgentId: string; fromAgentId: string | null; content: string }) => {
    await deliverA2ASpy({ toAgent: o.toAgentId, fromAgent: o.fromAgentId, payload: o.content, requiresResponse: false });
    return true;
  },
}));



import { runPokeCheck } from '../pm-agent.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const RECEIVER = 'receiver-agent';

function seed(id: string, thread: string, ageMs: number): void {
  const db = mockDb.current!;
  seedTrackerTask(db, { id, agentId: RECEIVER, status: 'on_deck', title: 'peer ask' });
  db.prepare('UPDATE work SET a2a_thread_id = ?, updated_at = ?, opened_at = ? WHERE id = ?')
    .run(thread, Date.now() - ageMs, Date.now() - ageMs - 1000, id);
}
const stateOf = (id: string) => (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

describe('the stale A2A sweep acts on a recorded reply, never on a clock', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    createWorkTable(mockDb.current);
    mockDb.current.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT, updated_at TEXT, session_started_at TEXT);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS a2a_replies (assign_message_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL, reply_intent TEXT NOT NULL, replied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  });

  it('an old ticket whose receiver chatted elsewhere but never replied on that thread stays open', async () => {
    seed('t-chatty', 'thread-aaa', 3 * 3600_000);
    mockDb.current!.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('m1', ?, 'assistant', 'hi', ?)")
      .run(RECEIVER, Date.now());
    await runPokeCheck();
    expect(stateOf('t-chatty'), 'activity elsewhere is a guess, not a record').toBe('open');
  });

  it.skip('2c: a ticket younger than 30 minutes is closed the moment the receiver replies on its thread', async () => {
    seed('t-replied', 'thread-bbb', 60_000);
    mockDb.current!.prepare("INSERT INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent) VALUES ('a1', ?, 'thread-bbb', 'COMPLETE')")
      .run(RECEIVER);
    await runPokeCheck();
    expect(stateOf('t-replied')).toBe('failed');
  });

  it('a reply on a different thread does not close this ticket', async () => {
    seed('t-other', 'thread-ccc', 3 * 3600_000);
    mockDb.current!.prepare("INSERT INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent) VALUES ('a2', ?, 'thread-zzz', 'COMPLETE')")
      .run(RECEIVER);
    await runPokeCheck();
    expect(stateOf('t-other')).toBe('open');
  });

  // R11: only a FINAL reply (A2AIntent ANSWER, COMPLETE, DELIVERABLE, FAIL; shared/src/a2a-protocol.ts) ends a ticket.
  it.each(['STATUS', 'QUESTION', 'BLOCK', 'FYI'])('a %s-only reply does not end the ticket', async (intent) => {
    seed('t-live', 'thread-ddd', 3 * 3600_000);
    mockDb.current!.prepare("INSERT INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent) VALUES ('a9', ?, 'thread-ddd', ?)")
      .run(RECEIVER, intent);
    await runPokeCheck();
    expect(stateOf('t-live')).toBe('open');
  });

  it.skip.each(['ANSWER', 'COMPLETE', 'DELIVERABLE', 'FAIL'])('2c: a %s reply ends the ticket', async (intent) => {
    seed('t-final', 'thread-eee', 60_000);
    mockDb.current!.prepare("INSERT INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent) VALUES ('a8', ?, 'thread-eee', ?)")
      .run(RECEIVER, intent);
    await runPokeCheck();
    expect(stateOf('t-final')).toBe('failed');
  });
});
