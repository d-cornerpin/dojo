import { Hono } from 'hono';
import os from 'node:os';
import { getDb } from '../../db/connection.js';
import { readLogEntries } from '../../logger.js';
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

export { systemRouter };
