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
const cardFrame = vi.fn();
const cardEnded = vi.fn();
vi.mock('../../services/owner-card-frames.js', () => ({
  ownerCardFrame: (...a: unknown[]) => cardFrame(...a),
  ownerCardEnded: (...a: unknown[]) => cardEnded(...a),
}));
const migratePaths = vi.fn();
vi.mock('../path-migration.js', () => ({ migratePaths: (...a: unknown[]) => migratePaths(...a) }));

import { performImport } from '../import.js';
import { importOwnerCards, bindImportCardMarker } from '../import-recovery.js';
import { runPostMigrationChecks } from '../checks.js';

const PARENT = homeDir();
const LIVE_DIR = path.join(PARENT, '.dojo');
const MARKER = path.join(PARENT, '.dojo-import-stuck.json');
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
  fs.rmSync(MARKER, { force: true });
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
  bindImportCardMarker(fs, MARKER);
  cleanup();
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LIVE_DIR, 'live.txt'), 'live');
  closeDb.mockReset();
  migratePaths.mockReset();
  cardFrame.mockReset();
  cardEnded.mockReset();
  for (const c of importOwnerCards()) c.dismiss();
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
    (runPostMigrationChecks as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('checks boom'));
    const restart = vi.fn(async () => {});
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).resolves.toBeTruthy();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(LIVE_DIR, 'live.txt'))).toBe(false); // the imported tree stays
  });

  it('the put-back fails: nothing is restarted, the backup stays put, the error names its exact path', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    const restart = vi.fn(async () => {});
    let caught: Error | null = null;
    try { await performImport(ZIP_PATH, 'pw', async () => {}, restart); } catch (e) { caught = e as Error; } finally { spy.mockRestore(); }
    expect(caught?.message).toContain('migrate boom');
    const backup = fs.readdirSync(PARENT).find((f) => f.startsWith('.dojo-backup-'))!;
    expect(backup).toBeTruthy();
    expect(caught?.message).toContain(path.join(PARENT, backup));
    expect(fs.readFileSync(path.join(PARENT, backup, 'live.txt'), 'utf-8')).toBe('live');
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(LIVE_DIR)).toBe(true); // ~/.dojo never vanishes
  });

  it('a restart that fails raises an owner card, which stands and is named in the error', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const restart = vi.fn(async () => { throw new Error('restart boom'); });
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).rejects.toThrow(/migrate boom.*could not restart itself/);
    expect(cardFrame).toHaveBeenCalledWith(expect.stringContaining('could not restart itself'), 'error', 'import-failed-not-running', 'action');
    expect(importOwnerCards()).toHaveLength(1);
  });

  it('a put-back that fails raises an owner card naming the backup path', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    try { await performImport(ZIP_PATH, 'pw', async () => {}, async () => {}); } catch { /* expected */ } finally { spy.mockRestore(); }
    const backup = fs.readdirSync(PARENT).find((f) => f.startsWith('.dojo-backup-'))!;
    expect(cardFrame).toHaveBeenCalledWith(expect.stringContaining(path.join(PARENT, backup)), 'error', 'import-failed-not-running', 'action');
    expect(importOwnerCards()[0].words).toContain(path.join(PARENT, backup));
  });

  it('a later good import ends the card', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => { throw new Error('x'); })).rejects.toThrow();
    expect(importOwnerCards()).toHaveLength(1);
    migratePaths.mockReset();
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    await performImport(ZIP_PATH, 'pw', async () => {}, async () => {});
    expect(importOwnerCards()).toHaveLength(0);
    expect(cardEnded).toHaveBeenCalled();
  });

  it('the stuck-backup card survives a restart (marker beside ~/.dojo) until dismissed', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    try { await performImport(ZIP_PATH, 'pw', async () => {}, async () => {}); } catch { /* expected */ } finally { spy.mockRestore(); }
    expect(fs.existsSync(MARKER)).toBe(true);
    const backup = fs.readdirSync(PARENT).find((f) => f.startsWith('.dojo-backup-'))!;
    // a restart forgets memory: ask the card source with a cleared memory by dismissing only the live copy
    vi.resetModules();
    const fresh = await import('../import-recovery.js');
    fresh.bindImportCardMarker(fs, MARKER);
    const cards = fresh.importOwnerCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].words).toContain(path.join(PARENT, backup));
    cards[0].dismiss();
    expect(fs.existsSync(MARKER)).toBe(false);
    expect(fresh.importOwnerCards()).toHaveLength(0);
  });

  it('a marker whose backup is gone shows nothing and is removed', () => {
    fs.writeFileSync(MARKER, JSON.stringify({ words: 'x', backupPath: path.join(PARENT, '.dojo-backup-gone') }));
    expect(importOwnerCards()).toHaveLength(0);
    expect(fs.existsSync(MARKER)).toBe(false);
  });
});
