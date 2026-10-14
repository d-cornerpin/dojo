// ════════════════════════════════════════════════════════════════════════════════════════
// t159 I (v3.3.3 run 7) — A MANAGER-ASSIGNED TURN'S OWN ASK IS NEVER FILTERED OUT OF ITS VIEW.
//
// THE MEASURED SHAPE (S1 variant B, the dev box's own rows and log, 2026-10-14):
//   * a worker agent was assigned a job by its manager over an A2A thread. The ASSIGN is the only
//     user-role row of the thread; everything after it is the worker's own tool_use / tool_result rows;
//   * its long turn kept the whole run in view (a ~400-message tail) until a pressure compaction folded
//     rows 132124-132345 — the ASSIGN among them — into a leaf summary (22:54:42);
//   * the very next assembly: the tail (54K tokens of valid work) held no user-role row, so the integrity
//     pass's "must start with role=user" shift stripped ALL of it, the zero-messages guard fired
//     (`Context assembly produced 0 messages after filtering`, ERROR) and pulled the raw last user row
//     out of the DB with no label. Eight calls in a row (22:54:45 - 22:54:59), 7 messages each time
//     where there had been 409.
// The owner's served message already survives exactly this (`memory/served-ask.ts`, t145 R4 / t158 B:
// re-emitted at the front of the live tail, labelled). The A2A ask a worker is working on was never
// among the served messages. Now it is.
//
// The fixture reproduces the shape without a compaction: a tight window trims the front of the tail,
// which takes the ASSIGN with it — the same absence, reached the other way.
// ════════════════════════════════════════════════════════════════════════════════════════
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

const loggerErrorSpy = vi.fn();
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
  }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { servedOwnerMessageIds, servedAssignMessageIds } from '../served-ask.js';
import { recordA2AReply } from '../../agent/a2a-replies.js';
import { assembleContext } from '../assembler.js';

const AGENT = 'worker';
const PEER = 'manager';
const THREAD = 'f00dcafe-1111-2222-3333-444455556666';
const ASK = 'Audit the ledger chain and report every wrong line.';
const LABEL = '(the message this work is answering)';
const ZERO_MESSAGES = 'Context assembly produced 0 messages after filtering';

let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  return db;
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(AGENT);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Manager', 'm', 'idle', '{}', 'sensei')").run(PEER);
  loggerErrorSpy.mockClear();
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

/** The ASSIGN, then `pairs` rounds of the worker's own tool work, each padded so a 40K window cannot hold them all. */
function assignedJob(pairs: number): void {
  insertMessage({
    id: 'assign-row', agentId: AGENT, role: 'user', lane: 'a2a', content: `[A2A:ASSIGN thread:f00dcafe from:Manager] ${ASK}`,
    sourceAgentId: PEER, a2aThreadId: THREAD, a2aIntent: 'ASSIGN',
  });
  for (let i = 0; i < pairs; i++) {
    insertMessage({
      id: `call-${i}`, agentId: AGENT, role: 'assistant', turnNumber: 2, subjectKind: 'a2a_thread', a2aThreadId: THREAD,
      content: JSON.stringify([{ type: 'tool_use', id: `tc-${i}`, name: 'file_read', input: { path: `/ledger/page-${i}.txt` } }]),
    });
    insertMessage({
      id: `res-${i}`, agentId: AGENT, role: 'tool', turnNumber: 2,
      content: JSON.stringify([{ type: 'tool_result', tool_use_id: `tc-${i}`, content: `page ${i} ${'pad '.repeat(400)}` }]),
    });
  }
}

/** The running turn: an A2A turn serving the unreplied ASSIGN (the bag's kind is what preflight records). */
function runningA2ATurn(): void {
  const bag = openTurnContext(AGENT);
  bag.kind = 'a2a';
}

const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const wire = async (): Promise<{ text: string; messages: Array<{ role: string; content: unknown }> }> => {
  const ctx = await assembleContext(AGENT, 'm');
  return { text: JSON.stringify(ctx.messages), messages: ctx.messages as Array<{ role: string; content: unknown }> };
};
const zeroMessagesLogged = (): boolean => loggerErrorSpy.mock.calls.some((c) => String(c[0]).startsWith(ZERO_MESSAGES));

describe('t159 I: the assigned ask is served like the owner\'s message', () => {
  it('THE MEASURED SHAPE: the ASSIGN is behind the boundary, the tail holds only tool rows — the view keeps the ASSIGN, labelled, and the work in view', async () => {
    assignedJob(40);
    // Positive control: with no turn running, the shape really is the empty-view shape (the ASSIGN is out of the tail).
    const control = await wire();
    expect(zeroMessagesLogged(), 'control: the shape reproduces the zero-messages guard').toBe(true);
    expect(control.messages.length).toBeLessThan(10);
    loggerErrorSpy.mockClear();

    runningA2ATurn();
    const { text, messages } = await wire();
    expect(zeroMessagesLogged(), 'no zero-messages error').toBe(false);
    expect(occurrences(text, ASK), 'the ask, once').toBe(1);
    expect(occurrences(text, LABEL), 'labelled as the message this work is answering, once').toBe(1);
    expect(text).toContain('page 39');                 // the newest work is in view...
    expect(messages.length, '...and so is the rest of the tail, not 7 messages out of hundreds').toBeGreaterThan(20);
    // It leads the live view.
    const first = JSON.stringify(messages[0]);
    expect(first).toContain(ASK);
    expect(messages[0].role).toBe('user');
  });

  it('served ids: the unreplied ASSIGN while an A2A turn runs; nothing once it is answered, nothing on any other kind of turn, nothing with no turn', () => {
    assignedJob(2);
    expect(servedAssignMessageIds(AGENT), 'no turn running').toEqual([]);
    const bag = openTurnContext(AGENT);
    expect(servedAssignMessageIds(AGENT), 'a turn of no a2a kind').toEqual([]);
    bag.kind = 'a2a';
    expect(servedAssignMessageIds(AGENT)).toEqual(['assign-row']);
    expect(servedOwnerMessageIds(AGENT), 'the owner\'s served ids — what a park carries — are untouched').toEqual([]);
    recordA2AReply({ assignMessageId: 'assign-row', agentId: AGENT, threadId: THREAD, replyIntent: 'ANSWER' });
    expect(servedAssignMessageIds(AGENT), 'answered: no longer owed, no longer re-shown').toEqual([]);
  });

  it('the LAST RESORT stays, and when it fires its row wears the standard label (instant and subject), never bare', async () => {
    assignedJob(40);   // no turn running: nothing is served, the tail is all tool rows, the guard fires
    const { messages } = await wire();
    expect(zeroMessagesLogged()).toBe(true);
    const recovered = JSON.stringify(messages[0]);
    expect(recovered).toContain(ASK);
    expect(recovered, 'the label: [<instant> · <subject>]').toMatch(/\[[^\]]* · [^\]]+\]/);
  });
});
