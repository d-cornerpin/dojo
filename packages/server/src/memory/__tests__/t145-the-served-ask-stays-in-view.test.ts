// ════════════════════════════════════════════════════════════════════════════════════════
// t145 group A, round 3 — THE OWNER MESSAGE A RUNNING TURN IS SERVING IS NEVER FOLDED OUT OF VIEW.
//
// The "still in force" pin carried the newest long ask into every call. Deleting it is only safe
// if no shape loses the owner's words, and one did: a long, tool-heavy turn on an ask with no
// task, where a pressure fold in the middle of the turn summarised the ask's raw row away. The
// root fix: while a turn is running for an agent, the owner message it SERVES (the claimed ask's
// own row) and everything after it is treated like the newest group — no fold takes it, the
// ceiling cut and the token trim do not pass it. Older rows go first. If honouring it overflows,
// nothing silently drops it: the trim stops at it and the provider boundary's honest refusal
// (assembly-validation) is what answers.
//
// Every reader of "which rows may leave the view" is asserted here at the DB level; the turn-level
// proof (a real turn, a real forced fold, the words verbatim on the next call) is in
// `t145-the-pin-is-gone.test.ts`.
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

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { claimAsk } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { getMessagesOutsideFreshTail } from '../store.js';
import {
  servedAskFloorSeq, rowsLeavingView, freshTailHorizon, groupsToDropForBudget, tailTrimBlockGroups,
} from '../tail-horizon.js';
import { contextWindowPolicy } from '../budget.js';

const AGENT = 'primary';
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

let n = 0;
function say(role: 'user' | 'assistant', content: string, id = `m-${++n}`): number {
  return insertMessage({
    id, agentId: AGENT, role, content, turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    ...(role === 'user' ? { inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) } : {}),
  }).seq;
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
              VALUES ('conv-dash', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`).run();
  n = 0;
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

/** 10 older rows, the owner's long ask (claimed by a running turn), then `after` rows of the turn. */
function servedAsk(after: number): { askSeq: number; lastSeq: number } {
  for (let i = 0; i < 5; i++) { say('user', `older question ${i}`); say('assistant', `older answer ${i}`); }
  const askSeq = say('user', 'THE-LONG-ASK '.repeat(30), 'ask-row');
  expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
  let lastSeq = askSeq;
  for (let i = 0; i < after; i++) lastSeq = say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i}`);
  return { askSeq, lastSeq };
}

const policy = { freshTailCount: 24 };

describe('t145 R3 — the served owner message is a floor no fold and no cut passes', () => {
  it('the floor is the claimed ask\'s own row, and only while a turn is running', () => {
    const { askSeq } = servedAsk(10);
    expect(servedAskFloorSeq(AGENT), 'no turn is running: nothing is protected').toBe(0);
    openTurnContext(AGENT);
    expect(servedAskFloorSeq(AGENT)).toBe(askSeq);
    endTurnContext(AGENT);
    expect(servedAskFloorSeq(AGENT)).toBe(0);
  });

  it('the fold input never reaches the ask: older rows only', () => {
    const { askSeq } = servedAsk(70);
    const before = getMessagesOutsideFreshTail(AGENT, 24).map((m) => m.rowid as number);
    expect(before).toContain(askSeq);           // control: unprotected, the ask is foldable
    openTurnContext(AGENT);
    const protectedRows = getMessagesOutsideFreshTail(AGENT, 24).map((m) => m.rowid as number);
    expect(protectedRows.length).toBeGreaterThan(0);
    expect(Math.max(...protectedRows)).toBeLessThan(askSeq);
  });

  it('the condense trigger ("full") ends its fold below the ask', () => {
    const { askSeq } = servedAsk(70);
    const free = rowsLeavingView(AGENT, policy, { viewFull: true });
    expect(free && free.throughSeq, 'control: unprotected, the trigger reaches past the ask').toBeGreaterThanOrEqual(askSeq);
    openTurnContext(AGENT);
    const guarded = rowsLeavingView(AGENT, policy, { viewFull: true });
    expect(guarded).not.toBeNull();
    expect(guarded!.throughSeq).toBeLessThan(askSeq);
    expect(guarded!.rowsLeaving).toBe(10);       // exactly the ten older rows
  });

  it('with nothing older than the ask, nothing leaves', () => {
    for (let i = 0; i < 0; i++) say('user', 'x');
    const askSeq = say('user', 'THE-LONG-ASK '.repeat(30), 'ask-row');
    claimAsk('ask:ask-row', AGENT);
    for (let i = 0; i < 80; i++) say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i}`);
    openTurnContext(AGENT);
    expect(servedAskFloorSeq(AGENT)).toBe(askSeq);
    expect(rowsLeavingView(AGENT, policy, { viewFull: true })).toBeNull();
  });

  it('the row ceiling\'s front cut stops at the ask', () => {
    const { askSeq } = servedAsk(260);          // well over 8 x 24 rows since the boundary
    const free = freshTailHorizon(AGENT, contextWindowPolicy(16000, { toolPayloadTokens: 0 }));
    expect(free.ceilingBound).toBe(true);
    expect(free.keepFromSeq, 'control: unprotected, the ceiling cut passes the ask').toBeGreaterThan(askSeq);
    openTurnContext(AGENT);
    const guarded = freshTailHorizon(AGENT, contextWindowPolicy(16000, { toolPayloadTokens: 0 }));
    expect(guarded.keepFromSeq).toBeLessThanOrEqual(askSeq);
  });

  it('the token trim never drops the protected group; older groups go first', () => {
    const tokens = Array.from({ length: 60 }, () => 100);
    const block = tailTrimBlockGroups(24);
    expect(groupsToDropForBudget(tokens, 3000, block)).toBeGreaterThanOrEqual(30);       // control
    // the ask is group 8: at most 8 groups may go, even though the budget wants more
    const d = groupsToDropForBudget(tokens, 3000, block, 8);
    expect(d).toBeLessThanOrEqual(8);
    // nothing older to drop at all
    expect(groupsToDropForBudget(tokens, 3000, block, 0)).toBe(0);
    // everything fits: unchanged
    expect(groupsToDropForBudget(tokens, 100_000, block, 8)).toBe(0);
  });
});
