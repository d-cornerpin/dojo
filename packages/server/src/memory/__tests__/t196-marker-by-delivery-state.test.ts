// t196 (A3) - THE END-OF-HISTORY MARKER IS PLACED BY DELIVERY STATE, NOT BY POSITION.
//
// An owner message that lands while an engine turn is running has a LOWER seq than that turn's later
// assistant rows. On the next turn it is the trigger, but it sits above those rows, and the trailing
// "[Engine: end of recorded history. Everything above ... was already delivered ...]" used to declare it
// delivered too. The marker now says which is which: the message the running turn is answering is NOT yet
// answered; the rest above was delivered. The text stays within the marker lane's reserve (216 chars).
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
import { assembleContext } from '../assembler.js';

const AGENT = 'primary';
const PREFIX = '[Engine: end of recorded history.';
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
function say(role: 'user' | 'assistant', content: string, id = `m-${++n}`, turnNumber = 1): number {
  return insertMessage({
    id, agentId: AGENT, role, content, turnNumber,
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

async function lastText(): Promise<string> {
  const ctx = await assembleContext(AGENT, 'm');
  const last = ctx.messages[ctx.messages.length - 1]!;
  expect(last.role).toBe('user');
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

/** The running turn (number 9) serves the owner message `ask-row`. */
function runningTurnServes(askId: string): void {
  const bag = openTurnContext(AGENT);
  bag.turnNumber = 9;
  bag.root = { kind: 'ask', id: askId, sourceMessageId: askId };
}

describe('t196 (A3) - the marker is placed by delivery state', () => {
  it('an owner message that arrived during an earlier turn sits above that turn\'s reply: the marker says it is NOT yet answered', async () => {
    say('user', 'older question'); say('assistant', 'older answer');
    say('user', 'THE-MID-TURN-ASK', 'ask-row', 2);                  // arrived while turn 2 was running
    say('assistant', 'turn 2 final reply', 'late-reply', 2);        // turn 2's own row, written after it
    expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
    runningTurnServes('ask-row');
    const text = await lastText();
    expect(text.startsWith(PREFIX)).toBe(true);
    expect(text).toMatch(/NOT yet answered/);
    expect(text).not.toMatch(/Everything above, including your own final replies, was already delivered/);
    expect(text.length, 'within the marker lane\'s 216-character reserve').toBeLessThanOrEqual(216);
  });

  it('control: no served message above the reply keeps the unchanged marker', async () => {
    say('user', 'older question'); say('assistant', 'older answer');
    const text = await lastText();
    expect(text).toContain('Everything above, including your own final replies, was already delivered');
    expect(text).not.toMatch(/NOT yet answered/);
  });

  it('control: the turn\'s own reply (the in-flight turn) above its served ask does not turn the marker into "not answered"', async () => {
    say('user', 'THE-ASK', 'ask-row', 9);
    say('assistant', 'its own reply so far', 'own-reply', 9);
    expect(claimAsk('ask:ask-row', AGENT).kind).toBe('applied');
    runningTurnServes('ask-row');
    expect(await lastText()).toContain('Everything above, including your own final replies, was already delivered');
  });
});
