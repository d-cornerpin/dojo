// ════════════════════════════════════════════════════════════════════════════════════════
// t98 — recall's CLIP never splits a character.
//
// `memory/recall.ts`'s `clip` shortened every message and tool result `recallRecentThread`
// shows the agent with `text.slice(0, maxChars)`. A cut by UTF-16 code unit can land between
// the two halves of an emoji (a high and its low surrogate), leaving a LONE high surrogate in
// the text the model is shown — a malformed string some providers reject outright — while the
// "N more chars" count was computed from that same mid-pair position. `memory/tool-result-view.ts`
// already carries the fix for this exact defect, `charBoundary` ("never inside a surrogate
// pair", and it keeps emoji joiners together); the compaction code uses it, this older helper
// never got it. The fix cuts at `charBoundary(text, maxChars, 'back')` and counts from there.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => { /* not exercised */ },
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { recallRecentThread } from '../recall.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const A = 'agent-recall';
const C = 'conv-owner';
let image: Buffer | null = null;

// A high surrogate not followed by its low pair, or a low one not preceded by its high pair.
const hasLoneSurrogate = (s: string) =>
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

beforeEach(() => {
  if (!image) { const s = new Database(':memory:'); mockDb.current = s; runMigrations(); image = s.serialize(); s.close(); }
  mockDb.current = new Database(image);
  const db = mockDb.current;
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'A', 'idle', datetime('now'))`).run(A);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, created_at) VALUES (?, ?, 'dashboard', 'owner', datetime('now'))`).run(C, A);
  // 205 UTF-16 units: 199 'a', one emoji (two units), 'tail'.
  const LONG = 'a'.repeat(199) + '😀' + 'tail';
  // Exactly at the 200-unit cap: 198 'a', one emoji (two units) — must stay whole.
  const AT_LIMIT = 'a'.repeat(198) + '😀';
  insertMessage({ id: 'u-long', agentId: A, role: 'user', content: LONG, conversationId: C });
  insertMessage({ id: 'a-long', agentId: A, role: 'assistant', content: LONG, conversationId: C });
  insertMessage({ id: 'u-exact', agentId: A, role: 'user', content: AT_LIMIT, conversationId: C });
  insertMessage({ id: 'u-short', agentId: A, role: 'user', content: 'hello there', conversationId: C });
});
afterEach(() => { endTurnContext(A); mockDb.current?.close(); mockDb.current = null; });

function recalled(): string {
  const bag = openTurnContext(A);
  bag.turnNumber = 9;
  return recallRecentThread(A, { turnCount: 20, truncateMessageChars: 200, turnConversationId: C });
}

describe('round 1 — recall\'s clip never splits an emoji', () => {
  it('a long USER message is cut at a whole character, not mid-emoji', () => {
    const out = recalled();
    expect(out).toContain('a'.repeat(199) + '…');
    expect(out).toContain('[truncated, 6 more chars, call history_get(id="u-long") for full body]');
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('a long ASSISTANT message is cut at a whole character, not mid-emoji', () => {
    const out = recalled();
    expect(out).toContain('a'.repeat(199) + '…');
    expect(out).toContain('[truncated, 6 more chars, call history_get(id="a-long") for full body]');
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('a message exactly at the cap is shown whole, with no truncation line', () => {
    const out = recalled();
    expect(out).toContain('a'.repeat(198) + '😀');
    expect(out).not.toContain('call history_get(id="u-exact")');
  });

  it('a short message is shown unchanged', () => {
    const out = recalled();
    expect(out).toContain('hello there');
  });
});
