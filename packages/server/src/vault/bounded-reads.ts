// The vault's reads, bounded. The async scans' page reads go through `vaultRead` (off the serving thread when
// the pool is up); the rowid-span seeks and `vaultLikeScanSync` run on the serving connection. The candidate
// pass projects `id, embedding, rowid`, never `*`, and fetches full rows only for the winners. `rowid` is
// the only monotonic key (the `id` is a TEXT uuid), so the recency window is a rowid floor. The cap bounds
// pathological size, not relevance: a distilled entry ("the owner's timezone") stays relevant however old.

import { setImmediate as setImmediateUnfaked } from 'node:timers';
import { getDb } from '../db/connection.js';
import { embeddingModelKey } from '../memory/embedding-model.js';
import { createLogger } from '../logger.js';
import { readerPoolAvailable, readerQuery } from '../memory/reader-pool.js';
import {
  boundedRecencyScan, boundedRecencyScanSync, ftsCandidateRowidFloor, logBoundedFallback,
  type BoundedScanReport,
} from '../memory/search-bounds.js';

const logger = createLogger('vault-bounded-reads');

// How many of the newest vault entries one semantic search may SCORE (~0.0065 ms per entry, measured by
// scripts/t98-measure-chunked-vault-scan.mjs); twice `FTS_CANDIDATE_ROWS`, far above a real vault.
export const VAULT_CANDIDATE_ROWS = 100_000;

// Rowids per candidate chunk: scoring runs on the main thread, so this bounds each loop stall.
export const VAULT_CANDIDATE_CHUNK_ROWS = 5_000;

// Byte ceiling on one candidate scan, guarding embedding WIDTH (the blob has no dimension column). 320 MB is just
// above the row cap's cost at 768 floats, so today the row cap binds.
export const VAULT_CANDIDATE_MAX_BYTES = 320 * 1024 * 1024;

// Ids per body fetch `IN (…)`: the limit is model-supplied and must not exceed SQLite's variable limit.
export const VAULT_BODY_CHUNK_IDS = 500;

export interface VaultCandidateRow {
  readonly id: string;
  readonly rid: number;
  readonly embedding: Buffer | null;
}

export interface ScoredVaultCandidate {
  readonly id: string;
  /** The entry's rowid, for the caller's tie-break (see `store.ts`). */
  readonly rid: number;
  readonly similarity: number;
}

export interface VaultCandidateScan {
  readonly scored: ScoredVaultCandidate[];
  readonly report: BoundedScanReport;
  readonly truncated: boolean;
  readonly oldestRidConsidered: number;
  /** The rowid floor the window started at: 0 means the whole table was in scope. */
  readonly windowFloor: number;
  readonly maxRid: number;
}

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

// Best first, ties broken by the OLDEST entry, independent of the newest-first order rows arrive in.
export function byBestSimilarity(a: ScoredVaultCandidate, b: ScoredVaultCandidate): number {
  return b.similarity - a.similarity || a.rid - b.rid;
}

/** The candidate window's rowid floor: 0 on any vault smaller than the cap. */
export function vaultCandidateFloor(maxRowid: number, candidateRows = VAULT_CANDIDATE_ROWS): number {
  return ftsCandidateRowidFloor(maxRowid, candidateRows);
}

// One turn of the event loop (with the pool down, chunks would run back to back). From `node:timers`, not the
// global: `vi.useFakeTimers()` fakes the global `setImmediate` and would deadlock a caller owning the clock.
const vaultBreathe = (): Promise<void> =>
  new Promise<void>((resolve) => { setImmediateUnfaked(resolve); });

// The one door every pooled vault read goes through. Pool up: the read runs on the worker's read-only connection.
// Pool down or erroring: the caller's statement runs here, so a reader hiccup makes a search slow, never
// failed. An abort is re-thrown, never retried: re-running it would resurrect what was cancelled.
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

const saidPoolFallback = new Set<string>();

// Said once per distinct failure, so a standing pool failure is one log line, not one per vault search.
function sayPoolFallbackOnce(label: string, error: string): void {
  if (saidPoolFallback.has(error)) return;
  saidPoolFallback.add(error);
  logger.warn('a vault read could not use the reader pool and ran on the serving thread instead; '
    + 'this is said once per distinct failure', { label, error });
}

export function resetVaultReadWarnsForTest(): void {
  saidPoolFallback.clear();
}

// The table's GLOBAL rowid span: no index covers an arbitrary listing scope, so a scoped MIN/MAX is a
// reverse table walk. Two statements, never `SELECT MIN(rowid), MAX(rowid)`: the combined form loses
// SQLite's min/max optimisation yet prints the same plan, so no EXPLAIN test can catch it.
function vaultRowidSpan(db: ReturnType<typeof getDb>): { maxRid: number; minRid: number } {
  const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM vault_entries').get() as
    { r: number | null } | undefined)?.r ?? 0;
  // Exclusive: the walk stops at `ceiling <= floorRowid`, so the floor sits one BELOW the oldest row.
  const minRid = Math.max(0, ((db.prepare('SELECT MIN(rowid) AS r FROM vault_entries')
    .get() as { r: number | null } | undefined)?.r ?? 1) - 1);
  return { maxRid, minRid };
}

// The span keyed to the SCOPE searched (a table-wide window can sit above the caller's rows): one
// `idx_vault_agent` seek per id, never `agent_id IN (…)`, which loses the min/max optimisation.
function vaultScopedRowidSpan(
  db: ReturnType<typeof getDb>,
  agentIds: readonly string[],
): { maxRid: number; minRid: number } {
  const maxStmt = db.prepare('SELECT MAX(rowid) AS r FROM vault_entries WHERE agent_id = ?');
  const minStmt = db.prepare('SELECT MIN(rowid) AS r FROM vault_entries WHERE agent_id = ?');
  let maxRid = 0;
  let oldest: number | null = null;
  for (const id of agentIds) {
    const hi = (maxStmt.get(id) as { r: number | null } | undefined)?.r;
    if (typeof hi === 'number' && hi > maxRid) maxRid = hi;
    const lo = (minStmt.get(id) as { r: number | null } | undefined)?.r;
    if (typeof lo === 'number' && (oldest === null || lo < oldest)) oldest = lo;
  }
  return { maxRid, minRid: Math.max(0, (oldest ?? 1) - 1) };
}

// Scores the newest `VAULT_CANDIDATE_ROWS` entries matching `conditions`, in budgeted chunks.
export async function scanVaultCandidates(opts: {
  readonly label: string;
  readonly queryEmbedding: Float32Array;
  readonly conditions: readonly string[];
  readonly params: readonly unknown[];
  readonly agentId?: string;
  readonly signal?: AbortSignal;
  readonly candidateRows?: number;
  readonly chunkRows?: number;
  /** The agent ids `conditions` scope to, so the window is THIS SCOPE's span; omit only for an unscoped scan. */
  readonly scopeAgentIds?: readonly string[];
}): Promise<VaultCandidateScan> {
  opts = { ...opts, conditions: [...opts.conditions, 'embedding_model = ?'], params: [...opts.params, embeddingModelKey()] };
  const db = getDb();
  const cap = opts.candidateRows ?? VAULT_CANDIDATE_ROWS;
  const span = opts.scopeAgentIds && opts.scopeAgentIds.length > 0
    ? vaultScopedRowidSpan(db, opts.scopeAgentIds)
    : vaultRowidSpan(db);
  const { maxRid, minRid } = span;
  const capFloor = vaultCandidateFloor(maxRid, cap);
  const windowFloor = Math.max(capFloor, minRid);

  // `rowid AS rid`, aliased: an unaliased `rowid` can come back renamed and read `undefined` silently.
  const pageSql = `
    SELECT id, embedding, rowid AS rid FROM vault_entries
    WHERE ${opts.conditions.join(' AND ')} AND rowid <= ? AND rowid > ?
    ORDER BY rid DESC
  `;
  const pageStmt = db.prepare(pageSql);

  // Starts at the floor, not the ceiling, so a window holding none of the caller's rows reports how far it looked.
  let oldestRidConsidered = windowFloor + 1;
  let lowestFloorRead = maxRid;
  const scan = await boundedRecencyScan<ScoredVaultCandidate>({
    limit: cap,
    startRowidCeiling: maxRid,
    // The walk is told where to stop: a chunk examining zero rows says nothing about older rows of this scope.
    floorRowid: windowFloor,
    chunkRows: opts.chunkRows ?? VAULT_CANDIDATE_CHUNK_ROWS,
    // Agreeing belts: the floor holds the walk to `cap / chunkRows` chunks; bytes guard WIDTH.
    maxRows: cap,
    maxBytes: VAULT_CANDIDATE_MAX_BYTES,
    breathe: vaultBreathe,
    fetchChunk: async (ceiling, chunkRows) => {
      // Clamped to the window, else the last chunk would score entries the cap excluded.
      const chunkFloor = Math.max(windowFloor, ceiling - chunkRows);
      if (chunkFloor < lowestFloorRead) lowestFloorRead = chunkFloor;
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
      // `rowsExamined` is the scored count: this page has no LIMIT, so the page IS the cost.
      return { rows, rowsExamined: page.length, bytesRead };
    },
  });

  // Two truncations, both loud: a budget stopping the walk, and the cap holding the window above the
  // caller's oldest row (which can cost an old permanent fact). Asked directly: is anything in this scope
  // older than what the walk looked at?
  const truncated = capFloor > minRid || lowestFloorRead > windowFloor;
  if (truncated) {
    // `report.truncated` is the budget's flag, so set the structured flag for a window truncation too.
    logBoundedFallback(
      `${opts.label}:candidates`,
      `the vault candidate window held this search to the newest ${cap} entr(ies) above rowid `
      + `#${windowFloor} of ${maxRid}; the oldest entry it considered was #${oldestRidConsidered}, `
      + 'so an older fact than that was NOT scored',
      { ...scan.report, truncated: true },
      opts.agentId,
    );
  }

  return {
    scored: scan.rows, report: scan.report, truncated,
    oldestRidConsidered, windowFloor, maxRid,
  };
}

export async function fetchVaultRowsByIds<T>(opts: {
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

// The scope and the match are separate fields so the logged cost is true: the walk's cost is every row in
// the window inside the scope, so the scope goes in both statements and the LIKE only in the page.
export interface VaultLikeScanQuery {
  readonly scope: readonly string[];
  readonly scopeParams: readonly unknown[];
  readonly match: readonly string[];
  readonly matchParams: readonly unknown[];
  readonly limit: number;
}

/** The two statements a bounded LIKE walk needs: the page it returns, and what that page cost. */
function vaultLikeSql(q: VaultLikeScanQuery): { page: string; cost: string } {
  const pageWhere = [...q.scope, ...q.match, 'rowid <= ?', 'rowid > ?'].join(' AND ');
  const costWhere = [...q.scope, 'rowid <= ?', 'rowid > ?'].join(' AND ');
  return {
    // The page carries whole rows (the caller's LIMIT bounds it) and walks `rowid DESC`: `created_at` is a
    // second-resolution string, not a monotonic chunk key.
    page: `SELECT * FROM vault_entries WHERE ${pageWhere} ORDER BY rowid DESC LIMIT ?`,
    // The cost read counts the rows SQLite had to test, which the page's LIMIT hides.
    cost: `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM vault_entries WHERE ${costWhere}`,
  };
}

interface CostRow { n: number; bytes: number }


function reportVaultLikeScan(report: BoundedScanReport): void {
  if (report.truncated || report.chunks > 1) {
    logBoundedFallback('vault_exact:like', 'a leading-wildcard LIKE cannot use an index', report);
  }
}

// Synchronous because `listEntries` has synchronous callers; the pooled walk serves callers that can await.
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
    breathe: vaultBreathe,
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
