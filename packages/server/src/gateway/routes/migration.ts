// Migration API routes: export, import, manifest, status

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
import { ImportAlreadyRunningError } from '../../migration/import-safety.js';
import { bindImportCardMarker } from '../../migration/import-recovery.js';
import { getChecks, dismissMigration, isMigrationDismissed, runPostMigrationChecks, getLastManifest } from '../../migration/checks.js';
import { buildCombinedInstaller } from '../../migration/dependency-script.js';
import { stopAgentRunsForImport, resumeAgentsAfterFailedImport } from '../../migration/import-agents.js';
import { closeDb } from '../../db/connection.js';
import { reopenDatabaseAfterImport } from '../../migration/after-import.js';
import { getDashboardPasswordHash, getJwtSecret } from '../../config/loader.js';
import { broadcast } from '../ws.js';
import { createLogger } from '../../logger.js';
import { homeDir } from '../../home.js';

const logger = createLogger('migration-routes');
bindImportCardMarker(fs, path.join(homeDir(), '.dojo-import-stuck.json')); // beside ~/.dojo, so the card outlives a restart

// ONE mount, `/api/migration/*`, behind the owner's token. There is no second public mount, so
// restore and installer routes are never reachable without auth; the import wizard calls this
// mount with its token.
const migrationRouter = new Hono<AppEnv>();

// POST /api/migration/export (create encrypted export zip)
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

    const fs = await import('node:fs');
    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);
    const fileName = `dojo-export-${new Date().toISOString().split('T')[0]}.zip`;

    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="${fileName}"`);
    c.header('Content-Length', stat.size.toString());

    const { Readable } = await import('node:stream');
    const webStream = Readable.toWeb(stream) as ReadableStream;

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

// POST /api/migration/manifest (read manifest from uploaded zip, no password needed)
//
// The zip is the raw request body (application/octet-stream), not multipart, and is streamed to a
// temp file so a multi-GB export is never buffered in memory (formData() throws past ~2GB).
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

// POST /api/migration/preflight (scan the upload WITHOUT importing)
//
// Verifies archive integrity (checksum), the password (prefix-decrypt) and free disk before
// anything touches ~/.dojo. Same raw-body and X-Export-Password transport as /import.
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
      const st = fs.statfsSync(homeDir());
      freeBytes = Number(st.bavail) * Number(st.bsize);
      diskOk = freeBytes >= manifest.contents.database_size_bytes * 2;
    } catch { diskOk = true; /* can't determine, so don't block */ }

    return c.json({ ok: true, data: { manifest, integrityOk, passwordOk, diskOk, freeBytes } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Preflight failed', { error: msg });
    return c.json({ ok: false, error: msg }, 400);
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
});

// POST /api/migration/import (full import from encrypted zip)
//
// Like /manifest, the zip is the raw request body streamed to a temp file, and the export
// password rides in the X-Export-Password header.
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

    // Runs in flight are stopped (the database closes for the swap), never terminated; a failed
    // import brings them back (`migration/import-agents.ts`).
    let stoppedForImport: string[] = [];
    const stopServices = async () => {
      stoppedForImport = stopAgentRunsForImport();
    };

    const restartServices = async () => {
      // Re-initialize database connection, run migrations, and the one-time owner conversion
      await reopenDatabaseAfterImport();
    };

    const { manifest, checks } = await performImport(tmpPath, password, stopServices, restartServices, currentAuth, () => resumeAgentsAfterFailedImport(stoppedForImport));

    return c.json({ ok: true, data: { manifest, checks } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Import failed', { error: msg });
    return c.json({ ok: false, error: msg }, err instanceof ImportAlreadyRunningError ? 409 : 500);
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
});

// GET /api/migration/import/status (current post-migration check state)
migrationRouter.get('/import/status', (c) => {
  const checks = getChecks();
  const dismissed = isMigrationDismissed();
  return c.json({ ok: true, data: { checks, dismissed } });
});

// POST /api/migration/import/dismiss (dismiss post-migration banner)
migrationRouter.post('/import/dismiss', (c) => {
  dismissMigration();
  return c.json({ ok: true, data: { dismissed: true } });
});

// POST /api/migration/import/recheck (re-evaluate the post-migration checks against the most
// recent import, e.g. after granting Full Disk Access). Broadcasts migration:checks.
migrationRouter.post('/import/recheck', async (c) => {
  const manifest = getLastManifest();
  if (!manifest) {
    return c.json({ ok: false, error: 'No recent import to re-check.' }, 400);
  }
  try {
    const checks = await runPostMigrationChecks(manifest);
    return c.json({ ok: true, data: { checks } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Post-migration re-check failed', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /api/migration/run-dependency-setup (run the bundled dependency installer and stream its
// output over WS as migration:depsetup events; user-triggered from the post-import wizard)
migrationRouter.post('/run-dependency-setup', (c) => {
  try {
    // Combined installer: core tools (Ollama/cloudflared, guarded) plus the bundled per-technique
    // installer, written to a temp file and run; output streams via migration:depsetup.
    const script = buildCombinedInstaller();
    const scriptPath = path.join(os.tmpdir(), `dojo-setup-combined-${Date.now()}-${process.pid}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const child = spawn('bash', [scriptPath], { cwd: homeDir(), env: process.env });
    const emit = (line: string) => broadcast({ type: 'migration:depsetup', data: { line } });
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
      broadcast({ type: 'migration:depsetup', data: { done: true, ok: code === 0, exitCode: code } });
      logger.info('Dependency setup finished', { exitCode: code });
    });
    child.on('error', (err) => {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      broadcast({ type: 'migration:depsetup', data: { done: true, ok: false, error: err.message } });
      logger.error('Dependency setup failed to start', { error: err.message });
    });
    logger.info('Dependency setup started');
    return c.json({ ok: true, data: { started: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Dependency setup failed to launch', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { migrationRouter };
