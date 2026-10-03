// ════════════════════════════════════════════════════════════════════════════════════════
// HARD BOUNDS ON TEXT SEARCH — because "LIMIT 20" bounds the ANSWER, not the WORK.
//
// ⚠ THE MEASURED DEFECT. On a user's box (729 MB database, born in April, one agent past turn 1,500) a
// profiler sample taken during a freeze window found 4,693 of 7,487 main-thread samples inside ONE
// `Statement::JS_all` — `sqlite3_step → sqlite3BtreeNext → moveToChild → getAndInitPage → readDbPage →
// pread`. A synchronous B-tree walk, reading pages off disk, on the thread that serves HTTP. The server
// was DEAF to a health probe for 43 seconds, then 14 seconds of life, then 38 more.
//
// ── WHY THE EXISTING "LIMIT" DID NOT HELP, WHICH IS THE WHOLE POINT OF THIS FILE ──
// Both search paths already had a LIMIT, and both were unbounded anyway:
//
//   · THE LIKE PATH: `content LIKE '%term%' … ORDER BY created_at DESC LIMIT 60`. SQLite cannot use an
//     index for a leading-wildcard LIKE, so it walks rows newest-first and TESTS EACH ONE until it has
//     sixty matches. For a common word that is sixty rows of work; for a rare word — or a word that
//     appears nowhere — it is the agent's ENTIRE history, every row's content read off disk. The LIMIT
//     bounds what comes back and says nothing about what was touched.
//   · THE FTS PATH: `messages_fts MATCH ? … ORDER BY rank LIMIT 20`. `ORDER BY rank` must SCORE EVERY
//     MATCH before it can know which twenty win, and the `INNER JOIN messages ON rowid` pulls each
//     matching row's content to do it. A term appearing in ten thousand messages is ten thousand row
//     reads to return twenty.
//
// So the bound has to be on the CANDIDATE SET, before ranking, and on ROWS READ, not rows returned.
//
// ── AND THE NUMBERS, EACH ARGUED RATHER THAN PICKED ──
// They are deliberately generous: this file exists to turn an unbounded scan into a bounded one, not to
// make search worse. A bound nobody reaches costs nothing; a bound everybody reaches is a feature
// regression. The warn is what tells us if we guessed wrong — which is why the fallback is LOUD.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('search-bounds');

/**
 * How many of an agent's most recent messages an FTS query may RANK over.
 *
 * Rank needs every candidate scored, so this is the real cost knob. 50,000 messages is far more history
 * than any search usefully reaches into — the measured box's whole database was ~123,000 events across
 * every agent and table — and it caps the work at a known ceiling instead of "however much exists".
 * ⚠ RECENCY IS THE RIGHT AXIS because `messages.rowid` is append-only, so a rowid floor IS a time
 * window, costs nothing to compute, and an older match is exactly the one a person is least likely to
 * mean. Searching further back is a feature request (a `since` filter already exists and is honoured);
 * silently scanning a 729 MB table is not.
 */
export const FTS_CANDIDATE_ROWS = 50_000;

/**
 * The LIKE fallback walks the table in chunks of this many rowids, newest first.
 *
 * Chunking is what converts one unbounded synchronous call into several bounded ones — which matters
 * even before the work moves off-thread, because the loop gets a turn between chunks and because the
 * budget below can stop the walk partway. 20,000 rows is big enough that an ordinary search finishes in
 * the first chunk and small enough that one chunk is not itself a freeze.
 */
export const LIKE_CHUNK_ROWS = 20_000;

/**
 * The hard ceiling on rows a single LIKE fallback may TOUCH, across all chunks.
 *
 * This is the number that would have ended the incident: past it the search stops and says so, instead
 * of walking a 729 MB table to find out there is nothing to find. 200,000 rows is ~10 chunks.
 */
export const LIKE_MAX_ROWS_SCANNED = 200_000;

/**
 * And a byte budget, because rows are not the cost — CONTENT is. One agent's history can hold messages
 * of a few hundred bytes and messages of half a megabyte, and 200,000 of the latter is a different
 * machine entirely. 64 MB of content read is the point at which this stops being a search and starts
 * being a table scan with extra steps.
 */
export const LIKE_MAX_BYTES_SCANNED = 64 * 1024 * 1024;

export type BoundedStopReason =
  /** The caller got everything it asked for — the ordinary case, and the bounds never bit. */
  | 'satisfied'
  /** No more rows to walk: the whole (bounded) history was searched and that was that. */
  | 'exhausted'
  /** The row ceiling was reached with the answer still incomplete. */
  | 'row_budget'
  /** The byte ceiling was reached with the answer still incomplete. */
  | 'byte_budget';

export interface BoundedScanReport {
  readonly rowsScanned: number;
  readonly bytesScanned: number;
  readonly chunks: number;
  readonly matched: number;
  readonly stoppedBecause: BoundedStopReason;
  /** True when the search gave up with room left in the caller's limit — a possibly-incomplete answer. */
  readonly truncated: boolean;
}

export interface BoundedScanChunk<T> {
  readonly rows: readonly T[];
  /** Total content bytes this chunk read, so the byte budget means what it says. */
  readonly bytesRead: number;
  /** Rows the chunk actually examined, which is NOT the rows it returned. */
  readonly rowsExamined: number;
}

/**
 * Walk a recency window in chunks until the caller's limit fills or a budget is spent.
 *
 * `fetchChunk` is handed a rowid ceiling (exclusive) and the chunk size, and returns what it found plus
 * what it cost. This module owns the ARITHMETIC and the budget; the caller owns the SQL, because the
 * three search subsystems query three different tables and a generic query builder here would be the
 * job-queue framework the brief says not to build.
 */
export function boundedRecencyScanSync<T>(opts: {
  readonly limit: number;
  readonly startRowidCeiling: number;
  readonly fetchChunk: (rowidCeiling: number, chunkRows: number) => BoundedScanChunk<T>;
  readonly chunkRows?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}): { rows: T[]; report: BoundedScanReport } {
  const chunkRows = opts.chunkRows ?? LIKE_CHUNK_ROWS;
  const maxRows = opts.maxRows ?? LIKE_MAX_ROWS_SCANNED;
  const maxBytes = opts.maxBytes ?? LIKE_MAX_BYTES_SCANNED;
  const rows: T[] = [];
  let rowsScanned = 0;
  let bytesScanned = 0;
  let chunks = 0;
  let ceiling = opts.startRowidCeiling;
  let stoppedBecause: BoundedStopReason = 'exhausted';
  while (rows.length < opts.limit) {
    if (ceiling <= 0) { stoppedBecause = 'exhausted'; break; }
    if (rowsScanned >= maxRows) { stoppedBecause = 'row_budget'; break; }
    if (bytesScanned >= maxBytes) { stoppedBecause = 'byte_budget'; break; }
    const chunk = opts.fetchChunk(ceiling, chunkRows);
    chunks += 1;
    rowsScanned += chunk.rowsExamined;
    bytesScanned += chunk.bytesRead;
    rows.push(...chunk.rows.slice(0, opts.limit - rows.length));
    if (chunk.rowsExamined === 0) { stoppedBecause = 'exhausted'; break; }
    ceiling -= chunkRows;
    if (rows.length >= opts.limit) { stoppedBecause = 'satisfied'; break; }
  }
  if (rows.length >= opts.limit) stoppedBecause = 'satisfied';
  return {
    rows,
    report: {
      rowsScanned, bytesScanned, chunks, matched: rows.length, stoppedBecause,
      truncated: stoppedBecause === 'row_budget' || stoppedBecause === 'byte_budget',
    },
  };
}

/**
 * ⚠ THE SAME LOOP, ASYNC, for the caller that can give the event loop a turn between chunks. Two
 * functions rather than one `await`-everywhere version because the retrieval paths are synchronous today
 * and will move to a worker thread (deliverable 1) rather than becoming async in place — making them
 * async here would be a wide refactor of callers for no behaviour gained. The sync one is the shipped
 * path; this one is what the worker uses.
 */
export async function boundedRecencyScan<T>(opts: {
  readonly limit: number;
  readonly startRowidCeiling: number;
  readonly fetchChunk: (rowidCeiling: number, chunkRows: number) => BoundedScanChunk<T>;
  readonly chunkRows?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
  /** Lets the loop give the event loop a turn between chunks. Omitted in a sync-only caller. */
  readonly breathe?: () => Promise<void>;
}): Promise<{ rows: T[]; report: BoundedScanReport }> {
  const chunkRows = opts.chunkRows ?? LIKE_CHUNK_ROWS;
  const maxRows = opts.maxRows ?? LIKE_MAX_ROWS_SCANNED;
  const maxBytes = opts.maxBytes ?? LIKE_MAX_BYTES_SCANNED;

  const rows: T[] = [];
  let rowsScanned = 0;
  let bytesScanned = 0;
  let chunks = 0;
  let ceiling = opts.startRowidCeiling;
  let stoppedBecause: BoundedStopReason = 'exhausted';

  while (rows.length < opts.limit) {
    if (ceiling <= 0) { stoppedBecause = 'exhausted'; break; }
    if (rowsScanned >= maxRows) { stoppedBecause = 'row_budget'; break; }
    if (bytesScanned >= maxBytes) { stoppedBecause = 'byte_budget'; break; }

    const chunk = opts.fetchChunk(ceiling, chunkRows);
    chunks += 1;
    rowsScanned += chunk.rowsExamined;
    bytesScanned += chunk.bytesRead;
    rows.push(...chunk.rows.slice(0, opts.limit - rows.length));

    // A chunk that examined nothing means there is nothing older left to examine; without this the loop
    // would spin on an empty tail forever.
    if (chunk.rowsExamined === 0) { stoppedBecause = 'exhausted'; break; }
    ceiling -= chunkRows;
    if (rows.length >= opts.limit) { stoppedBecause = 'satisfied'; break; }
    if (opts.breathe) await opts.breathe();
  }
  if (rows.length >= opts.limit) stoppedBecause = 'satisfied';

  return {
    rows,
    report: {
      rowsScanned,
      bytesScanned,
      chunks,
      matched: rows.length,
      stoppedBecause,
      truncated: stoppedBecause === 'row_budget' || stoppedBecause === 'byte_budget',
    },
  };
}

/**
 * ⚠ EVERY FALLBACK IS LOUD, and the brief is explicit about why: on the affected box a database born
 * before the FTS migration "silently LIKE-scans FOREVER — the fallback is a warn nobody sees". So the
 * warn carries the NUMBERS (rows read, bytes read, chunks) rather than the fact, because the fact was
 * already being logged and told nobody anything. A truncated answer is reported at warn level even when
 * the search "worked": an incomplete result that looks complete is the failure mode that wastes a day.
 *
 * ⚠ NO PATTERN, NO SNIPPET, NO CONTENT — the subsystem and the counts only. This line ends up in pasted
 * logs, and the brief forbids user query text in any shipped surface.
 */
export function logBoundedFallback(
  subsystem: string,
  reason: string,
  report: BoundedScanReport,
  agentId?: string,
): void {
  const sentence = report.truncated
    ? `${subsystem}: the bounded fallback STOPPED EARLY (${report.stoppedBecause}) with an incomplete answer`
    : `${subsystem}: the bounded fallback ran (${report.stoppedBecause})`;
  logger.warn(`${sentence} — ${reason}`, {
    subsystem,
    reason,
    rowsScanned: report.rowsScanned,
    bytesScanned: report.bytesScanned,
    chunks: report.chunks,
    matched: report.matched,
    stoppedBecause: report.stoppedBecause,
    truncated: report.truncated,
  }, agentId);
}

/**
 * The rowid floor for an FTS candidate window: rank over the newest `FTS_CANDIDATE_ROWS` rows and no
 * more. Returns 0 when the table is smaller than the window, which makes the bound a no-op on every
 * box that has not yet grown into the problem — the overwhelming majority.
 */
export function ftsCandidateRowidFloor(maxRowid: number, candidateRows = FTS_CANDIDATE_ROWS): number {
  return Math.max(0, maxRowid - candidateRows);
}
