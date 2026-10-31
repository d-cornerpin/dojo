// A package's technique id must never decide where files land: an id that is not a single plain name
// is refused before anything is written; a failed import removes only the folder it made.
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
  for (const bad of ['../escaped-by-id', 'a/b', '..', '.', '/abs/target', 'Has Space', 'UPPER', 5]) {
    it(`refuses ${JSON.stringify(bad)} and changes nothing`, async () => {
      const listing = before();
      const outsideBefore = fs.readdirSync(path.dirname(TECHNIQUES_DIR)).sort();
      await expect(importTechnique(pkg(bad))).rejects.toThrow(/nothing was imported|missing/);
      expect(before()).toEqual(listing);
      expect(fs.readdirSync(path.dirname(TECHNIQUES_DIR)).sort()).toEqual(outsideBefore);
    });
  }

  // The store (createTechnique) slugs any name to lowercase letters, digits and dashes of any length,
  // so a dash-first id or a long one is a real id the store has made and must import.
  for (const real of ['-starts-with-dash', '---', 'a'.repeat(255)]) {
    it(`imports an id the store can make: ${real.slice(0, 20)} (${real.length})`, async () => {
      const r = await importTechnique(pkg(real));
      expect(r.techniqueId).toBe(real);
      expect(fs.existsSync(path.join(TECHNIQUES_DIR, real, 'TECHNIQUE.md'))).toBe(true);
    });
  }

  it('refuses an id over 255 characters, with a truthful message', async () => {
    await expect(importTechnique(pkg('a'.repeat(256)))).rejects.toThrow(/lowercase letters, digits and dashes.*255/);
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
