// t196 (A1.1, A1.3) - THE LABELS TELL THE TRUTH ABOUT A RELAYED ANSWER.
//   * a `delivered` row the engine relayed to the owner says it was SENT (to whom, on which channel, when);
//   * a `delivered` row with no relay receipt (a media result) keeps the plain "result delivered later";
//   * an agent thread the agent opened by delegating the OWNER's request is not "for the other agent, not
//     for the person you are talking with" - the work IS the owner's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => { /* not exercised */ },
}));
vi.mock('../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../config/platform.js')>('../../config/platform.js');
  return { ...actual, getOwnerName: () => 'TestUser' };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not observed */ } }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage, deliveredResult } from '../message-store.js';
import { getRecentMessages } from '../store.js';
import { labelRows } from '../row-label.js';
import { openDelegationJoin } from '../../work/store.js';
import { endTurnContext, openTurnContext } from '../../agent/turn-context.js';

const A = 'agent-t196-label';
const THREAD = '7e1f2a3b-0000-4000-8000-0000000019a1';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'A', 'idle', datetime('now'))`).run(A);
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES ('peer', 'Peer', 'idle', datetime('now'))`).run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, counterparty_name, created_at)
              VALUES ('conv-owner', ?, 'dashboard', 'owner', 'Owner', datetime('now'))`).run(A);
  insertMessage({ id: 'ask-1', agentId: A, role: 'user', content: 'Ask the peer about HERON', channel: 'dashboard', senderId: 'owner', conversationId: 'conv-owner' });
});
afterEach(() => { endTurnContext(A); mockDb.current?.close(); mockDb.current = null; });

function relayRow(id: string, content: string, over: { delivery?: boolean; tool?: string; channel?: string } = {}): void {
  insertMessage({ id, agentId: A, role: 'assistant', content, ...deliveredResult('conv-owner', 'ask-1') });
  if (over.delivery === false) return;
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, outcome, detail, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?, 'delivered', 'join ask:ask-1', '2026-10-17 09:30:00')`,
  ).run(`d-${id}`, A, over.tool ?? 'a2a-join-relay', over.channel ?? 'dashboard', id);
}

const labelOf = (id: string): string => labelRows(A, getRecentMessages(A, 100)).get(id)!;

describe('t196 (A1.1) - a relayed row says it was sent', () => {
  it('a join relay with its delivery receipt: who, channel, instant, the request, and that they have it', () => {
    relayRow('relay-1', 'Heard back from Peer: HERON is fine');
    const label = labelOf('relay-1');
    expect(label).toMatch(/dashboard conversation with TestUser — sent to TestUser on dashboard at /);
    expect(label).toMatch(/ by the engine as the result of the request of [^"]*: "Ask the peer about HERON"; TestUser has it\]$/);
    expect(label).not.toMatch(/result delivered later/);
  });

  it('the channel is the one the receipt records, not an assumption', () => {
    relayRow('relay-2', 'Heard back from Peer: HERON is fine', { channel: 'imessage' });
    expect(labelOf('relay-2')).toMatch(/sent to TestUser on imessage at /);
  });

  it('a delivered row with no relay receipt (a media result) keeps the plain wording', () => {
    relayRow('media-1', 'Your image is ready', { delivery: false });
    expect(labelOf('media-1')).toMatch(/dashboard conversation with TestUser — result delivered later, for the request of /);
  });

  it('a delivered row whose receipt belongs to another tool is not a relay either', () => {
    relayRow('media-2', 'Your other image is ready', { tool: 'image_create' });
    expect(labelOf('media-2')).toMatch(/result delivered later, for the request of /);
  });

  it('keeps the label\'s shape: one bracket pair, one line, balanced quotes', () => {
    relayRow('relay-3', 'Heard back from Peer: HERON is fine');
    const label = labelOf('relay-3');
    expect(label.startsWith('[') && label.endsWith(']')).toBe(true);
    expect(label.slice(1, -1)).not.toMatch(/[[\]]/);
    expect(label).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect((label.match(/"/g) ?? []).length % 2).toBe(0);
  });
});

const CLAUSE = /work for .* in its own conversation, not for the person you are talking with/;

describe('t196 (A1.3) - a delegate\'s thread is the owner\'s work, not "not for the person you are talking with"', () => {
  function delegateThread(): void {
    openDelegationJoin({ parentWorkId: 'ask:ask-1', agentId: A, replyConversationId: 'conv-owner',
      ttlAt: Date.now() + 3_600_000, threads: [{ threadId: THREAD, assigneeAgent: 'peer', intent: 'QUESTION', hopCount: 0 }] });
    insertMessage({ id: 'send-1', agentId: 'peer', role: 'user', lane: 'a2a', content: 'three facts please', sourceAgentId: A, a2aThreadId: THREAD, a2aIntent: 'QUESTION' });
    insertMessage({ id: 'reply-1', agentId: A, role: 'user', lane: 'a2a', content: 'HERON is fine', sourceAgentId: 'peer', a2aThreadId: THREAD, a2aIntent: 'COMPLETE' });
    insertMessage({ id: 'wake-own', agentId: A, role: 'assistant', lane: 'a2a', content: 'noted the result', subjectKind: 'a2a_thread', a2aThreadId: THREAD });
    insertMessage({ id: 'owner-2', agentId: A, role: 'user', content: 'Anything new?', channel: 'dashboard', senderId: 'owner', conversationId: 'conv-owner' });
  }

  it('the owner\'s turn: the delegation thread says it is work the agent delegated for the request, never the "not for you" clause', () => {
    delegateThread();
    const bag = openTurnContext(A);
    bag.kind = 'user';
    const labels = labelRows(A, getRecentMessages(A, 100));
    const header = labels.get('reply-1')!;
    expect(header).toMatch(/agent thread 7e1f2a3b with Peer/);
    expect(header).not.toMatch(CLAUSE);
    expect(header).not.toMatch(/not for the person you are talking with/);
    expect(header).toMatch(/work you delegated to Peer for the request of the person you are talking with/);
  });

  it('control: a thread where the PEER asked the agent still carries the clause', () => {
    insertMessage({ id: 'peer-in', agentId: A, role: 'user', lane: 'a2a', content: 'search mail for PELICAN', sourceAgentId: 'peer', a2aThreadId: '9c8d7e6f-0000-4000-8000-0000000019b2', a2aIntent: 'QUESTION' });
    insertMessage({ id: 'owner-3', agentId: A, role: 'user', content: 'Anything new?', channel: 'dashboard', senderId: 'owner', conversationId: 'conv-owner' });
    const bag = openTurnContext(A);
    bag.kind = 'user';
    expect(labelRows(A, getRecentMessages(A, 100)).get('peer-in')).toMatch(CLAUSE);
  });
});
