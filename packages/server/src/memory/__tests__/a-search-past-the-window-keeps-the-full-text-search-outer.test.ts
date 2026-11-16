// An agent with more of its own messages than the full-text window still gets its hit, and the search runs the
// full-text match as the outer loop. With the agent's index outer, SQLite re-runs the match once per row: minutes.
// The statements checked are the ones the product prepares, captured at prepare time.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = vi.hoisted(() => ({ current: null as Database.Database | null }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => mockDb.current!, getDbPath: () => ':memory:', closeDb: () => {},
}));
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]) }));

import { runMigrations } from '../../db/migrations.js';
import { memoryGrep } from '../retrieval.js';
import { hybridSearch } from '../vector-search.js';
import { FTS_CANDIDATE_ROWS } from '../search-bounds.js';

const AGENT = 'agent-main';
const prepared: string[] = [];

beforeAll(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations(db);
  db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(AGENT);
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO messages (id, agent_id, role, lane, content) SELECT 'm-' || i, ?, 'user', 'owner', 'status line ' || i FROM n`)
    .run(FTS_CANDIDATE_ROWS + 10, AGENT);
  db.prepare("INSERT INTO messages (id, agent_id, role, lane, content) VALUES ('m-roof', ?, 'user', 'owner', 'The roof leaks again')").run(AGENT);
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => { prepared.push(sql); return prepare(sql); }) as typeof db.prepare;
});

const outerLoops = (): string[] => prepared.filter((sql) => /messages_fts MATCH/.test(sql)).map((sql) => {
  const plan = mockDb.current!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split('?').length - 1).fill(1)) as Array<{ detail: string }>;
  return plan[0]?.detail ?? '';
});

describe('a search past the full-text window', () => {
  it('history_search finds the hit with the full-text match as the outer loop', async () => {
    prepared.length = 0;
    expect(await memoryGrep(AGENT, { pattern: 'roof leaks', scope: 'messages' })).toContain('leaks<<< again');
    const loops = outerLoops();
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect(loop).toMatch(/^SCAN messages_fts/);
  });

  it("the dashboard's hybrid search does the same", async () => {
    prepared.length = 0;
    const hits = await hybridSearch('roof leaks', AGENT);
    expect(hits.map((h) => h.sourceId)).toContain('m-roof');
    const loops = outerLoops();
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect(loop).toMatch(/^SCAN (messages_)?fts/);
  });
});
