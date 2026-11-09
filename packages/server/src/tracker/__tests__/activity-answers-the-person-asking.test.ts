// ════════════════════════════════════════════════════════════════════════════════════════
// t174 — THE ACTIVITY REPORT ANSWERS THE PERSON ASKING.
//
// Run 11 S3: a peer agent asked a question; it was worked in its own A2A turn (t165, correct). Then the
// owner asked "what have you finished for me today?" and the reply listed the peer's mail search as his
// work, because `work_update(action="activity")` reports every row on the board, peer-asked ones included.
// Owner, 2026-10-15: "Leave it out of my answers."
//
//   (i)   a turn serving a person: the report omits work that came from another agent's request, counts
//         only the person's, and says so in one plain line;
//   (ii)  a turn serving another agent: the report is the whole board, as before;
//   (iii) the origin is read off the row's recorded ties (the thread, the answered message, the turn),
//         never off its words, and a join piece of the person's own ask stays his.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { startTurn } from '../../agent/v2/turn-record.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { PEER_WORK_NOTE } from '../../work/peer-origin.js';

const AGENT = 'agent-t174';
const PEER = 'peer-t174';
const THREAD = '7e1f2a3b-0000-4000-8000-00000000a2a1';
const OPEN = Date.now() - 60_000;

function work(id: string, cols: Record<string, unknown>): void {
  const row = {
    kind: 'task', agent_id: AGENT, requester: 'agent', root_kind: 'tracker', root_id: id, state: 'open',
    intent: 'tracker', wakes: 0, closes_thread: 0, opened_at: OPEN, updated_at: OPEN, provenance: 'live', ...cols, id,
  };
  const names = Object.keys(row);
  mockDb.current!.prepare(`INSERT INTO work (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...Object.values(row) as never[]);
}

/** Open a turn of this kind the way the engine does: a record in `turns`, and the bag the tools read. */
function inTurn(kind: 'user' | 'a2a' | 'engine'): void {
  const n = startTurn({
    agentId: AGENT, kind, subjectKind: kind === 'user' ? 'conv' : kind === 'a2a' ? 'a2a_thread' : 'engine_event',
    subjectId: null, rootKind: null, rootId: null, sourceMessageId: null, convKey: null,
  });
  openTurnContext(AGENT).turnNumber = n;
}

async function activity(): Promise<string> {
  const r = await trackerHandlers['work_update:activity']({ agentId: AGENT, args: {} } as never);
  return (r as { content: string }).content;
}

let peerTurn = 0;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  const db = mockDb.current;
  for (const a of [AGENT, PEER]) {
    db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`).run(a, a);
  }
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, counterparty_name, created_at)
              VALUES ('conv-owner', ?, 'dashboard', 'owner', 'Owner', datetime('now'))`).run(AGENT);

  // The OWNER's work: an ask (its row opened by the message door), a task tied to it, a commitment in his
  // conversation, and a join piece of his ask delegated to the peer.
  insertMessage({ id: 'owner-msg', agentId: AGENT, role: 'user', content: 'Draft the ORCHID note', channel: 'dashboard',
    senderId: 'owner', conversationId: 'conv-owner' });
  work('owner-task', { title: 'ORCHID note task', source_message_id: 'owner-msg' });
  work('owner-commit', { kind: 'commitment', requester: 'agent', root_kind: 'commitment', title: 'ORCHID follow-up', conversation_id: 'conv-owner' });
  work('piece:owner-ask:t1', { title: 'ORCHID piece for the helper', root_kind: 'a2a_thread', root_id: THREAD, parent_id: 'ask:owner-msg' });

  // The PEER's work, in each shape its request leaves behind.
  insertMessage({ id: 'peer-msg', agentId: AGENT, role: 'user', lane: 'a2a', content: 'search mail for PELICAN', sourceAgentId: PEER,
    a2aThreadId: THREAD, a2aIntent: 'QUESTION' });
  work('peer-assign', { title: 'PELICAN assigned task', a2a_thread_id: THREAD, origin_kind: 'a2a_assign' });
  work('peer-by-message', { title: 'PELICAN task by message', source_message_id: 'peer-msg' });
  peerTurn = startTurn({ agentId: AGENT, kind: 'a2a', subjectKind: 'a2a_thread', subjectId: THREAD, rootKind: null, rootId: null,
    sourceMessageId: null, convKey: null });
  insertMessage({ id: 'peer-own', agentId: AGENT, role: 'assistant', lane: 'a2a', content: 'searching', subjectKind: 'a2a_thread',
    a2aThreadId: THREAD, turnNumber: peerTurn });
  work('peer-by-turn', { title: 'PELICAN task by turn', origin_turn: peerTurn });
  work('peer-commit', { kind: 'commitment', root_kind: 'commitment', root_id: THREAD, title: 'PELICAN promise' });
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

describe('t174 (i) — a turn serving a person reports that person\'s work only', () => {
  it('omits every shape of peer-asked work, counts only the owner\'s, and says so in one line', async () => {
    inTurn('user');
    const out = await activity();
    expect(out).not.toMatch(/PELICAN/);
    for (const mine of ['ORCHID note task', 'ORCHID follow-up', 'ORCHID piece for the helper']) expect(out).toContain(mine);
    // The owner's ask, task, commitment and piece are the whole count: 4, none of them a peer's.
    expect(out).toContain('Opened (4): 2 tasks, 1 ask, 1 commitment');
    expect(out).toContain(PEER_WORK_NOTE);
    expect(out.split('\n').filter((l) => l.includes(PEER_WORK_NOTE))).toHaveLength(1);
  });

  it('says it on an empty window too, and does not count the peer\'s work there', async () => {
    // The owner's rows fall outside the window; only the peer's are inside it.
    mockDb.current!.prepare(`UPDATE work SET opened_at = ? WHERE id IN ('ask:owner-msg','owner-task','owner-commit','piece:owner-ask:t1')`)
      .run(Date.now() - 5 * 86_400_000);
    inTurn('user');
    const out = await activity();
    expect(out).toContain(PEER_WORK_NOTE);
    expect(out).toMatch(/0 rows opened/);
  });
});

describe('t174 (ii) — a turn serving another agent, or the engine, is unchanged', () => {
  it.each(['a2a', 'engine'] as const)('a %s turn lists the whole board and adds no note', async (kind) => {
    inTurn(kind);
    const out = await activity();
    for (const t of ['PELICAN assigned task', 'PELICAN task by message', 'PELICAN task by turn', 'PELICAN promise', 'ORCHID note task']) {
      expect(out).toContain(t);
    }
    expect(out).not.toContain(PEER_WORK_NOTE);
    expect(out).toMatch(/Opened \(\d+\):/);
  });

  it('a call outside any turn is the whole board', async () => {
    const out = await activity();
    expect(out).toContain('PELICAN assigned task');
    expect(out).not.toContain(PEER_WORK_NOTE);
  });
});
