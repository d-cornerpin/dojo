// OR-MAC-BELONGS-TO-THE-AGENT: the agent-facing technique file read and the imported-technique placeholder
// setup are not limited to the technique folder.
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

describe('read_file is not limited to the technique folder', () => {
  it('reads a link, a climbing name and an absolute name', () => {
    const t = mk('reader-one');
    const outsideFile = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(outsideFile, 'OUTSIDE-VALUE');
    fs.symlinkSync(outsideFile, path.join(t.directoryPath, 'peek.txt'));
    fs.writeFileSync(path.join(t.directoryPath, 'ok.txt'), 'plain');
    expect(read(t.id, 'peek.txt')).toContain('OUTSIDE-VALUE');
    expect(read(t.id, 'ok.txt')).toContain('plain');
    expect(read(t.id, outsideFile)).toContain('OUTSIDE-VALUE');
    fs.writeFileSync(path.join(TECHNIQUES_DIR, 'sibling.txt'), 'SIBLING');
    expect(read(t.id, '../sibling.txt')).toContain('SIBLING');
  });
});

describe('placeholder setup is not limited to the technique folder', () => {
  it('fills a placeholder in a file the package named outside the folder', () => {
    const t = mk('setup-one');
    const outside = path.join(TECHNIQUES_DIR, 'outside-setup-one.txt');
    fs.writeFileSync(outside, 'key={{NEEDS_FROM_USER:KEY}}');
    fs.writeFileSync(path.join(t.directoryPath, 'inside.txt'), 'key={{NEEDS_FROM_USER:KEY}}');
    fs.writeFileSync(path.join(t.directoryPath, 'IMPORT_MANIFEST.json'), JSON.stringify({
      placeholders: [{ label: 'KEY', hint: 'h', files: ['../outside-setup-one.txt', 'inside.txt'] }],
    }));
    expect(findRemainingPlaceholders(t.directoryPath)).toEqual(['KEY']);
    expect(applyPlaceholderToTechnique(t.directoryPath, 'KEY', 'abc')).toBe(2);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('key=abc');
    expect(fs.readFileSync(path.join(t.directoryPath, 'inside.txt'), 'utf-8')).toBe('key=abc');
  });
});
