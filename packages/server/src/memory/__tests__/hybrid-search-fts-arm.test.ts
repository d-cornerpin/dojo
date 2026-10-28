// ════════════════════════════════════════════════════════════════════════════════════════
// s05 F2 — THE FTS KEYWORD ARM OF `hybridSearch` MATCHES WHAT `searchMessagesInner` DOES.
//
// The keyword arm drifted from the retrieval path that owns it: it passes the RAW query text
// to FTS5 MATCH (so any `?`, `.` or `'` in the question throws a syntax error and the empty
// catch silently drops the keyword half — `memory_search` comes back with whatever the vector
// half found, or nothing at all), it ranks the WHOLE candidate set with no recency floor, and
// it surfaces the agent's own pure-tool-call echo (content is `[{"type":"tool_use",...}]`),
// which triggers the grep-the-grep loop.
//
// Each case is written to FAIL on the drifted arm and pass once it is brought back in line
// with `searchMessagesInner`:
//   1. a question carrying a `?` finds its row only through the keyword arm — the raw MATCH
//      throws on the punctuation and the catch swallows it, so the answer is empty
//   2. the same question without the `?` is the control: it proves the arm itself works, so a
//      failure in case 1 is the punctuation, not a broken index or a broken call
//   3. a pure tool_use echo row is never returned — over-fetch + `isPureToolCallMessage`
//   4. another agent's matching row is never returned for this agent (control: the agent
//      filter already holds, so case 3's failure is the echo filter, not the filter)
//
// The vector half is stubbed to THROW so the keyword arm is the whole result — exactly the
// shape the drifted arm produced (empty vector half + dead keyword half = nothing).
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

vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => { throw new Error('no embedder'); },
}));

import { insertMessage } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';
import { hybridSearch } from '../vector-search.js';

const AGENT = 'agent-fts';
const PEER = 'agent-fts-peer';

const REAL = 'm-real';
const ECHO = 'm-echo';
const PEER_ROW = 'm-peer';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const ins = mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')");
  ins.run(AGENT, 'Fts Arm');
  ins.run(PEER, 'Fts Peer');

  // The row the question is really about.
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', channel: 'dashboard', id: REAL,
    content: 'Where is the budget spreadsheet for the offsite',
  });
  // The agent's own earlier `memory_search` call, echoed back into the index: its JSON
  // literally contains the search args, so it matches the same terms as the real row.
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', id: ECHO,
    content: '[{"type":"tool_use","id":"t1","name":"memory_search","input":{"query":"budget spreadsheet"}}]',
  });
  // Another agent's row on the same terms: never this agent's answer.
  insertMessage({
    agentId: PEER, role: 'user', lane: 'owner', channel: 'dashboard', id: PEER_ROW,
    content: 'The budget spreadsheet for the offsite is in the shared drive',
  });
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('s05 F2 — the hybrid search keyword arm matches searchMessagesInner', () => {
  it('finds the row through the keyword arm when the question carries a `?`', async () => {
    const results = await hybridSearch('where is the budget spreadsheet?', AGENT);
    const fts = results.filter((r) => r.source === 'fts').map((r) => r.sourceId);
    expect(fts).toEqual([REAL]);
  });

  it('finds the same row when the question has no `?` (control: the arm itself works)', async () => {
    const results = await hybridSearch('where is the budget spreadsheet', AGENT);
    const fts = results.filter((r) => r.source === 'fts').map((r) => r.sourceId);
    expect(fts).toEqual([REAL]);
  });

  it("never returns the agent's own pure tool_use echo row", async () => {
    const results = await hybridSearch('budget spreadsheet', AGENT);
    const ids = results.map((r) => r.sourceId);
    expect(ids).toContain(REAL);
    expect(ids).not.toContain(ECHO);
  });

  it("never returns another agent's matching row (control: the agent filter holds)", async () => {
    const results = await hybridSearch('budget spreadsheet', AGENT);
    const ids = results.map((r) => r.sourceId);
    expect(ids).not.toContain(PEER_ROW);
  });
});
