// Imports are exclusive: a second import while one runs is refused with a plain message and
// touches nothing; a dead holder's lock is cleared atomically (one winner, never check-then-delete).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { homeDir } from '../../home.js';

vi.mock('../../db/connection.js', () => ({ closeDb: vi.fn() }));
vi.mock('../../config/loader.js', () => ({ clearSecretsCache: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../checks.js', () => ({ runPostMigrationChecks: vi.fn(), setLastManifest: vi.fn() }));
vi.mock('../path-migration.js', () => ({ migratePaths: vi.fn() }));
vi.mock('../../services/owner-card-frames.js', () => ({ ownerCardFrame: vi.fn(), ownerCardEnded: vi.fn() }));

import { performImport } from '../import.js';
import { acquireImportLock, ImportAlreadyRunningError } from '../import-safety.js';

const PARENT = homeDir();
const LIVE_DIR = path.join(PARENT, '.dojo');
const ZIP_PATH = path.join(PARENT, 'import.zip');
const LOCK = path.join(PARENT, '.dojo-import.lock');

async function buildGoodZip(): Promise<void> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const a = archiver('zip');
    a.on('data', (c: Buffer) => chunks.push(c));
    a.on('end', () => resolve());
    a.on('error', reject);
    a.append('fake', { name: 'data/fake.txt' });
    a.finalize();
  });
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.pbkdf2Sync('pw', salt, 100000, 32, 'sha256'), iv);
  const payload = Buffer.concat([salt, iv, cipher.update(Buffer.concat(chunks)), cipher.final()]);
  const manifest = { version: 1, exported_from: { hostname: 'x' }, contents: { agents_count: 0, techniques_count: 0 }, checksum: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` };
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(ZIP_PATH);
    const a = archiver('zip');
    out.on('close', resolve);
    a.on('error', reject);
    a.pipe(out);
    a.append(JSON.stringify(manifest), { name: 'manifest.json' });
    a.append(payload, { name: 'payload.enc' });
    a.finalize();
  });
}

function cleanup(): void {
  fs.rmSync(LIVE_DIR, { recursive: true, force: true });
  fs.rmSync(ZIP_PATH, { force: true });
  for (const f of fs.readdirSync(PARENT)) {
    if (f.startsWith('.dojo-backup-') || f.startsWith('.dojo-import.lock')) fs.rmSync(path.join(PARENT, f), { recursive: true, force: true });
  }
}
beforeEach(() => { cleanup(); fs.mkdirSync(LIVE_DIR, { recursive: true }); fs.writeFileSync(path.join(LIVE_DIR, 'live.txt'), 'live'); });
afterEach(() => { cleanup(); fs.mkdirSync(LIVE_DIR, { recursive: true }); });

describe('an import runs one at a time', () => {
  it('a second import while one runs is refused, and the first one is unharmed', async () => {
    await buildGoodZip();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let stopped!: () => void;
    const inStop = new Promise<void>((r) => { stopped = r; });
    const first = performImport(ZIP_PATH, 'pw', async () => { stopped(); await gate; }, async () => {});
    await inStop;
    const secondStop = vi.fn(async () => {});
    await expect(performImport(ZIP_PATH, 'pw', secondStop, async () => {})).rejects.toThrow(/already running/);
    expect(secondStop).not.toHaveBeenCalled();
    expect(fs.readdirSync(PARENT).filter((f) => f.startsWith('.dojo-backup-'))).toHaveLength(0);
    release();
    await first;
    expect(fs.existsSync(LOCK)).toBe(false); // released
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => {})).resolves.toBeTruthy(); // free again
  });

  it('the lock is released when the import fails', async () => {
    await buildGoodZip();
    await expect(performImport(ZIP_PATH, 'pw', async () => { throw new Error('stop boom'); }, async () => {})).rejects.toThrow('stop boom');
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('a dead holder is cleared; concurrent claimers get exactly one lock', () => {
    fs.mkdirSync(LOCK);
    fs.writeFileSync(path.join(LOCK, 'pid'), '2147483646'); // no such process
    const outcomes = [0, 1, 2, 3].map(() => { try { return acquireImportLock(fs, LOCK); } catch (e) { return e; } });
    const won = outcomes.filter((o) => typeof o === 'function');
    expect(won).toHaveLength(1);
    expect(outcomes.filter((o) => o instanceof ImportAlreadyRunningError)).toHaveLength(3);
    (won[0] as () => void)();
    expect(fs.existsSync(LOCK)).toBe(false);
    expect(fs.readdirSync(PARENT).filter((f) => f.startsWith('.dojo-import.lock'))).toHaveLength(0);
  });

  it('a live holder is never cleared', () => {
    const release = acquireImportLock(fs, LOCK);
    expect(() => acquireImportLock(fs, LOCK)).toThrow(ImportAlreadyRunningError);
    release();
  });
});
