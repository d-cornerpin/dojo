// ════════════════════════════════════════════════════════════════════════════════════════
// t212 (v3.4 D11) — THE ROUTER READS THE NEWEST ROWS, BEFORE ANYTHING IS ASSEMBLED.
//
// `router/routing-view.ts` gives `decide.ts` what it read off the assembled array: this turn's asks,
// the agent's newest reply before them, the user's previous real request (a short "yes, do it"
// inherits its tier) and whether an ask carries an image. On the real migration chain.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { routingView } from '../routing-view.js';

const AGENT = 'agent-t212-view';

function row(role: 'user' | 'assistant', content: string, extra: { conversationId?: string; attachments?: string } = {}): void {
  insertMessage({ agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, content, turnNumber: 1, ...extra });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Dock Desk', 'auto', 'idle', '{}')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t212 — the routing view', () => {
  it('the previous real request, the newest reply, then this turn\'s asks as one message', () => {
    row('user', 'Plan the north dock rota for next week, with two people on every shift.');
    row('assistant', 'Here is the draft rota: Monday has two on the early shift and two on the late shift.');
    row('user', 'yes, do it');
    const view = routingView(AGENT, { conversationId: null, query: 'yes, do it' });
    expect(view).toEqual([
      { role: 'user', content: 'Plan the north dock rota for next week, with two people on every shift.' },
      { role: 'assistant', content: 'Here is the draft rota: Monday has two on the early shift and two on the late shift.' },
      { role: 'user', content: 'yes, do it' },
    ]);
  });

  it('several waiting asks ride as one message (the assembler merges them the same way); a tool turn is read as its blocks', () => {
    row('user', 'Count the crates.');
    row('assistant', JSON.stringify([{ type: 'tool_use', id: 't1', name: 'count', input: {} }]));
    row('user', 'And the lids.');
    row('user', 'And the seals.');
    const view = routingView(AGENT, { conversationId: null, query: 'And the lids.' });
    expect(view.at(-2)).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'count', input: {} }] });
    expect(view.at(-1)).toEqual({ role: 'user', content: 'And the lids.\n\nAnd the seals.' });
  });

  it('an image attached to an ask of this turn is an image block (vision routes heavy); one on an answered ask is not', () => {
    row('user', 'Here is last week\'s photo.', { attachments: JSON.stringify([{ category: 'image', path: '/nowhere/old.png', filename: 'old.png' }]) });
    row('assistant', 'Ready.');
    row('user', 'What is in this picture?', { attachments: JSON.stringify([{ category: 'image', path: '/nowhere/crate.png', filename: 'crate.png' }]) });
    expect(routingView(AGENT, { conversationId: null, query: null }).at(-1)!.content)
      .toEqual([{ type: 'text', text: 'What is in this picture?' }, { type: 'image' }]);
    row('assistant', 'A crate.');
    row('user', 'Thanks, and how many bays are open?');
    expect(routingView(AGENT, { conversationId: null, query: null }).at(-1)!.content).toBe('Thanks, and how many bays are open?');
  });

  it('a person\'s turn reads its own conversation only', () => {
    row('user', 'Book the van for Friday morning at the depot.', { conversationId: 'conv-a' });
    row('user', 'Unrelated: what is the weather at the harbour?', { conversationId: 'conv-b' });
    expect(routingView(AGENT, { conversationId: 'conv-a', query: null }).at(-1)!.content).toBe('Book the van for Friday morning at the depot.');
  });

  it('no ask after the newest reply: the turn\'s own trigger text, else the newest ask', () => {
    row('user', 'Check the berth schedule.');
    row('assistant', 'Berth 3 is open.');
    expect(routingView(AGENT, { conversationId: null, query: 'A peer asks: is berth 3 still open?' }).at(-1)!.content).toBe('A peer asks: is berth 3 still open?');
    expect(routingView(AGENT, { conversationId: null, query: null }).at(-1)!.content).toBe('Check the berth schedule.');
  });
});
