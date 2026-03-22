// ════════════════════════════════════════
// Vault API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  markObsolete,
  deleteEntry,
  listConversations,
  getConversation,
  getVaultStats,
  getDreamReports,
  getLatestDreamReport,
} from '../../vault/store.js';
import { runDreamingCycle, getDreamingConfig, setDreamingConfig } from '../../vault/maintenance.js';
import { extractFromConversation, storeExtractedMemories } from '../../vault/extraction.js';
import { markConversationProcessed } from '../../vault/store.js';

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

vaultRouter.get('/entries/:id', (c) => {
  const entry = getEntry(c.req.param('id'));
  if (!entry) return c.json({ ok: false, error: 'Entry not found' }, 404);
  return c.json({ ok: true, data: entry });
});

vaultRouter.post('/entries', async (c) => {
  const body = await c.req.json();
  const { content, type, tags, pin, permanent } = body;

  if (!content || !type) {
    return c.json({ ok: false, error: 'content and type are required' }, 400);
  }

  try {
    const entry = await createEntry({
      agentId: 'manual',
      agentName: 'Dashboard',
      type,
      content,
      tags: tags ?? [],
      isPinned: pin ?? false,
      isPermanent: permanent ?? false,
      source: 'manual',
    });
    return c.json({ ok: true, data: entry });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

vaultRouter.put('/entries/:id', async (c) => {
  const body = await c.req.json();
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

vaultRouter.get('/conversations', (c) => {
  const agentId = c.req.query('agent');
  const processed = c.req.query('processed');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);

  const conversations = listConversations({
    agentId: agentId ?? undefined,
    processed: processed !== undefined ? processed === 'true' : undefined,
    limit,
  });

  // Don't send full message bodies in list view -- too large
  const stripped = conversations.map(conv => ({
    ...conv,
    messages: undefined,
    messagePreview: `${conv.messageCount} messages, ${conv.tokenCount} tokens`,
  }));

  return c.json({ ok: true, data: stripped });
});

vaultRouter.get('/conversations/:id', (c) => {
  const conv = getConversation(c.req.param('id'));
  if (!conv) return c.json({ ok: false, error: 'Conversation not found' }, 404);
  return c.json({ ok: true, data: conv });
});

vaultRouter.post('/conversations/:id/process', async (c) => {
  const conv = getConversation(c.req.param('id'));
  if (!conv) return c.json({ ok: false, error: 'Conversation not found' }, 404);
  if (conv.isProcessed) return c.json({ ok: false, error: 'Already processed' }, 400);

  const config = getDreamingConfig();
  const modelId = config.modelId;
  if (!modelId) return c.json({ ok: false, error: 'No dreaming model configured' }, 400);

  try {
    let parsedMessages: Array<{ role: string; content: string; createdAt?: string }>;
    try {
      parsedMessages = JSON.parse(conv.messages);
    } catch {
      return c.json({ ok: false, error: 'Failed to parse archived messages' }, 500);
    }

    const formatted = parsedMessages.map(m => {
      const role = (m.role ?? 'unknown').toUpperCase();
      const ts = m.createdAt ? ` [${m.createdAt}]` : '';
      return `[${role}${ts}] ${m.content}`;
    }).join('\n\n---\n\n');

    const result = await extractFromConversation(formatted, modelId, config.dreamMode === 'off' ? 'light' : config.dreamMode);
    const stored = await storeExtractedMemories(result.memories, conv.agentId, conv.agentName, conv.id);

    markConversationProcessed(conv.id);

    return c.json({ ok: true, data: { memoriesExtracted: stored, techniquesFound: result.techniqueCandidates.length } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
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
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
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
  setDreamingConfig({
    modelId: body.modelId,
    dreamTime: body.dreamTime,
    dreamMode: body.dreamMode,
  });
  // Reschedule if config changed
  const { scheduleDreamingCycle } = await import('../../vault/maintenance.js');
  scheduleDreamingCycle();
  return c.json({ ok: true, data: getDreamingConfig() });
});
