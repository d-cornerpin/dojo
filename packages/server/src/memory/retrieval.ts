import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { callModel } from '../agent/model.js';
import { estimateTokens } from './store.js';
import { getSummary, getDescendantMessages, getSummariesByAgent } from './dag.js';
import { getLargeFile } from './large-files.js';

const logger = createLogger('memory-retrieval');

// ── memory_grep: FTS5 search on messages and summaries ──

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
      results.push(`=== Messages (${messageResults.length} results) ===`);
      results.push(...messageResults);
    }
  }

  if (scope === 'summaries' || scope === 'both') {
    const summaryResults = searchSummaries(db, agentId, pattern, mode, limit);
    if (summaryResults.length > 0) {
      results.push(`=== Summaries (${summaryResults.length} results) ===`);
      results.push(...summaryResults);
    }
  }

  if (results.length === 0) {
    return `No results found for "${pattern}". This search checked all stored messages and summaries — retrying with a different query is unlikely to help. If the information was never discussed, it is not in memory.`;
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
      const rows = db.prepare(sql).all(pattern, ...params, limit ?? 20) as Array<{
        id: string;
        role: string;
        content: string;
        created_at: string;
        snippet: string;
      }>;

      for (const row of rows) {
        results.push(`[${row.created_at}] (${row.role}) ${row.snippet}`);
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

  const rows = db.prepare(`
    SELECT id, role, content, created_at FROM messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit ?? 20) as Array<{
    id: string;
    role: string;
    content: string;
    created_at: string;
  }>;

  return rows.map(row => {
    const preview = row.content.length > 200 ? row.content.slice(0, 200) + '...' : row.content;
    return `[${row.created_at}] (${row.role}) ${preview}`;
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

// ── memory_describe: lookup summary or large file by ID ──

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
      `Full content available (${meta.tokenCount} tokens). Use memory_expand to query specific parts.`,
    ];

    return parts.join('\n');
  }

  return `Unknown ID format: ${id}. Expected sum_* or file_* prefix.`;
}

// ── memory_expand: deep recall with DAG walking and LLM ──

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
        return `No results found for "${query}". This search checked all stored messages and summaries — retrying with a different query is unlikely to help.`;
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
