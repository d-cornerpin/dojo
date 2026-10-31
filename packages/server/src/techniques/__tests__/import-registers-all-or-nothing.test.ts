// An import either leaves no trace (no folder, no row) or is finished and never undone: the two
// database rows go in together, and a notification problem after that cannot delete the technique.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';

const mockDb = vi.hoisted(() => ({ current: null as unknown }));
const bc = vi.hoisted(() => ({ fail: false }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => mockDb.current,
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: vi.fn(() => { if (bc.fail) throw new Error('socket gone'); }),
}));
vi.mock('../../memory/message-store.js', () => ({ insertMessage: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { TECHNIQUES_DIR } from '../store.js';
import { importTechnique } from '../share-import.js';

let tmp: string;
beforeEach(() => {
  bc.fail = false;
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-import-tx-'));
  mockDb.current = new Database(path.join(tmp, 'dojo.db'));
  runMigrations();
  fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
});
afterEach(() => {
  (mockDb.current as Database.Database).close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pkg(id: string): Buffer {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify({
    format: 'dojo-technique', version: 1, exported_at: 'x', placeholders: [],
    technique: { id, name: 'Demo', description: null, tags: [], version: 1, author_agent_name: null },
  })));
  z.addFile('TECHNIQUE.md', Buffer.from('# Demo\nbody'));
  return z.toBuffer();
}
const db = () => mockDb.current as Database.Database;
const rows = (id: string) => ({
  t: db().prepare('SELECT COUNT(*) AS n FROM techniques WHERE id = ?').get(id) as { n: number },
  v: db().prepare('SELECT COUNT(*) AS n FROM technique_versions WHERE technique_id = ?').get(id) as { n: number },
});

describe('importing a technique is all or nothing', () => {
  it('a failed second insert leaves no row and no folder', async () => {
    db().exec(`CREATE TRIGGER refuse_version BEFORE INSERT ON technique_versions BEGIN SELECT RAISE(ABORT, 'no room'); END;`);
    await expect(importTechnique(pkg('half-done'))).rejects.toThrow(/no room/);
    expect(rows('half-done').t.n).toBe(0);
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'half-done'))).toBe(false);
  });

  it('a broadcast failure after registration keeps the folder and the rows', async () => {
    bc.fail = true;
    const r = await importTechnique(pkg('stays-put'));
    expect(r.techniqueId).toBe('stays-put');
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'stays-put', 'TECHNIQUE.md'))).toBe(true);
    const n = rows('stays-put');
    expect(n.t.n).toBe(1);
    expect(n.v.n).toBe(1);
  });
});
