// An imported technique must be added to the meaning-search index, like one made or edited by hand,
// so the agents can find it by asking.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsx = require('node:fs'); const osx = require('node:os'); const px = require('node:path');
  return { db: null as unknown, home: fsx.mkdtempSync(px.join(osx.tmpdir(), 'tech-import-')) as string };
});
vi.mock('../../db/connection.js', () => ({ getDb: () => env.db }));
vi.mock('../../home.js', () => ({ homeDir: () => env.home }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/message-store.js', () => ({ insertMessage: vi.fn() }));
const refreshEmbedding = vi.hoisted(() => vi.fn());
vi.mock('../../memory/embeddings.js', () => ({ refreshEmbedding }));

import { importTechnique } from '../share-import.js';

beforeEach(() => {
  fs.rmSync(path.join(env.home, '.dojo'), { recursive: true, force: true });
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE techniques (id TEXT PRIMARY KEY, name TEXT, description TEXT, state TEXT, author_agent_id TEXT,
      author_agent_name TEXT, tags TEXT, directory_path TEXT, enabled INTEGER, version INTEGER, usage_count INTEGER,
      build_project_id TEXT, build_squad_id TEXT, created_at TEXT, updated_at TEXT, published_at TEXT);
    CREATE TABLE technique_versions (id TEXT PRIMARY KEY, technique_id TEXT, version_number INTEGER, technique_md TEXT,
      changed_by TEXT, change_summary TEXT, files_snapshot TEXT, created_at TEXT);
  `);
  env.db = db;
  refreshEmbedding.mockReset();
});
afterEach(() => { (env.db as Database.Database).close(); });
afterAll(() => { fs.rmSync(env.home, { recursive: true, force: true }); });

describe('importing a technique', () => {
  it('adds it to the search index under its new id', async () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      format: 'dojo-technique', version: 1,
      technique: { id: 'demo-tech', name: 'Demo', description: 'Does a demo', tags: ['sample'], version: 1, author_agent_name: null },
      exported_at: '2026-10-30T00:00:00.000Z', placeholders: [],
    })));
    zip.addFile('TECHNIQUE.md', Buffer.from('# Demo\n\nSteps.'));
    await importTechnique(zip.toBuffer());
    expect(refreshEmbedding).toHaveBeenCalledTimes(1);
    expect(refreshEmbedding).toHaveBeenCalledWith('technique', 'demo-tech', null, expect.stringMatching(/^Demo/));
  });
});
