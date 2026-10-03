// ⚠ THE DEFECT, IN THE NUMBERS THAT WERE MEASURED: 4,693 of 7,487 main-thread profiler samples inside
// ONE `Statement::JS_all` — `sqlite3_step → sqlite3BtreeNext → moveToChild → getAndInitPage → readDbPage
// → pread` — on a 729 MB database, with the server DEAF to a health probe for 43 seconds.
//
// Both search paths already had a `LIMIT`. That is the finding this file exists to pin: a LIMIT bounds
// the ANSWER and says nothing about the WORK. The fixture below is generated and fictional; the shape is
// the box's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

/** Captured warns, so the LOUD-fallback clause reads the same logger the module under test uses. */
const warns: Array<{ msg: string; meta: Record<string, unknown> }> = [];
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), error: vi.fn(),
    warn: (msg: string, meta?: unknown) => { warns.push({ msg, meta: (meta ?? {}) as Record<string, unknown> }); },
  }),
}));
import { readFileSync } from 'node:fs';
import {
  boundedRecencyScanSync, ftsCandidateRowidFloor, logBoundedFallback,
  FTS_CANDIDATE_ROWS, LIKE_CHUNK_ROWS, LIKE_MAX_ROWS_SCANNED, LIKE_MAX_BYTES_SCANNED,
  type BoundedScanChunk,
} from '../search-bounds.js';

/**
 * ⚠ STARVED MILLISECONDS — t87's metric, reused rather than reinvented (the brief asks for exactly
 * that). Elapsed wall time minus the time the loop demonstrably serviced, at 10 ms per tick it managed.
 * A responsive loop starves ~0; a loop pinned inside a synchronous scan starves for the whole run. It is
 * the right headline for a fix whose entire purpose is giving the loop back.
 */
function measureStarvation(work: () => void): { starvedMs: number; elapsedMs: number; ticks: number } {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  try { work(); } finally { clearInterval(timer); }
  const elapsedMs = Date.now() - t0;
  return { starvedMs: Math.max(0, elapsedMs - ticks * 10), elapsedMs, ticks };
}

describe('the bounds are bounds, and each number is argued where it is set', () => {
  it('the FTS candidate floor is a recency window, and a no-op on a small box', () => {
    // A box smaller than the window gets floor 0 — the bound costs nothing until a box grows into it,
    // which is the overwhelming majority of boxes and the reason this is safe to ship.
    expect(ftsCandidateRowidFloor(1_000)).toBe(0);
    expect(ftsCandidateRowidFloor(FTS_CANDIDATE_ROWS)).toBe(0);
    // Past the window it is a floor, and the window above it is exactly the declared size.
    const floor = ftsCandidateRowidFloor(500_000);
    expect(floor).toBe(500_000 - FTS_CANDIDATE_ROWS);
    expect(500_000 - floor).toBe(FTS_CANDIDATE_ROWS);
  });

  it('the budgets are generous on purpose — a bound everybody reaches is a feature regression', () => {
    expect(LIKE_CHUNK_ROWS).toBeGreaterThanOrEqual(10_000);
    expect(LIKE_MAX_ROWS_SCANNED).toBeGreaterThanOrEqual(LIKE_CHUNK_ROWS * 5);
    expect(LIKE_MAX_BYTES_SCANNED).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  });
});

describe('⚠ THE ROW AND BYTE BUDGETS ACTUALLY STOP THE WALK', () => {
  /** A chunk source that always examines a full chunk and never matches — the rare-term worst case. */
  const neverMatches = (bytesPerChunk: number) => (): BoundedScanChunk<string> => ({
    rows: [], rowsExamined: LIKE_CHUNK_ROWS, bytesRead: bytesPerChunk,
  });

  it('a search for something that is not there STOPS, instead of walking the table', () => {
    // This is the incident's shape: a term that appears nowhere, so the LIMIT never fills and the walk
    // has no reason of its own to stop. Pre-fix that was the whole history; now it is the budget.
    const { rows, report } = boundedRecencyScanSync<string>({
      limit: 60,
      startRowidCeiling: 5_000_000,            // a box far bigger than the budget
      fetchChunk: neverMatches(1_000),
    });
    expect(rows).toHaveLength(0);
    expect(report.stoppedBecause).toBe('row_budget');
    expect(report.truncated).toBe(true);
    expect(report.rowsScanned).toBeLessThanOrEqual(LIKE_MAX_ROWS_SCANNED + LIKE_CHUNK_ROWS);
    // ⚠ AND THE NUMBER IS THE POINT: a bounded walk reads a knowable amount, not "however much exists".
    expect(report.rowsScanned).toBeLessThan(5_000_000);
  });

  it('the BYTE budget bites first when the rows are fat, because content is the real cost', () => {
    // 200,000 small rows and 200,000 half-megabyte rows are different machines. One agent's history can
    // hold both, so rows alone is not a budget.
    const { report } = boundedRecencyScanSync<string>({
      limit: 60,
      startRowidCeiling: 5_000_000,
      fetchChunk: neverMatches(LIKE_MAX_BYTES_SCANNED / 2),
    });
    expect(report.stoppedBecause).toBe('byte_budget');
    expect(report.rowsScanned).toBeLessThan(LIKE_MAX_ROWS_SCANNED);
  });

  it('an ordinary search finishes in the first chunk and the bounds never bite', () => {
    const { rows, report } = boundedRecencyScanSync<string>({
      limit: 3,
      startRowidCeiling: 100_000,
      fetchChunk: () => ({ rows: ['a', 'b', 'c', 'd'], rowsExamined: 120, bytesRead: 4_000 }),
    });
    expect(rows).toHaveLength(3);                 // the caller's limit, not the chunk's find
    expect(report.stoppedBecause).toBe('satisfied');
    expect(report.truncated).toBe(false);
    expect(report.chunks).toBe(1);
  });

  it('an empty tail ENDS the walk rather than spinning on it', () => {
    // Without this the loop would ask for older rows forever on a table it has already exhausted —
    // an infinite loop wearing a budget.
    const { report } = boundedRecencyScanSync<string>({
      limit: 60,
      startRowidCeiling: 50,
      fetchChunk: () => ({ rows: [], rowsExamined: 0, bytesRead: 0 }),
    });
    expect(report.stoppedBecause).toBe('exhausted');
    expect(report.chunks).toBe(1);
  });
});

describe('⚠ THE FALLBACK IS LOUD, AND CARRIES COUNTS — a warn nobody sees is the original defect', () => {
  it('reports rows and bytes read, and says when the answer is incomplete', () => {
    warns.length = 0;
    logBoundedFallback('history_search:like', 'no FTS table on this database', {
      rowsScanned: 200_000, bytesScanned: 1_000, chunks: 10, matched: 0,
      stoppedBecause: 'row_budget', truncated: true,
    });
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('STOPPED EARLY');
    expect(warns[0].msg).toContain('no FTS table');
    expect(warns[0].meta.rowsScanned).toBe(200_000);
    expect(warns[0].meta.truncated).toBe(true);
    // ⚠ NO PATTERN, NO CONTENT, NO SNIPPET anywhere in the line: it reaches pasted logs, and the brief
    // forbids user query text in any shipped surface.
    expect(JSON.stringify(warns[0])).not.toMatch(/%|LIKE '/);
  });
});

describe('⚠ THE REPRODUCTION — the same search, on a grown fixture, before and after the bound', () => {
  let db: Database.Database;
  const ROWS = 60_000;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    const ins = db.prepare('INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)');
    // Generated, fictional, and deliberately WIDE: the cost of a leading-wildcard LIKE is content bytes
    // read, so rows of a few hundred bytes are the shape that reproduces the pread storm.
    const filler = 'the quick brown fox jumps over the lazy dog and then keeps going for a while '.repeat(6);
    db.transaction(() => {
      for (let i = 0; i < ROWS; i += 1) {
        ins.run(`m-${i}`, 'agent-fixture', i % 2 === 0 ? 'user' : 'assistant',
          `${filler} sequence-${i}`, 1_700_000_000_000 + i * 1_000);
      }
    })();
  });

  afterEach(() => { db.close(); });

  it('the UNBOUNDED shape walks the whole table for a term that is not there', () => {
    // The pre-fix query, verbatim in shape: no index can serve a leading wildcard, so SQLite tests every
    // row and the LIMIT never fills.
    const unbounded = db.prepare(`
      SELECT id FROM messages WHERE agent_id = ? AND content LIKE ?
      ORDER BY created_at DESC LIMIT 60
    `);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages WHERE agent_id = ? AND content LIKE ?
      ORDER BY created_at DESC LIMIT 60`).all('agent-fixture', '%nothing-matches-this%') as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/SCAN messages/);
    const before = measureStarvation(() => { unbounded.all('agent-fixture', '%nothing-matches-this%'); });
    expect(before.starvedMs, 'the fixture is too small to reproduce the pin').toBeGreaterThan(0);

    // The BOUNDED walk over the same table, same term: it stops at the first chunk's worth of budget.
    const chunkStmt = db.prepare(`
      SELECT id FROM messages WHERE agent_id = ? AND content LIKE ? AND rowid <= ? AND rowid > ?
      ORDER BY rowid DESC LIMIT ?
    `);
    const countStmt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)),0) AS bytes FROM messages WHERE agent_id = ? AND rowid <= ? AND rowid > ?');
    const after = measureStarvation(() => {
      boundedRecencyScanSync<{ id: string }>({
        limit: 60,
        startRowidCeiling: ROWS,
        chunkRows: 5_000,
        maxRows: 10_000,                      // a deliberately tight budget, to prove the stop
        fetchChunk: (ceiling, chunkRows) => {
          const floor = Math.max(0, ceiling - chunkRows);
          const cost = countStmt.get('agent-fixture', ceiling, floor) as { n: number; bytes: number };
          return {
            rows: chunkStmt.all('agent-fixture', '%nothing-matches-this%', ceiling, floor, chunkRows) as Array<{ id: string }>,
            rowsExamined: cost.n, bytesRead: cost.bytes,
          };
        },
      });
    });

    // eslint-disable-next-line no-console
    console.log(`STARVATION  unbounded ${before.starvedMs}ms of ${before.elapsedMs}ms elapsed `
      + `· bounded ${after.starvedMs}ms of ${after.elapsedMs}ms (${ROWS} fixture rows)`);
    // ⚠ THE HEADLINE: the bounded walk gives the loop back, because it reads a fraction of the table.
    expect(after.elapsedMs).toBeLessThan(before.elapsedMs);
    expect(after.starvedMs).toBeLessThan(Math.max(1, before.starvedMs));
  });
});

describe('⚠ THE WIRE — and it COUNTS, in both directions', () => {
  const retrieval = readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8');

  it('the message search paths USE the bounds — an unused bound bounds nothing', () => {
    expect(retrieval).toContain('ftsCandidateRowidFloor(');
    expect(retrieval).toContain('boundedRecencyScanSync');
    expect(retrieval).toContain('logBoundedFallback(');
  });

  it('⚠ NO UNBOUNDED `LIKE` SCAN SURVIVES ON THE MESSAGE PATH', () => {
    // Both directions: the bounded helper must be present AND the pre-fix shape must be gone. A fix that
    // adds a bounded path beside the unbounded one has changed nothing.
    expect(retrieval).not.toMatch(/content LIKE \?\s*\n?\s*ORDER BY created_at DESC\s*\n?\s*LIMIT/);
    // every bounded scan reports what it cost
    const scans = retrieval.match(/boundedRecencyScanSync</g)?.length ?? 0;
    const reports = retrieval.match(/logBoundedFallback\(/g)?.length ?? 0;
    expect(scans).toBeGreaterThanOrEqual(1);
    expect(reports).toBe(scans);
  });
});
