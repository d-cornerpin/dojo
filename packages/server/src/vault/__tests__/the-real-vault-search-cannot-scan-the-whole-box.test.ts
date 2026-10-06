// ⚠ THE SEARCH THE CAPTURE ACTUALLY RAN. The bounds that landed first went onto the MESSAGE and
// SUMMARY searches (`memory/__tests__/a-search-cannot-scan-the-whole-box.test.ts`,
// `the-offload-is-measured-not-wired.test.ts`). The capture recorded a review running `vault_search`
// twice while the serving thread sat inside ONE synchronous `Statement::JS_all` — and `vault_search`
// is `vault/store.ts`, which had FOUR reads with no bound of any kind. Three had no `LIMIT` at all.
// All four were `SELECT *` over a table whose rows carry a 768-float (3 KB) embedding BLOB.
//
// So these clauses are the deliverable, not the wiring:
//   1. the serving thread stays SERVICEABLE while a vault candidate scan runs, measured on a grown
//      fixture with REAL-SHAPED blobs (starved-ms, the instrument the message side already uses);
//   2. the rows and the BYTES the scan read are COUNTED, and `EXPLAIN QUERY PLAN` shows the capped
//      scan using the index the window is supposed to ride;
//   3. the answers are the pre-fix answers — tie-breaks included — because a bound that changes
//      which entry a `vault_remember` supersedes is not a bound, it is a bug;
//   4. a stop DISCARDS rather than falling back on-thread, which is the one thing the offload buys
//      that bounding alone cannot;
//   5. the cap is LOUD when it bites, naming rows read AND the oldest entry considered, because what
//      a recency cap can cost in a VAULT is an old permanent fact.
//
// The fixture is generated and fictional. It is written to a real file because the reader pool opens
// its own connection: `:memory:` is per-connection by definition and would prove nothing about a
// second thread.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t98-vault-'));
const dbPath = path.join(dbDir, 'fixture.db');
let readDb: Database.Database | null = null;
/** Set by the write-path clause only: `createEntry` needs somewhere it can actually insert. */
let writeDb: Database.Database | null = null;
/** …and the pool reads by PATH on its own connection, so both must move together or it reads the
 *  wrong database and answers every query from the other fixture. */
let writePath: string | null = null;

/**
 * ⚠ EVERY READ THE SERVING CONNECTION ACTUALLY RAN, recorded by SQL.
 *
 * The starvation numbers answer "is the loop alive"; this answers the different question "did the
 * work leave this thread", and it answers it as a COUNT rather than a stopwatch — so it means the
 * same thing on an idle box and on one with nine other suites running. It exists because the first
 * cut of the starvation clause survived a mutant that deleted the pool fork entirely: chunking with a
 * breath between chunks already recovers most of the serviceability (43 % measured), and the pool
 * recovers the rest (63 %). Two real halves, and only one of them is visible to a timing threshold.
 */
let onThreadReads: string[] = [];

/** `getDb()`, wrapped so every `.all()` / `.get()` on this thread's connection is recorded. */
function recordingDb(real: Database.Database): Database.Database {
  const wrapStatement = (sql: string, stmt: unknown): unknown => new Proxy(stmt as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === 'all' || prop === 'get') {
        return (...args: unknown[]) => {
          onThreadReads.push(sql.replace(/\s+/g, ' ').trim());
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrapStatement(sql, real.prepare(sql));
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as Database.Database;
}

/** Captured warns, so the LOUD-truncation clause reads the same logger the module under test uses. */
const warns: Array<{ msg: string; meta: Record<string, unknown> }> = [];
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), error: vi.fn(),
    warn: (msg: string, meta?: unknown) => { warns.push({ msg, meta: (meta ?? {}) as Record<string, unknown> }); },
  }),
}));
vi.mock('../../db/connection.js', () => ({
  getDbPath: () => writePath ?? dbPath,
  getDb: () => {
    const db = writeDb ?? readDb;
    if (!db) throw new Error('fixture not open');
    return recordingDb(db);
  },
}));
// Content-keyed embeddings, so a clause can drive an exact cosine similarity. Nothing else in this
// file embeds anything; the grown fixture's vectors are generated directly.
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: async (text: string) => {
    const v = new Float32Array(8);
    if (text.includes('SAME-FACT')) { v[0] = 1; } else { v[4] = 1; }
    return v;
  },
  queueEmbedding: () => { /* not exercised */ },
  isEmbeddingBackendUnavailable: () => false,
  warnEmbeddingBackendAbsentOnce: () => { /* not exercised */ },
}));

import {
  scanVaultCandidates, fetchVaultRowsByIds, vaultRead, vaultCandidateFloor, byBestSimilarity,
  cosineSimilarity, resetVaultReadWarnsForTest, vaultLikeScan, vaultLikeScanSync,
  VAULT_CANDIDATE_ROWS, VAULT_CANDIDATE_CHUNK_ROWS, VAULT_CANDIDATE_MAX_BYTES, VAULT_BODY_CHUNK_IDS,
} from '../bounded-reads.js';
import { createEntry } from '../store.js';
import { FTS_CANDIDATE_ROWS } from '../../memory/search-bounds.js';
import {
  readerPoolAvailable, readerPendingCount, resetReaderPoolForTest, terminateReaderPool, warmReaderPool,
} from '../../memory/reader-pool.js';

const DIM = 768;
const ROWS = 50_000;
const AGENTS = ['agent-fixture-a', 'agent-fixture-b', 'agent-fixture-c', 'agent-fixture-d'];

/** A deterministic, fictional 768-float vector — the real shape, so the bytes are the real bytes. */
function blobFor(seed: number): Buffer {
  const v = new Float32Array(DIM);
  let x = seed + 1;
  for (let i = 0; i < DIM; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = (x / 2147483648) - 0.5;
  }
  return Buffer.from(v.buffer);
}

function queryVector(): Float32Array {
  const q = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) q[i] = (i % 17) / 17 - 0.5;
  return q;
}

/** t87's metric, reused: elapsed wall time minus the time the loop demonstrably serviced. */
async function measureStarvation(work: () => Promise<unknown>): Promise<{
  starvedMs: number; elapsedMs: number; ticks: number; serviced: number;
}> {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  try { await work(); } finally { clearInterval(timer); }
  const elapsedMs = Date.now() - t0;
  return {
    starvedMs: Math.max(0, elapsedMs - ticks * 10), elapsedMs, ticks,
    serviced: Math.min(1, (ticks * 10) / Math.max(1, elapsedMs)),
  };
}

/** The PRE-FIX read, verbatim in shape: no LIMIT, `SELECT *`, cosine-scored in JavaScript. */
function unboundedScan(db: Database.Database, q: Float32Array): Array<{ id: string; similarity: number }> {
  const rows = db.prepare('SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL')
    .all() as Array<{ id: string; embedding: Buffer }>;
  const scored: Array<{ id: string; similarity: number }> = [];
  for (const row of rows) {
    const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
    scored.push({ id: row.id, similarity: cosineSimilarity(q, emb) });
  }
  return scored;
}

beforeAll(() => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');          // the property that makes a second reader safe
  // The platform's own shape, trimmed to the columns these reads touch.
  db.exec(`CREATE TABLE vault_entries (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT,
    type TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, context TEXT,
    confidence REAL DEFAULT 1.0, is_permanent INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
    is_pinned INTEGER DEFAULT 0, is_obsolete INTEGER DEFAULT 0, superseded_by TEXT,
    retrieval_count INTEGER DEFAULT 0, last_retrieved_at TEXT, source_conversation_id TEXT,
    source TEXT DEFAULT 'extraction', embedding BLOB, namespace TEXT, citation TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX idx_vault_agent ON vault_entries(agent_id)');
  db.exec('CREATE INDEX idx_vault_obsolete ON vault_entries(is_obsolete)');
  const ins = db.prepare(`INSERT INTO vault_entries
    (id, agent_id, type, content, embedding, created_at, updated_at)
    VALUES (?, ?, 'fact', ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`);
  const filler = 'a distilled fictional fact about a made-up project, wide enough to cost real bytes';
  db.transaction(() => {
    for (let i = 0; i < ROWS; i += 1) {
      ins.run(`v-${i}`, AGENTS[i % AGENTS.length], `${filler} — entry ${i}`, blobFor(i));
    }
  })();
  db.close();
  readDb = new Database(dbPath, { readonly: true });
}, 120_000);

afterAll(async () => {
  await terminateReaderPool();
  readDb?.close();
  readDb = null;
  fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  warns.length = 0;
  onThreadReads = [];
  resetVaultReadWarnsForTest();
  resetReaderPoolForTest();
});

/**
 * A small fixture at CHOSEN rowids, for the two fix-round-1 shapes the grown fixture cannot express:
 * a vault whose oldest row is not rowid 1, and a table whose newest rowids belong to someone else.
 */
function fixtureAt(
  name: string,
  rows: ReadonlyArray<{ rid: number; agent: string }>,
): { path: string; close: () => void } {
  const p = path.join(dbDir, `${name}.db`);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${p}${suffix}`, { force: true });
  const d = new Database(p);
  d.pragma('journal_mode = WAL');
  d.exec(`CREATE TABLE vault_entries (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL, is_obsolete INTEGER DEFAULT 0, embedding BLOB, namespace TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  d.exec('CREATE INDEX idx_vault_agent ON vault_entries(agent_id)');
  d.exec('CREATE INDEX idx_vault_obsolete ON vault_entries(is_obsolete)');
  const ins = d.prepare(
    `INSERT INTO vault_entries (rowid, id, agent_id, content, embedding) VALUES (?, ?, ?, ?, ?)`);
  d.transaction(() => {
    for (const r of rows) {
      ins.run(r.rid, `e-${r.rid}`, r.agent, `a fictional fact at ${r.rid}`, blobFor(r.rid));
    }
  })();
  d.close();
  const ro = new Database(p, { readonly: true });
  writeDb = ro;
  writePath = p;
  resetReaderPoolForTest();
  return {
    path: p,
    close: () => {
      writeDb = null;
      writePath = null;
      ro.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${p}${suffix}`, { force: true });
    },
  };
}

describe('⚠ FIX ROUND 1, I1 — A PRUNED VAULT IS NOT A TRUNCATED SEARCH', () => {
  it('a vault whose oldest row was purged says NOTHING, because the cap never bit', async () => {
    // ⚠ THE DEFECT THIS CLAUSE EXISTS FOR, in the review's own numbers. `windowFloor` is
    // `max(capFloor, minRid)`, and the predicate read `windowFloor > 0` — so on ANY vault whose
    // earliest rows were ever pruned (which `vault/maintenance.ts`'s low-confidence purge and both
    // dashboard delete routes produce, and which this file's own purged-vault clause calls every
    // lived-in vault) the line fired with the cap nowhere near biting. 300 live rows at rowids
    // 501-800, ALL 300 scored, and it still said "an older fact than that was NOT scored".
    //
    // One warn per `vault_search` and THREE per `vault_remember`, for the life of the box — which is
    // this file's own "how a log stops being read", and it made a real truncation indistinguishable
    // from the noise. The predicate asks `capFloor > minRid` now: did the CAP cut anything the
    // caller actually owns?
    const live = Array.from({ length: 300 }, (_, i) => ({ rid: 501 + i, agent: AGENTS[0] }));
    const fx = fixtureAt('i1-purged', live);
    try {
      await warmReaderPool();
      warns.length = 0;
      const scan = await scanVaultCandidates({
        label: 'vault_semantic', queryEmbedding: queryVector(),
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[0]],
        agentId: AGENTS[0], scopeAgentIds: [AGENTS[0]],
      });
      expect(scan.scored, 'the fixture did not produce the 300 rows the clause reasons about')
        .toHaveLength(300);
      expect(scan.windowFloor, 'the window should sit at the purge boundary').toBe(500);
      expect(scan.truncated, 'a pruned vault is not a truncated search').toBe(false);
      expect(warns.filter((w) => String(w.meta.subsystem ?? '').startsWith('vault_')),
        'a pruned vault warned about a truncation that did not happen').toEqual([]);
    } finally {
      await terminateReaderPool();
      fx.close();
    }
  }, 180_000);

  it('a vault of exactly `cap` live rows is not truncated either (M3)', async () => {
    // The edge the review folded in: a dense vault of exactly the cap stops `'satisfied'` (the row
    // limit filled) rather than `'exhausted'`, which the old predicate also called a truncation.
    const cap = 40;
    const live = Array.from({ length: cap }, (_, i) => ({ rid: i + 1, agent: AGENTS[0] }));
    const fx = fixtureAt('i1-exact-cap', live);
    try {
      await warmReaderPool();
      warns.length = 0;
      const scan = await scanVaultCandidates({
        label: 'vault_semantic', queryEmbedding: queryVector(),
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[0]],
        agentId: AGENTS[0], scopeAgentIds: [AGENTS[0]], candidateRows: cap, chunkRows: 10,
      });
      expect(scan.scored).toHaveLength(cap);
      expect(scan.report.stoppedBecause, 'the row limit should be what filled').toBe('satisfied');
      expect(scan.truncated, 'a vault of exactly the cap lost nothing to the cap').toBe(false);
      expect(warns.filter((w) => String(w.meta.subsystem ?? '').startsWith('vault_'))).toEqual([]);
    } finally {
      await terminateReaderPool();
      fx.close();
    }
  }, 180_000);

  it('a REAL truncation still warns, and the structured flag says so too (M4)', async () => {
    // Both directions. And `meta.truncated` is asserted because a window truncation used to log
    // `truncated: false` with the fact buried in the prose — a log filter on `truncated: true` would
    // have missed exactly the case R10 cares about.
    const live = Array.from({ length: 200 }, (_, i) => ({ rid: 1001 + i, agent: AGENTS[0] }));
    const fx = fixtureAt('i1-real-truncation', live);
    try {
      await warmReaderPool();
      warns.length = 0;
      const scan = await scanVaultCandidates({
        label: 'vault_semantic', queryEmbedding: queryVector(),
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[0]],
        agentId: AGENTS[0], scopeAgentIds: [AGENTS[0]], candidateRows: 50, chunkRows: 25,
      });
      expect(scan.truncated, 'a cap that cut 150 of the agent\'s own rows must report').toBe(true);
      const warn = warns.find((w) => String(w.meta.subsystem ?? '').startsWith('vault_semantic'));
      expect(warn, 'a real truncation said nothing').toBeTruthy();
      expect(warn!.meta.truncated, 'the STRUCTURED flag must say truncated, not only the prose')
        .toBe(true);
      // ⚠ AND THE LINE NAMES THE FLOOR (I2). It used to name only `oldestRidConsidered`, which is
      // the wrong number in the one case the line exists for.
      expect(String(warn!.meta.reason)).toContain(`above rowid #${scan.windowFloor}`);
    } finally {
      await terminateReaderPool();
      fx.close();
    }
  }, 180_000);
});

describe('⚠ FIX ROUND 1, I2 — THE WINDOW IS THE SCOPE\'S SPAN, NOT THE TABLE\'S', () => {
  it('an agent whose rows are the OLDEST in a wide table is still found', async () => {
    // ⚠ THE REVIEW'S PROBE 3, AS A CLAUSE. The table spans 100,150 rowids; this agent owns rowids
    // 1-50 and another agent owns the newest 100,000. With the GLOBAL span the default cap put the
    // whole window above this agent's newest row and `semanticSearch` returned ZERO hits — and the
    // SAME window governs `findSemanticDuplicate`, so the agent also stopped detecting duplicates of
    // its own older facts. A scope-keyed span costs ~2 µs per id and removes both.
    const mine = Array.from({ length: 50 }, (_, i) => ({ rid: i + 1, agent: AGENTS[0] }));
    const theirs = [{ rid: 100_150, agent: AGENTS[1] }, { rid: 100_100, agent: AGENTS[1] }];
    const fx = fixtureAt('i2-oldest-owner', [...mine, ...theirs]);
    try {
      await warmReaderPool();
      warns.length = 0;
      const scan = await scanVaultCandidates({
        label: 'vault_semantic', queryEmbedding: queryVector(),
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[0]],
        agentId: AGENTS[0], scopeAgentIds: [AGENTS[0]],
      });
      // THE HEADLINE: fifty rows exist and fifty are scored. Pre-fix this was zero.
      expect(scan.scored, 'the scope-keyed window did not reach the agent\'s own rows')
        .toHaveLength(50);
      expect(scan.maxRid, 'the ceiling is the SCOPE\'s newest row, not the table\'s').toBe(50);
      expect(scan.truncated, 'nothing of this agent\'s was cut').toBe(false);
      expect(warns.filter((w) => String(w.meta.subsystem ?? '').startsWith('vault_'))).toEqual([]);
    } finally {
      await terminateReaderPool();
      fx.close();
    }
  }, 180_000);

  it('a scope that owns nothing does no work and says nothing', async () => {
    const fx = fixtureAt('i2-empty-scope', [{ rid: 90_000, agent: AGENTS[1] }]);
    try {
      await warmReaderPool();
      warns.length = 0;
      const scan = await scanVaultCandidates({
        label: 'vault_dedup', queryEmbedding: queryVector(),
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[2]],
        agentId: AGENTS[2], scopeAgentIds: [AGENTS[2]],
      });
      expect(scan.scored).toEqual([]);
      expect(scan.report.chunks, 'a scope with no rows should not walk the table').toBe(0);
      expect(scan.truncated).toBe(false);
      expect(warns.filter((w) => String(w.meta.subsystem ?? '').startsWith('vault_'))).toEqual([]);
    } finally {
      await terminateReaderPool();
      fx.close();
    }
  }, 180_000);

  it('the scope\'s span is N single-aggregate COVERING-INDEX seeks, never one combined IN', () => {
    const reads = fs.readFileSync(new URL('../bounded-reads.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(reads, 'the scoped span lost its per-id MAX seek')
      .toContain("SELECT MAX(rowid) AS r FROM vault_entries WHERE agent_id = ?");
    expect(reads, 'the scoped span lost its per-id MIN seek')
      .toContain("SELECT MIN(rowid) AS r FROM vault_entries WHERE agent_id = ?");
    // A combined `agent_id IN (…)` loses SQLite's min/max optimisation exactly as a combined
    // `MIN(x), MAX(x)` does, which this file already measured at 23.457 ms against 0.015 ms.
    expect(reads, 'the span was combined into one IN — the form that loses the optimisation')
      .not.toMatch(/(?:MIN|MAX)\(rowid\)[^;`]*agent_id IN/);
  });

  it('EXPLAIN confirms the scoped seek rides the covering index', () => {
    const fx = fixtureAt('i2-plan', [{ rid: 7, agent: AGENTS[0] }]);
    try {
      const d = new Database(fx.path, { readonly: true });
      const plan = (sql: string): string =>
        (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as Array<{ detail: string }>)
          .map((r) => r.detail).join(' | ');
      const hi = plan('SELECT MAX(rowid) AS r FROM vault_entries WHERE agent_id = ?');
      const lo = plan('SELECT MIN(rowid) AS r FROM vault_entries WHERE agent_id = ?');
      // eslint-disable-next-line no-console
      console.log(`I2 PLAN  MAX: ${hi}\n         MIN: ${lo}`);
      for (const p of [hi, lo]) {
        expect(p, 'the scoped span is not using idx_vault_agent').toContain('idx_vault_agent');
        expect(p, 'the scoped span fell back to a table scan').not.toMatch(/SCAN vault_entries/);
      }
      d.close();
    } finally {
      fx.close();
    }
  }, 60_000);
});

describe('the bounds are bounds, and every number is argued where it is set', () => {
  it('the candidate window is a no-op on every vault that exists, and a floor past that', () => {
    // A vault smaller than the cap gets floor 0 — which is every real distilled vault, and the
    // reason this is safe to ship at all.
    expect(vaultCandidateFloor(1_000)).toBe(0);
    expect(vaultCandidateFloor(VAULT_CANDIDATE_ROWS)).toBe(0);
    // Past it, the window above the floor is exactly the declared size.
    const floor = vaultCandidateFloor(VAULT_CANDIDATE_ROWS * 3);
    expect(VAULT_CANDIDATE_ROWS * 3 - floor).toBe(VAULT_CANDIDATE_ROWS);
  });

  it('the vault window is TWICE the message window, which is the whole design answer', () => {
    // ⚠ THIS IS THE RULING, NOT A COINCIDENCE. For messages, recency is obviously the right axis:
    // `seq` is append-only and an older match is the one a person is least likely to mean. A
    // DISTILLED VAULT ENTRY IS NOT LIKE THAT — an old permanent fact is exactly what semantic recall
    // is for. Recency is the only monotonic key `vault_entries` has (its `id` is a TEXT uuid), so it
    // is used as a ceiling on pathological size rather than as a relevance heuristic, and doubling
    // the window is the direct expression of that weakness. Change one number without the other and
    // this clause makes you come here and say why.
    expect(VAULT_CANDIDATE_ROWS).toBe(FTS_CANDIDATE_ROWS * 2);
  });

  it('the chunk is sized by the ON-THREAD half, which is the half a pool cannot take away', () => {
    // Cosine scoring happens in JavaScript: the pool hands back rows, and scoring them is main-thread
    // work by construction. So the chunk — not the cap — decides how long the loop goes unserviced.
    // Measured at 0.00175 ms per entry, this size is a worst burst of ~8.8 ms, i.e. one frame.
    const MEASURED_MS_PER_ENTRY_SCORING = 0.00175;
    expect(VAULT_CANDIDATE_CHUNK_ROWS * MEASURED_MS_PER_ENTRY_SCORING).toBeLessThan(16);
    // …and not so small that the cap costs hundreds of round trips to the worker.
    expect(VAULT_CANDIDATE_ROWS / VAULT_CANDIDATE_CHUNK_ROWS).toBeLessThanOrEqual(25);
  });

  it('the BYTE budget never bites at 768 floats and DOES bite at four times the width', () => {
    // ⚠ BOTH DIRECTIONS, because a byte budget that can never bite is decoration and one that always
    // bites is a feature regression. `vault_entries.embedding` carries no dimension column, so the
    // day the platform embeds with a 3072-dimension model every row costs four times as much and a
    // ROW cap cannot see it. At today's width the row cap is the binding one; at four times the
    // width the byte budget is, which is the correct answer and the warn names it.
    expect(VAULT_CANDIDATE_ROWS * DIM * 4).toBeLessThan(VAULT_CANDIDATE_MAX_BYTES);
    expect(VAULT_CANDIDATE_ROWS * DIM * 4 * 4).toBeGreaterThan(VAULT_CANDIDATE_MAX_BYTES);
  });

  it('a body fetch cannot build a statement SQLite will refuse', () => {
    // The winners' id list comes from the caller's `limit`, which on the `vault_search` tool path is
    // a MODEL-SUPPLIED argument. Unchunked, a `limit` of fifty thousand is a fifty-thousand-parameter
    // `IN (…)`. SQLITE_MAX_VARIABLE_NUMBER is 32,766 on a modern build and was 999 on an old one.
    expect(VAULT_BODY_CHUNK_IDS).toBeLessThan(999);
    expect(VAULT_BODY_CHUNK_IDS).toBeGreaterThan(0);
  });
});

describe('⚠ THE REPRODUCTION — the same search, on a grown fixture, before and after', () => {
  it('the UNBOUNDED read pins the loop and the bounded pooled scan does NOT', async () => {
    expect(readerPoolAvailable(), 'worker threads are unavailable in this environment').toBe(true);
    // Warm first: a COLD first query costs ~10 ms of main-thread time (compiling the worker's inline
    // source, opening its connection), which is real, paid once, and belongs at boot.
    await warmReaderPool();
    const q = queryVector();

    // PRE-FIX: `SELECT *` with no LIMIT, every row's 3 KB blob, cosine-scored on this thread.
    const before = await measureStarvation(async () => unboundedScan(readDb!, q));

    // POST-FIX: the shipped shape — `id, embedding` in budgeted chunks through the pool, scored per
    // chunk, one turn of the loop between chunks.
    let after: Awaited<ReturnType<typeof measureStarvation>>;
    let scan: Awaited<ReturnType<typeof scanVaultCandidates>> | null = null;
    after = await measureStarvation(async () => {
      scan = await scanVaultCandidates({
        label: 'vault_semantic', queryEmbedding: q,
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL'], params: [],
      });
    });
    const s = scan as unknown as Awaited<ReturnType<typeof scanVaultCandidates>>;

    // eslint-disable-next-line no-console
    console.log(`VAULT SCAN  unbounded starved ${before.starvedMs}ms of ${before.elapsedMs}ms `
      + `(${before.ticks} ticks, ${(before.serviced * 100).toFixed(0)}% serviced) · bounded+pooled starved `
      + `${after.starvedMs}ms of ${after.elapsedMs}ms (${after.ticks} ticks, `
      + `${(after.serviced * 100).toFixed(0)}% serviced) · ${s.scored.length} of ${ROWS} entries scored in `
      + `${s.report.chunks} chunk(s), ${(s.report.bytesScanned / 1048576).toFixed(1)} MB of embedding read `
      + `· ${(after.elapsedMs / ROWS).toFixed(6)} ms/entry`);

    // The pre-fix shape must actually pin the loop, or this fixture proves nothing. One synchronous
    // `.all()` cannot let a timer fire, so this half is the same fact on every machine.
    expect(before.starvedMs, 'the fixture is too small to pin the loop — nothing to prove').toBeGreaterThan(0);
    expect(before.serviced, 'the unbounded read did not pin the loop').toBeLessThan(0.25);
    // ⚠ t121 — THE RATIO ASSERTION IS GONE, AND ITS OWN COMMENT SAID WHY IT HAD TO GO.
    //
    // It asserted `after.serviced - before.serviced > 0.2`: a twenty-POINT improvement in the
    // fraction of wall time the event loop was serviced. The author had already been bitten once
    // here (the note recorded a first cut at `serviced > 0.4` reddening under load) and moved to a
    // comparative with a three-times margin — but a comparative of two wall-clock ratios is still
    // a wall-clock ratio. Under seven-lane starvation BOTH measurements collapse: the 10 ms
    // interval cannot fire on schedule in either half, `after.serviced` falls toward
    // `before.serviced`, and the margin evaporates. It redded in t120's full run and passed 38/38
    // alone — the signature of a clock being asserted rather than a fact.
    //
    // THE SUBJECT IS UNCHANGED and is still proven, twice, in forms that do not move with load:
    //
    //   1. THE UNBOUNDED SHAPE PINS THE LOOP — kept above, and structural rather than statistical:
    //      one synchronous `.all()` cannot let a timer fire at all, so `before` serviced nothing on
    //      any machine.
    //   2. THE BOUNDED SHAPE HANDS THE LOOP BACK — asserted here as the MECHANISM instead of its
    //      statistical shadow: the read is broken into chunks with a turn of the loop between them,
    //      and the loop demonstrably ran during it (`after.ticks > 0`) where the unbounded read let
    //      it run zero times. That is the same claim the ratio was reaching for, and it degrades in
    //      the SAFE direction: more load means more elapsed time, which gives a 10 ms interval MORE
    //      chances to fire, never fewer.
    //
    // The measurement itself is kept — it is logged above, which is where a benchmark belongs. The
    // counted clauses (zero page reads on the serving connection, `rowsScanned`, `bytesScanned`,
    // `chunks`) remain the stable spine of the claim, exactly as the original note said.
    expect(s.report.chunks,
      'the bounded scan was one synchronous gulp after all — there is no point for the loop to run')
      .toBeGreaterThan(1);
    expect(after.ticks,
      'the loop never ran during the bounded scan, so it was not handed back at all')
      .toBeGreaterThan(0);
    expect(before.ticks,
      'CONTROL: the unbounded read must service the loop strictly less — it is synchronous')
      .toBeLessThan(after.ticks);

    // ⚠ AND THE COST IS COUNTED, not asserted away. The scan says how many rows and how many bytes
    // it read; a bound whose cost nobody reports is the `LIMIT` this whole package replaced.
    expect(s.scored).toHaveLength(ROWS);
    expect(s.report.rowsScanned).toBe(ROWS);
    expect(s.report.bytesScanned).toBe(ROWS * DIM * 4);
    expect(s.report.chunks).toBe(Math.ceil(ROWS / VAULT_CANDIDATE_CHUNK_ROWS));
    // The fixture is smaller than the cap, so nothing was truncated and nothing is warned about.
    expect(s.truncated).toBe(false);
    expect(s.windowFloor).toBe(0);
    expect(warns, 'an untruncated scan must say nothing').toEqual([]);
  }, 180_000);

  it('EXPLAIN QUERY PLAN shows the capped scan riding an index, not sorting the table', () => {
    // The window is only affordable if SQLite can push the rowid floor into its seek. If this ever
    // reads `SCAN vault_entries` with a `USE TEMP B-TREE FOR ORDER BY`, the bound costs more than it
    // saves and this clause is where that shows up.
    const plan = readDb!.prepare(`EXPLAIN QUERY PLAN
      SELECT id, embedding, rowid AS rid FROM vault_entries
      WHERE is_obsolete = 0 AND embedding IS NOT NULL AND rowid <= ? AND rowid > ?
      ORDER BY rid DESC`).all(ROWS, ROWS - VAULT_CANDIDATE_CHUNK_ROWS) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' | ');
    // eslint-disable-next-line no-console
    console.log(`VAULT PLAN  capped candidate scan: ${detail}`);
    expect(detail).toMatch(/rowid>\?/);
    expect(detail, 'the capped scan fell back to a sort over the whole table')
      .not.toMatch(/TEMP B-TREE FOR ORDER BY/);

    // And the pre-fix shape, for the contrast the report quotes: the same index, no window.
    const prePlan = readDb!.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL`)
      .all() as Array<{ detail: string }>;
    // eslint-disable-next-line no-console
    console.log(`VAULT PLAN  pre-fix unbounded scan: ${prePlan.map((p) => p.detail).join(' | ')}`);
    expect(prePlan.map((p) => p.detail).join(' | ')).not.toMatch(/rowid>\?/);
  });
});

describe('⚠ THE WORK LEAVES THIS THREAD — counted, not timed', () => {
  it('a pooled candidate scan runs NO page read on the serving connection', async () => {
    await warmReaderPool();
    onThreadReads = [];
    const scan = await scanVaultCandidates({
      label: 'vault_semantic', queryEmbedding: queryVector(),
      conditions: ['is_obsolete = 0', 'embedding IS NOT NULL'], params: [],
    });
    expect(scan.scored).toHaveLength(ROWS);

    // ⚠ ZERO, NOT "FEWER". Ten chunks of page reads either happened on this connection or they did
    // not, and a count cannot be argued with the way a millisecond can. Delete the pool fork and this
    // reads ten.
    const pageReads = onThreadReads.filter((s) => s.includes('embedding, rowid AS rid'));
    expect(pageReads, 'the candidate page ran on the serving connection — the pool was bypassed')
      .toEqual([]);
    // What DOES stay on this thread is one O(log n) seek against the integer primary key, which is
    // cheaper than the round trip that would replace it, and it is stated at the site.
    expect(onThreadReads.filter((s) => s.includes('MAX(rowid)')),
      'the window cost more than one indexed seek on the serving thread').toHaveLength(1);
  }, 180_000);

  it('a pooled winners fetch runs no body read on the serving connection either', async () => {
    await warmReaderPool();
    onThreadReads = [];
    const rows = await fetchVaultRowsByIds<{ id: string }>({
      label: 'vault_semantic', ids: ['v-1', 'v-2', 'v-3'],
    });
    expect(rows).toHaveLength(3);
    expect(onThreadReads.filter((s) => s.startsWith('SELECT * FROM vault_entries WHERE id IN')),
      'the winners\' bodies were read on the serving connection').toEqual([]);
  }, 60_000);

  it('the pooled LIKE walk runs neither its cost read nor its page on this connection', async () => {
    await warmReaderPool();
    onThreadReads = [];
    await vaultLikeScan<{ id: string }>({
      scope: ['is_obsolete = 0'], scopeParams: [],
      match: ['content LIKE ?'], matchParams: ['%entry 4242%'],
      limit: 2,
    });
    const walked = onThreadReads.filter((s) => /content LIKE|COUNT\(\*\) AS n, COALESCE/.test(s));
    expect(walked, 'the exact search walked the table on the serving connection').toEqual([]);
  }, 180_000);
});

describe('⚠ FIX ROUND 1, I4 — THE POOL-DOWN FALLBACK BREATHES, AND IT DOES NOT DEADLOCK', () => {
  it('a bounded scan with the pool DOWN still leaves the loop serviceable', async () => {
    // ⚠ WHAT DELETING THE BREATHE COST, in the review's measurement: pool up 68 % serviced; pool
    // DOWN **207 ms, 0 ticks, 0 % serviced** at 60,000 rows, because `vaultRead` then resolves on a
    // microtask and the chunks run back-to-back. The earlier cut measured 43 % serviced WITH a
    // breathe. The yield is real work, and the pool-down mode is exactly the box that can least
    // afford a pinned thread.
    //
    // The pool is taken down the way production takes it down — `terminateReaderPool()` latches it —
    // so this measures the shipped fallback and not a stub.
    await terminateReaderPool();
    expect(readerPoolAvailable(), 'the pool must be DOWN for this clause to mean anything').toBe(false);
    const q = queryVector();
    const measured = await measureStarvation(async () => {
      await scanVaultCandidates({
        label: 'vault_semantic', queryEmbedding: q,
        conditions: ['is_obsolete = 0', 'embedding IS NOT NULL'], params: [],
        chunkRows: 2_500,
      });
    });
    // eslint-disable-next-line no-console
    console.log(`POOL-DOWN  starved ${measured.starvedMs}ms of ${measured.elapsedMs}ms `
      + `(${measured.ticks} ticks, ${(measured.serviced * 100).toFixed(0)}% serviced) over ${ROWS} rows`);
    // ⚠ A FRACTION, NOT A CEILING — nine suites share this box. Pre-fix this was 0 %; the floor is
    // set well below the 43 % the breathe measured so that a loaded machine cannot red it.
    expect(measured.ticks, 'the pool-down scan serviced no ticks at all — the breathe is gone again')
      .toBeGreaterThan(0);
    expect(measured.serviced, 'the pool-down scan pinned the loop').toBeGreaterThan(0.15);
    resetReaderPoolForTest();
  }, 180_000);

  it('the breathe comes from `node:timers`, which a caller holding the clock does not fake', () => {
    // ⚠ THE PROBE THAT SETTLED IT, run with one arm per `it` and NO guard timer, because the two
    // earlier attempts both raced the answer against a faked guard they then advanced — and lied in
    // opposite directions:
    //       global setImmediate      → TIMED OUT (faked)
    //       node:timers setImmediate → resolved
    //       MessageChannel           → resolved
    // So the unfaked binding avoids both the stall and the deadlock. The source clause pins WHICH
    // binding, because the global one is the obvious edit and it is the one that hangs
    // `the-prefix-holds-still.test.ts` for thirty seconds a clause.
    const reads = fs.readFileSync(new URL('../bounded-reads.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(reads, 'the breathe must come from the unfaked node:timers binding')
      .toMatch(/import \{ setImmediate as setImmediateUnfaked \} from 'node:timers'/);
    expect(reads, 'the breathe must USE that binding, not the global')
      .toMatch(/setImmediateUnfaked\(resolve\)/);
    // Both walks take it: a yield on one door and not the other is the shape that gets missed.
    expect((reads.match(/breathe: vaultBreathe/g) ?? []).length,
      'both bounded walks must breathe — the candidate scan and the pooled LIKE walk').toBe(2);
  });
});

describe('⚠ THE ANSWERS ARE THE PRE-FIX ANSWERS — a bound that moves results is a bug', () => {
  it('the bounded scan + the winners fetch return exactly what the unbounded read returned', async () => {
    await warmReaderPool();
    const q = queryVector();
    const minSim = 0.02;
    const limit = 10;

    // The pre-fix pipeline, verbatim: score everything, filter, sort by similarity, slice.
    const expected = unboundedScan(readDb!, q)
      .filter((r) => r.similarity >= minSim)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    expect(expected.length, 'the fixture produced no hits — the clause would be vacuous').toBe(limit);

    // The shipped pipeline.
    const scan = await scanVaultCandidates({
      label: 'vault_semantic', queryEmbedding: q,
      conditions: ['is_obsolete = 0', 'embedding IS NOT NULL'], params: [],
    });
    const winners = scan.scored.filter((c) => c.similarity >= minSim).sort(byBestSimilarity).slice(0, limit);

    expect(winners.map((w) => w.id)).toEqual(expected.map((e) => e.id));
    for (let i = 0; i < limit; i += 1) {
      expect(winners[i].similarity).toBeCloseTo(expected[i].similarity, 10);
    }

    // …and the bodies come back for those ids and nothing else, which is the "winners only" half.
    const rows = await fetchVaultRowsByIds<{ id: string; content: string; embedding: Buffer }>({
      label: 'vault_semantic', ids: winners.map((w) => w.id),
    });
    expect(rows).toHaveLength(limit);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(expected.map((e) => e.id)));
    expect(rows.every((r) => r.content.length > 0), 'a winner came back without its body').toBe(true);
  }, 180_000);

  it('⚠ BEHAVIOURALLY: a supersede destroys the OLDEST duplicate, not the newest', async () => {
    // ⚠ A CLAUSE DEFECT OF MY OWN, AND THE MUTANT THAT FOUND IT. My first version of this check
    // re-implemented the selection sort inside the test and asserted on that — so it was testing the
    // test, and flipping `a.rid - b.rid` to `b.rid - a.rid` in `store.ts` left it green. The rule is
    // only worth asserting where it BITES: `findSemanticDuplicate` hands `createEntry` the entry it
    // then marks obsolete, so "which hit" is a destructive decision and not a ranking preference.
    const p = path.join(dbDir, 'write.db');
    fs.rmSync(p, { force: true });
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT,
      type TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, context TEXT,
      confidence REAL DEFAULT 1.0, is_permanent INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0, is_obsolete INTEGER DEFAULT 0, superseded_by TEXT,
      retrieval_count INTEGER DEFAULT 0, last_retrieved_at TEXT, source_conversation_id TEXT,
      source TEXT DEFAULT 'extraction', embedding BLOB, namespace TEXT, citation TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    writeDb = db;
    writePath = p;
    resetReaderPoolForTest();
    try {
      // Two entries, same fictional fact, IDENTICAL embeddings — so both score 1.0 against the new
      // content and the only thing separating them is which was written first.
      const sameEmb = Buffer.from(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]).buffer);
      const ins = db.prepare(
        `INSERT INTO vault_entries (id, agent_id, type, content, embedding, created_at, updated_at)
         VALUES (?, 'agent-write', 'fact', ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`);
      ins.run('older-entry', 'SAME-FACT the made-up tunnel provider is alpha', sameEmb);
      ins.run('newer-entry', 'SAME-FACT the made-up tunnel provider is bravo', sameEmb);

      // A correction of the same fact: >= 0.92 similar, different substance, so `createEntry`
      // supersedes rather than skipping.
      const created = await createEntry({
        agentId: 'agent-write', type: 'fact',
        content: 'SAME-FACT the made-up tunnel provider is charlie',
      });

      const row = (id: string): { is_obsolete: number; superseded_by: string | null } =>
        db.prepare('SELECT is_obsolete, superseded_by FROM vault_entries WHERE id = ?')
          .get(id) as { is_obsolete: number; superseded_by: string | null };
      expect(row('older-entry').is_obsolete, 'the OLDEST duplicate must be the one superseded').toBe(1);
      expect(row('older-entry').superseded_by).toBe(created.id);
      expect(row('newer-entry').is_obsolete, 'a newer duplicate was destroyed instead').toBe(0);
    } finally {
      await terminateReaderPool();
      writeDb = null;
      writePath = null;
      db.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${p}${suffix}`, { force: true });
    }
  }, 60_000);

  it('a tie breaks to the OLDER entry, which is the order the pre-fix reads depended on', () => {
    // ⚠ THE RULE THAT WOULD HAVE FLIPPED SILENTLY. The unbounded reads had no `ORDER BY`, so SQLite
    // returned them rowid-ascending and `Array.prototype.sort`'s stability made "oldest wins a tie"
    // the shipped behaviour — in `semanticSearch`'s ranking AND in the near-duplicate band's
    // strict-`>` best tracker. The bounded walk arrives NEWEST-first, so without a spelled-out
    // tie-break an equal-similarity tie would quietly change which entry a caller is handed.
    const tied = [
      { id: 'newer', rid: 90, similarity: 0.8 },
      { id: 'older', rid: 10, similarity: 0.8 },
      { id: 'best', rid: 50, similarity: 0.9 },
    ];
    expect([...tied].sort(byBestSimilarity).map((c) => c.id)).toEqual(['best', 'older', 'newer']);
    // And reversing the input cannot change the answer, which is the property worth having.
    expect([...tied].reverse().sort(byBestSimilarity).map((c) => c.id)).toEqual(['best', 'older', 'newer']);
  });

  it('the write path\'s duplicate check still picks the OLDEST hit — the entry it supersedes', async () => {
    await warmReaderPool();
    // `findSemanticDuplicate` returns the entry the caller then marks obsolete, so "which hit" is a
    // destructive decision and not a ranking preference. Pre-fix it was the oldest above the
    // threshold, because that is the one SQLite's rowid-ascending walk reached first.
    const q = queryVector();
    const scan = await scanVaultCandidates({
      label: 'vault_dedup', queryEmbedding: q,
      conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[0]],
      agentId: AGENTS[0],
    });
    const threshold = scan.scored.map((c) => c.similarity).sort((a, b) => b - a)[4];
    const hits = scan.scored.filter((c) => c.similarity >= threshold);
    expect(hits.length, 'the fixture produced too few hits to show a choice').toBeGreaterThan(1);
    const chosen = [...hits].sort((a, b) => a.rid - b.rid)[0];
    expect(chosen.rid).toBe(Math.min(...hits.map((h) => h.rid)));
  }, 180_000);
});

describe('⚠ THE EXACT SEARCH — where a `LIMIT` bounded the answer and not the work', () => {
  it('the bounded LIKE walk finds the newest matches and reports what it had to TEST', async () => {
    await warmReaderPool();
    // A term that matches a handful of entries near the OLD end of the table, so the walk has to
    // keep going — the shape whose pre-fix cost was "every row the agent owns".
    const rows = await vaultLikeScan<{ id: string; content: string }>({
      scope: ['is_obsolete = 0', 'namespace IS NULL'],
      scopeParams: [],
      match: ['content LIKE ?'],
      matchParams: ['%entry 7%'],
      limit: 5,
    });
    expect(rows).toHaveLength(5);
    // Newest-first, which is the declared behaviour change from `created_at DESC`: `created_at` is a
    // second-resolution string every fixture row shares, so it was never a usable order here.
    const ids = rows.map((r) => Number(r.id.slice(2)));
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(rows.every((r) => r.content.includes('entry 7'))).toBe(true);

    // ⚠ AND THE COST IS SAID OUT LOUD WHEN THE WALK TAKES MORE THAN ONE CHUNK, with the rows TESTED
    // and the content bytes read — the two numbers the pre-fix `LIMIT` hid.
    const warn = warns.find((w) => w.meta.subsystem === 'vault_exact:like');
    if (warn) {
      expect(warn.meta.rowsScanned as number).toBeGreaterThan(5);
      expect(warn.meta.bytesScanned as number).toBeGreaterThan(0);
      expect(JSON.stringify(warn), 'the warn carried the query text').not.toContain('entry 7');
    }
  }, 180_000);

  it('a term that is nowhere STOPS inside its budget instead of walking the table', async () => {
    await warmReaderPool();
    const rows = await vaultLikeScan<{ id: string }>({
      scope: ['is_obsolete = 0'], scopeParams: [],
      match: ['content LIKE ?'], matchParams: ['%nothing-in-this-fixture-matches-this%'],
      limit: 5,
    });
    expect(rows).toHaveLength(0);
    // The incident's shape: the LIMIT never fills, so the walk has no reason of its own to stop.
    // Here it does, and it says how far it got.
    const warn = warns.find((w) => w.meta.subsystem === 'vault_exact:like');
    expect(warn, 'a multi-chunk miss said nothing — the original silent fallback, again').toBeTruthy();
    expect(warn!.meta.rowsScanned as number).toBeGreaterThan(0);
  }, 180_000);

  it('⚠ A PURGED VAULT DOES NOT WALK DOWN TO ROWID 1 — the floor has to be TOLD', async () => {
    // ⚠ A CLAUSE DEFECT OF MY OWN, AND IT IS THE ONE t89's C1 ROUND RECORDED ABOUT ITSELF. The grown
    // fixture above starts at rowid 1, so `floorRowid` and the old `ceiling <= 0` stop in the same
    // place and a mutant that DELETES the floor passes every clause. A real vault does not start at
    // rowid 1: entries are deleted (`deleteEntry`, the Dreamer's pruning), and SQLite does not reuse
    // the keys — so `MIN(rowid)` on a lived-in vault is a large number and everything below it is a
    // stretch of keys holding nothing at all.
    //
    // This fixture is that vault: a hundred entries at rowids 900,001-900,100 and nothing beneath
    // them. Told its floor, the walk asks for ONE chunk. Not told, it steps 20,000 keys at a time
    // from 900,100 to zero — forty-six chunks of two indexed reads each, every one of them certain
    // in advance to find nothing.
    const p = path.join(dbDir, 'purged.db');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${p}${suffix}`, { force: true });
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL, is_obsolete INTEGER DEFAULT 0, embedding BLOB, namespace TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    const ins = db.prepare(
      `INSERT INTO vault_entries (rowid, id, agent_id, content) VALUES (?, ?, 'agent-purged', ?)`);
    db.transaction(() => {
      for (let i = 1; i <= 100; i += 1) ins.run(900_000 + i, `p-${i}`, `a fictional surviving fact ${i}`);
    })();
    writeDb = db;
    writePath = p;
    try {
      // ⚠ THE SYNCHRONOUS DOOR, DELIBERATELY, because the instrument is a COUNT of reads on THIS
      // connection and a pooled read is invisible to it by design. Both doors take their floor from
      // the same `vaultRowidSpan`, so the property is one property; and the sync door is the one the
      // three call sites outside this lane's fence still use, which makes it the more valuable half
      // to pin. One chunk = one cost read.
      onThreadReads = [];
      const rows = vaultLikeScanSync<{ id: string }>({
        scope: ['is_obsolete = 0'], scopeParams: [],
        match: ['content LIKE ?'], matchParams: ['%nothing-here-matches-this%'],
        limit: 5,
      });
      expect(rows).toHaveLength(0);
      const costReads = onThreadReads.filter((q) => q.includes('COUNT(*) AS n, COALESCE'));
      expect(costReads.length, 'the walk stepped past the oldest row that exists').toBe(1);
      // And the span is read as TWO single-aggregate statements, never one combined `MIN(x), MAX(x)`
      // — the form that silently loses SQLite's min/max optimisation and prints the identical plan,
      // so no EXPLAIN clause could catch it (t89 measured 23.457 ms against 0.015 ms).
      expect(onThreadReads.filter((q) => q.includes('MAX(rowid)'))).toHaveLength(1);
      expect(onThreadReads.filter((q) => q.includes('MIN(rowid)'))).toHaveLength(1);
      expect(onThreadReads.filter((q) => /MIN\(rowid\)[\s\S]*MAX\(rowid\)|MAX\(rowid\)[\s\S]*MIN\(rowid\)/.test(q)),
        'the span was read as one combined aggregate — the form that loses the optimisation').toEqual([]);
    } finally {
      writeDb = null;
      writePath = null;
      db.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${p}${suffix}`, { force: true });
    }
  }, 180_000);

  it('the synchronous door is bounded too — the three call sites outside this fence still get it', () => {
    const rows = vaultLikeScanSync<{ id: string }>({
      scope: ['is_obsolete = 0'], scopeParams: [],
      match: ['content LIKE ?'], matchParams: ['%entry 123%'],
      limit: 3,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it('a body fetch wider than one batch still returns every winner', async () => {
    await warmReaderPool();
    // The chunked `IN (…)`: more ids than `VAULT_BODY_CHUNK_IDS`, so the loop runs more than once and
    // the batches have to be concatenated rather than the last one winning.
    const ids = Array.from({ length: VAULT_BODY_CHUNK_IDS * 2 + 7 }, (_, i) => `v-${i}`);
    const rows = await fetchVaultRowsByIds<{ id: string }>({ label: 'vault_semantic', ids });
    expect(rows).toHaveLength(ids.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(ids.length);
  }, 180_000);
});

describe('⚠ THE CAP IS LOUD WHEN IT BITES, and it names the old fact it may have missed', () => {
  it('a truncated window warns with the rows read AND the oldest entry considered', async () => {
    await warmReaderPool();
    const cap = 10_000;
    const scan = await scanVaultCandidates({
      label: 'vault_semantic', queryEmbedding: queryVector(),
      conditions: ['is_obsolete = 0', 'embedding IS NOT NULL'], params: [],
      candidateRows: cap, chunkRows: 2_000, agentId: AGENTS[0],
    });

    expect(scan.windowFloor).toBe(ROWS - cap);
    expect(scan.truncated).toBe(true);
    expect(scan.scored).toHaveLength(cap);
    // ⚠ THE NUMBER THAT MAKES A MISS DIAGNOSABLE. A recency cap on a VAULT can cost an old permanent
    // fact — which is exactly what semantic recall is for — so the line has to say how far back the
    // search actually looked, not merely that a bound existed.
    expect(scan.oldestRidConsidered).toBe(ROWS - cap + 1);

    expect(warns.length, 'a truncated vault window said nothing').toBeGreaterThan(0);
    const warn = warns.find((w) => String(w.meta.subsystem ?? '').startsWith('vault_semantic'));
    expect(warn, 'the warn is not attributed to the vault candidate scan').toBeTruthy();
    expect(warn!.meta.rowsScanned).toBe(cap);
    expect(String(warn!.meta.reason)).toContain(`newest ${cap} entr(ies)`);
    expect(String(warn!.meta.reason)).toContain(`#${scan.oldestRidConsidered}`);
    expect(String(warn!.meta.reason)).toContain('NOT scored');
    // ⚠ NO QUERY TEXT, NO CONTENT, NO SNIPPET: this line reaches pasted logs.
    expect(JSON.stringify(warn)).not.toMatch(/distilled fictional fact|LIKE '|%/);
  }, 180_000);

  it('⚠ THE WINDOW IS THE COST BOUND, and a SPARSE scope is what proves it', async () => {
    // ⚠ WHY THIS CLAUSE EXISTS, written down because its absence let a mutant live. My first cut
    // proved the cap on a DENSE scope — every row in the window matched — and in that case the scan's
    // row limit stops the walk at the same place the window would, so deleting the window's clamp
    // changed nothing a clause could see. The two bounds are NOT the same bound:
    //
    //   · the row limit counts entries SCORED, and so bounds the answer-shaped half;
    //   · the rowid window counts rowids WALKED, and so bounds the COST — which is the whole point,
    //     because the pathological vault is the one where most rows are obsolete or belong to another
    //     agent and the limit therefore never fills.
    //
    // One agent owns a quarter of this fixture, so a 2,000-rowid chunk yields ~500 scored and a cap
    // of 10,000 SCORED entries would need forty thousand rowids. The window allows five chunks. The
    // numbers below are that arithmetic, and the mutant that drops `windowFloor` from the chunk's
    // floor walks on past them to the bottom of the table.
    await warmReaderPool();
    // ⚠ THE CAP IS DELIBERATELY NOT A WHOLE NUMBER OF CHUNKS, and that is the second half of this
    // clause's own history. Once the walk is TOLD its floor (t89's C1 — `floorRowid`), the loop stops
    // at `ceiling <= floor` and never asks for a chunk below the window; so with a cap that divides
    // evenly the per-chunk clamp becomes unreachable and a mutant deleting it is invisible again. At
    // 9,000 over chunks of 2,000 the window edge falls MID-CHUNK, which is the only case the clamp
    // exists for and therefore the only case that can prove it.
    const cap = 9_000;
    const chunk = 2_000;
    const scan = await scanVaultCandidates({
      label: 'vault_semantic', queryEmbedding: queryVector(),
      conditions: ['is_obsolete = 0', 'embedding IS NOT NULL', 'agent_id = ?'], params: [AGENTS[0]],
      candidateRows: cap, chunkRows: chunk, agentId: AGENTS[0],
    });
    expect(scan.windowFloor).toBe(ROWS - cap);
    // Five chunks: four full, and a fifth clamped to the window edge. The walk then stops on the
    // FLOOR rather than on an empty chunk, which is what C1 bought.
    expect(scan.report.chunks, 'the walk went past the window edge').toBe(Math.ceil(cap / chunk));
    expect(scan.scored.length, 'the walk scored more than the window could hold')
      .toBe(cap / AGENTS.length);
    expect(scan.report.stoppedBecause, 'the window edge must END the walk, not a budget').toBe('exhausted');
    // ⚠ THE ASSERTION THE CLAMP OWNS: nothing older than the window was scored. Delete the clamp and
    // the fifth chunk reads a thousand rowids BELOW the floor, and this is where it shows.
    expect(scan.oldestRidConsidered, 'the walk looked older than the window allowed')
      .toBeGreaterThan(ROWS - cap);
    expect(scan.truncated).toBe(true);
  }, 180_000);

  it('the pool-fallback warn is said ONCE per distinct failure, not once per read', async () => {
    // A reader worker whose connection could not be opened answers every query with the same error
    // for the life of the process, so a per-read warn turns one standing condition into a line per
    // search — the same way a log stops being read as the silent fallback this package replaced.
    const failing: () => never[] = () => { throw new Error('the on-thread path is not what this clause measures'); };
    await expect(vaultRead('clause:probe', 'SELECT nope FROM nowhere', [], failing))
      .rejects.toThrow(/on-thread path/);
    const first = warns.filter((w) => w.msg.includes('could not use the reader pool')).length;
    await expect(vaultRead('clause:probe', 'SELECT nope FROM nowhere', [], failing))
      .rejects.toThrow(/on-thread path/);
    const second = warns.filter((w) => w.msg.includes('could not use the reader pool')).length;
    expect(first).toBe(1);
    expect(second, 'the same standing failure warned twice').toBe(1);
  }, 60_000);
});

describe('⚠ A STOP IS REAL ON THIS PATH FOR THE FIRST TIME', () => {
  it('an aborted read REJECTS and does NOT quietly re-run the work on the serving thread', async () => {
    await warmReaderPool();
    // ⚠ THE WHOLE POINT, AND THE EASY BUG. `vaultRead` falls back on-thread when the pool errors —
    // which is right for a hiccup and catastrophic for an abort: re-running would resurrect exactly
    // the scan the user just stopped, on the thread that could not even receive the stop.
    let onThreadRuns = 0;
    const ac = new AbortController();
    ac.abort();
    await expect(vaultRead(
      'clause:aborted',
      'SELECT COUNT(*) AS n FROM vault_entries',
      [],
      () => { onThreadRuns += 1; return []; },
      ac.signal,
    )).rejects.toThrow(/abort/i);
    expect(onThreadRuns, 'an aborted read was re-run on the serving thread').toBe(0);
    expect(readerPendingCount(), 'the aborted read was not discarded').toBe(0);
  }, 60_000);

  it('a stop mid-scan ends the whole walk, not just the chunk it was in', async () => {
    await warmReaderPool();
    const ac = new AbortController();
    const inFlight = scanVaultCandidates({
      label: 'vault_semantic', queryEmbedding: queryVector(),
      conditions: ['is_obsolete = 0', 'embedding IS NOT NULL'], params: [],
      chunkRows: 500, signal: ac.signal,
    });
    // Abort while the first chunks are still being read; the rejection must come out of the SCAN.
    setTimeout(() => ac.abort(), 5);
    await expect(inFlight).rejects.toThrow(/abort/i);
    expect(readerPendingCount()).toBe(0);
    // …and the pool survives it, which is the "a stop is not a crash" half.
    const rows = await vaultRead<{ n: number }>(
      'clause:after-abort', 'SELECT COUNT(*) AS n FROM vault_entries', [],
      () => { throw new Error('the pool should have answered'); },
    );
    expect(rows[0].n).toBe(ROWS);
  }, 180_000);
});

describe('⚠ THE WIRE — and it COUNTS, in both directions', () => {
  const SRC = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8');
  /** Comments stripped, because a clause satisfiable by the prose above a call tests the prose. */
  const code = (rel: string): string =>
    SRC(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('there is exactly ONE pool door, and exactly FOUR reads go through it', () => {
    const reads = code('../bounded-reads.ts');
    // ⚠ COUNTED EXACTLY, NOT `toBeGreaterThanOrEqual`. A `>=` clause stays green when a FIFTH read is
    // added without the fork, which is precisely how a helper ends up fully covered while the line
    // joining it to a caller is not. Adding a read reds this; deleting a wire reds it too; and the
    // reader has to come here and say which it was.
    expect((reads.match(/readerPoolAvailable\(\)/g) ?? []).length,
      'the pool-or-thread decision must have ONE spelling').toBe(1);
    expect((reads.match(/readerQuery</g) ?? []).length,
      'every pooled read goes through vaultRead, so there is one readerQuery call').toBe(1);
    expect((reads.match(/await vaultRead</g) ?? []).length,
      'FOUR pooled reads: the candidate page, the winners\' bodies, and the LIKE walk\'s cost + page').toBe(4);
    // And the door re-throws an abort rather than falling back — asserted on the CALL, not the prose.
    expect(reads, 'an aborted read must be re-thrown, never re-run on-thread')
      .toMatch(/if\s*\(signal\?\.aborted\)\s*throw\s+err;/);
  });

  it('all FOUR of store.ts\'s reads are converted, counted by site', () => {
    const store = code('../store.ts');
    // Three semantic sites (the search, the write path's duplicate check, the near-duplicate band)…
    expect((store.match(/scanVaultCandidates\(\{/g) ?? []).length,
      'three semantic reads: semanticSearch, findSemanticDuplicate, findNearDuplicateEntry').toBe(3);
    expect((store.match(/fetchVaultRowsByIds</g) ?? []).length,
      'each semantic site fetches bodies for its winners and nothing else').toBe(3);
    // …and the fourth, the exact search, in both of its doors.
    expect((store.match(/vaultLikeScanSync</g) ?? []).length, 'the synchronous exact-search door').toBe(1);
    expect((store.match(/vaultLikeScan</g) ?? []).length, 'the pooled exact-search door').toBe(1);
    // The pooled door has a REAL caller inside this file, not a dead export: the embed-outage
    // fallback, which is the exact-search SQL on the serving thread for the length of an outage.
    expect(store, 'listEntriesBounded is declared and never called — a wire to nowhere')
      .toMatch(/await listEntriesBounded\(/);
    // store.ts does not reach the pool itself; it has one route in.
    expect(store).not.toMatch(/readerQuery|readerPoolAvailable/);
  });

  // Every `SELECT … FROM vault_entries`, one entry per statement, whitespace normalised. The lazy
  // span refuses to cross another `SELECT`, which is what stops one function's read bleeding into
  // the next function's table (it did, on the first cut of this clause).
  const CENSUS = /SELECT(?:(?!\bSELECT\b)[\s\S])*?FROM vault_entries(?:(?!\bSELECT\b)[^`';])*/g;
  const census = (src: string): string[] =>
    [...src.matchAll(CENSUS)].map((m) => m[0].replace(/\s+/g, ' ').trim());

  it('⚠ NO UNBOUNDED VAULT SCAN SURVIVES — the other direction, as a CENSUS', () => {
    // ⚠ A CENSUS AND NOT AN ALLOWLIST, and the difference is which way it fails. A rule of the form
    // "these statements are blessed" goes stale silently; a census of what is UNBOUNDED reds when a
    // fifteenth read appears, whichever kind it is, and makes the author come here and say which.
    //
    // A read of `vault_entries` is bounded when it carries a `LIMIT`, is keyed on `id`, or is an
    // aggregate (one row out, whatever it scanned — still a scan, but not a 3 KB-per-row one).
    const store = code('../store.ts');
    const stmts = census(store);
    expect(stmts.length, 'the census found nothing — the regex broke, not the code').toBeGreaterThan(10);
    const unbounded = stmts.filter((s) => !(
      /\bLIMIT\b/i.test(s) || /\bid = \?/.test(s) || /\bid IN \(/.test(s)
      || /\b(?:COUNT|AVG|SUM|MAX|MIN)\s*\(/i.test(s)
    ));

    // ⚠ EXACTLY THESE THREE, AND THEY ARE THIS LANE'S RECORDED HAND-UP. Both are the ALWAYS-INJECTED
    // reads — the pinned entries and the session-context entries, which go into every assembled
    // context — and neither is one of the four sites the capture recorded. They cannot take a `LIMIT`
    // without silently dropping a pin the owner asked to be pinned, which is a product ruling and not
    // a bound. The report names them as the next reads in this family. A FOURTH unbounded read reds
    // this clause, which is the whole point of writing the number down.
    expect(unbounded).toEqual([
      "SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 AND agent_id IN (${inList}) ORDER BY created_at DESC",
      'SELECT * FROM vault_entries WHERE is_pinned = 1 AND is_obsolete = 0 ORDER BY created_at DESC',
      'SELECT * FROM vault_entries WHERE is_obsolete = 0 AND tags IS NOT NULL AND EXISTS (',
    ]);

    // And the four pre-fix spellings are GONE, named so a reader of a red clause knows what came back.
    expect(store, 'the unbounded semantic scan is back')
      .not.toMatch(/SELECT \* FROM vault_entries WHERE is_obsolete = 0 AND embedding IS NOT NULL/);
    expect(store, 'the unbounded agent-scoped semantic scan is back')
      .not.toMatch(/embedding IS NOT NULL AND agent_id = \?/);
    expect(store, 'the LIMIT-bounds-the-answer LIKE query is back')
      .not.toMatch(/content LIKE \?[\s\S]{0,120}ORDER BY created_at DESC/);
    expect(store, 'a scoring loop is back in store.ts — they all score in bounded-reads.ts now')
      .not.toMatch(/cosineSimilarity\(/);
  });

  it('every scan in bounded-reads.ts carries its rowid window, and reports what it cost', () => {
    const reads = code('../bounded-reads.ts');
    // The candidate page carries the window literally…
    expect(reads, 'the candidate page lost its rowid window')
      .toMatch(/FROM vault_entries\s*\n\s*WHERE \$\{opts\.conditions\.join\('\s*AND\s*'\)\} AND rowid <= \? AND rowid > \?/);
    // …and the LIKE walk builds BOTH of its wheres from arrays that end in the window, which is the
    // shape AND its application: these two arrays are joined into the two statements right below.
    expect(reads, 'the LIKE page lost its rowid window')
      .toMatch(/pageWhere = \[\.\.\.q\.scope, \.\.\.q\.match, 'rowid <= \?', 'rowid > \?'\]/);
    expect(reads, 'the LIKE cost read lost its rowid window — or gained the LIKE, which would make it lie')
      .toMatch(/costWhere = \[\.\.\.q\.scope, 'rowid <= \?', 'rowid > \?'\]/);
    // Every bounded walk reports what it cost: three walks (candidates + the LIKE walk's two doors),
    // two report sites (the candidate warn, and one shared by both LIKE doors).
    expect((reads.match(/boundedRecencyScan(Sync)?</g) ?? []).length).toBe(3);
    expect((reads.match(/logBoundedFallback\(/g) ?? []).length,
      'a bound whose cost nobody reports is the LIMIT this package replaced').toBe(2);
  });

  it('the reads are LABELLED, and no two of the eight labels collide', () => {
    const reads = code('../bounded-reads.ts');
    const store = code('../store.ts');
    // The helper composes `<site>:candidates` and `<site>:bodies` ON THE READ ITSELF (the warn reuses
    // the candidate label as its subsystem, which is why the bare occurrence count is two).
    expect(reads, 'the candidate read lost its label')
      .toMatch(/vaultRead<VaultCandidateRow>\(\s*\n?\s*`\$\{opts\.label\}:candidates`/);
    expect(reads, 'the body fetch lost its label')
      .toMatch(/vaultRead<T>\(\s*\n?\s*`\$\{opts\.label\}:bodies`/);
    const direct = [...reads.matchAll(/await vaultRead<[A-Za-z]+>\(\s*\n?\s*'([a-z_:]+)'/g)].map((m) => m[1]);
    const sites = [...new Set([...store.matchAll(/label: '([a-z_]+)'/g)].map((m) => m[1]))];
    expect(sites.sort()).toEqual(['vault_dedup', 'vault_nearband', 'vault_semantic']);
    expect(direct.sort()).toEqual(['vault_exact:like:cost', 'vault_exact:like:page']);
    // (3 sites × 2 reads) + the LIKE walk's 2 = the 8 labels the pool can attribute a line to.
    const runtimeLabels = [...sites.flatMap((s) => [`${s}:candidates`, `${s}:bodies`]), ...direct];
    expect(runtimeLabels).toHaveLength(8);
    expect(new Set(runtimeLabels).size, 'two vault reads share one label').toBe(8);
  });
});
