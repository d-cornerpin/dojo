// ════════════════════════════════════════════════════════════════════════════════════════
// t141 round 2 — conversation-scoped RECALL reads the row's LABEL, never a missing stamp.
//
// `memory/recall.ts` kept its own copy of the rule the three scopers lost in t141: an own row
// with `conversation_id IS NULL` was "this turn's untagged work, keep it", and any stamped row
// for another conversation was dropped. Once rows are labelled at birth (and migration 188
// reconstructs the conversation of rows the late stamp missed, and relayed / async results carry
// the conversation they answer) that rule HIDES rows that were in every recall before:
// a `legacy` row and a `delivered` result, each stamped with the conversation it truly belongs
// to, disappear from the recall of any other conversation. Label, never hide: the scopers' rule
// applies here too — in-flight is the live turn's number, and only a positive `conv` label for
// ANOTHER conversation leaves the recall.
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
const OTHER = 'conv-contact';
let image: Buffer | null = null;

beforeEach(() => {
  if (!image) { const s = new Database(':memory:'); mockDb.current = s; runMigrations(); image = s.serialize(); s.close(); }
  mockDb.current = new Database(image);
  const db = mockDb.current;
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'A', 'idle', datetime('now'))`).run(A);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, created_at) VALUES (?, ?, 'dashboard', 'owner', datetime('now'))`).run(C, A);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, created_at) VALUES (?, ?, 'imessage', '+15550100', datetime('now'))`).run(OTHER, A);
  const own = (id: string, content: string, subjectKind: 'conv' | 'legacy' | 'delivered' | 'background', conv: string | null, turnNumber?: number) =>
    insertMessage({ id, agentId: A, role: 'assistant', content, conversationId: conv, subjectKind, turnNumber: turnNumber ?? null });
  insertMessage({ id: 'ask', agentId: A, role: 'user', content: 'What is going on?', channel: 'dashboard', senderId: 'owner', conversationId: C });
  own('mine', 'MY-OWN-REPLY in this conversation', 'conv', C);
  own('other', 'OTHER-REPLY to the contact', 'conv', OTHER);
  own('legacy', 'LEGACY-ROW reconstructed by 188', 'legacy', OTHER);
  own('delivered', 'DELIVERED-ROW for the contact\'s request', 'delivered', OTHER);
  own('bg', 'BG-ROW from an email wake', 'background', null);
  own('inflight', 'INFLIGHT-ROW of the live turn', 'conv', OTHER, 9);
});
afterEach(() => { endTurnContext(A); mockDb.current?.close(); mockDb.current = null; });

function recalled(turnConversationId: string | null): string {
  const bag = openTurnContext(A);
  bag.turnNumber = 9;
  return recallRecentThread(A, { turnCount: 20, includeToolCalls: true, includeToolResults: true, turnConversationId });
}

describe('round 2 — scoped recall reads the label', () => {
  it.fails('a person turn\'s recall keeps every row it kept before, labelled, and still drops another conversation\'s reply', () => {
    const out = recalled(C);
    expect(out).toContain('MY-OWN-REPLY');
    expect(out).toContain('BG-ROW');
    expect(out, 'a legacy row was unstamped (kept) before 188').toContain('LEGACY-ROW');
    expect(out, 'a delivered result was unstamped (kept) before t141').toContain('DELIVERED-ROW');
    expect(out, 'the live turn\'s own work is the turn fact, not a stamp').toContain('INFLIGHT-ROW');
    expect(out, 'the re-answer-ghost guard is unchanged').not.toContain('OTHER-REPLY');
  });

  it.fails('an engine / agent-thread turn\'s recall keeps the unlabelled-as-a-person\'s rows and no person\'s reply', () => {
    const out = recalled(null);
    expect(out).toContain('BG-ROW');
    expect(out).toContain('LEGACY-ROW');
    expect(out).toContain('DELIVERED-ROW');
    expect(out).toContain('INFLIGHT-ROW');
    expect(out).not.toContain('MY-OWN-REPLY');
    expect(out).not.toContain('OTHER-REPLY');
  });
});
