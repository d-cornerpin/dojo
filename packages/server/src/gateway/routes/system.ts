import { Hono } from 'hono';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { readLogEntries } from '../../logger.js';
import { broadcast } from '../ws.js';
import type { HealthData, LogEntry } from '@dojo/shared';

const systemRouter = new Hono();

const startedAt = Date.now();

// GET /health (no auth required - handled by middleware exclusion)
systemRouter.get('/health', (c) => {
  let dbStatus: 'ok' | 'error' = 'ok';
  let agentCount = 0;

  try {
    const db = getDb();
    agentCount = (db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }).count;
    // Quick DB check
    db.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }

  const memInfo = process.memoryUsage();

  const health: HealthData = {
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    agents: agentCount,
    db: dbStatus,
    memory: {
      used: Math.round(memInfo.heapUsed / 1024 / 1024),
      total: Math.round(os.totalmem() / 1024 / 1024),
    },
  };

  return c.json({ ok: true, data: health });
});

// GET /system/logs
systemRouter.get('/system/logs', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const level = c.req.query('level') as LogEntry['level'] | undefined;
  const component = c.req.query('component');

  const entries = readLogEntries({
    limit: Math.min(limit, 1000),
    level: level,
    component: component ?? undefined,
  });

  return c.json({ ok: true, data: entries });
});

// GET /system/watchers — status of Gmail, Outlook, and Teams watchers.
// Pre-2026-04-30 watcher state was completely invisible — silent failures
// on a stale OAuth token or broken poll left the user with no signal that
// new emails weren't being delivered. This endpoint exposes everything
// the dashboard Health page needs to diagnose at a glance.
systemRouter.get('/system/watchers', async (c) => {
  try {
    const [{ getGmailWatcherStatus }, { getOutlookWatcherStatus }, { getTeamsWatcherStatus }] = await Promise.all([
      import('../../services/gmail-watcher.js'),
      import('../../services/outlook-watcher.js'),
      import('../../services/teams-watcher.js'),
    ]);
    return c.json({
      ok: true,
      data: {
        gmail: getGmailWatcherStatus(),
        outlook: getOutlookWatcherStatus(),
        teams: getTeamsWatcherStatus(),
      },
    });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});

// GET /system/time — current server time and timezone
systemRouter.get('/system/time', (c) => {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -now.getTimezoneOffset(); // minutes from UTC
  return c.json({
    ok: true,
    data: {
      utc: now.toISOString(),
      timezone: tz,
      offset,
    },
  });
});

// GET /og-preview?url=... — fetch Open Graph metadata for link previews
systemRouter.get('/og-preview', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ ok: false, error: 'url parameter required' }, 400);

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DojoBot/1.0)' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });

    if (!resp.ok) return c.json({ ok: true, data: { url, title: null, description: null, image: null } });

    const html = await resp.text();

    // Extract OG tags with simple regex (no DOM parser needed)
    const getOg = (property: string): string | null => {
      const match = html.match(new RegExp(`<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']+)["']`, 'i'))
        ?? html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:${property}["']`, 'i'));
      return match?.[1] ?? null;
    };

    // Fallback to regular meta tags and <title>
    const getMeta = (name: string): string | null => {
      const match = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'))
        ?? html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, 'i'));
      return match?.[1] ?? null;
    };

    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;

    const title = getOg('title') ?? getMeta('title') ?? titleTag;
    const description = getOg('description') ?? getMeta('description');
    const image = getOg('image');
    const siteName = getOg('site_name');

    // Make relative image URLs absolute
    let absoluteImage = image;
    if (image && !image.startsWith('http')) {
      try {
        absoluteImage = new URL(image, url).href;
      } catch { /* keep as-is */ }
    }

    return c.json({
      ok: true,
      data: { url, title, description, image: absoluteImage, siteName },
    });
  } catch {
    return c.json({ ok: true, data: { url, title: null, description: null, image: null } });
  }
});

// POST /system/reset-idle-sessions — resets every agent whose status is
// 'idle'. Used by the V2CutoverNotice's "Reset all idle sessions" button
// (Part XI / Phase 9). Returns a count breakdown.
//
// Mirrors the per-agent reset_session tool's archive-and-mark-boundary
// logic but in bulk. Skips agents that are working/paused/terminated.
systemRouter.post('/system/reset-idle-sessions', async (c) => {
  const db = getDb();
  const idle = db.prepare("SELECT id, name FROM agents WHERE status = 'idle'").all() as Array<{ id: string; name: string }>;
  const total = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE status NOT IN ('terminated')").get() as { c: number }).c;

  let reset = 0;
  const errors: Array<{ agentId: string; error: string }> = [];

  // Archive + boundary marker per idle agent. Inline the same logic as
  // reset_session in agent/tools.ts:2817 so we don't have to refactor that
  // big switch block to extract a shared helper.
  const { archiveAgentConversation } = await import('../../vault/archive.js');

  for (const agent of idle) {
    try {
      try { archiveAgentConversation(agent.id); } catch { /* archive is best-effort */ }
      const now = new Date();
      const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      db.prepare(
        "UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief') WHERE id = ?",
      ).run(boundary, boundary, agent.id);

      const markerId = uuidv4();
      db.prepare(
        "INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', '── New Session ──', ?)",
      ).run(markerId, agent.id, boundary);
      try {
        broadcast({
          type: 'chat:message',
          agentId: agent.id,
          message: {
            id: markerId,
            agentId: agent.id,
            role: 'system',
            content: '── New Session ──',
            tokenCount: null,
            modelId: null,
            cost: null,
            latencyMs: null,
            createdAt: boundary,
          },
        });
      } catch { /* best effort */ }
      reset++;
    } catch (err) {
      errors.push({ agentId: agent.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const busy = total - reset - errors.length;
  return c.json({
    ok: true,
    data: { reset, busy, errors: errors.length, total, errorDetails: errors },
  });
});

// POST /system/debug-toast — fire a chat:error broadcast for testing the
// dashboard's 3-tier toast system (INFO green / WARN orange / ERROR red).
// Body: { agentId: string, severity: 'info'|'warning'|'error', message: string }
// Auth-protected via the gateway's middleware (same as the rest of /system/*).
systemRouter.post('/debug-toast', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const agentId = (body.agentId as string | undefined) ?? 'kevin';
  const severity = (body.severity as 'info' | 'warning' | 'error' | undefined) ?? 'info';
  const message = (body.message as string | undefined) ?? `Test ${severity.toUpperCase()} toast — ${new Date().toLocaleTimeString()}`;
  broadcast({
    type: 'chat:error',
    agentId,
    error: message,
    code: severity === 'info' ? 'AGENT_RECOVERED' : severity === 'warning' ? 'CONTEXT_HIGH' : 'MODEL_FAILED',
    severity,
    retryable: false,
  });
  return c.json({ ok: true, data: { agentId, severity, message } });
});

export { systemRouter };
