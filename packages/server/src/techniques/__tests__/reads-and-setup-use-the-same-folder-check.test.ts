// The agent-facing technique file read and the imported-technique placeholder setup use the same
// "inside this folder" check as the writes: nothing outside the technique folder is read or rewritten,
// including through a link.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => mockDb.current,
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({ refreshEmbedding: vi.fn() }));
vi.mock('../../agent/effects/fs.js', async () => {
  const realFs = await import('node:fs');
  return { ...realFs };
});
vi.mock('../../agent/access/read.js', () => ({ mayUseTechnique: vi.fn(() => true) }));

import { runMigrations } from '../../db/migrations.js';
import { createTechnique, TECHNIQUES_DIR } from '../store.js';
import { executeTechniqueRead } from '../tools.js';
import { applyPlaceholderToTechnique, findRemainingPlaceholders } from '../import-setup.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-tech-reads-'));
  mockDb.current = new Database(path.join(tmp, 'dojo.db'));
  runMigrations();
  fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
});
afterEach(() => {
  (mockDb.current as Database.Database).close();
  fs.rmSync(path.join(TECHNIQUES_DIR, 'outside-setup-one.txt'), { force: true });
  fs.rmSync(path.join(TECHNIQUES_DIR, 'o2-setup-two.txt'), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mk = (name: string) => {
  const t = createTechnique({ name, displayName: name, description: 'd', instructions: '# T\nbody', validateReferences: false } as never);
  (mockDb.current as Database.Database).prepare("UPDATE techniques SET state = 'published' WHERE id = ?").run(t.id);
  return t;
};
const read = (id: string, file: string) => executeTechniqueRead('agent-1', 'A', 'sensei', { name: id, action: 'read_file', file });

describe('read_file stays inside the technique folder', () => {
  it('refuses a link that points at a file outside, and still reads a real file', () => {
    const t = mk('reader-one');
    const secret = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET-VALUE');
    fs.symlinkSync(secret, path.join(t.directoryPath, 'peek.txt'));
    fs.writeFileSync(path.join(t.directoryPath, 'ok.txt'), 'plain');
    const refused = read(t.id, 'peek.txt');
    expect(refused).toMatch(/Error/);
    expect(refused).not.toContain('TOP-SECRET-VALUE');
    expect(read(t.id, 'ok.txt')).toContain('plain');
  });
  it('refuses climbing out and absolute names', () => {
    const t = mk('reader-two');
    expect(read(t.id, '../outside.txt')).toMatch(/Error: file must be a relative path that stays inside/);
    expect(read(t.id, path.join(tmp, 'x'))).toMatch(/stays inside/);
  });
});

describe('placeholder setup stays inside the technique folder', () => {
  it('does not read or rewrite a file the package named outside the folder', () => {
    const t = mk('setup-one');
    const outside = path.join(TECHNIQUES_DIR, 'outside-setup-one.txt'); // the folder's sibling: '../outside-setup-one.txt'
    fs.writeFileSync(outside, 'key={{NEEDS_FROM_USER:KEY}}');
    fs.symlinkSync(outside, path.join(t.directoryPath, 'via-link.txt'));
    fs.writeFileSync(path.join(t.directoryPath, 'inside.txt'), 'key={{NEEDS_FROM_USER:KEY}}');
    fs.writeFileSync(path.join(t.directoryPath, 'IMPORT_MANIFEST.json'), JSON.stringify({
      placeholders: [{ label: 'KEY', hint: 'h', files: ['../outside-setup-one.txt', 'via-link.txt', 'inside.txt'] }],
    }));
    expect(findRemainingPlaceholders(t.directoryPath)).toEqual(['KEY']);
    expect(applyPlaceholderToTechnique(t.directoryPath, 'KEY', 'abc')).toBe(1);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('key={{NEEDS_FROM_USER:KEY}}');
    expect(fs.readFileSync(path.join(t.directoryPath, 'inside.txt'), 'utf-8')).toBe('key=abc');
  });
  it('a package that names only outside files leaves the placeholder unfilled', () => {
    const t = mk('setup-two');
    const outside = path.join(TECHNIQUES_DIR, 'o2-setup-two.txt');
    fs.writeFileSync(outside, '{{NEEDS_FROM_USER:K}}');
    fs.writeFileSync(path.join(t.directoryPath, 'IMPORT_MANIFEST.json'), JSON.stringify({
      placeholders: [{ label: 'K', hint: 'h', files: ['../o2-setup-two.txt'] }],
    }));
    expect(findRemainingPlaceholders(t.directoryPath)).toEqual([]);
    expect(applyPlaceholderToTechnique(t.directoryPath, 'K', 'v')).toBe(0);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('{{NEEDS_FROM_USER:K}}');
  });
});
