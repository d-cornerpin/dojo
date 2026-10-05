import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { breadcrumbFor, clearQueryDispatched, markQueryDispatched } from '../observability/stall-sentinel.js';
import {
  boundedRecencyScan, boundedRecencyScanSync, ftsCandidateRowidFloor, logBoundedFallback,
} from './search-bounds.js';
import { readerPoolAvailable, readerQuery } from './reader-pool.js';
import { callModel } from '../agent/model.js';
import { estimateTokens } from './budget.js';
import { getSummary, getDescendantMessages, getSummariesByAgent } from './dag.js';
import { getLargeFile } from './large-files.js';

const logger = createLogger('memory-retrieval');

// v2.7.8, self-echo filter for history_search.
//
// Pure tool-call assistant messages persist as JSON like
// `[{"type":"tool_use","id":"...","name":"history_search","input":{"pattern":"replace the"}}]`.
// FTS5 indexes that JSON. When the agent later searches for "replace
// the", their OWN previous call shows up as a match, the agent reads
// the snippet as a real conversation hit, refines their pattern, gets
// the new call back, loops forever. Real production failure: trainer
// agent burned 6 turns going in circles before the user typed STOP.
//
// Filter: a message whose parsed content is an array AND every block
// is type:tool_use is treated as agent self-noise and excluded from
// search results. Messages that mix text + tool_use still surface
// (the text might be a real hit). tool_result messages still surface
// (those are observations of the world, not the agent's own calls).
function isPureToolCallMessage(content: string): boolean {
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
    const messageResults = await searchMessages(db, agentId, pattern, mode, since, before, limit);
    if (messageResults.length > 0) {
      results.push(`=== RAW MESSAGES (${messageResults.length} results, exact conversation records) ===`);
      results.push(...messageResults);
    }
  }

  if (scope === 'summaries' || scope === 'both') {
    const summaryResults = await searchSummaries(db, agentId, pattern, mode, limit);
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

async function searchMessages(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  mode: string,
  since?: string,
  before?: string,
  limit?: number,
): Promise<string[]> {
  // ⚠ THE BREADCRUMB (t89 deliverable 4). A synchronous B-tree walk cannot be interrupted from
  // JavaScript, so when this query pins the loop NOTHING else in the process can name it — not the
  // health probe, not the stop button, not the log line that eventually prints 20 seconds late. The
  // sentinel reads this mark and the freeze becomes one line. A SHAPE, never the pattern: this string
  // reaches logs that get pasted into bug reports.
  const crumb = markQueryDispatched(breadcrumbFor('history_search', mode === 'full_text' ? 'fts' : 'like'));
  try {
    return await searchMessagesInner(db, agentId, pattern, mode, since, before, limit);
  } finally {
    clearQueryDispatched(crumb);
  }
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
    // FTS5 MATCH query
    // Join messages_fts with messages to filter by agent_id
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

    // ⚠ RANK OVER A BOUNDED CANDIDATE SET (t89 deliverable 2). `ORDER BY rank` must SCORE EVERY MATCH
    // before it knows which twenty win, and the join pulls each matching row's content to do it — so a
    // common term over a 729 MB table was ten thousand row reads to return twenty, inside ONE
    // synchronous call on the serving thread. The rowid floor makes recency the bound: `messages.rowid`
    // is append-only, so this IS a time window, it costs one indexed MAX() to compute, and an older
    // match is the one a person is least likely to mean. On a box smaller than the window the floor is
    // 0 and nothing changes at all.
    // ⚠ `seq`, NOT `rowid`. On `messages` the insertion key is `seq INTEGER PRIMARY KEY AUTOINCREMENT`
    // — the table's rowid ALIAS — and PHASE-1 T10's reader guard refuses a bare `rowid` projection
    // because SQLite names such a column `seq`, so `row.rowid` reads `undefined` and NOTHING THROWS.
    // Same value, one name. (It also means the floor is served by the primary key, which is why this
    // bound costs one indexed MAX.)
    const maxSeq = (db.prepare('SELECT MAX(seq) AS r FROM messages WHERE agent_id = ?')
      .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
    const candidateFloor = ftsCandidateRowidFloor(maxSeq);
    if (candidateFloor > 0) {
      conditions.push('m.seq > ?');
      params.push(candidateFloor);
    }

    // FTS5 match using the content column
    const sql = `
      SELECT m.id, m.role, m.content, datetime(m.created_at/1000,'unixepoch') AS created_at,
             snippet(messages_fts, 0, '>>>', '<<<', '...', 64) as snippet
      FROM messages_fts
      INNER JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE messages_fts MATCH ?
        AND ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;

    try {
      // v2.7.8, over-fetch then filter. The agent's own pure-tool-call
      // messages (content is `[{"type":"tool_use",...}]`) match
      // patterns like `"replace the"` because the JSON of the agent's
      // previous history_search call literally contains the search args.
      // Returning those triggers the self-echo loop where the agent
      // grep-the-grep-the-grep until the user hits STOP. Over-fetch
      // 3× the requested limit so post-filter still hits limit when
      // possible.
      const fetchLimit = (limit ?? 20) * 3;
      // ⚠ THE WIRE (t89 deliverable 1). When the reader pool is up, this — the one query that
      // measured 43 seconds of deafness on a real box — runs on the worker's own connection and
      // the serving thread stays serviceable; the sync run is the fallback, not the path.
      type FtsRow = { id: string; role: string; content: string; created_at: string; snippet: string };
      const rawRows = readerPoolAvailable()
        ? await readerQuery<FtsRow>('history_search:fts', sql, [pattern, ...params, fetchLimit])
        : db.prepare(sql).all(pattern, ...params, fetchLimit) as FtsRow[];
      const rows = rawRows.filter((r) => !isPureToolCallMessage(r.content)).slice(0, limit ?? 20);

      // Phase 3.5 (2026-05-04), hard cap per-match snippet at 300 chars
      // (Part XVIII §A). FTS5's snippet() defaults to ~64 tokens which can
      // exceed 300 chars on long-token text; we trim defensively.
      const SNIPPET_CHARS = 300;
      for (const row of rows) {
        const isTruncated = row.snippet.length > SNIPPET_CHARS || row.content.length > row.snippet.length;
        const snippet = row.snippet.length > SNIPPET_CHARS
          ? row.snippet.slice(0, SNIPPET_CHARS) + '…'
          : row.snippet;
        // Include the message ID so the agent can call history_get(id)
        // for the full body when the snippet isn't enough. Without this,
        // agents loop endlessly with different patterns trying to find
        // content that's right there but truncated. The fullChars suffix
        // tells the agent at a glance how much more there is to read.
        const idShort = row.id.slice(0, 8);
        const expandHint = isTruncated
          ? ` [snippet only, call history_get(id="${row.id}") for full ${row.content.length}-char message]`
          : '';
        results.push(`[id=${idShort} ${row.created_at}] (${row.role}) ${snippet}${expandHint}`);
      }
    } catch (err) {
      // FTS5 MATCH can fail with invalid syntax
      logger.warn('FTS5 search failed, falling back to LIKE', {
        pattern,
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

  // ⚠ THE BOUND THAT WOULD HAVE ENDED THE INCIDENT (t89 deliverable 2). This query already had a
  // LIMIT and was still unbounded: SQLite cannot index a leading-wildcard LIKE, so it walks rows
  // newest-first and TESTS EACH ONE until the limit fills. A common word costs sixty rows; a rare word
  // — or one that appears nowhere — costs the agent's ENTIRE history, every row's content read off
  // disk, in one synchronous call. The LIMIT bounded the ANSWER and said nothing about the WORK.
  //
  // Now it walks in recency chunks with a hard row and byte budget, and reports what it touched. The
  // chunking also means the walk can STOP partway, which is the difference between a bounded search
  // and a 43-second freeze.
  const fetchLimit = (limit ?? 20) * 3;
  // ⚠ `seq` IS THE ROWID ALIAS HERE (PHASE-1 T10, migration 133), and the reader guard refuses a bare
  // `rowid` for a reason worth keeping: SQLite would name the column `seq`, `row.rowid` would read
  // `undefined`, and nothing would throw — the silent shape that broke 45 tests once already.
  const maxSeq = (db.prepare('SELECT MAX(seq) AS r FROM messages WHERE agent_id = ?')
    .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
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
  };
  // ⚠ THE WIRE (t89 deliverable 1): pool up → each chunk is two worker-side reads (the honest count,
  // then the page) and the serving thread breathes between chunks; pool down → the same arithmetic
  // on-thread, bounded exactly as before. One scan loop owns the budget either way.
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
        // What the chunk COST is what the chunk EXAMINED, not what it matched — the whole point of the
        // budget. One cheap indexed count per chunk buys an honest number.
        const cost = countStmt.get(agentId, ceiling, floor) as CostRow;
        const found = chunkStmt.all(...params, ceiling, floor, chunkRows) as LikeRow[];
        return { rows: found, rowsExamined: cost.n, bytesRead: cost.bytes };
      },
    });
  if (scan.report.truncated || scan.report.chunks > 1) {
    logBoundedFallback('history_search:like', 'leading-wildcard LIKE cannot use an index', scan.report, agentId);
  }
  const rows = scan.rows.filter((r) => !isPureToolCallMessage(r.content)).slice(0, limit ?? 20);

  return rows.map(row => {
    const isTruncated = row.content.length > 200;
    const preview = isTruncated ? row.content.slice(0, 200) + '...' : row.content;
    const idShort = row.id.slice(0, 8);
    const expandHint = isTruncated
      ? ` [snippet only, call history_get(id="${row.id}") for full ${row.content.length}-char message]`
      : '';
    return `[id=${idShort} ${row.created_at}] (${row.role}) ${preview}${expandHint}`;
  });
}

async function searchSummaries(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  mode: string,
  limit?: number,
): Promise<string[]> {
  const crumb = markQueryDispatched(breadcrumbFor('summary_search', mode === 'full_text' ? 'fts' : 'like'));
  try {
    return await searchSummariesInner(db, agentId, pattern, mode, limit);
  } finally {
    clearQueryDispatched(crumb);
  }
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
      // ⚠ THE SAME BOUND THE MESSAGES PATH TAKES (t89 item 2), and summaries need it for a reason of
      // their own: `ORDER BY rank` scores EVERY match before it knows which twenty win, and a
      // summary row is a condensed BODY — the join pulls each matching one to rank it. A long-lived
      // agent's summary table is smaller than its messages table but its rows are far larger, so the
      // bytes read per ranked candidate are worse, not better. `ftsCandidateRowidFloor` makes
      // recency the bound here exactly as it does there.
      // ⚠ `rowid AS rid`, aliased on purpose: `summaries.id` is a TEXT primary key, so the insertion
      // order lives in the implicit rowid, and PHASE-1 T10's reader guard refuses a BARE `rowid`
      // projection — the shape where SQLite names the column something else, the read comes back
      // `undefined`, and nothing throws. One name, chosen here.
      const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM summaries WHERE agent_id = ?')
        .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
      const candidateFloor = ftsCandidateRowidFloor(maxRid);
      const floorClause = candidateFloor > 0 ? 'AND s.rowid > ?' : '';
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
        ? [pattern, agentId, candidateFloor, limit ?? 20]
        : [pattern, agentId, limit ?? 20];
      // ⚠ THE WIRE (t89 item 2): pool up → the ranked read runs on a worker's own connection and the
      // serving thread stays serviceable; pool down → the same query on-thread. The fork is the
      // messages path's, deliberately, so there is one shape to understand and one to review.
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
    } catch (err) {
      logger.warn('FTS5 summary search failed, falling back to LIKE', {
        pattern,
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
  // ⚠ THE SAME UNBOUNDED SHAPE THE MESSAGES PATH HAD (t89 item 2). A leading-wildcard LIKE cannot use
  // an index, so this walked the agent's summaries testing each one until the LIMIT filled — and a
  // term that appears nowhere cost EVERY summary row, each one a condensed body read off disk, in one
  // synchronous call. The LIMIT bounded the answer and said nothing about the work, which is the exact
  // sentence the messages path earned.
  //
  // ⚠ AND THE WALK ORDER CHANGES, stated because it is a real behaviour change and not a refactor:
  // this ordered by `earliest_at DESC` (the period a summary COVERS) and now walks `rowid DESC` (the
  // order summaries were WRITTEN). The bounded scan needs a monotonic key to chunk on and `earliest_at`
  // is not one — two summaries can share it, and it is not the insertion order the chunk ceiling walks.
  // For a search result the two are near-identical and the new one is arguably truer: the most recently
  // BUILT summary is the one whose wording a person just read. A clause pins the recency direction.
  //
  // ⚠ `rowid AS rid`, aliased: `summaries.id` is a TEXT primary key so insertion order lives in the
  // implicit rowid, and T10's reader guard refuses a bare `rowid` projection — the shape that reads
  // `undefined` without throwing.
  const likeParams: unknown[] = [agentId, `%${pattern}%`];
  const fetchLimit = (limit ?? 20) * 3;
  const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM summaries WHERE agent_id = ?')
    .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
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
  const scanOpts = { limit: fetchLimit, startRowidCeiling: maxRid };
  // ⚠ THE WIRE (t89 item 2), the messages path's fork verbatim: pool up → each chunk is two
  // worker-side reads (the honest cost, then the page) and the serving thread breathes between
  // chunks; pool down → the same arithmetic on-thread, bounded identically. One scan loop owns the
  // budget either way, which is what makes the fallback a fallback rather than a second policy.
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

  // Otherwise treat it as a message ID (UUID). Look up the row and return
  // the full body. history_search emits message IDs in its output (along with
  // a "snippet only, call history_get(...)" hint when truncated), so
  // this is the canonical path for getting full content of a search hit.
  try {
    const db = getDb();
    // T5: one table, one lookup. This was a two-arm UNION because an id handed out by
    // history_search or recall could name a row in either home; every lane now lives here,
    // so the pointer resolves in one statement.
    // STRIP; requirement preserved: a history_get pointer always fetches a full body,
    // whatever lane the row is on.
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
      parts.push('', 'Content:', row.content);
      return parts.join('\n');
    }
  } catch { /* fall through to unknown-ID error */ }

  return `Unknown ID format: ${id}. Expected sum_* (summary), file_* (large file), or a message UUID from history_search output.`;
}

// ── history_expand: deep recall with DAG walking and LLM ──

// ════════════════════════════════════════════════════════════════════════════════════════
// ⚠ THE THIRD SEARCHABLE SURFACE, AND THE ONE THE BRIEF POINTED AT BY LINE NUMBER (t89 item 1).
//
// The brief named this pair "the vault search" at `retrieval.ts:447` and `:471+`. Those line
// numbers are THIS code — `history_expand`'s summary lookup — not the vault's. The real
// `vault_search` lives in `vault/store.ts` (`semanticSearch`, `listEntries({ search })`) and is
// handed up separately, because it is a different unbounded shape in a file this change does not
// own. What was true either way is that these two arms are the LAST unbounded text search on the
// retrieval surface, and they are the same two shapes the messages and summaries paths earned
// their fix for:
//
//   · THE FTS ARM had `ORDER BY rank LIMIT 5`, which must SCORE EVERY MATCH before it can know
//     which five win, with the `INNER JOIN summaries` pulling each candidate's condensed body off
//     disk to do it. Five rows out, every match read.
//   · THE LIKE ARM had `content LIKE '%…%' … LIMIT 5`, and a leading-wildcard LIKE cannot use an
//     index, so a term that appears nowhere cost every summary row the agent owns.
//
// AND IT IS WORSE HERE THAN ON EITHER OF THE OTHER TWO SURFACES, which is the reason it is not
// "small enough to skip": `history_expand` is the deep-recall door, so every row it finds is then
// walked for its DESCENDANT MESSAGES and fed to a model. The read is the cheap half of what this
// function does, and it was the unbounded half.
//
// ⚠ ONE BEHAVIOUR CHANGE, THE SAME ONE THE SUMMARIES HALF STATED AND FOR THE SAME REASON: the
// LIKE arm ordered by `earliest_at DESC` (the period a summary COVERS) and now walks `rowid DESC`
// (the order summaries were WRITTEN). A bounded scan needs a monotonic chunk key and `earliest_at`
// is not one — two summaries can share it, and it is not the insertion order a chunk ceiling walks.
// ════════════════════════════════════════════════════════════════════════════════════════

/** How many summaries `history_expand` may carry into its synthesis. The pre-existing `LIMIT 5`,
 *  named rather than repeated twice, because both arms must agree on it. */
const EXPAND_SUMMARY_LIMIT = 5;

type ExpandSummaryRow = {
  id: string; content: string; depth: number; earliest_at: string; latest_at: string;
};

async function expandSummariesFts(
  db: ReturnType<typeof getDb>,
  agentId: string,
  query: string,
): Promise<ExpandSummaryRow[]> {
  const crumb = markQueryDispatched(breadcrumbFor('history_expand', 'fts'));
  try {
    // ⚠ `rowid AS rid` is NOT projected here and does not need to be — the floor is a WHERE term
    // only. `MAX(rowid) AS r` is aliased at the expression level, which is the form PHASE-1 T10's
    // reader guard accepts; a BARE projected `rowid` is the shape SQLite may name something else,
    // which then reads `undefined` without throwing.
    const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM summaries WHERE agent_id = ?')
      .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
    const candidateFloor = ftsCandidateRowidFloor(maxRid);
    const floorClause = candidateFloor > 0 ? 'AND s.rowid > ?' : '';
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
      ? [query, agentId, candidateFloor, EXPAND_SUMMARY_LIMIT]
      : [query, agentId, EXPAND_SUMMARY_LIMIT];
    // THE WIRE: pool up → the ranked read runs on a worker's own read-only connection and the
    // serving thread stays serviceable; pool down → the same bounded query on-thread. The fork is
    // the messages and summaries paths' fork verbatim, so there is one shape to review.
    return (readerPoolAvailable()
      ? await readerQuery<ExpandSummaryRow>('history_expand:fts', sql, sqlParams)
      : db.prepare(sql).all(...sqlParams)) as ExpandSummaryRow[];
  } finally {
    clearQueryDispatched(crumb);
  }
}

async function expandSummariesLike(
  db: ReturnType<typeof getDb>,
  agentId: string,
  query: string,
): Promise<ExpandSummaryRow[]> {
  const crumb = markQueryDispatched(breadcrumbFor('history_expand', 'like'));
  try {
    const likeParams: unknown[] = [agentId, `%${query}%`];
    const maxRid = (db.prepare('SELECT MAX(rowid) AS r FROM summaries WHERE agent_id = ?')
      .get(agentId) as { r: number | null } | undefined)?.r ?? 0;
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
    const scanOpts = { limit: EXPAND_SUMMARY_LIMIT, startRowidCeiling: maxRid };
    // THE WIRE, again the same fork: pool up → each chunk is two worker-side reads (the honest
    // cost, then the page); pool down → the same arithmetic on-thread, bounded identically. One
    // scan loop owns the budget either way, which is what keeps the fallback a fallback rather
    // than a second policy.
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
  } finally {
    clearQueryDispatched(crumb);
  }
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

    // Search summaries via FTS — BOUNDED and OFF-THREAD when the pool is up (t89 item 1).
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
      // FTS failed, try the LIKE fallback — now a budgeted recency walk that says so out loud.
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

  // Get agent's model
  const db = getDb();
  const agent = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;

  if (!agent?.model_id) {
    // Return raw material without LLM processing
    return `Expanded material (no model available for synthesis):\n\n${materialParts.join('\n')}`;
  }

  // Make a model call to answer the prompt using the expanded material
  const systemPrompt = `You are a memory retrieval assistant. You have been given expanded conversation history material. Answer the user's question based ONLY on the material provided. If the material doesn't contain the answer, say so.`;

  const userMessage = `Here is the expanded conversation history:\n\n${materialParts.join('\n')}\n\n---\n\nQuestion: ${prompt}`;

  // Truncate if too long
  const maxInputTokens = 100000;
  const truncatedMessage = estimateTokens(userMessage) > maxInputTokens
    ? userMessage.slice(0, maxInputTokens * 4) + '\n\n[... material truncated ...]'
    : userMessage;

  try {
    const result = await callModel({
      agentId,
      modelId: agent.model_id,
      messages: [{ role: 'user', content: truncatedMessage }],
      systemPrompt,
      tools: false,
      // W3-1: fully handled utility call, the catch below falls back to
      // returning the raw expanded material, so the caller always gets the
      // content. Fail fast instead of riding the provider's 5-minute default
      // (this synthesis blocks a live tool result), and log at WARN.
      abortSignal: AbortSignal.timeout(60_000),
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

    // Return raw material on failure
    return `Expanded material (model call failed):\n\n${materialParts.join('\n')}`;
  }
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
        return `No results found for "${query}". This search checked all stored messages and summaries, retrying with a different query is unlikely to help.`;
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
