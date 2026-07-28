// PHASE-1 T2 Step 2 — the duplicate-summary race, and the lock that ends it.
//
// The race (research 22): two compaction runs for the SAME agent overlap. Both
// read the uncompacted set before either has written a summary, so both compact
// the same messages and both write depth-0 summaries over them. Measured in real
// data: 11.4% of depth-0 summaries were duplicates (44 of 387). The platform had
// no mutual-exclusion primitive of any kind, so nothing could stop it.
//
// checkAndCompact is the ONE site that covers all seven compaction entry points
// (v2 loop x4, recovery, the memory route, and the routine background drain), so
// the lock goes there and every caller inherits it.
//
// What is real here and what is not:
//   - DB: REAL better-sqlite3 in-memory on the REAL migration chain.
//   - The summary writes (dag.ts), the uncompacted-set reads (store.ts), the
//     chunking and the compaction control flow: all REAL. The duplicate rows
//     this test counts are the same rows the race produced in production.
//   - Mocked: the summarizer LLM (summarize.js), the vault archive, the
//     broadcast, and the service-agent lookup. None of them participate in the
//     race; all of them need either a model or a filesystem.
//
// The summarizer mock yields on a real macrotask, which is what opens the
// window: run A is awaiting the "model" while run B walks in behind it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const generateSummarySpy = vi.fn();

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../summarize.js', () => ({
  generateSummary: (...args: unknown[]) => generateSummarySpy(...args),
}));

// The vault needs a filesystem and a Dreamer; neither is part of this race.
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

// Partial: only the service-agent lookup is forced (it would otherwise read
// platform config this scratch DB has no reason to carry). Everything else in
// the module — getOwnerName, used by the summary party label — stays real.
vi.mock('../../config/platform.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemServiceAgent: vi.fn(() => false),
}));

import { checkAndCompact } from '../compaction.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-lock-test';
const CONTEXT_WINDOW = 200_000;

/** Rows the summarizer must chew on: long enough to be worth compacting, and
 *  far enough back that they sit outside the fresh tail. */
function seedHistory(db: Database.Database, count: number): string[] {
  const ids: string[] = [];
  const insert = db.prepare(`
    INSERT INTO messages (id, agent_id, role, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < count; i++) {
    const id = `msg-${i.toString().padStart(4, '0')}`;
    ids.push(id);
    // Deliberately chunky content so chunkMessages produces real chunks.
    insert.run(id, AGENT, i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: ${'context '.repeat(400)}`, 2000,
      `2026-07-0${1 + (i % 9)} 10:00:${(i % 60).toString().padStart(2, '0')}`);
  }
  return ids;
}

const depthZeroSummaries = (db: Database.Database): Array<{ id: string }> =>
  db.prepare('SELECT id FROM summaries WHERE agent_id = ? AND depth = 0 ORDER BY id').all(AGENT) as Array<{ id: string }>;

/** message_id -> how many depth-0 summaries claim it. >1 anywhere IS the race. */
function coverageCounts(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`
    SELECT sm.message_id AS mid, COUNT(*) AS n
    FROM summary_messages sm INNER JOIN summaries s ON s.id = sm.summary_id
    WHERE s.agent_id = ? AND s.depth = 0
    GROUP BY sm.message_id
  `).all(AGENT) as Array<{ mid: string; n: number }>;
  return new Map(rows.map(r => [r.mid, r.n]));
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`)
    .run(AGENT, 'Lock Test');
  // The summary-writer model resolver reads models/providers; give it one
  // enabled text-capable model so compaction proceeds instead of bailing.
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('testprov', 'Test', 'openai', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m)
              VALUES ('test-model', 'testprov', 'Test Model', 'test-model', 1, '["text"]', 1)`).run();

  generateSummarySpy.mockReset();
  // Yield on a MACROtask: the awaited summarizer call is the window in which a
  // second compaction can start. A synchronous mock would close the window the
  // race needs and the test would pass against unlocked code, proving nothing.
  generateSummarySpy.mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 5));
    const text = 'A summary of the conversation so far.';
    return { text, tokenCount: 12 };
  });
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.clearAllMocks();
});

describe('checkAndCompact concurrency (PHASE-1 T2)', () => {
  it('two concurrent compactions over one seeded history produce ONE summary set — no message is summarised twice', async () => {
    const db = mockDb.current!;
    const ids = seedHistory(db, 160);

    // Both forced, both for the same agent, launched without awaiting the first
    // — exactly the shape of the live race (the v2 loop's background drain
    // overlapping an emergency compaction).
    const [a, b] = await Promise.all([
      checkAndCompact(AGENT, 'test-model', CONTEXT_WINDOW, { force: true }),
      checkAndCompact(AGENT, 'test-model', CONTEXT_WINDOW, { force: true }),
    ]);

    const summaries = depthZeroSummaries(db);
    const coverage = coverageCounts(db);
    const doubled = [...coverage.entries()].filter(([, n]) => n > 1);

    // The load-bearing assertion: no message belongs to two depth-0 summaries.
    // That is precisely the corruption class research 22 measured at 11.4%.
    expect(doubled).toEqual([]);

    // And the second runner did no summarising work at all: with ifBusy:'skip'
    // it returns the zero result rather than duplicating the first run.
    expect(a.leafCreated + b.leafCreated).toBeGreaterThan(0);
    expect(Math.min(a.leafCreated, b.leafCreated)).toBe(0);

    // Every summarised message is covered exactly once; summaries exist.
    expect(summaries.length).toBeGreaterThan(0);
    for (const [, n] of coverage) expect(n).toBe(1);
    expect([...coverage.keys()].every(id => ids.includes(id))).toBe(true);
  });

  it('a SECOND, non-overlapping compaction still runs — the lock releases, it does not latch the agent shut', async () => {
    // The failure this guards is silent: a lock that never frees its key makes
    // every later compaction a no-op, so the agent stops compacting forever and
    // nothing errors. Sequential calls must behave exactly as before.
    const db = mockDb.current!;
    seedHistory(db, 160);

    const first = await checkAndCompact(AGENT, 'test-model', CONTEXT_WINDOW, { force: true });
    expect(first.leafCreated).toBeGreaterThan(0);
    const afterFirst = depthZeroSummaries(db).length;

    // Fresh material, then compact again. It must do real work.
    const insert = db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, token_count, created_at)
      VALUES (?, ?, 'user', ?, 2000, ?)
    `);
    for (let i = 0; i < 120; i++) {
      insert.run(`later-${i.toString().padStart(4, '0')}`, AGENT, `Later message ${i}: ${'context '.repeat(400)}`,
        `2026-07-2${i % 9} 10:00:${(i % 60).toString().padStart(2, '0')}`);
    }

    const second = await checkAndCompact(AGENT, 'test-model', CONTEXT_WINDOW, { force: true });
    expect(second.leafCreated).toBeGreaterThan(0);
    expect(depthZeroSummaries(db).length).toBeGreaterThan(afterFirst);
  });

  it('two DIFFERENT agents compact concurrently — the lock is per agent, not global', async () => {
    const db = mockDb.current!;
    const OTHER = 'agent-lock-test-2';
    db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`)
      .run(OTHER, 'Lock Test 2');
    seedHistory(db, 160);
    const insert = db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, token_count, created_at)
      VALUES (?, ?, 'user', ?, 2000, ?)
    `);
    for (let i = 0; i < 160; i++) {
      insert.run(`other-${i.toString().padStart(4, '0')}`, OTHER, `Other message ${i}: ${'context '.repeat(400)}`,
        `2026-07-0${1 + (i % 9)} 11:00:${(i % 60).toString().padStart(2, '0')}`);
    }

    const [a, b] = await Promise.all([
      checkAndCompact(AGENT, 'test-model', CONTEXT_WINDOW, { force: true }),
      checkAndCompact(OTHER, 'test-model', CONTEXT_WINDOW, { force: true }),
    ]);

    // Neither was skipped: both agents got their own summaries.
    expect(a.leafCreated).toBeGreaterThan(0);
    expect(b.leafCreated).toBeGreaterThan(0);
    const otherCount = (db.prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND depth = 0').get(OTHER) as { n: number }).n;
    expect(depthZeroSummaries(db).length).toBeGreaterThan(0);
    expect(otherCount).toBeGreaterThan(0);
  });
});
