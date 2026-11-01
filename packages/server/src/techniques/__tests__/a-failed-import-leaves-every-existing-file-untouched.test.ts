// A failed import never deletes or damages anything it did not create (owner answer 7). Drives the REAL
// importTechnique with a stub zip (AdmZip drops ".." from real names) through both failure points.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = vi.hoisted(() => ({ current: null as unknown }));
const zipState = vi.hoisted(() => ({ names: [] as string[], withMd: true }));
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current, getDbPath: () => ':memory:', closeDb: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/message-store.js', () => ({ insertMessage: vi.fn() }));
vi.mock('adm-zip', () => {
  class FakeZip {
    getEntry(name: string) {
      return name === 'manifest.json' ? { getData: () => Buffer.from(JSON.stringify({
        format: 'dojo-technique', version: 1, exported_at: 'x', placeholders: [],
        technique: { id: 'imp-id', name: 'Demo', description: null, tags: [], version: 1, author_agent_name: null },
      })) } : null;
    }
    getEntries() {
      const e = zipState.names.map((n) => ({ isDirectory: false, entryName: n, getData: () => Buffer.from(`PKG:${n}`) }));
      if (zipState.withMd) e.push({ isDirectory: false, entryName: 'TECHNIQUE.md', getData: () => Buffer.from('# T') });
      return e;
    }
  }
  return { default: FakeZip };
});

import { runMigrations } from '../../db/migrations.js';
import { TECHNIQUES_DIR } from '../store.js';
import { importTechnique } from '../share-import.js';

let tmp: string;
const T = (n: string) => path.join(TECHNIQUES_DIR, n);
const db = () => mockDb.current as Database.Database;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-import-undo-'));
  mockDb.current = new Database(path.join(tmp, 'dojo.db'));
  runMigrations();
  fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
  zipState.names = ['../precious.bin', '../brand-new.txt'];
  zipState.withMd = true;
});
afterEach(() => {
  db().close();
  for (const n of ['precious.bin', 'brand-new.txt', 'dangling', 'locked.txt']) { try { fs.chmodSync(T(n), 0o600); } catch { /* none */ } fs.rmSync(T(n), { force: true }); }
  fs.rmSync(T('imp-id'), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ORIGINAL = Buffer.from([0, 1, 2, 250, 251, 10, 13]);
function assertUntouched(): void {
  expect(fs.readFileSync(T('precious.bin')).equals(ORIGINAL)).toBe(true);
  expect(fs.existsSync(T('brand-new.txt'))).toBe(false);
  expect(fs.existsSync(T('imp-id'))).toBe(false);
  expect((db().prepare('SELECT COUNT(*) AS n FROM techniques').get() as { n: number }).n).toBe(0);
  expect((db().prepare('SELECT COUNT(*) AS n FROM technique_versions').get() as { n: number }).n).toBe(0);
}

describe('a failed import leaves every file it did not create exactly as it was', () => {
  it('failure 1: the package has no TECHNIQUE.md', async () => {
    fs.writeFileSync(T('precious.bin'), ORIGINAL);
    zipState.withMd = false;
    await expect(importTechnique(Buffer.alloc(1))).rejects.toThrow(/TECHNIQUE.md/);
    assertUntouched();
  });

  it('failure 2: the database step fails after a full extraction', async () => {
    fs.writeFileSync(T('precious.bin'), ORIGINAL);
    db().exec("CREATE TRIGGER boom BEFORE INSERT ON techniques BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(importTechnique(Buffer.alloc(1))).rejects.toThrow(/boom/);
    assertUntouched();
  });

  it('a broken link at a destination is refused, not written through, and is still there', async () => {
    fs.writeFileSync(T('precious.bin'), ORIGINAL);
    zipState.names = ['../precious.bin', '../dangling'];
    fs.symlinkSync(path.join(tmp, 'nowhere.txt'), T('dangling'));
    await expect(importTechnique(Buffer.alloc(1))).rejects.toThrow(/not a plain file/);
    expect(fs.lstatSync(T('dangling')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'nowhere.txt'))).toBe(false);
    expect(fs.readFileSync(T('precious.bin')).equals(ORIGINAL)).toBe(true);
    expect(fs.existsSync(T('imp-id'))).toBe(false);
  });

  it('a file the server cannot read is refused and is still there', async () => {
    if (process.getuid?.() === 0) return;   // root reads everything
    zipState.names = ['../locked.txt'];
    fs.writeFileSync(T('locked.txt'), 'secret');
    fs.chmodSync(T('locked.txt'), 0o200);
    await expect(importTechnique(Buffer.alloc(1))).rejects.toThrow(/cannot be read|not a plain file/);
    fs.chmodSync(T('locked.txt'), 0o600);
    expect(fs.readFileSync(T('locked.txt'), 'utf-8')).toBe('secret');
    expect(fs.existsSync(T('imp-id'))).toBe(false);
  });
});
