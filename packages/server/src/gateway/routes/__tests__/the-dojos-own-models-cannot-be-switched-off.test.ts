// The Dojo's own standard models are hard-wired: switching one off or deleting it is refused
// at the door with one plain sentence, and a mixed batch disables only the other models.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import { STANDARD_WRITER_MODEL } from '../../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
const app = new Hono().route('/config', configRouter);
const disable = (modelIds: string[]) => app.request('/config/models/disable', { method: 'POST', body: JSON.stringify({ modelIds }), headers: { 'content-type': 'application/json' } });
const enabled = (id: string) => (db().prepare('SELECT is_enabled FROM models WHERE id = ?').get(id) as { is_enabled: number }).is_enabled;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  const m = db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES (?, 'ollama-local', ?, ?, '[\"chat\"]', 262144, 0, 1)");
  m.run('writer-row', STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag);
  m.run('other-row', 'other:1b', 'other:1b');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe("the Dojo's own models cannot be switched off", () => {
  it('disabling the writer alone is refused with the plain sentence, and it stays on', async () => {
    const res = await disable(['writer-row']);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/^The Dojo itself runs on this model/);
    expect(enabled('writer-row')).toBe(1);
  });

  it('a mixed batch, as first-run setup sends, disables only the other model', async () => {
    const res = await disable(['writer-row', 'other-row']);
    expect(res.status).toBe(200);
    expect(enabled('writer-row')).toBe(1);
    expect(enabled('other-row')).toBe(0);
  });

  it('deleting the writer is refused the same way', async () => {
    const res = await app.request('/config/models/writer-row', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(db().prepare("SELECT id FROM models WHERE id = 'writer-row'").get()).toBeTruthy();
  });
});
