import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { estimateTokens } from '../../memory/budget.js';
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
import { taskScope, projectScope, msToText } from '../../work/tracker-view.js';
import { deleteTrackerRow, detachChildren } from '../../work/tracker-store.js';

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

// ── v2.7.2 — Forensic memory search + purge ──
//
// Operator-grade tools for cleaning up self-reinforcing memory loops. The
// agent's vault_search uses semantic embeddings and is structurally blind
// to exact substrings (a query for "corp erp.in" embeds to "email domain"
// concepts and misses the literal string). These routes do plain SQL LIKE
// across every place a stale or wrong string can hide in an agent's
// persistent state, and let the operator bulk-delete the offending rows.

interface ForensicHit {
  kind: 'vault' | 'summary' | 'project' | 'task' | 'scratchpad';
  id: string;
  agentId: string | null;
  title: string | null;
  preview: string;
  createdAt: string | null;
}

// GET /memory/forensic-search?q=...&limit=...
// Returns matches across vault_entries, summaries, projects, tasks, and per-
// agent scratchpads (stored as JSON in agents.config). Always exact LIKE
// match — case-insensitive by default. Caller should pass distinctive
// strings; a query of "the" will return thousands.
memoryRouter.get('/forensic-search', (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ ok: false, error: 'q is required' }, 400);
  if (q.length < 2) return c.json({ ok: false, error: 'q must be at least 2 characters' }, 400);

  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const like = `%${q}%`;
  const db = getDb();
  const hits: ForensicHit[] = [];

  // Vault entries — include obsolete so the operator can see what's been
  // soft-deleted but is still in the table.
  const vaultRows = db.prepare(
    `SELECT id, agent_id, type, content, created_at FROM vault_entries
     WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`,
  ).all(like, limit) as Array<{ id: string; agent_id: string; type: string; content: string; created_at: string }>;
  for (const r of vaultRows) {
    hits.push({
      kind: 'vault',
      id: r.id,
      agentId: r.agent_id,
      title: `[${r.type}]`,
      preview: snippetAround(r.content, q),
      createdAt: r.created_at,
    });
  }

  const summaryRows = db.prepare(
    `SELECT id, agent_id, content, created_at FROM summaries
     WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`,
  ).all(like, limit) as Array<{ id: string; agent_id: string; content: string; created_at: string }>;
  for (const r of summaryRows) {
    hits.push({
      kind: 'summary',
      id: r.id,
      agentId: r.agent_id,
      title: null,
      preview: snippetAround(r.content, q),
      createdAt: r.created_at,
    });
  }

  const projectRows = db.prepare(
    `SELECT p.id AS id, p.title AS title, p.description AS description,
            p.requester_id AS created_by, ${msToText('p.opened_at')} AS created_at
       FROM work p
      WHERE ${projectScope('p')} AND (p.title LIKE ? OR p.description LIKE ?)
      ORDER BY p.opened_at DESC LIMIT ?`,
  ).all(like, like, limit) as Array<{ id: string; title: string; description: string | null; created_by: string; created_at: string }>;
  for (const r of projectRows) {
    const haystack = `${r.title}\n${r.description ?? ''}`;
    hits.push({
      kind: 'project',
      id: r.id,
      agentId: r.created_by,
      title: r.title,
      preview: snippetAround(haystack, q),
      createdAt: r.created_at,
    });
  }

  const taskRows = db.prepare(
    `SELECT w.id AS id, w.title AS title, w.description AS description,
            w.agent_id AS assigned_to, ${msToText('w.opened_at')} AS created_at
       FROM work w
      WHERE ${taskScope('w')} AND (w.title LIKE ? OR w.description LIKE ? OR w.notes LIKE ?)
      ORDER BY w.opened_at DESC LIMIT ?`,
  ).all(like, like, like, limit) as Array<{ id: string; title: string; description: string | null; assigned_to: string | null; created_at: string }>;
  for (const r of taskRows) {
    const haystack = `${r.title}\n${r.description ?? ''}`;
    hits.push({
      kind: 'task',
      id: r.id,
      agentId: r.assigned_to,
      title: r.title,
      preview: snippetAround(haystack, q),
      createdAt: r.created_at,
    });
  }

  // Scratchpad lives inside agents.config as JSON $.scratchpad. SQLite's
  // json_extract returns NULL when missing or invalid, so the LIKE matches
  // only agents whose scratchpad actually contains the substring.
  const scratchRows = db.prepare(
    `SELECT id, name, json_extract(config, '$.scratchpad') AS scratch
     FROM agents
     WHERE json_extract(config, '$.scratchpad') LIKE ?`,
  ).all(like) as Array<{ id: string; name: string; scratch: string }>;
  for (const r of scratchRows) {
    hits.push({
      kind: 'scratchpad',
      id: r.id,
      agentId: r.id,
      title: `${r.name} scratchpad`,
      preview: snippetAround(r.scratch, q),
      createdAt: null,
    });
  }

  return c.json({ ok: true, data: { query: q, total: hits.length, hits } });
});

// POST /memory/forensic-purge
// Body: { items: [{ kind, id }, ...] }
// Deletes (or in the case of scratchpad, clears) each item. Returns per-item
// success/failure so the UI can report partial deletes.
memoryRouter.post('/forensic-purge', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) {
    return c.json({ ok: false, error: 'items array is required' }, 400);
  }
  const items = body.items as Array<{ kind: ForensicHit['kind']; id: string }>;
  const db = getDb();
  const results: Array<{ kind: string; id: string; deleted: boolean; error?: string }> = [];

  for (const item of items) {
    try {
      switch (item.kind) {
        case 'vault':
          db.prepare('DELETE FROM vault_entries WHERE id = ?').run(item.id);
          break;
        case 'summary':
          // Drop summary + its leaf-message links + parent-of relationships
          // so we don't leave dangling rows that fail FK joins later.
          db.prepare('DELETE FROM summary_messages WHERE summary_id = ?').run(item.id);
          db.prepare('DELETE FROM summary_parents WHERE summary_id = ? OR parent_id = ?').run(item.id, item.id);
          db.prepare('DELETE FROM summaries WHERE id = ?').run(item.id);
          break;
        case 'project':
          // Tasks reference projects via FK; null out the task linkage rather
          // than cascade-delete tasks, so individual tasks remain visible
          // even after their parent project is purged.
          detachChildren(item.id);
          deleteTrackerRow(item.id);
          break;
        case 'task':
          deleteTrackerRow(item.id);
          break;
        case 'scratchpad': {
          // Scratchpad purge means "clear $.scratchpad", not "delete agent".
          // SQLite's json_remove on a missing key is a no-op, so this is safe
          // even if the field is already gone.
          db.prepare("UPDATE agents SET config = json_remove(COALESCE(config, '{}'), '$.scratchpad') WHERE id = ?").run(item.id);
          break;
        }
        default:
          throw new Error(`unknown kind: ${item.kind}`);
      }
      results.push({ kind: item.kind, id: item.id, deleted: true });
      logger.info('Forensic purge', { kind: item.kind, id: item.id });
    } catch (err) {
      results.push({
        kind: item.kind,
        id: item.id,
        deleted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const deleted = results.filter(r => r.deleted).length;
  return c.json({ ok: true, data: { deleted, total: items.length, results } });
});

// Helper: return ~120 chars of content centered on the first match of `q`,
// with ellipses to mark truncation. Falls back to the prefix if the query
// isn't found case-sensitively (defensive — caller used LIKE so it should be).
function snippetAround(content: string, q: string, radius = 80): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) {
    return content.length > radius * 2 ? content.slice(0, radius * 2) + '…' : content;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + q.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}
