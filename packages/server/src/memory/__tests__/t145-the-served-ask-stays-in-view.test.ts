// ════════════════════════════════════════════════════════════════════════════════════════
// t145 group A, round 4 — THE OWNER MESSAGE A RUNNING TURN SERVES IS NEVER OUT OF VIEW.
//
// The "still in force" pin carried the newest long ask into every call. Deleting it is only safe
// if no shape loses the owner's words, and one did: a long, tool-heavy turn on an ask with no
// task, where a pressure fold in the middle of the turn summarised the ask's raw row away.
//
// ROUND 3 froze every row from the ask onward; the owner's long jobs make that unacceptable (a long
// job's own tool rows must fold like any other). So the protection is NARROW: only the owner
// message(s) the running turn serves (the claimed ask's own message, and the unanswered owner
// messages merged into it in the same conversation). Folds, the condense trigger, the ceiling cut
// and the token trim proceed exactly as before. When the served message ends up behind the fold
// boundary (or off the front of the trimmed tail), the assembler re-emits that one row verbatim at
// the front of the live tail, labelled plainly with its time, once, for as long as the turn (and its
// carried continuations) runs. If the row is still in view, nothing extra is emitted (t139's rule).
// Structural: the turn's own claimed ask rows; no content is read.
//
// The turn-level proof (a real turn, a real forced fold, the words verbatim on the next call, the
// turn's own tool rows folded, no refusal) is in `t145-the-pin-is-gone.test.ts`.
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
import { rowsLeavingView } from '../tail-horizon.js';
import { servedOwnerMessageIds } from '../served-ask.js';
import { createLeafSummary } from '../dag.js';
import { assembleContext } from '../assembler.js';

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
const LABEL = 'The message from you this work is answering';
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const wire = async (): Promise<string> => JSON.stringify((await assembleContext(AGENT, 'm')).messages);

describe('t145 R4 — only the served owner message is protected, and it is re-emitted when it is out of view', () => {
  it('the served ids are the claimed ask\'s own message and the unanswered owner messages merged into it, only while a turn runs', () => {
    servedAsk(0);
    say('user', 'a later owner message merged into the same turn', 'later-row');
    expect(servedOwnerMessageIds(AGENT), 'no turn is running: nothing is served').toEqual([]);
    openTurnContext(AGENT);
    expect(servedOwnerMessageIds(AGENT)).toEqual(['ask-row', 'later-row']);
    endTurnContext(AGENT);
    expect(servedOwnerMessageIds(AGENT)).toEqual([]);
  });

  it('NOTHING after the ask is frozen: the fold input and the condense trigger reach past it, as before', () => {
    const { askSeq } = servedAsk(70);
    openTurnContext(AGENT);
    expect(getMessagesOutsideFreshTail(AGENT, 24).map((m) => m.rowid as number)).toContain(askSeq);
    const leaving = rowsLeavingView(AGENT, policy, { viewFull: true });
    expect(leaving!.throughSeq).toBeGreaterThanOrEqual(askSeq);
  });

  it('in view: the ask is in the live conversation and nothing extra is emitted', async () => {
    servedAsk(6);
    openTurnContext(AGENT);
    const text = await wire();
    expect(occurrences(text, 'THE-LONG-ASK')).toBeGreaterThan(0);
    expect(text).not.toContain(LABEL);
  });

  it('behind the fold boundary: the ask is re-emitted verbatim at the front of the live tail, labelled, exactly once', async () => {
    const { askSeq } = servedAsk(30);
    // A summary covers everything up to and including the ask: the live view starts after it.
    const ids = (mockDb.current!.prepare('SELECT id FROM messages WHERE seq <= ? ORDER BY seq').all(askSeq) as Array<{ id: string }>).map((r) => r.id);
    createLeafSummary(AGENT, 'Earlier: the owner asked for a big job.', 20, ids, new Date().toISOString(), new Date().toISOString());
    const ask = 'THE-LONG-ASK '.repeat(30);
    expect(occurrences(await wire(), 'THE-LONG-ASK'), 'control: no turn running, the ask is only in the note').toBe(0);
    openTurnContext(AGENT);
    const ctx = await assembleContext(AGENT, 'm');
    const text = JSON.stringify(ctx.messages);
    expect(text).toContain(LABEL);
    expect(occurrences(text, LABEL), 'exactly once').toBe(1);
    expect(text).toContain(ask.trim());
    expect(occurrences(text, ask.trim()), 'the words appear once').toBe(1);
    // it leads the live tail: it is the first message that is not the summary scaffolding
    const firstLabelled = ctx.messages.findIndex((m) => JSON.stringify(m).includes(LABEL));
    const firstTurnRow = ctx.messages.findIndex((m) => JSON.stringify(m).includes('turn row 0'));
    expect(firstLabelled).toBeGreaterThanOrEqual(0);
    expect(firstLabelled).toBeLessThan(firstTurnRow);
    // and once the turn ends it is gone
    endTurnContext(AGENT);
    expect(await wire()).not.toContain(LABEL);
  });

  it('trimmed off the front by the token budget: the ask is re-emitted, older rows are what went, the budget holds', async () => {
    mockDb.current!.prepare("UPDATE models SET context_window = 40000 WHERE id = 'm'").run();
    for (let i = 0; i < 10; i++) { say('user', `older question ${i} ${'pad '.repeat(300)}`); say('assistant', `older answer ${i} ${'pad '.repeat(300)}`); }
    say('user', 'THE-LONG-ASK '.repeat(8), 'ask-row');
    claimAsk('ask:ask-row', AGENT);
    for (let i = 0; i < 40; i++) say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i} ${'pad '.repeat(300)}`);
    const control = await wire();
    expect(control, 'control: no turn running, the trim drops the ask with the front').not.toContain('THE-LONG-ASK');
    openTurnContext(AGENT);
    const text = await wire();
    expect(text).toContain(LABEL);
    expect(occurrences(text, 'THE-LONG-ASK '.repeat(8).trim())).toBe(1);
    expect(text).not.toContain('older question 0');
    expect(text).toContain('turn row 39');   // the newest rows are untouched
  });
});
