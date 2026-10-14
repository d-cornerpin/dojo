// ════════════════════════════════════════════════════════════════════════════════════════
// t158 B — THE SERVED OWNER MESSAGE WEARS THE SAME LABEL AS EVERY OTHER ROW.
//
// t145 round 4 re-emits the owner message a running turn serves when it is out of view, and it
// labelled that row with its own sentence ("The message from you this work is answering (sent
// <instant>):"). That carried the time but not the conversation, channel or sender that every
// other row's label carries (t141, `memory/row-label.ts`), and "from you" in a user-role block
// reads as if the agent had sent it. The kit's NO_UNLABELLED_ROW flagged it on every call.
//
// The served row now renders `renderRowLabel` (the label `labelRows` gives that row in place),
// then a short pronoun-free phrase saying what the message is for. The words stay verbatim and
// the row is still emitted exactly once, and only when it is out of view.
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
import { createLeafSummary } from '../dag.js';
import { assembleContext } from '../assembler.js';
import { getMessagesByIds } from '../store.js';
import { labelRows, withSubjectKinds } from '../row-label.js';

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
/** The turn that picked the ask up: its bag, with the trigger root the preflight publishes. */
function runningTurnOn(askId: string): void {
  const bag = openTurnContext(AGENT);
  bag.root = { kind: 'ask', id: askId, sourceMessageId: askId };
}

function servedAsk(after: number): { askSeq: number; lastSeq: number } {
  for (let i = 0; i < 5; i++) { say('user', `older question ${i}`); say('assistant', `older answer ${i}`); }
  const askSeq = say('user', 'THE-LONG-ASK '.repeat(30), 'ask-row');
  expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
  let lastSeq = askSeq;
  for (let i = 0; i < after; i++) lastSeq = say(i % 2 === 0 ? 'assistant' : 'user', `turn row ${i}`);
  return { askSeq, lastSeq };
}



const ASK_WORDS = 'THE-LONG-ASK '.repeat(30).trim();
const PHRASE = '(the message this work is answering)';
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** The ask has been folded behind a summary, so only the served-message door can show it. */
async function foldedBehindASummary(): Promise<void> {
  const { askSeq } = servedAsk(30);
  const ids = (mockDb.current!.prepare('SELECT id FROM messages WHERE seq <= ? ORDER BY seq').all(askSeq) as Array<{ id: string }>).map((r) => r.id);
  createLeafSummary(AGENT, 'Earlier: the owner asked for a big job.', 20, ids, new Date().toISOString(), new Date().toISOString());
  runningTurnOn('ask-row');
}

/** The one message of the assembled context that carries the ask's words. */
async function servedMessageText(): Promise<string> {
  const ctx = await assembleContext(AGENT, 'm');
  const hits = ctx.messages.filter((m) => JSON.stringify(m).includes('THE-LONG-ASK'));
  expect(hits, 'the served words appear in exactly one message').toHaveLength(1);
  const c = hits[0]!.content;
  expect(hits[0]!.role).toBe('user');
  return typeof c === 'string' ? c : (c as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('');
}

describe('t158 B — the served message wears the standard row label', () => {
  it('its label is exactly the label labelRows gives that row in place, then the phrase, then the words', async () => {
    await foldedBehindASummary();
    const row = withSubjectKinds(AGENT, getMessagesByIds(['ask-row']));
    const inPlace = labelRows(AGENT, row).get('ask-row');
    expect(inPlace, 'the row has a label in place').toBeTruthy();
    expect(inPlace).toContain('dashboard conversation with');   // the conversation, channel and sender it was missing
    const text = await servedMessageText();
    expect(text).toBe(`${inPlace} ${PHRASE} ${row[0]!.content as string}`);
  });

  it('the words are byte-identical to the stored row, and the old first-person label is gone', async () => {
    await foldedBehindASummary();
    const stored = (mockDb.current!.prepare("SELECT content FROM messages WHERE id = 'ask-row'").get() as { content: string }).content;
    const text = await servedMessageText();
    expect(text.endsWith(stored)).toBe(true);
    expect(text).not.toContain('from you');
    expect(text).not.toContain('(sent ');
    expect(occurrences(text, ASK_WORDS)).toBe(1);
  });

  it('still emitted only when out of view, and exactly once', async () => {
    servedAsk(6);                       // the ask is in the live conversation
    runningTurnOn('ask-row');
    const inView = JSON.stringify((await assembleContext(AGENT, 'm')).messages);
    expect(inView).not.toContain(PHRASE);
  });

  it('out of view it carries the phrase once across the whole context', async () => {
    await foldedBehindASummary();
    const all = JSON.stringify((await assembleContext(AGENT, 'm')).messages);
    expect(occurrences(all, PHRASE)).toBe(1);
  });
});
