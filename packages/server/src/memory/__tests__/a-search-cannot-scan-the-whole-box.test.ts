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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  boundedRecencyScanSync, ftsCandidateRowidFloor, logBoundedFallback,
  FTS_CANDIDATE_ROWS, LIKE_CHUNK_ROWS, LIKE_MAX_ROWS_SCANNED, LIKE_MAX_BYTES_SCANNED,
  type BoundedScanChunk, type BoundedScanReport,
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

function retrievalSource(): string {
  return readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8');
}

describe('⚠ THE WIRE — and it COUNTS, in both directions', () => {
  const retrieval = retrievalSource();

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

// ════════════════════════════════════════════════════════════════════════════════════════
// ⚠ C1 (fix round 1) — THE CHUNKS ARE GLOBAL, THE COUNTS ARE PER-AGENT, AND THE WALK USED TO
// MISTAKE THE DIFFERENCE FOR THE END OF THE DATA.
//
// Reproduced on a 300,000-row two-agent fixture before the fix, with the real `boundedRecencyScanSync`
// and the production chunk/cost SQL: fifty rows matched in the table, the walk returned ZERO, and the
// report said `{"stoppedBecause":"exhausted","truncated":false}` with 60,000 rows of budget left — i.e.
// `logBoundedFallback` announced a COMPLETE answer. The pre-fix unbounded walk, slow as it was, found
// all fifty. That is a bound bounding the ANSWER, which is the one thing this module must never do.
//
// These clauses use a SMALL fixture for the same mechanism, so the needle is genuinely reachable inside
// the budgets and the claim can be `matched > 0` rather than "the report is now honest". The gap between
// the two agents' key ranges is deliberately LARGER than `LIKE_CHUNK_ROWS`, because a gap smaller than
// one chunk cannot reproduce the defect at all — a chunk that spans the gap still examines rows.
// ════════════════════════════════════════════════════════════════════════════════════════

const GAP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-t89-c1-')), 'gap.db');

/** Two agents, interleaved by insertion key, with the needle in the OLDER agent-a block.
 *  Built with the production index set for the columns these queries name (migration 133):
 *  `ix_msg_agent_seq`, `idx_messages_agent_id`, `idx_messages_agent_created`,
 *  `idx_messages_created_at`. The rest of the table's indexes are on `task_id`, `run_id`,
 *  `conversation_id`, `turn_number` and `lane` — columns no query here mentions, so they cannot
 *  change a plan. */
function buildGapFixture(): { aLo: number; aHi: number; needles: number; floor: number } {
  fs.rmSync(GAP_DB, { force: true });
  const db = new Database(GAP_DB);
  db.exec(`CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, agent_id TEXT NOT NULL, role TEXT,
    content TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX ix_msg_agent_seq ON messages(agent_id, seq)');
  db.exec('CREATE INDEX idx_messages_agent_id ON messages(agent_id)');
  db.exec('CREATE INDEX idx_messages_agent_created ON messages(agent_id, created_at)');
  db.exec('CREATE INDEX idx_messages_created_at ON messages(created_at)');
  const ins = db.prepare('INSERT INTO messages (seq, id, agent_id, role, content, created_at) VALUES (?,?,?,?,?,?)');
  // THE LAYOUT, and every boundary earns its place:
  //   agent-b   1 ..  20,000   BELOW everything agent-a owns, so agent-a's own floor is 20,000 and
  //                            not zero — without this the floor and `ceiling <= 0` behave
  //                            identically and a clause cannot tell the fix from the old code.
  //   agent-a  20,001..20,100  the needle lives in 20,001..20,050 — the OLD end of its history.
  //   agent-b  20,101..60,100  a 40,000-key gap, TWO chunks wide. A gap narrower than one chunk
  //                            cannot reproduce the defect: a chunk spanning it still examines rows.
  //   agent-a  60,101..60,200  its recent block, where a search starts.
  const filler = 'generated fixture text, fictional, wide enough to cost bytes ';
  db.transaction(() => {
    for (let seq = 1; seq <= 60_200; seq += 1) {
      const agent = (seq > 20_000 && seq <= 20_100) || seq > 60_100 ? 'agent-a' : 'agent-b';
      const needle = (agent === 'agent-a' && seq <= 20_050) ? ' UNIQUEFIXTURETOKEN ' : ' ';
      ins.run(seq, `id-${seq}`, agent, 'user', filler + needle + seq, 1_700_000_000_000 + seq);
    }
  })();
  const needles = (db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'agent-a' AND content LIKE '%UNIQUEFIXTURETOKEN%'`,
  ).get() as { n: number }).n;
  db.close();
  return { aLo: 20_001, aHi: 60_200, needles, floor: 20_000 };
}

/** The production chunk and cost SQL from `searchMessagesLike`, verbatim in shape. */
const GAP_CHUNK_SQL = `
    SELECT id, role, content, datetime(created_at/1000,'unixepoch') AS created_at, seq AS rowid
    FROM messages
    WHERE agent_id = ? AND content LIKE ? AND seq <= ? AND seq > ?
    ORDER BY seq DESC
    LIMIT ?
  `;
const GAP_COST_SQL = `
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM messages
    WHERE agent_id = ? AND seq <= ? AND seq > ?
  `;

describe('⚠ C1 — A CHUNK OWNED BY ANOTHER AGENT IS NOT THE END OF THIS AGENT\'S HISTORY', () => {
  let fixture: { aLo: number; aHi: number; needles: number; floor: number };
  let db: Database.Database;

  beforeEach(() => {
    if (!fixture) fixture = buildGapFixture();
    db = new Database(GAP_DB, { readonly: true });
  });
  afterEach(() => { db.close(); });

  /** The production walk, plus the ceilings it asked for — which is how the FLOOR becomes observable. */
  function walk(opts: { floorRowid?: number }): {
    rows: unknown[]; report: BoundedScanReport; ceilings: number[];
  } {
    const chunk = db.prepare(GAP_CHUNK_SQL);
    const cost = db.prepare(GAP_COST_SQL);
    const hi = (db.prepare('SELECT MAX(seq) AS r FROM messages WHERE agent_id = ?')
      .get('agent-a') as { r: number }).r;
    const ceilings: number[] = [];
    const out = boundedRecencyScanSync<unknown>({
      limit: 60,
      startRowidCeiling: hi,
      ...opts,
      fetchChunk: (ceiling, chunkRows) => {
        ceilings.push(ceiling);
        const floor = Math.max(0, ceiling - chunkRows);
        const c = cost.get('agent-a', ceiling, floor) as { n: number; bytes: number };
        const found = chunk.all('agent-a', '%UNIQUEFIXTURETOKEN%', ceiling, floor, chunkRows);
        return { rows: found, rowsExamined: c.n, bytesRead: c.bytes };
      },
    });
    return { ...out, ceilings };
  }

  /** The agent's own floor, exactly as `searchMessagesLike` computes it. */
  function agentFloor(): number {
    const lo = (db.prepare('SELECT MIN(seq) AS r FROM messages WHERE agent_id = ?')
      .get('agent-a') as { r: number }).r;
    return Math.max(0, lo - 1);
  }

  it('the fixture has BOTH properties the clauses need, or they prove nothing', () => {
    expect(fixture.needles).toBe(50);
    // (1) a foreign-owned gap wider than one chunk — the C1 defect needs a chunk that examines zero.
    const gap = (db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'agent-b' AND seq > 20100`).get() as { n: number }).n;
    expect(gap, 'the foreign-owned gap must exceed LIKE_CHUNK_ROWS').toBeGreaterThan(LIKE_CHUNK_ROWS);
    // (2) a NON-ZERO floor — agent-a's oldest row sits above the bottom of the table. Without this,
    // `floorRowid` and the old `ceiling <= 0` behave identically and no clause can tell them apart.
    // My first fixture lacked it and a mutant that IGNORED the caller's floor passed all 18 clauses.
    expect(agentFloor(), 'the agent floor must be above zero').toBe(fixture.floor);
  });

  it('⚠ THE WALK FINDS THE NEEDLE BELOW THE GAP — matched > 0, which is the whole claim', () => {
    const { rows, report } = walk({ floorRowid: agentFloor() });
    // eslint-disable-next-line no-console
    console.log(`C1 GAP WALK  matched ${report.matched} of ${fixture.needles} · chunks ${report.chunks} `
      + `· rowsScanned ${report.rowsScanned} · stopped ${report.stoppedBecause} `
      + `· truncated ${report.truncated}`);
    expect(report.matched, 'the walk stopped at a foreign-owned chunk and missed the needle').toBe(50);
    expect(rows).toHaveLength(50);
    // And it is reported as COMPLETE, truthfully this time: the floor was reached, not a budget.
    expect(report.stoppedBecause).toBe('exhausted');
    expect(report.truncated).toBe(false);
    // It had to cross the gap to get there, which is what the chunk count proves.
    expect(report.chunks, 'the walk never crossed the gap').toBeGreaterThan(2);
  });

  it('the pre-fix report would have been a LIE, and this pins which kind', () => {
    // Without a floor the walk stops the moment the ceiling passes 0 — so a fixture whose gap sits
    // ABOVE zero still walks, and it is the ZERO-ROWS BREAK that produced the lie. That break is
    // deleted; this clause pins the property it broke: a walk that stops with budget left and
    // `truncated: false` must have actually reached the caller's floor.
    const { report } = walk({ floorRowid: agentFloor() });
    const budgetLeft = report.rowsScanned < LIKE_MAX_ROWS_SCANNED
      && report.bytesScanned < LIKE_MAX_BYTES_SCANNED;
    expect(budgetLeft, 'this fixture must stop on the FLOOR, not on a budget').toBe(true);
    expect(report.truncated, 'a floor stop with budget left is a complete answer').toBe(false);
    expect(report.matched, 'and a complete answer must contain everything that matched').toBe(fixture.needles);
  });

  it('⚠ THE FLOOR IS USED, NOT JUST ACCEPTED — no chunk is fetched below it', () => {
    // ⚠ WHY THIS CLAUSE EXISTS, recorded because it is the recurring shape: a mutant that replaced
    // `ceiling <= floorRowid` with `ceiling <= 0` — i.e. ignored the caller's floor entirely — passed
    // every other clause in this file, because the needle is found either way and the floor only
    // changes where the walk STOPS. The floor's whole content is work not done, so the clause has to
    // observe the work: the ceilings the scan actually asked for.
    const floor = agentFloor();
    const withFloor = walk({ floorRowid: floor });
    const withoutFloor = walk({});
    // eslint-disable-next-line no-console
    console.log(`C1 FLOOR  with floor ${floor}: ceilings [${withFloor.ceilings.join(', ')}] · `
      + `without: [${withoutFloor.ceilings.join(', ')}]`);
    for (const c of withFloor.ceilings) {
      expect(c, `a chunk was fetched at ceiling ${c}, below the caller's floor ${floor}`)
        .toBeGreaterThan(floor);
    }
    // And it is not vacuous: without the floor the walk DOES go below it.
    expect(withoutFloor.ceilings.some((c) => c <= floor),
      'the fixture cannot distinguish a used floor from an ignored one').toBe(true);
    // Both answers are still complete — the floor removes work, never rows.
    expect(withFloor.report.matched).toBe(fixture.needles);
    expect(withoutFloor.report.matched).toBe(fixture.needles);
  });

  it('a floor of 0 still terminates — the old behaviour is the DEFAULT, not a removed guard', () => {
    // The default `floorRowid` is 0, so a caller that genuinely walks a whole table is unchanged.
    const { report } = walk({});
    expect(report.chunks).toBeGreaterThan(0);
    expect(['exhausted', 'satisfied', 'row_budget', 'byte_budget']).toContain(report.stoppedBecause);
  });
});

describe('⚠ I5 — THE COST OF THE POST-FIX QUERIES, MEASURED, ON PRODUCTION INDEXES', () => {
  // The grown-box rule asks for a plan check on a fixture with the index set production has. These
  // clauses do that AND report a finding the plan check cannot carry on its own.
  //
  // ⚠ EXPLAIN QUERY PLAN IS NOT SUFFICIENT EVIDENCE HERE, and that is worth more than the clauses
  // themselves. SQLite's min/max optimisation reads a single aggregate off the end of a b-tree, and it
  // does NOT apply to `SELECT MIN(x), MAX(x)` in one statement — that form walks every index entry the
  // WHERE matches. Measured on this fixture:
  //     SELECT MIN(seq), MAX(seq) … WHERE agent_id = ?   23.457 ms
  //     SELECT MIN(seq)           … WHERE agent_id = ?    0.015 ms
  //     SELECT MAX(seq)           … WHERE agent_id = ?    0.007 ms
  // and all THREE print the identical plan: `SEARCH messages USING COVERING INDEX
  // idx_messages_agent_id (agent_id=?)`. A plan-only clause would have passed the 23 ms form — which
  // is exactly the form the first cut of the C1 fix used, caught by measuring instead of reading.
  let db: Database.Database;
  beforeEach(() => { db = new Database(GAP_DB, { readonly: true }); });
  afterEach(() => { db.close(); });

  const plan = (sql: string, params: readonly unknown[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
      .map((r) => r.detail).join(' | ');
  const timeOf = (sql: string, params: readonly unknown[], runs = 20): number => {
    const st = db.prepare(sql);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < runs; i += 1) st.get(...params);
    return Number(process.hrtime.bigint() - t0) / runs / 1e6;
  };

  it('the chunk and its cost count are bounded by the key range, on production indexes', () => {
    const chunk = plan(GAP_CHUNK_SQL, ['agent-a', '%x%', 40_200, 20_200, 20_000]);
    const cost = plan(GAP_COST_SQL, ['agent-a', 40_200, 20_200]);
    // eslint-disable-next-line no-console
    console.log(`I5 PLAN  chunk: ${chunk}\nI5 PLAN  cost:  ${cost}`);
    for (const p of [chunk, cost]) {
      // The property, not the index NAME: a renamed index in a migration is not a defect.
      expect(p, 'a chunk that SCANs the table is not a chunk').not.toMatch(/SCAN messages\b(?! USING)/);
      expect(p, 'the key range must be in the plan, or the chunk is not bounded by it')
        .toMatch(/rowid>\?|rowid<\?|seq>\?|seq<\?/);
    }
  });

  it('⚠ THE SPAN IS TWO SINGLE-AGGREGATE READS, and the clause MEASURES it because the plan cannot', () => {
    const combined = 'SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM messages WHERE agent_id = ?';
    const lo = 'SELECT MIN(seq) AS r FROM messages WHERE agent_id = ?';
    const hi = 'SELECT MAX(seq) AS r FROM messages WHERE agent_id = ?';
    // ⚠ MEASURED FOR THE AGENT WITH THE LONG HISTORY, and the choice is the claim's content: the
    // combined form's cost is O(the agent's own rows), so on `agent-a` — 200 rows across the gap —
    // both shapes are ~0 and the clause would be vacuous. `agent-b` owns 40,000, which is the shape
    // of the agent this whole package exists for. (My first cut measured agent-a and read 0.014 ms
    // against 0.010 ms, i.e. no signal at all; the 23 ms figure in the header is a 240,000-row agent.)
    const subject = 'agent-b';
    // ⚠ THE POINT, ASSERTED RATHER THAN TAKEN ON TRUST: a plan-only clause would pass BOTH shapes.
    // Both report an indexed covering search with no table scan — which index the planner picks is
    // fixture- and stats-dependent and is deliberately NOT asserted, because the claim is that the
    // plan string cannot tell the cheap shape from the expensive one.
    for (const p of [plan(combined, [subject]), plan(lo, [subject]), plan(hi, [subject])]) {
      expect(p, 'a plan-only clause would have to reject this to catch the expensive shape')
        .not.toMatch(/SCAN messages\b(?! USING)/);
      expect(p).toMatch(/SEARCH messages USING .*INDEX/);
    }
    const tCombined = timeOf(combined, [subject]);
    const tSplit = timeOf(lo, [subject]) + timeOf(hi, [subject]);
    // eslint-disable-next-line no-console
    console.log(`I5 MEASURED  combined MIN+MAX ${tCombined.toFixed(3)}ms · two statements `
      + `${tSplit.toFixed(3)}ms · identical plans`);
    // ⚠ A RATIO, NOT A CEILING. Seven lanes share this machine, so an absolute millisecond bound is a
    // coin flip; the ratio is a property of the query planner and holds under load. 10× is far below
    // the ~1,500× measured and far above any noise.
    expect(tSplit, 'the two-statement span is no longer cheaper — re-measure before simplifying')
      .toBeLessThan(tCombined / 10);
  });

  it('and the SOURCE takes the cheap shape — no combined MIN/MAX survives on a search path', () => {
    const code = retrievalSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Both directions. The cheap shape must be present…
    expect(code, 'the recency floor is not computed at all').toMatch(/SELECT MIN\((seq|rowid)\) AS r FROM/);
    // …and the expensive one must be absent, which is the half a presence clause would miss.
    expect(code, 'a combined MIN/MAX loses SQLite\'s min/max optimisation — see the measurement above')
      .not.toMatch(/SELECT MIN\([a-z_]+\) AS lo, MAX\(/);
    // I5's other half: `summaries` has NO index on agent_id anywhere in db/migrations, so a per-agent
    // MAX over it is a reverse table walk (10.1 ms measured for an agent with no recent summary).
    expect(code, 'a per-agent MIN/MAX over summaries is a reverse table walk (I5)')
      .not.toMatch(/FROM summaries WHERE agent_id = \?/);
  });

  it('the summaries per-agent MAX really was the expensive shape — the rule is not vacuous', () => {
    // Measured on a summaries-shaped table with production's index set, which is NO indexes at all:
    // the agent that owns only the newest rows costs ~0 and the agent with none costs the table.
    const sdb = new Database(':memory:');
    sdb.exec(`CREATE TABLE summaries (id TEXT PRIMARY KEY, agent_id TEXT, depth INT, kind TEXT,
      content TEXT, earliest_at TEXT, latest_at TEXT)`);
    const ins = sdb.prepare('INSERT INTO summaries VALUES (?,?,?,?,?,?,?)');
    const body = 'x'.repeat(512);
    sdb.transaction(() => {
      for (let i = 1; i <= 20_000; i += 1) ins.run(`s-${i}`, 'agent-other', 1, 'k', body, 't', 't');
    })();
    const ms = (sql: string, params: readonly unknown[]): number => {
      const st = sdb.prepare(sql);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 10; i += 1) st.get(...params);
      return Number(process.hrtime.bigint() - t0) / 10 / 1e6;
    };
    const perAgent = ms('SELECT MAX(rowid) AS r FROM summaries WHERE agent_id = ?', ['agent-absent']);
    const global = ms('SELECT MAX(rowid) AS r FROM summaries', []);
    sdb.close();
    // eslint-disable-next-line no-console
    console.log(`I5 MEASURED  summaries per-agent MAX ${perAgent.toFixed(3)}ms · global MAX `
      + `${global.toFixed(3)}ms (no index on agent_id exists in db/migrations)`);
    expect(global, 'the global MAX is no cheaper — re-measure before reverting I5')
      .toBeLessThan(perAgent / 10);
  });
});

describe('⚠ I6 — A BOUNDED FTS MISS IS NOT A MISS, AND BOTH AUDIENCES ARE TOLD', () => {
  // The FTS floor silently drops every match older than the newest FTS_CANDIDATE_ROWS messages. On a
  // box past that window — the only box the bound exists for — a search for old history returned a
  // partial or EMPTY answer that looked complete: no warn, nothing in the result. That is the same
  // defect the LIKE fallback was fixed for ("a warn nobody sees"), reintroduced on the other arm by
  // the fix itself.
  const code = (): string => retrievalSource()
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('the floor being APPLIED and the floor being ANNOUNCED are different lines, and both exist', () => {
    const fts = code().slice(code().indexOf('async function searchMessagesInner'),
      code().indexOf('async function searchMessagesLike'));
    // The guard is on BOTH conditions: a floor that did not bite, or a result that filled its limit,
    // says nothing. Announcing a bound nobody reached is the noise that makes real lines ignorable.
    expect(fts, 'the bounded miss is not detected').toMatch(
      /if \(candidateFloor > 0 && rows\.length < \(limit \?\? 20\)\)/);
    expect(fts, 'the operator is not told').toContain(
      "logger.warn('history_search:fts answered from a bounded candidate window");
    expect(fts, 'the AGENT is not told — it cannot tell "nothing matched" from "nothing recent matched"')
      .toMatch(/results\.push\(`\[searched the newest/);
    expect(fts, 'the agent line must name the door out, or it is just an apology')
      .toMatch(/before="<ISO date>"/);
  });

  it('⚠ NO PATTERN IN THE WARN — counts, the floor, and whether filters were given', () => {
    const fts = code().slice(code().indexOf('async function searchMessagesInner'),
      code().indexOf('async function searchMessagesLike'));
    const warnStart = fts.indexOf("logger.warn('history_search:fts answered from a bounded");
    const warnBody = fts.slice(warnStart, fts.indexOf('}, agentId);', warnStart));
    // ⚠ The whole-file rule this package carries: this line is pasted into bug reports. `since` and
    // `before` are reported as BOOLEANS — whether a filter was given, never its value.
    expect(warnBody, 'the warn carries the user\'s query text').not.toMatch(/\bpattern\b/);
    expect(warnBody).toMatch(/sinceGiven: Boolean\(since\)/);
    expect(warnBody).toMatch(/beforeGiven: Boolean\(before\)/);
    expect(warnBody).toMatch(/candidateFloor,/);
    expect(warnBody).toMatch(/matched: rows\.length,/);
  });

  it('the agent-facing line is derived from the constant, so the two cannot disagree', () => {
    // A hard-coded "50,000" in the sentence is a number that goes stale the day the bound moves.
    const fts = code();
    expect(fts).toMatch(/FTS_CANDIDATE_ROWS\.toLocaleString\('en-US'\)/);
    expect(FTS_CANDIDATE_ROWS).toBe(50_000);
  });
});
