// ════════════════════════════════════════
// Migration API Routes — export, import, manifest, status
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createExport } from '../../migration/export.js';
import { readManifestFromZip, performImport } from '../../migration/import.js';
import { getChecks, dismissMigration, isMigrationDismissed } from '../../migration/checks.js';
import { terminateAgent } from '../../agent/spawner.js';
import { getDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { getDashboardPasswordHash, getJwtSecret } from '../../config/loader.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('migration-routes');

const migrationRouter = new Hono<AppEnv>();

// POST /api/migration/export — create encrypted export zip
migrationRouter.post('/export', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.password || typeof body.password !== 'string') {
      return c.json({ ok: false, error: 'Password is required' }, 400);
    }
    if (body.password.length < 8) {
      return c.json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
    }

    logger.info('Export requested');
    const { filePath, manifest } = await createExport(body.password);

    // Stream the file as download
    const fs = await import('node:fs');
    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);
    const fileName = filePath.split('/').pop() ?? 'dojo-export.zip';

    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="${fileName}"`);
    c.header('Content-Length', stat.size.toString());

    // Convert Node stream to Response
    const { Readable } = await import('node:stream');
    const webStream = Readable.toWeb(stream) as ReadableStream;

    // Cleanup temp file after streaming
    stream.on('close', () => {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    });

    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': stat.size.toString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Export failed', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /api/migration/manifest — read manifest from uploaded zip (no password needed)
migrationRouter.post('/manifest', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return c.json({ ok: false, error: 'No file uploaded' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const manifest = readManifestFromZip(buffer);

    return c.json({ ok: true, data: manifest });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Manifest read failed', { error: msg });
    return c.json({ ok: false, error: msg }, 400);
  }
});

// POST /api/migration/import — full import from encrypted zip
migrationRouter.post('/import', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const password = formData.get('password') as string | null;

    if (!file) {
      return c.json({ ok: false, error: 'No file uploaded' }, 400);
    }
    if (!password || password.length < 8) {
      return c.json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
    }

    logger.info('Import requested');
    const buffer = Buffer.from(await file.arrayBuffer());

    // Capture current auth BEFORE import replaces secrets.yaml
    const currentAuth = {
      passwordHash: getDashboardPasswordHash(),
      jwtSecret: getJwtSecret(),
    };

    const stopServices = async () => {
      // Terminate all running agents
      try {
        const db = getDb();
        const running = db.prepare("SELECT id FROM agents WHERE status IN ('idle', 'working')").all() as Array<{ id: string }>;
        for (const agent of running) {
          try { terminateAgent(agent.id, 'migration-import'); } catch { /* ignore */ }
        }
      } catch { /* DB may be fresh/empty during OOBE */ }
    };

    const restartServices = async () => {
      // Re-initialize database connection and run migrations
      runMigrations();
    };

    const { manifest, checks } = await performImport(buffer, password, stopServices, restartServices, currentAuth);

    return c.json({ ok: true, data: { manifest, checks } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Import failed', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /api/migration/import/status — current post-migration check state
migrationRouter.get('/import/status', (c) => {
  const checks = getChecks();
  const dismissed = isMigrationDismissed();
  return c.json({ ok: true, data: { checks, dismissed } });
});

// POST /api/migration/import/dismiss — dismiss post-migration banner
migrationRouter.post('/import/dismiss', (c) => {
  dismissMigration();
  return c.json({ ok: true, data: { dismissed: true } });
});

export { migrationRouter };
