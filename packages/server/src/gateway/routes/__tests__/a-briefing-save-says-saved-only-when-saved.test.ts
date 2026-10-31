// The dashboard briefing Save answers "updated" only when the briefing was saved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
  getEmbeddingStatus: () => ({}),
  setEmbeddingConfig: () => undefined,
}));

import { runMigrations } from '../../../db/migrations.js';
import { memoryRouter } from '../memory.js';

const AGENT = 'agent-briefing-save';
const MODEL = 'model-briefing-save';
const db = (): Database.Database => mockDb.current!;

function put(agentId: string, body: unknown): Promise<Response> {
  return memoryRouter.request(`/${agentId}/briefing`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as Promise<Response>;
}
const rows = (agentId: string) =>
  db().prepare('SELECT content, manual_edits FROM briefings WHERE agent_id = ?').all(agentId) as Array<{ content: string; manual_edits: string | null }>;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-b', 'P', 'openai-compatible', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
                VALUES (?, 'p-b', 'M', 'm', '["text"]', 32000, 4096, 1)`).run(MODEL);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Desk', ?, 'idle', '{}')").run(AGENT, MODEL);
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('PUT /:agentId/briefing', () => {
  it('saves a first briefing for an agent that has none', async () => {
    const res = await put(AGENT, { content: 'first briefing' });
    expect(res.status).toBe(200);
    expect(rows(AGENT).map((r) => r.content)).toEqual(['first briefing']);
  });

  it('replaces the content on a second save and marks it hand-edited', async () => {
    await put(AGENT, { content: 'first briefing' });
    const res = await put(AGENT, { content: 'second briefing' });
    expect(res.status).toBe(200);
    const r = rows(AGENT);
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe('second briefing');
    expect(r[0].manual_edits).not.toBeNull();
  });

  it('refuses an agent id that does not exist and writes nothing', async () => {
    const res = await put('agent-not-there', { content: 'nobody home' });
    expect(res.status).toBe(404);
    expect(rows('agent-not-there')).toHaveLength(0);
  });

  it('refuses empty content', async () => {
    const res = await put(AGENT, { content: '' });
    expect(res.status).toBe(400);
  });
});
