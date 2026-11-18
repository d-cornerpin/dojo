import { Hono } from 'hono';
import os from 'node:os';
import { getDb } from '../../db/connection.js';
import { readLogEntries } from '../../logger.js';
import { broadcast } from '../ws.js';
import { assertPublicHttpTarget } from '../../agent/net-guard.js';
import { toolDocsStatus } from '../../tools/doc-freshness.js';
import type { HealthData, LogEntry } from '@dojo/shared';
import { noteRouteFailure, routeFailure } from './route-failure.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('system-routes');

const systemRouter = new Hono();

const startedAt = Date.now();

// GET /health (no auth required - handled by middleware exclusion)
systemRouter.get('/health', (c) => {
  let dbStatus: 'ok' | 'error' = 'ok';
  let agentCount = 0;

  try {
    const db = getDb();
    agentCount = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status != 'terminated'").get() as { count: number }).count;
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
    // Whether this box's tool manuals are the ones it shipped with; absent until boot has
    // measured. Best-effort: a health read must never fail on its own diagnostics.
    ...(() => {
      try {
        const d = toolDocsStatus();
        return d ? { toolDocs: d } : {};
      } catch { return {}; }
    })(),
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

// GET /system/watchers: status of the Gmail, Outlook and Teams watchers, so a stale OAuth token or a broken
// poll is visible on the Health page.
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
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// og-preview fetches a URL server-side for every link in rendered (possibly untrusted) messages, so it must
// refuse private targets (SSRF). agent/net-guard.ts is the one owner of that judgement; each redirect hop is
// re-checked.

// GET /og-preview?url=...: fetch Open Graph metadata for link previews
systemRouter.get('/og-preview', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ ok: false, error: 'url parameter required' }, 400);

  try {
    // Follow redirects MANUALLY so each hop's target is re-validated (an open
    // redirect on an allowed host could otherwise bounce us to a private one).
    let current = url;
    let resp: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublicHttpTarget(current);
      resp = await fetch(current, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DojoBot/1.0)' },
        signal: AbortSignal.timeout(8000),
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
        current = new URL(resp.headers.get('location') as string, current).href;
        continue;
      }
      break;
    }

    if (!resp || !resp.ok) return c.json({ ok: true, data: { url, title: null, description: null, image: null } });

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
  } catch (err) {
    noteRouteFailure(c, logger, err);
    return c.json({ ok: true, data: { url, title: null, description: null, image: null } });
  }
});

/** Exit so launchd (KeepAlive) brings the Dojo back within a couple of seconds; under `tsx watch` the exit
 *  stops the dev server. Deferred so the caller's response flushes first; the marker lets every dashboard
 *  show a "restarting" overlay through the gap. */
export function restartDojo(reason: string): void {
  broadcast({ type: 'system:restart', initiatedAt: new Date().toISOString(), mode: process.env.NODE_ENV !== 'production' ? 'dev' : 'production' });
  setTimeout(() => {
    logger.info('Exiting to restart', { reason });
    process.exit(0);
  }, 300);
}

// POST /system/restart: the owner's restart button.
systemRouter.post('/system/restart', async (c) => {
  const isDev = process.env.NODE_ENV !== 'production';
  restartDojo('the owner asked');
  return c.json({
    ok: true,
    data: {
      restarting: true,
      mode: isDev ? 'dev' : 'production',
      message: isDev
        ? 'Server exiting. tsx watch will NOT restart it automatically - re-run `npm run dev` manually.'
        : 'Server exiting. launchd will bring it back in 1-2 seconds.',
    },
  });
});

export { systemRouter };
