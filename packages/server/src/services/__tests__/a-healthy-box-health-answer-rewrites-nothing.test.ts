// A box whose Ollama lists both standard models and the decision window tag, with both rows registered: its health answers
// run no upkeep, so they never rewrite the system tier or re-register the writer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../local-standard.js';
import { upkeep, upkeepSettled } from '../ollama-upkeep.js';
import { checkOllamaHealth } from '../ollama.js';
import '../decision-window.js';

const LISTED = ['nomic-embed-text:latest', STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.windowTag, STANDARD_WRITER_MODEL.tag];
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/tags') return Response.json({ models: LISTED.map((name) => ({ name, size: 1 })) });
    if (path === '/api/show') return Response.json({ parameters: 'num_ctx 8192', model_info: {} });
    return new Response('nf', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a healthy box', () => {
  it('its health answers rewrite neither the system tier nor the writer row', async () => {
    await upkeep('boot');
    const tier = (): unknown => mockDb.current!.prepare("SELECT rowid, model_id FROM router_tier_models WHERE tier_id = 'system'").all();
    const writer = (): unknown => mockDb.current!.prepare('SELECT updated_at, capabilities FROM models WHERE api_model_id = ?').get(STANDARD_WRITER_MODEL.tag);
    const before = [tier(), writer()];
    expect((before[0] as unknown[]).length).toBe(1);
    mockDb.current!.prepare("UPDATE models SET updated_at = 'unchanged' WHERE api_model_id = ?").run(STANDARD_WRITER_MODEL.tag);
    for (let i = 0; i < 3; i++) await checkOllamaHealth('http://localhost:11434');
    await upkeepSettled();
    expect(tier()).toEqual(before[0]);
    expect((writer() as { updated_at: string }).updated_at).toBe('unchanged');
  });
});
