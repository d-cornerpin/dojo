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

export { systemRouter };
