// ════════════════════════════════════════════════════════════════════════════════════════
// THE VAULT'S READS, BOUNDED AND OFF THE SERVING THREAD — this is the `vault_search` the
// incident actually ran.
//
// ⚠ THE MEASURED DEFECT, AND WHY IT IS THIS FILE AND NOT `memory/retrieval.ts`. The capture that
// opened this package recorded the serving thread pinned inside ONE synchronous `Statement::JS_all`
// while a review ran `vault_search` twice. The bounds that landed first went onto the MESSAGE and
// SUMMARY searches; the path in the capture is `vault/store.ts`, and it had four reads with no
// bound of any kind:
//
//   · the semantic search (`semanticSearch`)        — `SELECT * FROM vault_entries WHERE …`, NO LIMIT
//   · the exact search (`listEntries({ search })`)  — `content LIKE '%…%' … LIMIT ?`
//   · the write path's duplicate check              — `SELECT * …`, NO LIMIT, one agent
//   · the near-duplicate band check                 — `SELECT * …`, NO LIMIT, one agent
//
// Three of them had no `LIMIT` at all. The fourth had one, and a `LIMIT` bounds the ANSWER and says
// nothing about the WORK: a leading-wildcard LIKE cannot use an index, so a term appearing nowhere
// cost every row the agent owned. And all four were `SELECT *` over a table whose rows carry a
// 768-float embedding BLOB — 3,072 bytes each — so every row read dragged its vector along whether
// the caller wanted it or not.
//
// ── THE THREE THINGS THIS MODULE DOES, EACH MEASURED (see the report's measurement table) ──
//  1. THE POOL FIRST. Every read goes through `vaultRead`, which routes to the reader pool when it is
//     up and runs on the serving connection when it is not. Pre-fix, 100,000 fixture entries pinned
//     the loop for 601 ms with 0 % of its ticks serviced. Post-fix the same scan leaves the loop
//     62–65 % serviced. That is the incident's mechanism, gone.
//  2. BODIES ONLY FOR THE WINNERS. The candidate pass projects `id, embedding, rowid` — not `*` — and
//     full rows are fetched for the handful of entries that actually won. Measured: `SELECT *` costs
//     7.54 µs/row to read, `id, embedding` costs 3.33 µs/row. Same answers, half the bytes.
//  3. A GENEROUS RECENCY CAP, LOUD WHEN IT BITES. `rowid` is the only monotonic key on
//     `vault_entries` (its `id` is a TEXT uuid), so the candidate window is a rowid floor. The cap is
//     sized from the measurement below, and when it truncates `logBoundedFallback` names the rows
//     read AND the oldest entry considered — because the thing a cap can cost here is an old fact,
//     and a missed old fact has to be diagnosable rather than silent.
//
// ⚠ WHY THE CAP IS TWICE THE MESSAGE-SIDE WINDOW, WHICH IS THE ONE REAL DESIGN QUESTION HERE.
// For messages, recency is obviously the right axis: `seq` is append-only and an older match is the
// one a person is least likely to mean. A DISTILLED VAULT ENTRY IS NOT LIKE THAT — "the owner's
// timezone", "the project's name" — an old permanent fact is exactly what semantic recall is for. So
// recency is the only monotonic axis available, and it is used as a ceiling on PATHOLOGICAL size
// rather than as a relevance heuristic: the cap is set so far above any real vault that a normal one
// is never truncated, and the warn is what tells us if that judgement was wrong.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { readerPoolAvailable, readerQuery } from '../memory/reader-pool.js';
import {
  boundedRecencyScan, boundedRecencyScanSync, ftsCandidateRowidFloor, logBoundedFallback,
  type BoundedScanReport,
} from '../memory/search-bounds.js';

const logger = createLogger('vault-bounded-reads');

/**
 * How many of the newest vault entries one semantic search may SCORE.
 *
 * ⚠ SIZED BY MEASUREMENT, not by taste. On a generated fixture of 100,000 entries with real-shaped
 * 768-float blobs (397 MB on disk, 293 MB of embedding), the shipped chunked-and-pooled scan costs
 * **0.0062–0.0068 ms per entry** end to end, of which **0.00175 ms per entry** is the cosine scoring
 * that cannot leave the main thread. At this cap that is ~0.63 s of wall time and ~0.22 s of
 * serving-thread time, paid in bursts of under 9 ms with a turn of the loop between them. The same
 * 100,000 entries pre-fix were 601 ms of solid pin with zero ticks serviced.
 *
 * ⚠ AND IT IS DELIBERATELY TWICE `FTS_CANDIDATE_ROWS` (the message-side window). A vault entry is a
 * distilled fact, so "older is less likely to be what you meant" is much weaker here than it is for
 * raw messages — the header argues this at length. Doubling the window is the direct expression of
 * that weakness. A lived-in distilled vault is hundreds to low thousands of entries; this is ~80×
 * that, so on every real box the floor is 0 and this constant changes nothing at all.
 */
export const VAULT_CANDIDATE_ROWS = 100_000;

/**
 * How many rowids one candidate chunk covers.
 *
 * Chunking is what converts one unbounded synchronous call into several bounded ones, and here it
 * does a second job the message side did not need: the cosine scoring happens in JavaScript on the
 * main thread, so it is the chunk that decides how long the loop goes unserviced. Measured at this
 * size, the worst single scoring burst is **8.7–8.8 ms** — one frame, not a freeze. At the cap this
 * is 20 chunks, each one round trip to the reader pool plus one turn of the loop.
 */
export const VAULT_CANDIDATE_CHUNK_ROWS = 5_000;

/**
 * The byte ceiling on one candidate scan, and it guards a thing the row cap cannot see: EMBEDDING
 * WIDTH.
 *
 * `vault_entries.embedding` carries no dimension column — the width is implicit in the blob — so the
 * day the platform embeds with a 3072-dimension model, every row costs 12,288 bytes instead of
 * 3,072 and the same row cap buys four times the work. 320 MB is just above what the cap costs at
 * today's 768 floats (100,000 × 3,072 = 307 MB), so at today's width this never bites and the row cap
 * is the binding one; at four times the width it bites at ~26,000 entries, which is the correct
 * answer (four times the cost per entry, a quarter of the entries for the same work) and the warn
 * names it.
 */
export const VAULT_CANDIDATE_MAX_BYTES = 320 * 1024 * 1024;

/**
 * How many ids one body fetch may name in a single `IN (…)`.
 *
 * The winners' bodies are fetched by id, and the id list comes from the CALLER'S LIMIT — which on the
 * `vault_search` tool path is a model-supplied argument. An unchunked `IN (…)` would therefore let a
 * `limit` of fifty thousand build a fifty-thousand-parameter statement and trip SQLite's own
 * variable ceiling. Chunking keeps the semantics exact (every winner is still fetched) and the
 * statement bounded.
 */
export const VAULT_BODY_CHUNK_IDS = 500;

export interface VaultCandidateRow {
  readonly id: string;
  readonly rid: number;
  readonly embedding: Buffer | null;
}

export interface ScoredVaultCandidate {
  readonly id: string;
  /** The entry's rowid, carried so a caller's tie-break can be the OLD one — see `store.ts`. */
  readonly rid: number;
  readonly similarity: number;
}

export interface VaultCandidateScan {
  /** Every candidate inside the window, scored. Small objects: no bodies, no blobs. */
  readonly scored: ScoredVaultCandidate[];
  readonly report: BoundedScanReport;
  /** True when the window was not the whole table, or a budget stopped the walk. */
  readonly truncated: boolean;
  /** The oldest rowid actually scored, so a missed old fact is diagnosable. */
  readonly oldestRidConsidered: number;
  /** The rowid floor the window started at: 0 means the whole table was in scope. */
  readonly windowFloor: number;
  readonly maxRid: number;
}

// ── Cosine similarity ──
//
// One copy, and it used to be three: `vault/store.ts` carried its own and `memory/vector-search.ts`
// still does (a different table, a different lane, out of this change's fence). `store.ts`'s copy is
// deleted in favour of this one, because all three of its callers now score here.
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Sort the best candidate first, breaking ties by the OLDEST entry.
 *
 * ⚠ THE TIE-BREAK IS NOT TASTE, IT IS THE PRE-FIX ANSWER. The unbounded reads had no `ORDER BY`, so
 * SQLite handed them back rowid-ascending and `Array.prototype.sort`'s stability made "oldest wins a
 * tie" the shipped behaviour. The bounded walk comes back newest-first, so without this an equal-
 * similarity tie would silently flip. Spelling the tie-break out makes the result independent of the
 * direction the rows arrive in, which is the only form of "semantics unchanged" worth asserting.
 */
export function byBestSimilarity(a: ScoredVaultCandidate, b: ScoredVaultCandidate): number {
  return b.similarity - a.similarity || a.rid - b.rid;
}

/** The candidate window's rowid floor. 0 on any vault smaller than the cap — i.e. all of them. */
export function vaultCandidateFloor(maxRowid: number, candidateRows = VAULT_CANDIDATE_ROWS): number {
  // ⚠ REUSED, NOT REBUILT. `ftsCandidateRowidFloor` already takes the window size as its second
  // argument and already returns 0 for a table smaller than the window, which is exactly this
  // function. Its name says "fts" because the message side needed it first; the arithmetic is
  // "newest N rowids" and belongs to neither.
  return ftsCandidateRowidFloor(maxRowid, candidateRows);
}

/**
 * ⚠ THE ONE DOOR EVERY VAULT READ GOES THROUGH, so the pool-or-thread decision has ONE spelling.
 *
 * Pool up → the read runs on the worker's own read-only connection and the serving thread stays
 * serviceable. Pool down → the caller's own statement runs here, bounded identically. A pool that
 * ERRORS falls back too, which the message side does not do on its LIKE path: a reader hiccup must
 * degrade a search to slow, never to failed.
 *
 * ⚠ EXCEPT ON AN ABORT, AND THAT EXCEPTION IS THE WHOLE POINT OF THE OFFLOAD. A stop rejects here,
 * and re-running the work on the serving thread would resurrect exactly what the user just cancelled
 * — so an aborted read is re-thrown, never retried.
 */
export async function vaultRead<T>(
  label: string,
  sql: string,
  params: readonly unknown[],
  onThread: () => T[],
  signal?: AbortSignal,
): Promise<T[]> {
  if (!readerPoolAvailable()) return onThread();
  try {
    return await readerQuery<T>(label, sql, params, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    sayPoolFallbackOnce(label, err instanceof Error ? err.message : String(err));
    return onThread();
  }
}

/** Distinct pool failures already reported, so a standing condition is one line and not thousands. */
const saidPoolFallback = new Set<string>();

/**
 * ⚠ ONCE PER DISTINCT FAILURE, NOT ONCE PER READ, and the reason is measured rather than tasteful: a
 * reader worker whose connection could not be OPENED keeps answering every query with the same error
 * for the life of the process (the pool reports the open failure once and still calls itself
 * available). Warning per read would turn one standing condition into a line per vault search, which
 * is how a log stops being read — the same failure mode as the silent fallback this package exists to
 * end, arriving from the other side. A DIFFERENT message still speaks.
 */
function sayPoolFallbackOnce(label: string, error: string): void {
  if (saidPoolFallback.has(error)) return;
  saidPoolFallback.add(error);
  logger.warn('a vault read could not use the reader pool and ran on the serving thread instead; '
    + 'this is said once per distinct failure', { label, error });
}

/** Test seam: let a clause see the warn again. */
export function resetVaultReadWarnsForTest(): void {
  saidPoolFallback.clear();
}

/**
 * Score the newest `VAULT_CANDIDATE_ROWS` entries matching `conditions`, in budgeted chunks, off the
 * serving thread when the pool is up.
 *
 * The caller owns the SQL conditions (three callers, three different scopes) and this owns the
 * window, the chunking, the scoring and the warn — the same division `search-bounds.ts` draws on the
 * message side, for the same reason: a generic query builder here would be the framework the brief
 * says not to build.
 */
export async function scanVaultCandidates(opts: {
  /** Reader-pool label PREFIX. The read is labelled `<label>:candidates`. */
  readonly label: string;
  readonly queryEmbedding: Float32Array;
  readonly conditions: readonly string[];
  readonly params: readonly unknown[];
  readonly agentId?: string;
  readonly signal?: AbortSignal;
  readonly candidateRows?: number;
  readonly chunkRows?: number;
}): Promise<VaultCandidateScan> {
  const db = getDb();
  const cap = opts.candidateRows ?? VAULT_CANDIDATE_ROWS;
  // ⚠ TWO SINGLE-AGGREGATE STATEMENTS, NEVER A COMBINED `MIN(x), MAX(x)`, and the reason is measured
  // rather than stylistic (t89 fix round 1, I5): SQLite's min/max optimisation reads ONE aggregate
  // off the end of a b-tree and does not apply to two in one statement — the combined form walks
  // every index entry the WHERE matches, 23.457 ms against 0.015 ms on a 240,000-row fixture, AND
  // ALL THREE PRINT THE IDENTICAL PLAN, so an `EXPLAIN QUERY PLAN` clause cannot tell them apart.
  // Both ends are the table's GLOBAL span against the integer primary key, so each is O(log n) and
  // needs no index; the caller's scope stays in the chunk SQL, which leaves the ROWS unchanged.
  const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM vault_entries').get() as
    { r: number | null } | undefined)?.r ?? 0;
  const minRid = Math.max(0, ((db.prepare('SELECT MIN(rowid) AS r FROM vault_entries')
    .get() as { r: number | null } | undefined)?.r ?? 1) - 1);
  const windowFloor = Math.max(vaultCandidateFloor(maxRid, cap), minRid);

  // ⚠ `rowid AS rid`, ALIASED. `vault_entries.id` is a TEXT primary key so insertion order lives in
  // the implicit rowid, and an unaliased `rowid` projection is the shape that can come back under
  // another name and read `undefined` in TypeScript WITHOUT THROWING (PHASE-1 T10's reader guard
  // names that class on `messages`; the hazard is not table-specific).
  const pageSql = `
    SELECT id, embedding, rowid AS rid FROM vault_entries
    WHERE ${opts.conditions.join(' AND ')} AND rowid <= ? AND rowid > ?
    ORDER BY rid DESC
  `;
  const pageStmt = db.prepare(pageSql);

  let oldestRidConsidered = maxRid;
  const scan = await boundedRecencyScan<ScoredVaultCandidate>({
    limit: cap,
    startRowidCeiling: maxRid,
    // ⚠ THE CAP'S APPLICATION, AND IT IS A FIRST-CLASS ARGUMENT RATHER THAN AN EMERGENT PROPERTY.
    // `boundedRecencyScan` used to stop on a chunk that examined zero rows, and that inference was
    // C1 — a stretch of keys owned entirely by other agents examines none of THIS scope's rows and
    // says nothing whatever about whether older rows of its own exist. The break is deleted, so the
    // walk is TOLD where it may stop, and for this scan that key is the candidate window's floor.
    floorRowid: windowFloor,
    chunkRows: opts.chunkRows ?? VAULT_CANDIDATE_CHUNK_ROWS,
    // Agreeing belts rather than three policies: the floor holds the walk to `cap / chunkRows`
    // chunks, so the row ceiling cannot bite before it does unless a future caller drops
    // `embedding IS NOT NULL` from its conditions, and the byte ceiling guards embedding WIDTH.
    maxRows: cap,
    maxBytes: VAULT_CANDIDATE_MAX_BYTES,
    // One turn of the loop per chunk. This is what turns "0 % of ticks serviced" into "62 %".
    breathe: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
    fetchChunk: async (ceiling, chunkRows) => {
      // ⚠ CLAMPED TO THE WINDOW, which matters only for the LAST chunk and matters there completely:
      // the loop stops when `ceiling <= floorRowid`, so the final chunk is reached with a ceiling
      // still above the floor, and without this clamp its lower bound would reach BELOW the window
      // and score entries the cap excluded. (No empty-chunk guard here any more — the floor owns
      // that question now, and one mechanism is the point of C1.)
      const chunkFloor = Math.max(windowFloor, ceiling - chunkRows);
      const page = await vaultRead<VaultCandidateRow>(
        `${opts.label}:candidates`, pageSql, [...opts.params, ceiling, chunkFloor],
        () => pageStmt.all(...opts.params, ceiling, chunkFloor) as VaultCandidateRow[],
        opts.signal,
      );
      let bytesRead = 0;
      const rows: ScoredVaultCandidate[] = [];
      for (const row of page) {
        if (row.rid < oldestRidConsidered) oldestRidConsidered = row.rid;
        if (!row.embedding) continue;
        bytesRead += row.embedding.length;
        const emb = new Float32Array(
          row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4,
        );
        rows.push({ id: row.id, rid: row.rid, similarity: cosineSimilarity(opts.queryEmbedding, emb) });
      }
      // ⚠ `rowsExamined` IS THE SCORED COUNT, AND THERE IS NO SECOND "COST" READ HERE ON PURPOSE. The
      // LIKE walk below needs one, because its page carries a LIMIT and so the rows it returns say
      // nothing about the rows SQLite tested. This page has NO LIMIT: every row in the window that
      // matches is returned, so the page IS the cost. (SQLite still steps past rows the conditions
      // reject; the rowid window is what bounds THAT, which is the number the warn reports.)
      return { rows, rowsExamined: page.length, bytesRead };
    },
  });

  // ⚠ TWO DIFFERENT TRUNCATIONS, BOTH LOUD. A budget stopping the walk is one; the window not being
  // the whole table is the other, and it is the one that can cost an old permanent fact — so it is
  // reported even though the scan "worked".
  const truncated = scan.report.stoppedBecause !== 'exhausted' || windowFloor > 0;
  if (truncated) {
    logBoundedFallback(
      `${opts.label}:candidates`,
      `the vault candidate window held this search to the newest ${cap} entr(ies) of ${maxRid}; `
      + `the oldest entry it considered was #${oldestRidConsidered}, so an older fact than that was `
      + 'NOT scored',
      scan.report,
      opts.agentId,
    );
  }

  return {
    scored: scan.rows, report: scan.report, truncated,
    oldestRidConsidered, windowFloor, maxRid,
  };
}

/**
 * Fetch full rows for the entries that actually won, by id, in bounded batches.
 *
 * This is the other half of "bodies only for the winners": the candidate pass never reads a body, so
 * the 3 KB embedding and the content are paid for ten rows instead of ten thousand.
 */
export async function fetchVaultRowsByIds<T>(opts: {
  /** Reader-pool label PREFIX. The read is labelled `<label>:bodies`. */
  readonly label: string;
  readonly ids: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<T[]> {
  if (opts.ids.length === 0) return [];
  const db = getDb();
  const out: T[] = [];
  for (let i = 0; i < opts.ids.length; i += VAULT_BODY_CHUNK_IDS) {
    const batch = opts.ids.slice(i, i + VAULT_BODY_CHUNK_IDS);
    const sql = `SELECT * FROM vault_entries WHERE id IN (${batch.map(() => '?').join(', ')})`;
    const stmt = db.prepare(sql);
    out.push(...await vaultRead<T>(
      `${opts.label}:bodies`, sql, batch, () => stmt.all(...batch) as T[], opts.signal,
    ));
  }
  return out;
}

/**
 * ⚠ THE SCOPE AND THE MATCH ARE SEPARATE FIELDS, AND THAT SPLIT IS THE WHOLE REASON THE LOGGED COST
 * IS TRUE. The walk's cost is the rows it had to TEST, which is every row in the window inside the
 * caller's scope — not the rows the LIKE let through. So the scope conditions go in both statements
 * and the match condition goes only in the page; a cost query carrying the LIKE would count the
 * ANSWER and call it the work, which is the defect this file exists to end.
 */
export interface VaultLikeScanQuery {
  /** Conditions every examined row is tested against (type, agent scope, namespace, flags). */
  readonly scope: readonly string[];
  readonly scopeParams: readonly unknown[];
  /** The narrowing condition(s) — the leading-wildcard LIKE — and their parameters. */
  readonly match: readonly string[];
  readonly matchParams: readonly unknown[];
  readonly limit: number;
}

/** The two statements a bounded LIKE walk needs: the page it returns, and what that page cost. */
function vaultLikeSql(q: VaultLikeScanQuery): { page: string; cost: string } {
  const pageWhere = [...q.scope, ...q.match, 'rowid <= ?', 'rowid > ?'].join(' AND ');
  const costWhere = [...q.scope, 'rowid <= ?', 'rowid > ?'].join(' AND ');
  return {
    // The page carries whole rows because it is already bounded by the caller's LIMIT — at most
    // `limit` embeddings, not the table's.
    //
    // ⚠ AND THE WALK ORDER CHANGES, stated because it is a real behaviour change and not a refactor:
    // this was `ORDER BY created_at DESC` and now walks `rowid DESC`. A bounded scan needs a
    // monotonic chunk key and `created_at` is not one — it is a second-resolution `datetime('now')`
    // string, so two entries written in the same second share it. For a search result the two orders
    // are near-identical and the new one is strictly more deterministic.
    page: `SELECT * FROM vault_entries WHERE ${pageWhere} ORDER BY rowid DESC LIMIT ?`,
    // ⚠ THE COST READ IS WHAT MAKES THE LOGGED NUMBER HONEST. The page query has a LIMIT, so the rows
    // it RETURNS say nothing about the rows SQLite had to test to find them — which is the entire
    // defect. One indexed count over the same rowid window is the real examined figure.
    cost: `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM vault_entries WHERE ${costWhere}`,
  };
}

interface CostRow { n: number; bytes: number }

/**
 * The table's GLOBAL rowid span — where the walk starts and the key below which it has nothing.
 *
 * ⚠ GLOBAL, NOT SCOPED, and that is the cheaper AND the more honest choice. `vault_entries` has no
 * index that covers an arbitrary listing scope (type, tags, namespace, an agent IN-list), so a
 * scoped `MIN`/`MAX` would be a reverse table walk — the exact cost I5 measured at 50 ms on a
 * 40,000-row table. Against the integer primary key both ends are O(log n) and need no index at all,
 * and the scope stays in the chunk SQL so the ROWS the walk returns are unchanged. The price is
 * stated: a narrowly-scoped listing walks every chunk between the TABLE's ends rather than its own,
 * which is bounded by construction and is two indexed reads per empty chunk.
 *
 * ⚠ AND NEVER AS ONE `SELECT MIN(rowid), MAX(rowid)` — see `scanVaultCandidates` for the
 * measurement. The combined form silently loses SQLite's min/max optimisation and prints the same
 * plan, so no `EXPLAIN` clause can catch it.
 */
function vaultRowidSpan(db: ReturnType<typeof getDb>): { maxRid: number; minRid: number } {
  const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM vault_entries').get() as
    { r: number | null } | undefined)?.r ?? 0;
  // Exclusive: the walk stops at `ceiling <= floorRowid`, so the floor sits one BELOW the oldest row.
  const minRid = Math.max(0, ((db.prepare('SELECT MIN(rowid) AS r FROM vault_entries')
    .get() as { r: number | null } | undefined)?.r ?? 1) - 1);
  return { maxRid, minRid };
}

function reportVaultLikeScan(report: BoundedScanReport): void {
  if (report.truncated || report.chunks > 1) {
    logBoundedFallback('vault_exact:like', 'a leading-wildcard LIKE cannot use an index', report);
  }
}

/**
 * The exact-search walk, SYNCHRONOUS.
 *
 * ⚠ WHY A SYNCHRONOUS DOOR STILL EXISTS, stated rather than left to be wondered at: `listEntries` is
 * called from a Hono route handler, from a squad-recall tool and from the `vault_search` tool, and
 * three of those four call sites are in files this change does not own. Making it `async` is a
 * one-line edit at each — cheap, and NOT this lane's to make. So the walk is bounded in both
 * directions and the POOLED one (below) is wired to the caller inside this package that is already
 * async. The report hands the remaining `await`s up.
 */
export function vaultLikeScanSync<T>(q: VaultLikeScanQuery): T[] {
  const db = getDb();
  const { page, cost } = vaultLikeSql(q);
  const pageStmt = db.prepare(page);
  const costStmt = db.prepare(cost);
  const pageParams = [...q.scopeParams, ...q.matchParams];
  const { maxRid, minRid } = vaultRowidSpan(db);
  const scan = boundedRecencyScanSync<T>({
    limit: q.limit,
    startRowidCeiling: maxRid,
    floorRowid: minRid,
    fetchChunk: (ceiling, chunkRows) => {
      const floor = Math.max(minRid, ceiling - chunkRows);
      const c = costStmt.get(...q.scopeParams, ceiling, floor) as CostRow;
      const rows = pageStmt.all(...pageParams, ceiling, floor, q.limit) as T[];
      return { rows, rowsExamined: c.n, bytesRead: c.bytes };
    },
  });
  reportVaultLikeScan(scan.report);
  return scan.rows;
}

/** The same walk, through the pool, for a caller that can await it. */
export async function vaultLikeScan<T>(q: VaultLikeScanQuery, signal?: AbortSignal): Promise<T[]> {
  const db = getDb();
  const { page, cost } = vaultLikeSql(q);
  const pageStmt = db.prepare(page);
  const costStmt = db.prepare(cost);
  const pageParams = [...q.scopeParams, ...q.matchParams];
  const { maxRid, minRid } = vaultRowidSpan(db);
  const scan = await boundedRecencyScan<T>({
    limit: q.limit,
    startRowidCeiling: maxRid,
    floorRowid: minRid,
    breathe: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
    fetchChunk: async (ceiling, chunkRows) => {
      const floor = Math.max(minRid, ceiling - chunkRows);
      const c = (await vaultRead<CostRow>(
        'vault_exact:like:cost', cost, [...q.scopeParams, ceiling, floor],
        () => [costStmt.get(...q.scopeParams, ceiling, floor) as CostRow], signal,
      ))[0] ?? { n: 0, bytes: 0 };
      const rows = await vaultRead<T>(
        'vault_exact:like:page', page, [...pageParams, ceiling, floor, q.limit],
        () => pageStmt.all(...pageParams, ceiling, floor, q.limit) as T[], signal,
      );
      return { rows, rowsExamined: c.n, bytesRead: c.bytes };
    },
  });
  reportVaultLikeScan(scan.report);
  return scan.rows;
}
