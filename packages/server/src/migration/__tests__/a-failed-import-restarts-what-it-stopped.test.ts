// A failed import that already stopped services must leave a working Dojo: restore the backup
// THIS run made, then restart services (which re-opens the database). Failures before the stop
// must not restart anything; a failing restart must never replace the original error; and a
// restart that already ran on the success path must never run a second time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { homeDir } from '../../home.js';

const closeDb = vi.fn();
vi.mock('../../db/connection.js', () => ({ closeDb: (...a: unknown[]) => closeDb(...a) }));
vi.mock('../../config/loader.js', () => ({ clearSecretsCache: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../checks.js', () => ({ runPostMigrationChecks: vi.fn(), setLastManifest: vi.fn() }));
const migratePaths = vi.fn();
vi.mock('../path-migration.js', () => ({ migratePaths: (...a: unknown[]) => migratePaths(...a) }));

import { performImport } from '../import.js';

const PARENT = homeDir();
const LIVE_DIR = path.join(PARENT, '.dojo');
const ZIP_PATH = path.join(PARENT, 'import.zip');

/** A valid encrypted export (fake data): inner zip with one file, AES-256-CBC like the exporter. */
async function encryptPayloadForTest(password: string): Promise<[object, Buffer]> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('end', () => resolve());
    archive.on('error', reject);
    archive.append('fake', { name: 'data/fake.txt' });
    archive.finalize();
  });
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const payload = Buffer.concat([salt, iv, cipher.update(Buffer.concat(chunks)), cipher.final()]);
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  return [
    { version: 1, exported_from: { hostname: 'x' }, contents: { agents_count: 0, techniques_count: 0 }, checksum: `sha256:${checksum}` },
    payload,
  ];
}

function cleanup(): void {
  fs.rmSync(LIVE_DIR, { recursive: true, force: true });
  fs.rmSync(ZIP_PATH, { force: true });
  for (const f of fs.readdirSync(PARENT)) {
    if (f.startsWith('.dojo-backup-')) fs.rmSync(path.join(PARENT, f), { recursive: true, force: true });
  }
}

function buildZip(manifest: object, payload?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 1 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
    if (payload) archive.append(payload, { name: 'payload.enc' });
    archive.finalize();
  });
}

beforeEach(() => {
  cleanup();
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LIVE_DIR, 'live.txt'), 'live');
  closeDb.mockReset();
  migratePaths.mockReset();
});
afterEach(() => {
  cleanup();
  fs.mkdirSync(LIVE_DIR, { recursive: true });
});

describe('a failed import restarts what it stopped', () => {
  it('failure before services are stopped: nothing is restarted', async () => {
    const payload = crypto.randomBytes(100);
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    await buildZip({ version: 1, exported_from: { hostname: 'x' }, contents: {}, checksum: `sha256:${checksum}` }, payload);
    const stop = vi.fn(async () => {});
    const restart = vi.fn(async () => {});
    await expect(performImport(ZIP_PATH, 'pw', stop, restart)).rejects.toThrow(/Wrong password/);
    expect(stop).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('failure after stop, before the backup: restarted once, original error rejects', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    const stop = vi.fn(async () => {});
    const restart = vi.fn(async () => {});
    closeDb.mockImplementation(() => { throw new Error('close boom'); });
    await expect(performImport(ZIP_PATH, 'pw', stop, restart)).rejects.toThrow('close boom');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
  });

  it('failure after the backup: live data restored, restarted once, original error rejects', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    const stop = vi.fn(async () => {});
    const restart = vi.fn(async () => {});
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    await expect(performImport(ZIP_PATH, 'pw', stop, restart)).rejects.toThrow('migrate boom');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
  });

  it('the restart itself failing never replaces the original error', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    const restart = vi.fn(async () => { throw new Error('restart boom'); });
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).rejects.toThrow('migrate boom');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('the success-path restart throws: handle closed before the swap, old tree back, restarted again', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    const order: string[] = [];
    closeDb.mockImplementation(() => { order.push('close'); });
    const restart = vi.fn(async () => {
      order.push('restart');
      if (restart.mock.calls.length === 1) throw new Error('restart boom');
    });
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).rejects.toThrow('restart boom');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['close', 'restart', 'close', 'restart']);
    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
  });

  it('a failure AFTER a good restart (checks throw) is not rolled back', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    const { runPostMigrationChecks } = await import('../checks.js');
    (runPostMigrationChecks as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('checks boom'));
    const restart = vi.fn(async () => {});
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).resolves.toBeTruthy();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(LIVE_DIR, 'live.txt'))).toBe(false); // the imported tree stays
  });
});
