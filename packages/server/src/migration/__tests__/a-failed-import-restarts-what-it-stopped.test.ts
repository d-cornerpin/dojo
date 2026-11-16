// A failed import that already stopped services must leave a working Dojo: restore the backup
// THIS run made, then restart services (which re-opens the database). Failures before the stop
// must not restart anything; a failing restart must never replace the original error; and a
// committed import never calls it (the Dojo restarts itself onto the new data).

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
vi.mock('../../healer/owner-notices.js', () => ({
  tellOwner: (...a: unknown[]) => cardFrame(...a),
  ownerConditionCleared: (...a: unknown[]) => cardEnded(...a),
}));
const migratePaths = vi.fn();
vi.mock('../path-migration.js', () => ({ migratePaths: (...a: unknown[]) => migratePaths(...a) }));

import { performImport } from '../import.js';
import { importCardStands, bindImportCardMarker, clearImportCard } from '../import-recovery.js';
/** The words of the card the import raised last, or ''. */
const raisedWords = (): string => String(cardFrame.mock.calls.at(-1)?.[1] ?? '');
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
  clearImportCard(); cardEnded.mockReset();
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

  it('a failure after the commit (checks throw) is not rolled back', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    (runPostMigrationChecks as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('checks boom'));
    const restart = vi.fn(async () => {});
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).resolves.toBeTruthy();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(LIVE_DIR, 'live.txt'))).toBe(false); // the imported tree stays
  });

  // Final round (owner rule: the Dojo does the work). A put-back whose rename is refused is done by COPY instead, and
  // the Dojo restarts; only when both are refused does the backup stay put (and nothing restarts onto the wrong tree).
  it('the put-back rename is refused: the Dojo copies the data back, restarts, and leaves no stray backup', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    const restart = vi.fn(async () => {});
    const resumed = vi.fn();
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart, undefined, resumed)).rejects.toThrow('migrate boom');
    spy.mockRestore();
    expect(fs.readFileSync(path.join(LIVE_DIR, 'live.txt'), 'utf-8')).toBe('live');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(resumed, 'the agents it stopped are brought back').toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(PARENT).filter((f) => f.startsWith('.dojo-backup-'))).toEqual([]);
    expect(importCardStands()).toBe(false);
  });

  it('rename and copy both refused: nothing is restarted, the backup stays put, the error names its exact path', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    const cp = vi.spyOn(fs, 'cpSync').mockImplementation((() => { throw new Error('copy denied'); }) as typeof fs.cpSync);
    const restart = vi.fn(async () => {});
    const resumed = vi.fn();
    let caught: Error | null = null;
    try { await performImport(ZIP_PATH, 'pw', async () => {}, restart, undefined, resumed); } catch (e) { caught = e as Error; } finally { spy.mockRestore(); cp.mockRestore(); }
    expect(caught?.message).toContain('migrate boom');
    const backup = fs.readdirSync(PARENT).find((f) => f.startsWith('.dojo-backup-'))!;
    expect(backup).toBeTruthy();
    expect(caught?.message).toContain(path.join(PARENT, backup));
    expect(fs.readFileSync(path.join(PARENT, backup, 'live.txt'), 'utf-8')).toBe('live');
    expect(restart).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
    expect(fs.existsSync(LIVE_DIR)).toBe(true); // ~/.dojo never vanishes
  });

  it('the cards state the fact only: no move, no restart, no menu bar', async () => {
    const { backupStuckWords } = await import('../import-recovery.js');
    const restartWords = await (async () => {
      await buildZip(...(await encryptPayloadForTest('pw')));
      migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
      try { await performImport(ZIP_PATH, 'pw', async () => {}, async () => { throw new Error('restart boom'); }); } catch { /* expected */ }
      return raisedWords();
    })();
    for (const words of [backupStuckWords('/tmp/example-backup'), restartWords]) {
      expect(words.length).toBeGreaterThan(0);
      expect(words).not.toMatch(/\bmove\b|\brestart Dojo\b|menu bar|\bthen\b/i);
      expect(words).not.toContain('\u2014');
    }
  });

  it('a restart that fails raises an owner card, which stands and is named in the error', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const restart = vi.fn(async () => { throw new Error('restart boom'); });
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, restart)).rejects.toThrow(/migrate boom.*could not start its services again/);
    expect(cardFrame).toHaveBeenCalledWith('import-failed-not-running', expect.stringContaining('could not start its services again'));
    expect(importCardStands()).toBe(true);
  });

  it('a put-back that fails raises an owner card naming the backup path', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    const cp = vi.spyOn(fs, 'cpSync').mockImplementation((() => { throw new Error('copy denied'); }) as typeof fs.cpSync);
    try { await performImport(ZIP_PATH, 'pw', async () => {}, async () => {}); } catch { /* expected */ } finally { spy.mockRestore(); cp.mockRestore(); }
    const backup = fs.readdirSync(PARENT).find((f) => f.startsWith('.dojo-backup-'))!;
    expect(cardFrame).toHaveBeenCalledWith('import-failed-not-running', expect.stringContaining(path.join(PARENT, backup)));
    expect(importCardStands()).toBe(true);
  });

  it('a later good import ends the card', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    await expect(performImport(ZIP_PATH, 'pw', async () => {}, async () => { throw new Error('x'); })).rejects.toThrow();
    expect(importCardStands()).toBe(true);
    migratePaths.mockReset();
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    await performImport(ZIP_PATH, 'pw', async () => {}, async () => {});
    expect(importCardStands()).toBe(false);
    expect(cardEnded).toHaveBeenCalledWith('import-failed-not-running');
  });

  it('the stuck-backup card survives a restart (marker beside ~/.dojo): binding the marker raises it again', async () => {
    await buildZip(...(await encryptPayloadForTest('pw')));
    migratePaths.mockImplementation(() => { throw new Error('migrate boom'); });
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === LIVE_DIR && String(from).includes('.dojo-backup-')) throw new Error('rename denied');
      return real(from, to);
    }) as typeof fs.renameSync);
    const cp = vi.spyOn(fs, 'cpSync').mockImplementation((() => { throw new Error('copy denied'); }) as typeof fs.cpSync);
    try { await performImport(ZIP_PATH, 'pw', async () => {}, async () => {}); } catch { /* expected */ } finally { spy.mockRestore(); cp.mockRestore(); }
    expect(fs.existsSync(MARKER)).toBe(true);
    const backup = fs.readdirSync(PARENT).find((f) => f.startsWith('.dojo-backup-'))!;
    // a restart forgets memory: a fresh module, bound to the marker, raises the card again in this database
    vi.resetModules();
    const fresh = await import('../import-recovery.js');
    cardFrame.mockReset();
    fresh.bindImportCardMarker(fs, MARKER);
    expect(cardFrame).toHaveBeenCalledWith('import-failed-not-running', expect.stringContaining(path.join(PARENT, backup)));
    expect(fresh.importCardStands()).toBe(true);
  });

  it('a marker whose backup is gone shows nothing and is removed', () => {
    fs.writeFileSync(MARKER, JSON.stringify({ words: 'x', backupPath: path.join(PARENT, '.dojo-backup-gone') }));
    expect(importCardStands()).toBe(false);
    expect(fs.existsSync(MARKER)).toBe(false);
  });
});
