// OR-MAC-BELONGS-TO-THE-AGENT: a package's technique id is not refused for its shape. One rule stays:
// a failed import never deletes anything it did not create itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';

const mockDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => mockDb.current,
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/message-store.js', () => ({ insertMessage: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { TECHNIQUES_DIR } from '../store.js';
import { importTechnique } from '../share-import.js';
import { extractPackageEntries, undoExtraction, type ExtractedWrite } from '../share-disk.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-import-id-'));
  mockDb.current = new Database(path.join(tmp, 'dojo.db'));
  runMigrations();
  fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
});
afterEach(() => {
  (mockDb.current as Database.Database).close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pkg(id: unknown, withMd = true, name: unknown = 'Demo'): Buffer {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify({
    format: 'dojo-technique', version: 1, exported_at: 'x', placeholders: [],
    technique: { id, name, description: null, tags: [], version: 1, author_agent_name: null },
  })));
  if (withMd) z.addFile('TECHNIQUE.md', Buffer.from('# Demo\nbody'));
  return z.toBuffer();
}
const before = () => fs.readdirSync(TECHNIQUES_DIR).sort();

describe('importing a package whose id is not a plain name', () => {
  it('imports an id with a slash as a nested folder', async () => {
    const r = await importTechnique(pkg('a/b'));
    expect(r.techniqueId).toBe('a/b');
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'a', 'b', 'TECHNIQUE.md'))).toBe(true);
  });

  it('imports an id with capitals and a space', async () => {
    await importTechnique(pkg('Has Space'));
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'Has Space', 'TECHNIQUE.md'))).toBe(true);
  });

  it('an id that names a folder that already exists is refused and that folder is left untouched', async () => {
    const outside = path.join(path.dirname(TECHNIQUES_DIR), 'precious');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    await expect(importTechnique(pkg('../precious'))).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8')).toBe('keep');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('an id of ".." (the techniques folder parent) is refused and nothing is deleted', async () => {
    const listing = fs.readdirSync(path.dirname(TECHNIQUES_DIR)).sort();
    await expect(importTechnique(pkg('..'))).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(TECHNIQUES_DIR)).sort()).toEqual(listing);
    expect(fs.existsSync(TECHNIQUES_DIR)).toBe(true);
  });

  it('extracts a package entry where the package says, even outside the technique folder', () => {
    const dir = path.join(TECHNIQUES_DIR, 'extract-out');
    fs.mkdirSync(dir, { recursive: true });
    const zip = { getEntries: () => [
      { isDirectory: false, entryName: 'TECHNIQUE.md', getData: () => Buffer.from('# T') },
      { isDirectory: false, entryName: '../landed-by-package.txt', getData: () => Buffer.from('hi') },
    ] };
    extractPackageEntries(zip as never, dir);
    expect(fs.readFileSync(path.join(TECHNIQUES_DIR, 'landed-by-package.txt'), 'utf-8')).toBe('hi');
  });

  it('a failed import puts back a file it overwrote outside its folder, byte for byte, and removes files it newly made', async () => {
    const outside = path.join(TECHNIQUES_DIR, 'precious-outside.bin');
    const original = Buffer.from([0, 1, 2, 250, 251, 10, 13]);
    fs.writeFileSync(outside, original);
    // AdmZip drops '..' from names, so the extractor is driven with a stub zip.
    const dir = path.join(TECHNIQUES_DIR, 'fails-after-writing');
    const entries = [
      { isDirectory: false, entryName: '../precious-outside.bin', getData: () => Buffer.from('OVERWRITTEN') },
      { isDirectory: false, entryName: '../brand-new-outside.txt', getData: () => Buffer.from('fresh') },
    ];
    const journal: ExtractedWrite[] = [];
    fs.mkdirSync(dir);
    extractPackageEntries({ getEntries: () => entries } as never, dir, journal);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('OVERWRITTEN');
    undoExtraction(journal);
    expect(fs.readFileSync(outside).equals(original)).toBe(true);
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'brand-new-outside.txt'))).toBe(false);
    fs.rmSync(outside, { force: true });
  });

  it('still imports a plain id', async () => {
    const r = await importTechnique(pkg('plain-one'));
    expect(r.techniqueId).toBe('plain-one');
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'plain-one', 'TECHNIQUE.md'))).toBe(true);
  });

  it('removes the folder it made when the package has no instructions, and only that one', async () => {
    fs.mkdirSync(path.join(TECHNIQUES_DIR, 'someone-elses'));
    await expect(importTechnique(pkg('half-made', false))).rejects.toThrow(/TECHNIQUE.md/);
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'half-made'))).toBe(false);
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'someone-elses'))).toBe(true);
  });

  it('removes the folder it made when a later step fails', async () => {
    await expect(importTechnique(pkg('bad-name', true, { not: 'text' }))).rejects.toThrow();
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'bad-name'))).toBe(false);
  });
});
