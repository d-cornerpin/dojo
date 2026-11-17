import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import {
  agentMessagesFloor, boundedRecencyScan, boundedRecencyScanSync, ftsAgentCandidateFloor,
  logBoundedFallback, FTS_CANDIDATE_ROWS,
} from './search-bounds.js';
import { ftsSafeQuery } from './fts-query.js';
import { renderInstant } from './message-stamp.js';
import { pickWriter, summaryRoom } from './writer.js';
import { readerPoolAvailable, readerQuery } from './reader-pool.js';
import { callModel } from '../agent/model.js';
import { CHARS_PER_TOKEN, estimateTokens } from './budget.js';
import { getSummary, getDescendantMessages } from './dag.js';
import { getLargeFile } from './large-files.js';
import { clauseFor, requestForAnotherTurn } from './awaiting-own-turn.js';

const logger = createLogger('memory-retrieval');

// Self-echo filter for history_search: a pure tool-call assistant message persists as JSON that FTS5 indexes, so
// the agent's OWN previous call matches its next search and sends it round a loop. A message whose content is an
// array of only tool_use blocks is excluded; mixed text + tool_use and tool_result messages still surface.
export function isPureToolCallMessage(content: string): boolean {
  if (!content.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every((b: unknown) => {
      const block = b as { type?: string };
      return block?.type === 'tool_use';
    });
  } catch {
    return false;
  }
}

/**
 * The summaries FTS candidate window. `summaries_fts MATCH` ranks every agent's matching rows before the agent
 * filter applies, so the floor is the table's global MAX(rowid) minus FTS_CANDIDATE_ROWS. For an agent whose newest
 * summary is older than that floor, it would exclude every row the agent owns: zero rows, no error, no fallback.
 * So keep the global floor while the agent has rows inside it, and re-seat the window on the agent's own newest
 * row when it does not. A re-seated window bounds the global candidate set more weakly; correctness wins, and the
 * caller says so. Both MAX reads are cheap: the per-agent one is an indexed probe (idx_summaries_agent_depth).
 */
interface SummariesFtsWindow {
  readonly candidateFloor: number;
  readonly agentMax: number;
  readonly globalMax: number;
  /** The global window sat entirely above this agent's history and had to be re-seated on it. */
  readonly reseated: boolean;
}

function summariesFtsWindow(db: ReturnType<typeof getDb>, agentId: string): SummariesFtsWindow {
  // This function owns the two reads; `ftsAgentCandidateFloor` (search-bounds.ts) owns the rule, so a test can
  // exercise the real rule rather than a copy of it.
  const globalMax = (db.prepare('SELECT MAX(rowid) AS r FROM summaries')
    .get() as { r: number | null } | undefined)?.r ?? 0;
  // Indexed by idx_summaries_agent_depth (agent_id, ...).
  const agentMax = (db.prepare('SELECT MAX(rowid) AS r FROM summaries WHERE agent_id = ?')
    .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
  const { floor, reseated } = ftsAgentCandidateFloor(globalMax, agentMax);
  return { candidateFloor: floor, agentMax, globalMax, reseated };
}

/**
 * A bounded FTS miss says so, on every arm, through this one helper. The operator gets counts, the floor, the
 * window and whether filters were given (booleans, never values: the line is pasted into bug reports). The AGENT
 * gets one sentence naming the door out, because an agent that cannot tell "nothing matched" from "nothing RECENT
 * matched" re-asks with new wording (the self-echo loop). Returns that sentence, or null when the bound did not bite.
 * The door out is regex mode: its bounded walk is not held to the FTS window. It fires only when a floor applied AND the limit went unfilled; announcing a bound nobody reached is noise.
 */
function noteBoundedFtsMiss(p: {
  readonly subsystem: string;
  readonly unit: 'messages' | 'summaries';
  readonly agentId: string;
  readonly candidateFloor: number;
  readonly matched: number;
  readonly limit: number;
  readonly reseated?: boolean;
  readonly sinceGiven?: boolean;
  readonly beforeGiven?: boolean;
}): string | null {
  if (p.candidateFloor <= 0 || p.matched >= p.limit) return null;
  logger.warn(`${p.subsystem} answered from a bounded candidate window — the result may be incomplete`, {
    subsystem: p.subsystem,
    candidateFloor: p.candidateFloor,
    candidateRows: FTS_CANDIDATE_ROWS,
    matched: p.matched,
    limit: p.limit,
    reseated: p.reseated ?? false,
    sinceGiven: p.sinceGiven ?? false,
    beforeGiven: p.beforeGiven ?? false,
  }, p.agentId);
  return `[searched the newest ${FTS_CANDIDATE_ROWS.toLocaleString('en-US')} ${p.unit} only, older history was not`
    + ' scanned. Search again with mode: "regex" (an exact-phrase match) to reach further back.]';
}

// ── history_search: FTS5 search on messages and summaries ──

export async function memoryGrep(
  agentId: string,
  params: {
    pattern: string;
    mode?: 'full_text' | 'regex';
    scope?: 'messages' | 'summaries' | 'both';
    since?: string;
    before?: string;
    limit?: number;
  },
): Promise<string> {
  const db = getDb();
  const {
    pattern,
    mode = 'full_text',
    scope = 'both',
    since,
    before,
    limit = 20,
  } = params;

  const results: string[] = [];

  if (scope === 'messages' || scope === 'both') {
    const messageResults = await searchMessagesInner(db, agentId, pattern, mode, since, before, limit);
    if (messageResults.length > 0) {
      results.push(`=== RAW MESSAGES (${messageResults.length} results, exact conversation records) ===`);
      results.push(...messageResults);
    }
  }

  if (scope === 'summaries' || scope === 'both') {
    const summaryResults = await searchSummariesInner(db, agentId, pattern, mode, limit);
    if (summaryResults.length > 0) {
      results.push(`=== COMPRESSED SUMMARIES (${summaryResults.length} results, condensed history, details may be lost) ===`);
      results.push(...summaryResults);
    }
  }

  if (results.length === 0) {
    const firstWord = pattern.trim().split(/\s+/)[0] || 'keyword';
    return `No results found for "${pattern}".\n\nSuggestions:\n- Try broader search terms (e.g., "${firstWord}" instead of the full phrase)\n- Try vault_search for semantic (meaning-based) search\n- The information may predate your memory window or may never have been discussed`;
  }

  return results.join('\n');
}

async function searchMessagesInner(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  mode: string,
  since?: string,
  before?: string,
  limit?: number,
): Promise<string[]> {
  const results: string[] = [];

  if (mode === 'full_text') {
    // FTS5 MATCH, joined with messages to filter by agent_id
    const conditions = ['m.agent_id = ?'];
    const params: unknown[] = [agentId];

    if (since) {
      conditions.push('m.created_at >= (unixepoch(?) * 1000)');
      params.push(since);
    }
    if (before) {
      conditions.push('m.created_at < (unixepoch(?) * 1000)');
      params.push(before);
    }

    // Rank over a bounded candidate set: ORDER BY rank scores every match and the join pulls each row's content, so
    // a common term over a huge table is thousands of row reads in one synchronous call. The floor is counted in the
    // agent's own rows, so other agents' traffic never pushes its history out of reach.
    const candidateFloor = agentMessagesFloor(db, agentId);
    // CROSS JOIN keeps the full-text match the outer loop: with the floor present SQLite would otherwise walk the
    // agent's rows by index and re-run the match once per row. The floor, spelled on the FTS side, then bounds the
    // rows that reach the join.
    if (candidateFloor > 0) {
      conditions.push('messages_fts.rowid > ?');
      params.push(candidateFloor);
    }

    const sql = `
      SELECT m.id, m.role, m.content, datetime(m.created_at/1000,'unixepoch') AS created_at,
             snippet(messages_fts, 0, '>>>', '<<<', '...', 64) as snippet
      FROM messages_fts
      CROSS JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE messages_fts MATCH ?
        AND ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;

    try {
      // Over-fetch 3x then filter: the agent's own pure tool-call rows match their own search args (self-echo loop).
      const fetchLimit = (limit ?? 20) * 3;
      // With the reader pool up this runs on the worker's connection so the serving thread stays serviceable.
      type FtsRow = { id: string; role: string; content: string; created_at: string; snippet: string };
      const rawRows = readerPoolAvailable()
        ? await readerQuery<FtsRow>('history_search:fts', sql, [ftsSafeQuery(pattern), ...params, fetchLimit])
        : db.prepare(sql).all(ftsSafeQuery(pattern), ...params, fetchLimit) as FtsRow[];
      const rows = rawRows.filter((r) => !isPureToolCallMessage(r.content)).slice(0, limit ?? 20);

      // A bounded miss is not a miss: the one helper all three FTS arms use says so.
      const note = noteBoundedFtsMiss({
        subsystem: 'history_search:fts', unit: 'messages', agentId,
        candidateFloor, matched: rows.length, limit: limit ?? 20,
        sinceGiven: Boolean(since), beforeGiven: Boolean(before),
      });
      if (note) results.push(note);

      // Hard cap per-match snippet at 300 chars: FTS5 snippet() can exceed that on long-token text.
      const SNIPPET_CHARS = 300;
      const elsewhere = requestForAnotherTurn(agentId);   // a peer's request awaiting its own turn says so
      for (const row of rows) {
        const isTruncated = row.snippet.length > SNIPPET_CHARS || row.content.length > row.snippet.length;
        const snippet = row.snippet.length > SNIPPET_CHARS
          ? row.snippet.slice(0, SNIPPET_CHARS) + '…'
          : row.snippet;
        // Include the message ID so the agent can call history_get(id) for the full body; without it agents loop with
        // new patterns on content that is right there but truncated.
        const idShort = row.id.slice(0, 8);
        const expandHint = isTruncated
          ? ` [snippet only, call history_get(id="${row.id}") for full ${row.content.length}-char message]`
          : '';
        results.push(`[id=${idShort} ${renderInstant(row.created_at) ?? row.created_at}] (${row.role}) ${clauseFor(elsewhere, row.id)}${snippet}${expandHint}`);
      }
    } catch (err) {
      // FTS5 MATCH can fail with invalid syntax. Log no pattern (the user's own words; this log is pasted into bug
      // reports): patternChars is the only diagnostic part.
      logger.warn('FTS5 search failed, falling back to LIKE', {
        patternChars: pattern.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return await searchMessagesLike(db, agentId, pattern, since, before, limit);
    }
  } else {
    // Regex mode: use LIKE as SQLite doesn't have native REGEXP without extension
    return await searchMessagesLike(db, agentId, pattern, since, before, limit);
  }

  return results;
}

async function searchMessagesLike(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  since?: string,
  before?: string,
  limit?: number,
): Promise<string[]> {
  const conditions = ['agent_id = ?', 'content LIKE ?'];
  const params: unknown[] = [agentId, `%${pattern}%`];

  if (since) {
    conditions.push('created_at >= (unixepoch(?) * 1000)');
    params.push(since);
  }
  if (before) {
    conditions.push('created_at < (unixepoch(?) * 1000)');
    params.push(before);
  }

  // This query had a LIMIT and was still unbounded: a leading-wildcard LIKE cannot use an index, so it walks rows
  // newest-first testing each until the limit fills, and a rare or absent term reads the agent's ENTIRE history in
  // one synchronous call. So it walks in recency chunks with a hard row and byte budget and reports what it touched.
  const fetchLimit = (limit ?? 20) * 3;
  // `seq` is the rowid alias here, and the reader guard refuses a bare rowid projection (it would read undefined).
  // The walk needs both ends: the ceiling says where to start and the floor where to stop, so a long stretch owned
  // by other agents (an empty chunk) is not read as "nothing older" and does not end the search.
  // MIN and MAX are two statements: SQLite's min/max optimisation does not apply to one `SELECT MIN(x), MAX(x)`, which
  // walks every matching index entry (tens of ms), and EXPLAIN QUERY PLAN cannot show the difference.
  const maxSeq = (db.prepare('SELECT MAX(seq) AS r FROM messages WHERE agent_id = ?')
    .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
  const oldestSeq = (db.prepare('SELECT MIN(seq) AS r FROM messages WHERE agent_id = ?')
    .get(agentId) as { r: number | null } | undefined)?.r ?? 1;
  // Exclusive, so the agent's own oldest row is still inside the walk.
  const minSeq = Math.max(0, oldestSeq - 1);
  const chunkStmt = db.prepare(`
    SELECT id, role, content, datetime(created_at/1000,'unixepoch') AS created_at, seq AS rowid
    FROM messages
    WHERE ${conditions.join(' AND ')} AND seq <= ? AND seq > ?
    ORDER BY seq DESC
    LIMIT ?
  `);
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM messages
    WHERE agent_id = ? AND seq <= ? AND seq > ?
  `);
  type LikeRow = { id: string; role: string; content: string; created_at: string; rowid: number };
  type CostRow = { n: number; bytes: number };
  const scanOpts = {
    limit: fetchLimit,
    startRowidCeiling: maxSeq,
    floorRowid: minSeq,
  };
  // Pool up: each chunk is two worker-side reads (the honest count, then the page); pool down: the same arithmetic
  // on-thread. One scan loop owns the budget either way.
  const scan = readerPoolAvailable()
    ? await boundedRecencyScan<Omit<LikeRow, 'rowid'>>({
      ...scanOpts,
      fetchChunk: async (ceiling, chunkRows) => {
        const floor = Math.max(0, ceiling - chunkRows);
        const cost = (await readerQuery<CostRow>('history_search:like:cost', countStmt.source ?? '', [agentId, ceiling, floor]))[0] ?? { n: 0, bytes: 0 };
        const found = await readerQuery<LikeRow>('history_search:like:page', chunkStmt.source ?? '', [...params, ceiling, floor, chunkRows]);
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    })
    : boundedRecencyScanSync<Omit<LikeRow, 'rowid'>>({
      ...scanOpts,
      fetchChunk: (ceiling, chunkRows) => {
        const floor = Math.max(0, ceiling - chunkRows);
        // A chunk's cost is what it EXAMINED, not what it matched; one cheap indexed count per chunk gives an honest number.
        const cost = countStmt.get(agentId, ceiling, floor) as CostRow;
        const found = chunkStmt.all(...params, ceiling, floor, chunkRows) as LikeRow[];
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    });
  if (scan.report.truncated || scan.report.chunks > 1) {
    logBoundedFallback('history_search:like', 'leading-wildcard LIKE cannot use an index', scan.report, agentId);
  }
  const rows = scan.rows.filter((r) => !isPureToolCallMessage(r.content)).slice(0, limit ?? 20);

  const elsewhere = requestForAnotherTurn(agentId);
  return rows.map(row => {
    const isTruncated = row.content.length > 200;
    const preview = isTruncated ? row.content.slice(0, 200) + '...' : row.content;
    const idShort = row.id.slice(0, 8);
    const expandHint = isTruncated
      ? ` [snippet only, call history_get(id="${row.id}") for full ${row.content.length}-char message]`
      : '';
    return `[id=${idShort} ${renderInstant(row.created_at) ?? row.created_at}] (${row.role}) ${clauseFor(elsewhere, row.id)}${preview}${expandHint}`;
  });
}

async function searchSummariesInner(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  mode: string,
  limit?: number,
): Promise<string[]> {
  const results: string[] = [];

  if (mode === 'full_text') {
    try {
      // Same bound as the messages path: ORDER BY rank scores every match and the join pulls each summary body.
      // The floor is spelled `summaries_fts.rowid`: on the joined table the range is not pushed into the virtual-table
      // scan, so it would cost and bound nothing. The window comes from summariesFtsWindow; read its header before editing.
      const window = summariesFtsWindow(db, agentId);
      const candidateFloor = window.candidateFloor;
      const floorClause = candidateFloor > 0 ? 'AND summaries_fts.rowid > ?' : '';
      const sql = `
        SELECT s.id, s.depth, s.kind, s.content, s.earliest_at, s.latest_at,
               snippet(summaries_fts, 0, '>>>', '<<<', '...', 64) as snippet
        FROM summaries_fts
        INNER JOIN summaries s ON summaries_fts.rowid = s.rowid
        WHERE summaries_fts MATCH ?
          AND s.agent_id = ?
          ${floorClause}
        ORDER BY rank
        LIMIT ?
      `;
      const sqlParams: unknown[] = candidateFloor > 0
        ? [ftsSafeQuery(pattern), agentId, candidateFloor, limit ?? 20]
        : [ftsSafeQuery(pattern), agentId, limit ?? 20];
      // Pool up: the ranked read runs on a worker connection; pool down: the same query on-thread (as the messages path).
      type SumFtsRow = {
        id: string; depth: number; kind: string; content: string;
        earliest_at: string; latest_at: string; snippet: string;
      };
      const rows = (readerPoolAvailable()
        ? await readerQuery<SumFtsRow>('summary_search:fts', sql, sqlParams)
        : db.prepare(sql).all(...sqlParams)) as Array<{
        id: string;
        depth: number;
        kind: string;
        content: string;
        earliest_at: string;
        latest_at: string;
        snippet: string;
      }>;

      for (const row of rows) {
        results.push(`[${row.id}] (depth=${row.depth}, ${row.kind}) ${row.earliest_at} - ${row.latest_at}\n  ${row.snippet}`);
      }
      // The same bounded-miss note the messages arm has.
      const note = noteBoundedFtsMiss({
        subsystem: 'summary_search:fts', unit: 'summaries', agentId,
        candidateFloor, matched: rows.length, limit: limit ?? 20, reseated: window.reseated,
      });
      if (note) results.push(note);
    } catch (err) {
      // No pattern: see the messages arm above.
      logger.warn('FTS5 summary search failed, falling back to LIKE', {
        patternChars: pattern.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return await searchSummariesLike(db, agentId, pattern, limit);
    }
  } else {
    return await searchSummariesLike(db, agentId, pattern, limit);
  }

  return results;
}

async function searchSummariesLike(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  limit?: number,
): Promise<string[]> {
  // Same unbounded shape as the messages LIKE path: a leading-wildcard LIKE cannot use an index, so an absent term
  // would read every summary body. It walks `rowid DESC` (the order summaries were written) because the bounded scan
  // needs a monotonic chunk key and earliest_at is not one (two summaries can share it).
  // `rowid AS rid` is aliased because summaries.id is a TEXT key and the reader guard refuses a bare rowid projection.
  const likeParams: unknown[] = [agentId, `%${pattern}%`];
  const fetchLimit = (limit ?? 20) * 3;
  // The global span (see floorRowid on boundedRecencyScan); the agent filter stays in the chunk SQL.
  // Two single-aggregate statements, for the reason stated at searchMessagesLike.
  const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM summaries')
    .get() as { r: number | null } | undefined)?.r ?? 0;
  const minRid = Math.max(0, ((db.prepare('SELECT MIN(rowid) AS r FROM summaries')
    .get() as { r: number | null } | undefined)?.r ?? 1) - 1);
  const chunkSql = `
    SELECT id, depth, kind, content, earliest_at, latest_at, rowid AS rid FROM summaries
    WHERE agent_id = ? AND content LIKE ? AND rowid <= ? AND rowid > ?
    ORDER BY rowid DESC
    LIMIT ?
  `;
  const costSql = `
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM summaries
    WHERE agent_id = ? AND rowid <= ? AND rowid > ?
  `;
  const chunkStmt = db.prepare(chunkSql);
  const costStmt = db.prepare(costSql);
  type SumLikeRow = {
    id: string; depth: number; kind: string; content: string;
    earliest_at: string; latest_at: string; rid: number;
  };
  type CostRow = { n: number; bytes: number };
  const scanOpts = { limit: fetchLimit, startRowidCeiling: maxRid, floorRowid: minRid };
  // Pool up: each chunk is two worker-side reads (cost, then page); pool down: the same arithmetic on-thread.
  // One scan loop owns the budget either way.
  const scan = readerPoolAvailable()
    ? await boundedRecencyScan<Omit<SumLikeRow, 'rid'>>({
      ...scanOpts,
      fetchChunk: async (ceiling, chunkRows) => {
        const floor = Math.max(0, ceiling - chunkRows);
        const cost = (await readerQuery<CostRow>('summary_search:like:cost', costSql, [agentId, ceiling, floor]))[0] ?? { n: 0, bytes: 0 };
        const found = await readerQuery<SumLikeRow>('summary_search:like:page', chunkSql, [...likeParams, ceiling, floor, chunkRows]);
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    })
    : boundedRecencyScanSync<Omit<SumLikeRow, 'rid'>>({
      ...scanOpts,
      fetchChunk: (ceiling, chunkRows) => {
        const floor = Math.max(0, ceiling - chunkRows);
        const cost = costStmt.get(agentId, ceiling, floor) as CostRow;
        const found = chunkStmt.all(...likeParams, ceiling, floor, chunkRows) as SumLikeRow[];
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    });
  if (scan.report.truncated || scan.report.chunks > 1) {
    logBoundedFallback('summary_search:like', 'leading-wildcard LIKE cannot use an index', scan.report, agentId);
  }
  const rows = scan.rows.slice(0, limit ?? 20);

  return rows.map(row => {
    const preview = row.content.length > 200 ? row.content.slice(0, 200) + '...' : row.content;
    return `[${row.id}] (depth=${row.depth}, ${row.kind}) ${row.earliest_at} - ${row.latest_at}\n  ${preview}`;
  });
}

// ── history_get: lookup summary or large file by ID ──

export function memoryDescribe(agentId: string, params: { id: string }): string {
  const { id } = params;

  // Check if it's a summary
  if (id.startsWith('sum_')) {
    const summary = getSummary(id);
    if (!summary) {
      return `Summary not found: ${id}`;
    }

    if (summary.agentId !== agentId) {
      return `Summary ${id} does not belong to this agent`;
    }

    const parts = [
      `Summary: ${summary.id}`,
      `Depth: ${summary.depth}`,
      `Kind: ${summary.kind}`,
      `Tokens: ${summary.tokenCount}`,
      `Time Range: ${summary.earliestAt} - ${summary.latestAt}`,
      `Descendants: ${summary.descendantCount}`,
      `Created: ${summary.createdAt}`,
      '',
      'Content:',
      summary.content,
    ];

    return parts.join('\n');
  }

  // Check if it's a large file
  if (id.startsWith('file_')) {
    const file = getLargeFile(id);
    if (!file) {
      return `Large file not found: ${id}`;
    }

    const meta = file.metadata as Record<string, unknown>;
    if (meta.agentId !== agentId) {
      return `File ${id} does not belong to this agent`;
    }

    const parts = [
      `File: ${meta.id}`,
      `Original Path: ${meta.originalPath ?? 'unknown'}`,
      `MIME Type: ${meta.mimeType ?? 'unknown'}`,
      `Tokens: ${meta.tokenCount}`,
      `Created: ${meta.createdAt}`,
      '',
      'Exploration Summary:',
      meta.explorationSummary as string,
      '',
      `Full content available (${meta.tokenCount} tokens). Use history_expand to query specific parts.`,
    ];

    return parts.join('\n');
  }

  // Otherwise treat it as a message ID: history_search emits message IDs (with a "snippet only" hint when truncated),
  // so this is the path to a hit's full content.
  try {
    const db = getDb();
    // One table, one lookup: every lane lives in messages, so a history_get pointer fetches a full body on any lane.
    const row = db.prepare(
      `SELECT id, agent_id, role, content, datetime(created_at/1000,'unixepoch') AS created_at, attachments FROM messages WHERE id = ?`,
    ).get(id) as
      | { id: string; agent_id: string; role: string; content: string; created_at: string; attachments: string | null }
      | undefined;
    if (row) {
      if (row.agent_id !== agentId) {
        return `Message ${id} does not belong to this agent.`;
      }
      const parts = [
        `Message: ${row.id}`,
        `Role: ${row.role}`,
        `Created: ${row.created_at}`,
        `Length: ${row.content.length} chars`,
      ];
      if (row.attachments) parts.push(`Attachments: ${row.attachments}`);
      const waiting = clauseFor(requestForAnotherTurn(agentId), row.id).trim();
      parts.push(...(waiting ? [waiting] : []), '', 'Content:', row.content);
      return parts.join('\n');
    }
  } catch { /* fall through to unknown-ID error */ }

  return `Unknown ID format: ${id}. Expected sum_* (summary), file_* (large file), or a message UUID from history_search output.`;
}

// ── history_expand: deep recall with DAG walking and LLM ──

// history_expand's summary lookup (FTS arm and LIKE arm) is bounded like the messages and summaries paths: the FTS
// arm must not score every match (ORDER BY rank over joined summary bodies) and the LIKE arm must not walk every
// summary row for an absent term. This is the deep-recall door, so each row it finds is then walked for descendant
// messages and fed to a model. The LIKE arm walks rowid DESC (write order): a bounded scan needs a monotonic key.

/** How many summaries `history_expand` may carry into its synthesis; both arms must agree on it. */
const EXPAND_SUMMARY_LIMIT = 5;

type ExpandSummaryRow = {
  id: string; content: string; depth: number; earliest_at: string; latest_at: string;
};

async function expandSummariesFts(
  db: ReturnType<typeof getDb>,
  agentId: string,
  query: string,
): Promise<ExpandSummaryRow[]> {
  // `MAX(rowid) AS r` is aliased at the expression level, the form the reader guard accepts; no rowid is projected.
  // The floor is spelled on the FTS side and the window comes from the same helper as searchSummariesInner.
  const window = summariesFtsWindow(db, agentId);
  const candidateFloor = window.candidateFloor;
  const floorClause = candidateFloor > 0 ? 'AND summaries_fts.rowid > ?' : '';
  const sql = `
      SELECT s.id, s.content, s.depth, s.earliest_at, s.latest_at
      FROM summaries_fts
      INNER JOIN summaries s ON summaries_fts.rowid = s.rowid
      WHERE summaries_fts MATCH ?
        AND s.agent_id = ?
        ${floorClause}
      ORDER BY rank
      LIMIT ?
    `;
  const sqlParams: unknown[] = candidateFloor > 0
    ? [ftsSafeQuery(query), agentId, candidateFloor, EXPAND_SUMMARY_LIMIT]
    : [ftsSafeQuery(query), agentId, EXPAND_SUMMARY_LIMIT];
  // Pool up: the ranked read runs on a worker's read-only connection; pool down: the same bounded query on-thread.
  const rows = (readerPoolAvailable()
    ? await readerQuery<ExpandSummaryRow>('history_expand:fts', sql, sqlParams)
    : db.prepare(sql).all(...sqlParams)) as ExpandSummaryRow[];
  // Operator warn only, deliberately: this helper returns ROWS that feed a synthesis model as raw material, so an
  // "older history was not scanned" sentence spliced in would be read as content to summarise.
  void noteBoundedFtsMiss({
    subsystem: 'history_expand:fts', unit: 'summaries', agentId,
    candidateFloor, matched: rows.length, limit: EXPAND_SUMMARY_LIMIT, reseated: window.reseated,
  });
  return rows;
}

async function expandSummariesLike(
  db: ReturnType<typeof getDb>,
  agentId: string,
  query: string,
): Promise<ExpandSummaryRow[]> {
  const likeParams: unknown[] = [agentId, `%${query}%`];
  // Global span (floorRowid on boundedRecencyScan); single-aggregate statements, as at searchMessagesLike.
  const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM summaries')
    .get() as { r: number | null } | undefined)?.r ?? 0;
  const minRid = Math.max(0, ((db.prepare('SELECT MIN(rowid) AS r FROM summaries')
    .get() as { r: number | null } | undefined)?.r ?? 1) - 1);
  const chunkSql = `
    SELECT id, content, depth, earliest_at, latest_at, rowid AS rid FROM summaries
    WHERE agent_id = ? AND content LIKE ? AND rowid <= ? AND rowid > ?
    ORDER BY rowid DESC
    LIMIT ?
  `;
  const costSql = `
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM summaries
    WHERE agent_id = ? AND rowid <= ? AND rowid > ?
  `;
  type ExpandLikeRow = ExpandSummaryRow & { rid: number };
  type CostRow = { n: number; bytes: number };
  const scanOpts = { limit: EXPAND_SUMMARY_LIMIT, startRowidCeiling: maxRid, floorRowid: minRid };
  // Pool up: each chunk is two worker-side reads (cost, then page); pool down: the same arithmetic on-thread.
  const scan = readerPoolAvailable()
    ? await boundedRecencyScan<ExpandSummaryRow>({
      ...scanOpts,
      fetchChunk: async (ceiling, chunkRows) => {
        const floor = Math.max(0, ceiling - chunkRows);
        const cost = (await readerQuery<CostRow>('history_expand:like:cost', costSql, [agentId, ceiling, floor]))[0] ?? { n: 0, bytes: 0 };
        const found = await readerQuery<ExpandLikeRow>('history_expand:like:page', chunkSql, [...likeParams, ceiling, floor, chunkRows]);
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    })
    : boundedRecencyScanSync<ExpandSummaryRow>({
      ...scanOpts,
      fetchChunk: (ceiling, chunkRows) => {
        const floor = Math.max(0, ceiling - chunkRows);
        const cost = db.prepare(costSql).get(agentId, ceiling, floor) as CostRow;
        const found = db.prepare(chunkSql).all(...likeParams, ceiling, floor, chunkRows) as ExpandLikeRow[];
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    });
  if (scan.report.truncated || scan.report.chunks > 1) {
    logBoundedFallback('history_expand:like', 'leading-wildcard LIKE cannot use an index', scan.report, agentId);
  }
  return scan.rows.slice(0, EXPAND_SUMMARY_LIMIT);
}


export async function memoryExpand(
  agentId: string,
  params: {
    query?: string;
    summary_ids?: string[];
    prompt: string;
  },
): Promise<string> {
  const { query, summary_ids, prompt } = params;

  // Collect material to expand
  const materialParts: string[] = [];

  // If summary_ids provided, walk DAG to get source messages
  if (summary_ids && summary_ids.length > 0) {
    for (const summaryId of summary_ids) {
      const summary = getSummary(summaryId);
      if (!summary || summary.agentId !== agentId) continue;

      materialParts.push(`--- Summary ${summaryId} (depth=${summary.depth}) ---`);
      materialParts.push(summary.content);
      materialParts.push('');

      // Walk down to source messages
      const sourceMessages = getDescendantMessages(summaryId);
      if (sourceMessages.length > 0) {
        materialParts.push(`--- Source Messages (${sourceMessages.length}) ---`);
        for (const msg of sourceMessages) {
          materialParts.push(`[${msg.createdAt}] (${msg.role}) ${msg.content}`);
        }
        materialParts.push('');
      }
    }
  }

  // If query provided, search for relevant summaries
  if (query) {
    const db = getDb();

    // Search summaries via FTS, bounded and off-thread when the pool is up.
    try {
      const rows = await expandSummariesFts(db, agentId, query);

      for (const row of rows) {
        materialParts.push(`--- Summary ${row.id} (depth=${row.depth}, ${row.earliest_at} - ${row.latest_at}) ---`);
        materialParts.push(row.content);
        materialParts.push('');

        // Get source messages for this summary
        const sourceMessages = getDescendantMessages(row.id);
        if (sourceMessages.length > 0 && sourceMessages.length <= 50) {
          materialParts.push(`--- Source Messages (${sourceMessages.length}) ---`);
          for (const msg of sourceMessages) {
            materialParts.push(`[${msg.createdAt}] (${msg.role}) ${msg.content}`);
          }
          materialParts.push('');
        }
      }
    } catch {
      // FTS failed, try the LIKE fallback (a budgeted recency walk that says so).
      const rows = await expandSummariesLike(db, agentId, query);

      for (const row of rows) {
        materialParts.push(`--- Summary ${row.id} (depth=${row.depth}) ---`);
        materialParts.push(row.content);
        materialParts.push('');
      }
    }
  }

  if (materialParts.length === 0) {
    return 'No relevant material found for the given query/summary IDs.';
  }

  // The model that writes this agent's summaries: its own, or for an auto agent its router's standard-tier pick.
  const modelId = pickWriter(agentId);
  if (!modelId) {
    // Return raw material without LLM processing
    return `Expanded material (no model available for synthesis):\n\n${materialParts.join('\n')}`;
  }

  // Make a model call to answer the prompt using the expanded material
  const systemPrompt = `You are a memory retrieval assistant. You have been given expanded conversation history material. Answer the user's question based ONLY on the material provided. If the material doesn't contain the answer, say so.`;

  // The material is cut to what the writer can hold (at most 100,000 tokens), never the question after it.
  const material = materialParts.join('\n');
  const maxMaterialChars = Math.min(100_000, summaryRoom(modelId, estimateTokens(systemPrompt + prompt))) * CHARS_PER_TOKEN;
  const shown = material.length > maxMaterialChars ? `${material.slice(0, maxMaterialChars)}\n\n[... material truncated ...]` : material;
  const truncatedMessage = `Here is the expanded conversation history:\n\n${shown}\n\n---\n\nQuestion: ${prompt}`;

  try {
    const result = await callModel({
      agentId,
      modelId,
      messages: [{ role: 'user', content: truncatedMessage }],
      systemPrompt,
      tools: false,
      // The timeout scales with the input size set above (see expandSynthesisBudgetMs): a flat bound would abort a large,
      // legitimately retrieved corpus for certain, and the catch below would then silently return the raw dump. It must
      // still fail fast, since this call blocks a live tool result.
      abortSignal: AbortSignal.timeout(expandSynthesisBudgetMs(estimateTokens(truncatedMessage))),
      bestEffort: true,
    });

    logger.info('Memory expand completed', {
      materialTokens: estimateTokens(materialParts.join('\n')),
      resultTokens: estimateTokens(result.content),
    }, agentId);

    return result.content;
  } catch (err) {
    // WARN, not ERROR: the raw-material fallback below fully handles this.
    logger.warn('Memory expand model call failed, returning raw material', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);

    // The label distinguishes an ABANDONED synthesis from a FAILED one: the agent decides whether to ask again by
    // which happened ("ran out of time" invites a narrower question).
    const why = err instanceof Error ? err.message : String(err);
    const abandoned = /abort|timed out|timeout/i.test(why);
    return abandoned
      ? `Expanded material (synthesis ran out of time for this much material — ask a narrower question to have it summarised):\n\n${materialParts.join('\n')}`
      : `Expanded material (model call failed):\n\n${materialParts.join('\n')}`;
  }
}

// The synthesis budget, derived from the size being synthesised: FLOOR is the base timeout so a small expand fails
// as fast as a flat one, a per-1K-token grant scales it, and CEILING keeps this a bounded utility call. Exported and
// at module scope so a test can call this arithmetic rather than re-derive it.
export const EXPAND_FLOOR_MS = 60_000;
export const EXPAND_MS_PER_1K_TOKENS = 1_500;
export const EXPAND_CEILING_MS = 10 * 60_000;

export function expandSynthesisBudgetMs(inputTokens: number): number {
  return Math.min(
    EXPAND_FLOOR_MS + Math.ceil(Math.max(inputTokens, 0) / 1000) * EXPAND_MS_PER_1K_TOKENS,
    EXPAND_CEILING_MS,
  );
}

// ── memory_search: hybrid FTS + vector search ──

export async function memorySearch(
  agentId: string,
  params: { query: string; limit?: number },
): Promise<string> {
  const { query, limit = 10 } = params;

  // Check if embeddings are available
  const db = getDb();
  const embeddingCount = (db.prepare('SELECT COUNT(*) as count FROM embeddings WHERE agent_id = ?').get(agentId) as { count: number }).count;

  if (embeddingCount > 0) {
    // Use hybrid search (FTS5 + vector)
    try {
      const { hybridSearch } = await import('./vector-search.js');
      const results = await hybridSearch(query, agentId, { limit });

      if (results.length === 0) {
        return `No results found for "${query}".`;
      }

      const formatted = results.map((r, i) => {
        const sourceLabel = r.source === 'vector' ? '(semantic)' : '(keyword)';
        return `${i + 1}. [${r.sourceType}] ${sourceLabel} (score: ${r.score.toFixed(3)})\n   ${r.preview}`;
      }).join('\n\n');

      return `Search results for "${query}" (${results.length} results, hybrid FTS+vector):\n\n${formatted}`;
    } catch (err) {
      logger.warn('Hybrid search failed, falling back to FTS', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback to FTS-only search
  return await memoryGrep(agentId, {
    pattern: query,
    mode: 'full_text',
    scope: 'both',
    limit,
  });
}
