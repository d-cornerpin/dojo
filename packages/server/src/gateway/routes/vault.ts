// ════════════════════════════════════════
// Vault API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  listEntries,
  isOverEntryLimit,
  ownerEntryTooLongMessage,
  updateEntry,
  markObsolete,
  deleteEntry,
  getVaultStats,
  getDreamReports,
  getLatestDreamReport,
  bulkDiscardUnprocessedConversations,
} from '../../vault/store.js';
import { runDreamingCycle, getDreamingConfig, setDreamingConfig } from '../../vault/maintenance.js';
import { routeFailure } from './route-failure.js';
import { getDb } from '../../db/connection.js';
import { refuseAgentModel } from '../../agent/main-model-floor.js';
import { setAgentModel } from '../../agent/model-switch.js';
import { refuseBadClockTime } from '../../config/clock-time.js';

const logger = createLogger('vault-routes');

export const vaultRouter = new Hono<AppEnv>();

// ── Entries ──

vaultRouter.get('/entries', (c) => {
  const type = c.req.query('type');
  const agentId = c.req.query('agent');
  const tag = c.req.query('tag');
  const pinned = c.req.query('pinned') === 'true' ? true : undefined;
  const permanent = c.req.query('permanent') === 'true' ? true : undefined;
  const search = c.req.query('search');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);

  const entries = listEntries({ type: type ?? undefined, agentId: agentId ?? undefined, tag: tag ?? undefined, pinned, permanent, search: search ?? undefined, limit });
  return c.json({ ok: true, data: entries });
});

vaultRouter.put('/entries/:id', async (c) => {
  const body = await c.req.json();
  if (body.confidence !== undefined && !(typeof body.confidence === 'number' && Number.isFinite(body.confidence) && body.confidence >= 0 && body.confidence <= 1)) {
    return c.json({ ok: false, error: 'confidence must be a number from 0 to 1' }, 400);
  }
  if (body.content !== undefined && (typeof body.content !== 'string' || body.content.trim() === '')) {
    return c.json({ ok: false, error: 'content must be non-empty text' }, 400);
  }
  if (typeof body.content === 'string' && isOverEntryLimit(body.content)) {
    return c.json({ ok: false, error: ownerEntryTooLongMessage(body.content) }, 400);
  }
  const updated = updateEntry(c.req.param('id'), {
    content: body.content,
    tags: body.tags,
    isPinned: body.pin,
    isPermanent: body.permanent,
    confidence: body.confidence,
  });
  if (!updated) return c.json({ ok: false, error: 'Entry not found' }, 404);
  return c.json({ ok: true, data: updated });
});

vaultRouter.post('/entries/:id/obsolete', async (c) => {
  const body = await c.req.json();
  markObsolete(c.req.param('id'), body.reason);
  return c.json({ ok: true });
});

vaultRouter.delete('/entries/:id', (c) => {
  deleteEntry(c.req.param('id'));
  return c.json({ ok: true });
});

// ── Conversations ──

// Bulk-discard unprocessed conversation archives. Provides a fast path
// for users who have built up a backlog of junk archives and want to
// reset the Dreamer queue without waiting for it to grind through them.
// Body shape (one of the three required to act):
//   { agentId: string }       discard all unprocessed archives from this agent
//   { olderThanDays: number } discard archives older than N days
//   { all: true }              nuke every unprocessed archive
vaultRouter.post('/conversations/discard', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const filter: { agentId?: string; olderThanIso?: string; all?: boolean } = {};
  if (typeof body.agentId === 'string' && body.agentId.length > 0) {
    filter.agentId = body.agentId;
  }
  if (typeof body.olderThanDays === 'number' && body.olderThanDays > 0) {
    const cutoff = new Date(Date.now() - body.olderThanDays * 24 * 60 * 60 * 1000);
    filter.olderThanIso = cutoff.toISOString();
  }
  if (body.all === true) {
    filter.all = true;
  }
  if (!filter.agentId && !filter.olderThanIso && !filter.all) {
    return c.json({ ok: false, error: 'Specify one of: agentId, olderThanDays, or all=true' }, 400);
  }
  const deleted = bulkDiscardUnprocessedConversations(filter);
  logger.info('Bulk-discarded unprocessed archives', { deleted, filter });
  return c.json({ ok: true, data: { deleted } });
});

// ── Stats ──

vaultRouter.get('/stats', (c) => {
  const stats = getVaultStats();
  return c.json({ ok: true, data: stats });
});

// ── Dream ──

vaultRouter.post('/dream', async (c) => {
  try {
    const result = await runDreamingCycle();
    if (result.dreamerId) {
      return c.json({ ok: true, data: { dreamerId: result.dreamerId, message: 'Dreamer agent spawned' } });
    } else {
      return c.json({ ok: true, data: { dreamerId: null, message: 'No archives to process or dreaming disabled' } });
    }
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

vaultRouter.get('/dream/history', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const reports = getDreamReports(limit);
  return c.json({ ok: true, data: reports });
});

vaultRouter.get('/dream/latest', (c) => {
  const report = getLatestDreamReport();
  return c.json({ ok: true, data: report });
});

// ── Dreaming Config ──

vaultRouter.get('/dream/config', (c) => {
  const config = getDreamingConfig();
  return c.json({ ok: true, data: config });
});

vaultRouter.put('/dream/config', async (c) => {
  const body = await c.req.json();
  // 32K main-model floor: this is the dreamer's MAIN model; refuse before any write.
  const { getDreamerAgentId } = await import('../../config/platform.js');
  // Then the memory fit: a local model that will not fit in this box's memory is refused too.
  const newModel = typeof body.modelId === 'string' ? body.modelId : null;
  const current = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(getDreamerAgentId()) as { model_id: string | null } | undefined)?.model_id;
  const refused = await refuseAgentModel(newModel, current);
  if (refused) return c.json({ ok: false, error: refused }, 400);

  const badTime = body.dreamTime === undefined ? null : refuseBadClockTime(body.dreamTime);
  if (badTime) return c.json({ ok: false, error: badTime }, 400);

  if (body.modelId !== undefined && typeof body.modelId !== 'string') {
    return c.json({ ok: false, error: 'Model id must be text.' }, 400);
  }

  setDreamingConfig({
    modelId: body.modelId,
    dreamTime: body.dreamTime,
  });

  if (body.modelId) await setAgentModel(getDreamerAgentId(), body.modelId);

  // Reschedule if config changed
  const { scheduleDreamingCycle } = await import('../../vault/maintenance.js');
  scheduleDreamingCycle();
  return c.json({ ok: true, data: getDreamingConfig() });
});
