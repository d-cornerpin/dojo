// OR-MAC-BELONGS-TO-THE-AGENT: a supporting file named by an agent is written where it says, including
// an absolute path or one that climbs out with "..". (The export's own folder check is still tested below.)
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
import { insideTechniqueDir } from '../technique-folder.js';
import { executeUpdateTechnique } from '../tools.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-tech-files-'));
  mockDb.current = new Database(path.join(tmp, 'dojo.db'));
  runMigrations();
  fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
});
afterEach(() => {
  (mockDb.current as Database.Database).close();
  fs.rmSync(path.join(TECHNIQUES_DIR, 'escaped.txt'), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mk = (name: string, files?: Array<{ path: string; content: string }>) =>
  createTechnique({ name, displayName: name, description: 'd', instructions: '# T\nbody', files, validateReferences: false } as never);

describe('createTechnique supporting-file paths', () => {
  it('writes a path that climbs out where it says', () => {
    mk('climb-out', [{ path: '../escaped.txt', content: 'x' }]);
    expect(fs.readFileSync(path.join(TECHNIQUES_DIR, 'escaped.txt'), 'utf-8')).toBe('x');
  });

  it('writes an absolute path where it says', () => {
    const abs = path.join(tmp, 'abs-target.txt');
    mk('abs-path', [{ path: abs, content: 'x' }]);
    expect(fs.readFileSync(abs, 'utf-8')).toBe('x');
  });

  it('still writes a normal nested supporting file', () => {
    const t = mk('fine-one', [{ path: 'notes/ok.md', content: 'x' }]);
    expect(fs.readFileSync(path.join(t.directoryPath, 'notes', 'ok.md'), 'utf-8')).toBe('x');
  });
});

describe('insideTechniqueDir shapes', () => {
  it('refuses empty, dot, parent, absolute and nested-escape names', () => {
    const d = path.join(tmp, 'tech');
    fs.mkdirSync(d);
    for (const bad of ['', '.', '..', '../x', 'a/../../x', path.join(tmp, 'x'), 'a\0b']) {
      expect(insideTechniqueDir(d, bad), JSON.stringify(bad)).toBeNull();
    }
    expect(insideTechniqueDir(d, 'a/b.md')).toBe(path.join(d, 'a', 'b.md'));
  });

  it('refuses a path that goes through a link pointing outside', () => {
    const d = path.join(tmp, 'tech');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(d); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(d, 'link'));
    expect(insideTechniqueDir(d, 'link/file.txt')).toBeNull();
  });
});

describe('executeUpdateTechnique supporting-file paths', () => {
  it('writes an escaping path where it says', () => {
    const t = mk('update-me');
    const out = executeUpdateTechnique('agent-1', 'A', 'sensei', {
      name: t.id, description: 'changed', files: [{ path: '../escaped.txt', content: 'x' }],
    });
    expect(out).not.toMatch(/^Error:/);
    expect(fs.readFileSync(path.join(TECHNIQUES_DIR, 'escaped.txt'), 'utf-8')).toBe('x');
  });
});
