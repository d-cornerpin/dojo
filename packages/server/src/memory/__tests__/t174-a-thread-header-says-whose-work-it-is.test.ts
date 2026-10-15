// ════════════════════════════════════════════════════════════════════════════════════════
// t174 — THE LABEL SAYS WHOSE WORK IT IS.
//
// Owner rulings, binding together: OR-LABEL-NOT-HIDE ("the agent just needs to be aware of what conversations
// are what and not confuse them": label, never hide) and, 2026-10-15, "Leave it out of my answers" (only work
// done for the owner is reported to him). So an agent's own rows from a peer's thread stay in the view of a
// person's conversation, and the label on them says plainly: this was work for that agent, in its own
// conversation, not for the person you are talking with.
// ════════════════════════════════════════════════════════════════════════════════════════
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
import { insertMessage } from '../message-store.js';
import { getRecentMessages } from '../store.js';
import { LabelFacts, labelRows, renderRowLabel, withSubjectKinds } from '../row-label.js';

const A = 'agent-t174-label';
const THREAD = '7e1f2a3b-0000-4000-8000-00000000a2a1';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'A', 'idle', datetime('now'))`).run(A);
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES ('peer', 'Peer', 'idle', datetime('now'))`).run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, counterparty_name, created_at)
              VALUES ('conv-owner', ?, 'dashboard', 'owner', 'Owner', datetime('now'))`).run(A);
  insertMessage({ id: 'owner-1', agentId: A, role: 'user', content: 'Draft the ORCHID note', channel: 'dashboard', senderId: 'owner', conversationId: 'conv-owner' });
  insertMessage({ id: 'owner-1-reply', agentId: A, role: 'assistant', content: 'Drafted.', conversationId: 'conv-owner', subjectKind: 'conv' });
  insertMessage({ id: 'peer-in', agentId: A, role: 'user', lane: 'a2a', content: 'search mail for PELICAN', sourceAgentId: 'peer', a2aThreadId: THREAD, a2aIntent: 'QUESTION' });
  insertMessage({ id: 'peer-own', agentId: A, role: 'assistant', lane: 'a2a', content: 'PELICAN mail search done', subjectKind: 'a2a_thread', a2aThreadId: THREAD });
  insertMessage({ id: 'owner-2', agentId: A, role: 'user', content: 'What have you finished for me today?', channel: 'dashboard', senderId: 'owner', conversationId: 'conv-owner' });
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t174 (iii) — an own row from an agent thread is labelled as that agent\'s work, and is still there', () => {
  it('stays in the view (OR-LABEL-NOT-HIDE) under a header that names whose work it is', () => {
    const rows = getRecentMessages(A, 100);
    expect(rows.map((r) => r.id), 'the peer-thread rows are still in the view').toEqual(
      expect.arrayContaining(['peer-in', 'peer-own', 'owner-1', 'owner-2']));
    const labels = labelRows(A, rows);
    const header = labels.get('peer-in')!;
    expect(header).toMatch(/agent thread 7e1f2a3b with Peer/);
    expect(header).toMatch(/work for Peer in its own conversation, not for the person you are talking with; do not report it to them as theirs/);
    // The request and the agent's own rows of the thread share ONE header (no alternating headers).
    expect(labels.get('peer-own')).not.toMatch(/agent thread/);
    // The owner's own conversation is labelled as his, with no such clause.
    expect(labels.get('owner-2')).toMatch(/dashboard conversation with TestUser/);
    expect(labels.get('owner-2')).not.toMatch(/not for the person/);
    // The header of a block that opens ON the agent's own thread row carries it too.
    const own = withSubjectKinds(A, rows).find((r) => r.id === 'peer-own')!;
    expect(renderRowLabel(own, new LabelFacts(A))).toMatch(/work for Peer in its own conversation, not for the person you are talking with/);
  });

  it('keeps the label\'s shape: one bracket pair, one line, balanced quotes', () => {
    const own = withSubjectKinds(A, getRecentMessages(A, 100)).find((r) => r.id === 'peer-own')!;
    const label = renderRowLabel(own, new LabelFacts(A));
    expect(label.startsWith('[') && label.endsWith(']')).toBe(true);
    expect(label.slice(1, -1)).not.toMatch(/[[\]]/);
    expect(label).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect((label.match(/"/g) ?? []).length % 2).toBe(0);
  });
});
