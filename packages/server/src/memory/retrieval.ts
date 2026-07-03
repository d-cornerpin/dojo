import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { callModel } from '../agent/model.js';
import { estimateTokens } from './store.js';
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

export function memoryGrep(
  agentId: string,
  params: {
    pattern: string;
    mode?: 'full_text' | 'regex';
    scope?: 'messages' | 'summaries' | 'both';
    since?: string;
    before?: string;
    limit?: number;
  },
): string {
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
    const messageResults = searchMessages(db, agentId, pattern, mode, since, before, limit);
    if (messageResults.length > 0) {
      results.push(`=== RAW MESSAGES (${messageResults.length} results, exact conversation records) ===`);
      results.push(...messageResults);
    }
  }

  if (scope === 'summaries' || scope === 'both') {
    const summaryResults = searchSummaries(db, agentId, pattern, mode, limit);
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

function searchMessages(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  mode: string,
  since?: string,
  before?: string,
  limit?: number,
): string[] {
  const results: string[] = [];

  if (mode === 'full_text') {
    // FTS5 MATCH query
    // Join messages_fts with messages to filter by agent_id
    const conditions = ['m.agent_id = ?'];
    const params: unknown[] = [agentId];

    if (since) {
      conditions.push('m.created_at >= ?');
      params.push(since);
    }
    if (before) {
      conditions.push('m.created_at < ?');
      params.push(before);
    }

    // FTS5 match using the content column
    const sql = `
      SELECT m.id, m.role, m.content, m.created_at,
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
      const rawRows = db.prepare(sql).all(pattern, ...params, fetchLimit) as Array<{
        id: string;
        role: string;
        content: string;
        created_at: string;
        snippet: string;
      }>;
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
      return searchMessagesLike(db, agentId, pattern, since, before, limit);
    }
  } else {
    // Regex mode: use LIKE as SQLite doesn't have native REGEXP without extension
    return searchMessagesLike(db, agentId, pattern, since, before, limit);
  }

  return results;
}

function searchMessagesLike(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  since?: string,
  before?: string,
  limit?: number,
): string[] {
  const conditions = ['agent_id = ?', 'content LIKE ?'];
  const params: unknown[] = [agentId, `%${pattern}%`];

  if (since) {
    conditions.push('created_at >= ?');
    params.push(since);
  }
  if (before) {
    conditions.push('created_at < ?');
    params.push(before);
  }

  // v2.7.8, over-fetch then filter pure tool-call self-echoes (see
  // isPureToolCallMessage rationale above).
  const fetchLimit = (limit ?? 20) * 3;
  const rawRows = db.prepare(`
    SELECT id, role, content, created_at FROM messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, fetchLimit) as Array<{
    id: string;
    role: string;
    content: string;
    created_at: string;
  }>;
  const rows = rawRows.filter((r) => !isPureToolCallMessage(r.content)).slice(0, limit ?? 20);

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

function searchSummaries(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  mode: string,
  limit?: number,
): string[] {
  const results: string[] = [];

  if (mode === 'full_text') {
    try {
      const rows = db.prepare(`
        SELECT s.id, s.depth, s.kind, s.content, s.earliest_at, s.latest_at,
               snippet(summaries_fts, 0, '>>>', '<<<', '...', 64) as snippet
        FROM summaries_fts
        INNER JOIN summaries s ON summaries_fts.rowid = s.rowid
        WHERE summaries_fts MATCH ?
          AND s.agent_id = ?
        ORDER BY rank
        LIMIT ?
      `).all(pattern, agentId, limit ?? 20) as Array<{
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
      return searchSummariesLike(db, agentId, pattern, limit);
    }
  } else {
    return searchSummariesLike(db, agentId, pattern, limit);
  }

  return results;
}

function searchSummariesLike(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pattern: string,
  limit?: number,
): string[] {
  const rows = db.prepare(`
    SELECT id, depth, kind, content, earliest_at, latest_at FROM summaries
    WHERE agent_id = ? AND content LIKE ?
    ORDER BY earliest_at DESC
    LIMIT ?
  `).all(agentId, `%${pattern}%`, limit ?? 20) as Array<{
    id: string;
    depth: number;
    kind: string;
    content: string;
    earliest_at: string;
    latest_at: string;
  }>;

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
    const row = db.prepare(
      'SELECT id, agent_id, role, content, created_at, attachments FROM messages WHERE id = ?',
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

    // Search summaries via FTS
    try {
      const rows = db.prepare(`
        SELECT s.id, s.content, s.depth, s.earliest_at, s.latest_at
        FROM summaries_fts
        INNER JOIN summaries s ON summaries_fts.rowid = s.rowid
        WHERE summaries_fts MATCH ?
          AND s.agent_id = ?
        ORDER BY rank
        LIMIT 5
      `).all(query, agentId) as Array<{
        id: string;
        content: string;
        depth: number;
        earliest_at: string;
        latest_at: string;
      }>;

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
      // FTS failed, try LIKE fallback
      const rows = db.prepare(`
        SELECT id, content, depth, earliest_at, latest_at FROM summaries
        WHERE agent_id = ? AND content LIKE ?
        ORDER BY earliest_at DESC
        LIMIT 5
      `).all(agentId, `%${query}%`) as Array<{
        id: string;
        content: string;
        depth: number;
        earliest_at: string;
        latest_at: string;
      }>;

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
    });

    logger.info('Memory expand completed', {
      materialTokens: estimateTokens(materialParts.join('\n')),
      resultTokens: estimateTokens(result.content),
    }, agentId);

    return result.content;
  } catch (err) {
    logger.error('Memory expand model call failed', {
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
  return memoryGrep(agentId, {
    pattern: query,
    mode: 'full_text',
    scope: 'both',
    limit,
  });
}
