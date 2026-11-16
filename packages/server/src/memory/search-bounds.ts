// Hard bounds on text search: LIMIT bounds the ANSWER, not the WORK. A leading-wildcard LIKE and FTS ORDER BY rank
// both touch every candidate, so the bound is on the candidate set and on ROWS READ. The fallback is LOUD.

import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const logger = createLogger('search-bounds');

/** Newest messages an FTS query may RANK over; rowid is append-only, so the floor is a cheap time window. */
export const FTS_CANDIDATE_ROWS = 50_000;

/** Newest embeddings of one agent a vector search scores, read newest first through an index. */
export const VECTOR_CANDIDATE_ROWS = 10_000;

/** Rowids per LIKE chunk, newest first: each call is bounded and the budget can stop the walk partway. */
export const LIKE_CHUNK_ROWS = 20_000;

/** Hard ceiling on rows one LIKE fallback may TOUCH across all chunks: past it the search stops and says so. */
export const LIKE_MAX_ROWS_SCANNED = 200_000;

/** Byte budget, because CONTENT is the cost, not rows: 64 MB read is a table scan with extra steps. */
export const LIKE_MAX_BYTES_SCANNED = 64 * 1024 * 1024;

export type BoundedStopReason =
  | 'satisfied'
  | 'exhausted'
  | 'row_budget'
  | 'byte_budget';

export interface BoundedScanReport {
  readonly rowsScanned: number;
  readonly bytesScanned: number;
  readonly chunks: number;
  readonly matched: number;
  readonly stoppedBecause: BoundedStopReason;
  readonly truncated: boolean;
}

export interface BoundedScanChunk<T> {
  readonly rows: readonly T[];
  readonly bytesRead: number;
  /** Rows the chunk actually examined, which is NOT the rows it returned. */
  readonly rowsExamined: number;
}

/**
 * Walk a recency window in chunks until the caller's limit fills or a budget is spent; the caller owns the SQL.
 * It stops ONLY on `floorRowid` or a budget, never on an empty chunk: `rowsExamined` counts only this agent's
 * rows, so a stretch of the global key owned by other agents examines zero and says nothing about older rows.
 */
export function boundedRecencyScanSync<T>(opts: {
  readonly limit: number;
  readonly startRowidCeiling: number;
  readonly floorRowid?: number;
  readonly fetchChunk: (rowidCeiling: number, chunkRows: number) => BoundedScanChunk<T>;
  readonly chunkRows?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}): { rows: T[]; report: BoundedScanReport } {
  const chunkRows = opts.chunkRows ?? LIKE_CHUNK_ROWS;
  const maxRows = opts.maxRows ?? LIKE_MAX_ROWS_SCANNED;
  const maxBytes = opts.maxBytes ?? LIKE_MAX_BYTES_SCANNED;
  const floorRowid = opts.floorRowid ?? 0;
  const rows: T[] = [];
  let rowsScanned = 0;
  let bytesScanned = 0;
  let chunks = 0;
  let ceiling = opts.startRowidCeiling;
  let stoppedBecause: BoundedStopReason = 'exhausted';
  while (rows.length < opts.limit) {
    if (ceiling <= floorRowid) { stoppedBecause = 'exhausted'; break; }
    if (rowsScanned >= maxRows) { stoppedBecause = 'row_budget'; break; }
    if (bytesScanned >= maxBytes) { stoppedBecause = 'byte_budget'; break; }
    const chunk = opts.fetchChunk(ceiling, chunkRows);
    chunks += 1;
    rowsScanned += chunk.rowsExamined;
    bytesScanned += chunk.bytesRead;
    rows.push(...chunk.rows.slice(0, opts.limit - rows.length));
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

/** The same walk as boundedRecencyScanSync, for a chunk that may be awaited; keep the two in step. */
export async function boundedRecencyScan<T>(opts: {
  readonly limit: number;
  readonly startRowidCeiling: number;
  /** The key below which the caller has nothing (exclusive), so an empty chunk never ends the walk: an indexed
   *  MIN for `messages`, the table's global MIN(rowid) for `summaries` (no per-agent index). */
  readonly floorRowid?: number;
  readonly fetchChunk: (rowidCeiling: number, chunkRows: number) => BoundedScanChunk<T> | Promise<BoundedScanChunk<T>>;
  readonly chunkRows?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
  readonly breathe?: () => Promise<void>;
}): Promise<{ rows: T[]; report: BoundedScanReport }> {
  const chunkRows = opts.chunkRows ?? LIKE_CHUNK_ROWS;
  const maxRows = opts.maxRows ?? LIKE_MAX_ROWS_SCANNED;
  const maxBytes = opts.maxBytes ?? LIKE_MAX_BYTES_SCANNED;
  const floorRowid = opts.floorRowid ?? 0;

  const rows: T[] = [];
  let rowsScanned = 0;
  let bytesScanned = 0;
  let chunks = 0;
  let ceiling = opts.startRowidCeiling;
  let stoppedBecause: BoundedStopReason = 'exhausted';

  while (rows.length < opts.limit) {
    if (ceiling <= floorRowid) { stoppedBecause = 'exhausted'; break; }
    if (rowsScanned >= maxRows) { stoppedBecause = 'row_budget'; break; }
    if (bytesScanned >= maxBytes) { stoppedBecause = 'byte_budget'; break; }

    const chunk = await opts.fetchChunk(ceiling, chunkRows);
    chunks += 1;
    rowsScanned += chunk.rowsExamined;
    bytesScanned += chunk.bytesRead;
    rows.push(...chunk.rows.slice(0, opts.limit - rows.length));

    // No zero-rows break: an empty chunk says nothing about older rows of this agent; floorRowid is the honest answer.
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

/** Every fallback is LOUD: the warn carries the NUMBERS, and a truncated answer is a warn even if the search
 *  "worked". No pattern or content: this line ends up in pasted logs. */
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

/** The messages FTS floor counted in the agent's own rows: the seq under its newest FTS_CANDIDATE_ROWS (0 when fewer). */
export function agentMessagesFloor(db: Database.Database, agentId: string): number {
  return (db.prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?')
    .get(agentId, FTS_CANDIDATE_ROWS) as { seq: number } | undefined)?.seq ?? 0;
}

/** The rowid floor for an FTS candidate window over the newest FTS_CANDIDATE_ROWS rows (0 when smaller). */
export function ftsCandidateRowidFloor(maxRowid: number, candidateRows = FTS_CANDIDATE_ROWS): number {
  return Math.max(0, maxRowid - candidateRows);
}

/**
 * The floor for a candidate window on a table shared by many agents: keep the global floor while the agent has
 * rows inside it, else re-seat on the agent's own newest row (a global floor above all its rows would silently
 * return zero). A re-seated window bounds more weakly, so `reseated` tells the caller. Kept here so a test
 * reads the real rule.
 */
export function ftsAgentCandidateFloor(
  globalMaxRowid: number,
  agentMaxRowid: number,
  candidateRows = FTS_CANDIDATE_ROWS,
): { readonly floor: number; readonly reseated: boolean } {
  const globalFloor = ftsCandidateRowidFloor(globalMaxRowid, candidateRows);
  if (agentMaxRowid > globalFloor) return { floor: globalFloor, reseated: false };
  return { floor: ftsCandidateRowidFloor(agentMaxRowid, candidateRows), reseated: true };
}
