import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { estimateTokens } from '../../memory/store.js';
import {
  createLeafSummary,
  getSummary,
  getSummariesByAgent,
  getSummaryChildren,
  getSummarySourceMessages,
  updateSummaryContent,
  deleteSummary,
} from '../../memory/dag.js';
import { checkAndCompact } from '../../memory/compaction.js';
import { getContextWindow } from '../../agent/model.js';
import {
  generateBriefing,
  getLatestBriefing,
  updateBriefing,
} from '../../memory/briefing.js';
import { memorySearch } from '../../memory/retrieval.js';
import { getEmbeddingStatus, setEmbeddingConfig } from '../../memory/embeddings.js';
import { runBackfill, isBackfillRunning, getBackfillProgress } from '../../memory/backfill.js';
import { vectorSearch } from '../../memory/vector-search.js';

const logger = createLogger('memory-routes');
export const memoryRouter = new Hono();

// GET /:agentId/dag — query summaries and links, optional depth filter
memoryRouter.get('/:agentId/dag', (c) => {
  const agentId = c.req.param('agentId');
  const depthParam = c.req.query('depth');
  const depth = depthParam !== undefined ? parseInt(depthParam, 10) : undefined;

  try {
    const summaries = getSummariesByAgent(agentId, {
      depth: depth !== undefined && !isNaN(depth) ? depth : undefined,
    });

    // Query parent links for all summaries
    const db = getDb();
    const summaryIds = summaries.map(s => s.id);
    const links: Array<{ summaryId: string; parentIds: string[] }> = [];

    if (summaryIds.length > 0) {
      const placeholders = summaryIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT summary_id, parent_id FROM summary_parents WHERE summary_id IN (${placeholders})`,
      ).all(...summaryIds) as Array<{ summary_id: string; parent_id: string }>;

      // Group by summary_id
      const linkMap = new Map<string, string[]>();
      for (const row of rows) {
        const existing = linkMap.get(row.summary_id);
        if (existing) {
          existing.push(row.parent_id);
        } else {
          linkMap.set(row.summary_id, [row.parent_id]);
        }
      }

      for (const [summaryId, parentIds] of linkMap) {
        links.push({ summaryId, parentIds });
      }
    }

    return c.json({ ok: true, data: { summaries, links } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch DAG', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /:agentId/summary/:summaryId — full summary detail
memoryRouter.get('/:agentId/summary/:summaryId', (c) => {
  const agentId = c.req.param('agentId');
  const summaryId = c.req.param('summaryId');

  try {
    const summary = getSummary(summaryId);
    if (!summary) {
      return c.json({ ok: false, error: 'Summary not found' }, 404);
    }

    if (summary.agentId !== agentId) {
      return c.json({ ok: false, error: 'Summary does not belong to this agent' }, 403);
    }

    const db = getDb();

    // Get parent IDs (summaries that this summary was condensed from)
    const parentRows = db.prepare(
      'SELECT parent_id FROM summary_parents WHERE summary_id = ?',
    ).all(summaryId) as Array<{ parent_id: string }>;
    const parentIds = parentRows.map(r => r.parent_id);

    // Get child IDs (summaries that condensed this summary)
    const childRows = db.prepare(
      'SELECT summary_id FROM summary_parents WHERE parent_id = ?',
    ).all(summaryId) as Array<{ summary_id: string }>;
    const childIds = childRows.map(r => r.summary_id);

    // Get source message IDs
    const messageRows = db.prepare(
      'SELECT message_id FROM summary_messages WHERE summary_id = ?',
    ).all(summaryId) as Array<{ message_id: string }>;
    const sourceMessageIds = messageRows.map(r => r.message_id);

    const detail = {
      ...summary,
      parentIds,
      childIds,
      sourceMessageIds,
    };

    return c.json({ ok: true, data: detail });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch summary detail', { summaryId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// DELETE /:agentId/summary/:summaryId — delete summary
memoryRouter.delete('/:agentId/summary/:summaryId', (c) => {
  const agentId = c.req.param('agentId');
  const summaryId = c.req.param('summaryId');

  try {
    const summary = getSummary(summaryId);
    if (!summary) {
      return c.json({ ok: false, error: 'Summary not found' }, 404);
    }

    if (summary.agentId !== agentId) {
      return c.json({ ok: false, error: 'Summary does not belong to this agent' }, 403);
    }

    deleteSummary(summaryId);
    return c.json({ ok: true, data: { deleted: summaryId } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to delete summary', { summaryId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /:agentId/summary/:summaryId — edit summary content
memoryRouter.put('/:agentId/summary/:summaryId', async (c) => {
  const agentId = c.req.param('agentId');
  const summaryId = c.req.param('summaryId');

  try {
    const body = await c.req.json<{ content: string }>();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ ok: false, error: 'Missing or invalid content field' }, 400);
    }

    const summary = getSummary(summaryId);
    if (!summary) {
      return c.json({ ok: false, error: 'Summary not found' }, 404);
    }

    if (summary.agentId !== agentId) {
      return c.json({ ok: false, error: 'Summary does not belong to this agent' }, 403);
    }

    const tokenCount = estimateTokens(body.content);
    updateSummaryContent(summaryId, body.content, tokenCount);

    const updated = getSummary(summaryId);
    return c.json({ ok: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update summary', { summaryId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /:agentId/search — search memory (hybrid FTS + vector)
memoryRouter.get('/:agentId/search', async (c) => {
  const agentId = c.req.param('agentId');
  const q = c.req.query('q');
  const limitParam = c.req.query('limit');

  if (!q) {
    return c.json({ ok: false, error: 'Missing query parameter: q' }, 400);
  }

  try {
    const result = await memorySearch(agentId, {
      query: q,
      limit: limitParam ? parseInt(limitParam, 10) : undefined,
    });

    return c.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Memory search failed', { agentId, q, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /:agentId/inject — inject manual memory
memoryRouter.post('/:agentId/inject', async (c) => {
  const agentId = c.req.param('agentId');

  try {
    const body = await c.req.json<{ content: string }>();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ ok: false, error: 'Missing or invalid content field' }, 400);
    }

    const now = new Date().toISOString();
    const tokenCount = estimateTokens(body.content);

    const summary = createLeafSummary(
      agentId,
      body.content,
      tokenCount,
      [], // no source messages
      now,
      now,
    );

    return c.json({ ok: true, data: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to inject memory', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /:agentId/briefing — get latest briefing
memoryRouter.get('/:agentId/briefing', (c) => {
  const agentId = c.req.param('agentId');

  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT id, agent_id, content, token_count, generated_at FROM briefings
      WHERE agent_id = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `).get(agentId) as { id: string; agent_id: string; content: string; token_count: number; generated_at: string } | undefined;

    if (!row) {
      return c.json({ ok: false, error: 'No briefing found' }, 404);
    }

    const briefing = {
      id: row.id,
      agentId: row.agent_id,
      content: row.content,
      tokenCount: row.token_count,
      generatedAt: row.generated_at,
    };

    return c.json({ ok: true, data: briefing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch briefing', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /:agentId/briefing — edit briefing
memoryRouter.put('/:agentId/briefing', async (c) => {
  const agentId = c.req.param('agentId');

  try {
    const body = await c.req.json<{ content: string }>();
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ ok: false, error: 'Missing or invalid content field' }, 400);
    }

    updateBriefing(agentId, body.content);
    return c.json({ ok: true, data: { updated: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to update briefing', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /:agentId/briefing/regenerate — regenerate briefing
memoryRouter.post('/:agentId/briefing/regenerate', async (c) => {
  const agentId = c.req.param('agentId');

  try {
    const db = getDb();
    const agent = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;

    if (!agent) {
      return c.json({ ok: false, error: 'Agent not found' }, 404);
    }

    if (!agent.model_id) {
      return c.json({ ok: false, error: 'Agent has no model configured' }, 400);
    }

    const result = await generateBriefing(agentId, agent.model_id);

    const briefing = {
      id: result.id,
      agentId,
      content: result.content,
      tokenCount: result.tokenCount,
      generatedAt: new Date().toISOString(),
    };

    return c.json({ ok: true, data: briefing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to regenerate briefing', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /:agentId/compact — trigger manual compaction
memoryRouter.post('/:agentId/compact', async (c) => {
  const agentId = c.req.param('agentId');

  try {
    const db = getDb();
    const agent = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;

    if (!agent) {
      return c.json({ ok: false, error: 'Agent not found' }, 404);
    }

    if (!agent.model_id) {
      return c.json({ ok: false, error: 'Agent has no model configured' }, 400);
    }

    const contextWindow = getContextWindow(agent.model_id);
    const result = await checkAndCompact(agentId, agent.model_id, contextWindow, { force: true });

    return c.json({
      ok: true,
      data: {
        leafSummariesCreated: result.leafCreated,
        condensedCreated: result.condensedCreated,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Manual compaction failed', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ════════════════════════════════════════
// Embedding / Vector Search Routes (Phase 5C)
// ════════════════════════════════════════

// GET /embeddings/status — embedding backfill progress
memoryRouter.get('/embeddings/status', (c) => {
  try {
    const status = getEmbeddingStatus();
    const backfillProgress = getBackfillProgress();
    return c.json({
      ok: true,
      data: {
        ...status,
        backfillRunning: isBackfillRunning(),
        backfillProgress,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /embeddings/backfill — trigger embedding backfill
memoryRouter.post('/embeddings/backfill', async (c) => {
  try {
    if (isBackfillRunning()) {
      return c.json({ ok: false, error: 'Backfill is already running' }, 409);
    }

    // Run backfill in background
    runBackfill().catch(err => {
      logger.error('Backfill failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ ok: true, data: { started: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// PUT /embeddings/config — update embedding configuration
memoryRouter.put('/embeddings/config', async (c) => {
  try {
    const body = await c.req.json();
    setEmbeddingConfig(body);
    return c.json({ ok: true, data: getEmbeddingStatus() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /vector-search — vector similarity search
memoryRouter.get('/vector-search', async (c) => {
  const q = c.req.query('q');
  const agentId = c.req.query('agent_id');
  const limitParam = c.req.query('limit');

  if (!q) {
    return c.json({ ok: false, error: 'Missing query parameter: q' }, 400);
  }

  try {
    const results = await vectorSearch(q, agentId || undefined, {
      limit: limitParam ? parseInt(limitParam, 10) : 10,
    });
    return c.json({ ok: true, data: results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});
