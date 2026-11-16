// The update's disk check counts the Dojo's local models the box still lacks, since its first start downloads
// them; models already installed, or a box with no local Ollama, add nothing. Only GitHub (`fetch`) and the
// volume's free space are stood in for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { checkForUpdate } from '../../gateway/routes/update.js';
import { STANDARD_DECISION_MODEL, STANDARD_PAIR_BYTES } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
const localOllama = (): void => {
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
};
const disk = async () => (await checkForUpdate('stable')).disk!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 5e9, bsize: 1 } as unknown as ReturnType<typeof fs.statfsSync>);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: 'v99.0.0', name: 'v99.0.0', assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/z', size: 1000 }],
  }), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); mockDb.current?.close(); mockDb.current = null; });

describe('the update disk check counts the models the first start downloads', () => {
  it('a box with a local Ollama and neither model needs room for both, and is short here', async () => {
    localOllama();
    expect((await disk()).modelBytes).toBe(STANDARD_PAIR_BYTES);
    expect((await disk()).ok).toBe(false);
  });

  it('a model already installed is not counted', async () => {
    localOllama();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, is_enabled) VALUES ('m1', 'ollama-local', 'decision', ?, 1)").run(STANDARD_DECISION_MODEL.tag);
    expect((await disk()).modelBytes).toBe(STANDARD_PAIR_BYTES - STANDARD_DECISION_MODEL.bytes);
  });

  it('a box with no local Ollama counts nothing', async () => {
    expect((await disk()).modelBytes).toBe(0);
    expect((await disk()).ok).toBe(true);
  });
});
