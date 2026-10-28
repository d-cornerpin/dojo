// ════════════════════════════════════════════════════════════════════════════════════════
// THE OTHER-THREADS READ WALKS TO THE NEWEST ROW, IT DOES NOT SCAN FOR IT.
//
// The read derived every other thread's newest activity with `MAX(created_at)` + `GROUP BY c.id`.
// `created_at` is in neither message index, so that read touched EVERY message row of EVERY
// thread — synchronously, twice per model call of a turn (`assembler.ts` reserve +
// `pre-call-injections.ts` injection). `seq` is the table's insertion key (the `messages` rowid
// alias, append-only, so it IS a time window — the rule `retrieval.ts` and `search-bounds.ts`
// already rank on), and the newest row of a conversation is its highest `seq`, which
// `ix_msg_conv_seq` answers directly. The plan itself is the instrument: no scan of `messages`,
// no grouping b-tree — and the answer it returns must not change.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null; spy: Database.Database | null } = { current: null, spy: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { const d = mockDb.spy ?? mockDb.current; if (!d) throw new Error('test DB not initialized'); return d; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../services/capability-registry.js', () => ({
  listChannelStatuses: () => [{ name: 'imessage', displayName: 'iMessage', configured: true, inboundLive: true }],
}));
vi.mock('../../agent/access/read.js', () => ({ toolCategoryGranted: () => true }));

import { runMigrations } from '../../db/migrations.js';
import { readOtherThreads } from '../other-threads-lane.js';

const AGENT = 'threaded';
const SERVED = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;
const hoursAgo = (h: number): number => Date.now() - h * 3_600_000;

function thread(id: string, name: string, role: 'user' | 'assistant', atMs: number, channel = 'imessage'): void {
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, AGENT, channel, channel, `id-${id}`, name);
  message(id, role, atMs);
}
function message(conversationId: string, role: 'user' | 'assistant', atMs: number): void {
  db().prepare(`INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at, display_kind) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`m-${Math.random().toString(36).slice(2)}`, AGENT, conversationId, role, 'a body', atMs, role === 'user' ? 'user-text' : 'agent-text');
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.spy = null;
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')").run(AGENT);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('owner_name', 'the owner')").run();
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES (?, ?, 'dashboard', 'dashboard', 'owner')`).run(SERVED, AGENT);
  message(SERVED, 'user', hoursAgo(50));
  message(SERVED, 'assistant', hoursAgo(10));       // the agent's last turn in THIS conversation
});

describe('the other-threads read reads the newest row, not the whole table', () => {
  it('the query plan scans no messages table and groups with no temp b-tree', () => {
    const seen: string[] = [];
    const real = mockDb.current!;
    mockDb.spy = new Proxy(real, {
      get(t, p) {
        if (p === 'prepare') return (sql: string) => { seen.push(sql); return t.prepare(sql); };
        const v = (t as never as Record<string | symbol, unknown>)[p];
        return typeof v === 'function' ? (v as Function).bind(t) : v;
      },
    }) as Database.Database;
    thread('w1', 'contact 1', 'user', hoursAgo(5));
    thread('w2', 'contact 2', 'user', hoursAgo(4));
    thread('w3', 'contact 3', 'user', hoursAgo(3));
    readOtherThreads(AGENT, SERVED);
    mockDb.spy = null;

    const sql = seen.find((s) => s.includes('FROM conversations c'));
    if (!sql) throw new Error(`no activity read was prepared; saw: ${seen.join(' | ')}`);
    const plan = real.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array((sql.match(/\?/g) ?? []).length).fill(AGENT)) as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail);
    expect(details.filter((d) => /^SCAN (m|messages)\b/.test(d)), details.join(' | ')).toEqual([]);
    expect(details.filter((d) => d.includes('TEMP B-TREE FOR GROUP BY')), details.join(' | ')).toEqual([]);
  });

  it('the newest row still decides who spoke last, waiting threads first', () => {
    thread('a', 'contact a', 'user', hoursAgo(30));
    message('a', 'assistant', hoursAgo(3));       // answered, and after the agent's last turn here
    thread('b', 'contact b', 'assistant', hoursAgo(40));
    message('b', 'user', hoursAgo(2));            // they spoke last: waiting
    const rows = readOtherThreads(AGENT, SERVED).rows;
    expect(rows.map((r) => r.label)).toEqual(['contact b (imessage)', 'contact a (imessage)']);
    expect(rows.map((r) => r.theySpokeLast)).toEqual([true, false]);
  });

  it("another agent's newest row in a thread does not change who spoke last", () => {
    db().prepare("INSERT INTO agents (id, name, classification, status) VALUES ('someone-else', 'B', 'sensei', 'idle')").run();
    thread('a', 'contact a', 'user', hoursAgo(30));
    message('a', 'assistant', hoursAgo(3));
    db().prepare(`INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at, display_kind) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`m-${Math.random().toString(36).slice(2)}`, 'someone-else', 'a', 'user', 'a body', hoursAgo(1), 'user-text');
    const rows = readOtherThreads(AGENT, SERVED).rows;
    expect(rows.map((r) => r.label)).toEqual(['contact a (imessage)']);
    expect(rows[0].theySpokeLast).toBe(false);
  });
});
