// ════════════════════════════════════════════════════════════════════════════════════════
// A FAILED IMPORT NEVER TOUCHES A BACKUP IT DID NOT MAKE (fresh-box audit, finding 94).
//
// `performImport` wraps its whole pipeline in one `try`, but the safety backup of the live
// `~/.dojo` is only taken at Step 6 — AFTER the payload is read, checksummed, decrypted and
// extracted. Any failure before that step lands in the same `catch`, which (v35) could not tell
// which backup THIS run made: it took the newest `.dojo-backup-*` it found in the home folder,
// deleted the live `~/.dojo` and renamed that old backup into its place. A user who imported
// once before, then hit a pre-backup failure (disk full mid-extract, a corrupt inner zip, an
// `Unsafe path in archive` refusal, a checksum mismatch, or a wrong password when the wizard's
// preflight was skipped), would lose every change since that old backup.
//
// THE FIX: the catch restores only the backup THIS run made (`ownBackup`), and when no backup
// was made at all it deletes nothing and renames nothing — just removes the temp dir and rethrows
// the original error. These clauses pin exactly that, against the real home folder layout.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { homeDir } from '../../home.js';

// Mock everything the module imports that would touch a database, the network or a real service.
// The failure happens BEFORE Step 6, so none of these are ever called — but the module must still
// import cleanly in a throwaway home with no real services.
vi.mock('../../db/connection.js', () => ({ closeDb: vi.fn() }));
vi.mock('../../config/loader.js', () => ({ clearSecretsCache: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../checks.js', () => ({ runPostMigrationChecks: vi.fn(), setLastManifest: vi.fn() }));
vi.mock('../path-migration.js', () => ({ migratePaths: vi.fn() }));

import { performImport } from '../import.js';

// `DOJO_DIR` in the module is `path.join(homeDir(), '.dojo')` — the worker's throwaway home.
const PARENT = homeDir(); // the home folder, i.e. `path.dirname(DOJO_DIR)`
const LIVE_DIR = path.join(PARENT, '.dojo');
const OLD_BACKUP = path.join(PARENT, '.dojo-backup-1700000000000');
const ZIP_PATH = path.join(PARENT, 'import.zip');

/** The manifest shape `performImport` needs: hostname + counts + checksum. */
function baseManifest(): {
  version: number;
  exported_from: { hostname: string };
  contents: { agents_count: number; techniques_count: number };
  checksum: string;
} {
  return {
    version: 1,
    exported_from: { hostname: 'test-box' },
    contents: { agents_count: 0, techniques_count: 0 },
    checksum: 'sha256:00',
  };
}

/** Build a tiny export zip: manifest.json always, `payload.enc` only when supplied. */
function buildZip(manifest: object, payload?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 1 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    if (payload) archive.append(payload, { name: 'payload.enc' });
    archive.finalize();
  });
}

/** Live `~/.dojo` with content, plus (optionally) an older backup from a prior import. */
function setUpScenario(withOldBackup: boolean): void {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LIVE_DIR, 'live.txt'), 'live');
  if (withOldBackup) {
    fs.mkdirSync(OLD_BACKUP, { recursive: true });
    fs.writeFileSync(path.join(OLD_BACKUP, 'old.txt'), 'old');
  }
}

beforeEach(() => {
  // A clean slate: no live dojo, no backup, no leftover zip from a prior case.
  fs.rmSync(LIVE_DIR, { recursive: true, force: true });
  fs.rmSync(OLD_BACKUP, { recursive: true, force: true });
  fs.rmSync(ZIP_PATH, { force: true });
  fs.mkdirSync(LIVE_DIR, { recursive: true });
});

afterEach(() => {
  // Remove the whole home sub-tree this scenario created, and restore the empty `.dojo`
  // the worker setup hands every test.
  fs.rmSync(LIVE_DIR, { recursive: true, force: true });
  fs.rmSync(OLD_BACKUP, { recursive: true, force: true });
  fs.rmSync(ZIP_PATH, { force: true });
  fs.mkdirSync(LIVE_DIR, { recursive: true });
});

describe('a failed import never touches a backup it did not make', () => {
  it('case 1: a pre-backup failure leaves the live ~/.dojo where it is', async () => {
    setUpScenario(true);
    await buildZip(baseManifest()); // no payload.enc → throws before any backup is made

    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => {}))
      .rejects.toThrow(/no encrypted payload/);

    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
    expect(fs.existsSync(path.join(LIVE_DIR, 'old.txt'))).toBe(false);
  });

  it('case 2: the old backup folder is not renamed away', async () => {
    setUpScenario(true);
    await buildZip(baseManifest());

    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => {}))
      .rejects.toThrow(/no encrypted payload/);

    expect(fs.existsSync(path.join(OLD_BACKUP, 'old.txt'))).toBe(true);
  });

  it('case 3: with no prior backup, the failure leaves the live folder intact', async () => {
    setUpScenario(false);
    await buildZip(baseManifest());

    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => {}))
      .rejects.toThrow(/no encrypted payload/);

    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
  });

  it('case 4: wrong password — the same folder guarantees hold', async () => {
    setUpScenario(true);
    const payload = crypto.randomBytes(100);
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    await buildZip({ ...baseManifest(), checksum: `sha256:${checksum}` }, payload);

    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => {}))
      .rejects.toThrow(/Wrong password or corrupted archive/);

    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
    expect(fs.existsSync(path.join(LIVE_DIR, 'old.txt'))).toBe(false);
    expect(fs.existsSync(path.join(OLD_BACKUP, 'old.txt'))).toBe(true);
  });
});
