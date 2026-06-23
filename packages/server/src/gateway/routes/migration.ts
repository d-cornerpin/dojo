// ════════════════════════════════════════
// Migration API Routes — export, import, manifest, status
// ════════════════════════════════════════

import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import type { AppEnv } from '../server.js';
import { createExport } from '../../migration/export.js';
import { readManifestFromZip, performImport, verifyArchive } from '../../migration/import.js';
import { getChecks, dismissMigration, isMigrationDismissed, runPostMigrationChecks, getLastManifest } from '../../migration/checks.js';
import { buildCombinedInstaller } from '../../migration/dependency-script.js';
import { terminateAgent } from '../../agent/spawner.js';
import { getDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { getDashboardPasswordHash, getJwtSecret } from '../../config/loader.js';
import { broadcast } from '../ws.js';
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
//
// The export zip is sent as the raw request body (application/octet-stream),
// NOT multipart form-data. We stream it straight to a temp file so a multi-GB
// export never gets buffered into a single in-memory Buffer (formData() +
// arrayBuffer() throws "length out of range" past ~2GB).
migrationRouter.post('/manifest', async (c) => {
  let tmpPath: string | null = null;
  try {
    const body = c.req.raw.body;
    if (!body) {
      return c.json({ ok: false, error: 'No file uploaded' }, 400);
    }

    tmpPath = path.join(os.tmpdir(), `dojo-manifest-${Date.now()}-${process.pid}.zip`);
    await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(tmpPath));

    const manifest = await readManifestFromZip(tmpPath);
    return c.json({ ok: true, data: manifest });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Manifest read failed', { error: msg });
    return c.json({ ok: false, error: msg }, 400);
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
});

// POST /api/migration/preflight — scan the upload WITHOUT importing.
//
// Powers the wizard's "scan" step: verify archive integrity (checksum over the
// full payload), the password (cheap prefix-decrypt), and that there's enough
// free disk for the restore — before anything touches ~/.dojo. Same raw-body +
// X-Export-Password transport as /import.
migrationRouter.post('/preflight', async (c) => {
  let tmpPath: string | null = null;
  try {
    const body = c.req.raw.body;
    const rawPassword = c.req.header('x-export-password');
    const password = rawPassword ? decodeURIComponent(rawPassword) : null;
    if (!body) return c.json({ ok: false, error: 'No file uploaded' }, 400);
    if (!password || password.length < 8) {
      return c.json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
    }

    tmpPath = path.join(os.tmpdir(), `dojo-preflight-${Date.now()}-${process.pid}.zip`);
    await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(tmpPath));

    const { manifest, integrityOk, passwordOk } = await verifyArchive(tmpPath, password);

    // Free-disk check: the restore stages the inner zip + extracted tree + the
    // restored db, so require ~2x the database size free on the dojo volume.
    let diskOk = true;
    let freeBytes: number | null = null;
    try {
      const st = fs.statfsSync(os.homedir());
      freeBytes = Number(st.bavail) * Number(st.bsize);
      diskOk = freeBytes >= manifest.contents.database_size_bytes * 2;
    } catch { diskOk = true; /* can't determine — don't block */ }

    return c.json({ ok: true, data: { manifest, integrityOk, passwordOk, diskOk, freeBytes } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Preflight failed', { error: msg });
    return c.json({ ok: false, error: msg }, 400);
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
});

// POST /api/migration/import — full import from encrypted zip
//
// Like /manifest, the zip is the raw request body (streamed to a temp file to
// avoid the ~2GB single-Buffer ceiling) and the export password rides in the
// X-Export-Password header instead of a multipart field.
migrationRouter.post('/import', async (c) => {
  let tmpPath: string | null = null;
  try {
    const body = c.req.raw.body;
    // Header values must be ASCII, so the client URI-encodes the password
    // (handles spaces / unicode); decode before use and length-check.
    const rawPassword = c.req.header('x-export-password');
    const password = rawPassword ? decodeURIComponent(rawPassword) : null;

    if (!body) {
      return c.json({ ok: false, error: 'No file uploaded' }, 400);
    }
    if (!password || password.length < 8) {
      return c.json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
    }

    logger.info('Import requested');
    tmpPath = path.join(os.tmpdir(), `dojo-import-upload-${Date.now()}-${process.pid}.zip`);
    await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(tmpPath));

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

    const { manifest, checks } = await performImport(tmpPath, password, stopServices, restartServices, currentAuth);

    return c.json({ ok: true, data: { manifest, checks } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Import failed', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
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

// POST /api/migration/import/recheck — re-evaluate the post-migration checks
// against the most recent import (e.g. after the user grants Full Disk Access or
// reconnects an account). Broadcasts migration:checks and returns the fresh set.
migrationRouter.post('/import/recheck', async (c) => {
  const manifest = getLastManifest();
  if (!manifest) {
    return c.json({ ok: false, error: 'No recent import to re-check.' }, 400);
  }
  try {
    const checks = await runPostMigrationChecks(manifest);
    return c.json({ ok: true, data: { checks } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/migration/run-dependency-setup — run the bundled technique
// dependency installer (setup-dependencies.sh) and stream its output over WS
// (migration:depsetup events). User-triggered from the post-import wizard.
migrationRouter.post('/run-dependency-setup', (c) => {
  try {
    // Combined installer: core tools (Ollama/cloudflared, guarded) + the bundled
    // per-technique installer. Written to a temp file and run; output streams via
    // migration:depsetup, exactly as before.
    const script = buildCombinedInstaller();
    const scriptPath = path.join(os.tmpdir(), `dojo-setup-combined-${Date.now()}-${process.pid}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const child = spawn('bash', [scriptPath], { cwd: os.homedir(), env: process.env });
    const emit = (line: string) => broadcast({ type: 'migration:depsetup', data: { line } } as never);
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) if (line.length > 0) emit(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', async (code) => {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      // Re-run checks now that the core tools + deps are installed. This also
      // starts the background Ollama model pulls (Ollama is on PATH now) and
      // flips ollama/cloudflared/technique checks to green.
      try {
        const manifest = getLastManifest();
        if (manifest) await runPostMigrationChecks(manifest);
      } catch (err) {
        logger.warn('Post-install re-check failed', { error: err instanceof Error ? err.message : String(err) });
      }
      broadcast({ type: 'migration:depsetup', data: { done: true, ok: code === 0, exitCode: code } } as never);
      logger.info('Dependency setup finished', { exitCode: code });
    });
    child.on('error', (err) => {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      broadcast({ type: 'migration:depsetup', data: { done: true, ok: false, error: err.message } } as never);
      logger.error('Dependency setup failed to start', { error: err.message });
    });
    logger.info('Dependency setup started');
    return c.json({ ok: true, data: { started: true } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export { migrationRouter };
