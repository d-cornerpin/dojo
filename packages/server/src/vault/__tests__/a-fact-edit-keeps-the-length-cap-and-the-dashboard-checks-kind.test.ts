// Editing a saved fact keeps the length cap new facts get, and the dashboard checks kind and confidence.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
// A different vector per call, so the duplicate check never merges two test facts.
vi.mock('../../memory/embeddings.js', () => {
  let n = 0;
  return {
    generateEmbedding: async () => { const v = new Float32Array(8); v[n++ % 8] = 1; return v; },
    queueEmbedding: () => undefined,
    storeEmbedding: async () => undefined,
    refreshEmbedding: () => undefined,
    getEmbeddingStatus: () => ({}),
    setEmbeddingConfig: () => undefined,
  };
});

import { runMigrations } from '../../db/migrations.js';
import { vaultRouter } from '../../gateway/routes/vault.js';
import { createEntry, getEntry } from '../store.js';
import { executeVaultUpdate } from '../tools.js';

const SUFFIX = '[Truncated -- consider creating a technique for longer procedures]';
const db = (): Database.Database => mockDb.current!;

function call(method: string, path: string, body: unknown): Promise<Response> {
  return vaultRouter.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as Promise<Response>;
}
async function seed(content = 'the blue binder holds the spare key'): Promise<string> {
  const e = await createEntry({ agentId: 'manual', agentName: 'Dashboard', type: 'fact', content, tags: [], isPinned: false, isPermanent: false, source: 'manual' });
  return e.id;
}
const count = (): number => (db().prepare('SELECT COUNT(*) AS n FROM vault_entries').get() as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a fact edit keeps the length cap', () => {
  it('the agent tool cuts a long edit', async () => {
    const id = await seed();
    await executeVaultUpdate('manual', { entry_id: id, new_content: 'x'.repeat(10_000), reason: 'test' });
    const stored = getEntry(id)!.content;
    expect(stored.endsWith(SUFFIX)).toBe(true);
    expect(stored.length - SUFFIX.length - 1).toBeLessThanOrEqual(2000);
  });

  it('the agent tool still cuts a long edit, and says so plainly', async () => {
    const id = await seed();
    const out = await executeVaultUpdate('manual', { entry_id: id, new_content: 'x'.repeat(10_000), reason: 'test' });
    expect(out, 'a cut the agent was not told about is a silent loss').toMatch(/cut|shortened|truncated/i);
    expect(out).toMatch(/500/);
  });

  it('the dashboard edit door refuses a long edit plainly and changes nothing (owner data is never cut)', async () => {
    const id = await seed();
    const before = getEntry(id)!.content;
    const res = await call('PUT', `/entries/${id}`, { content: 'y'.repeat(10_000) });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toMatch(/too long/i);
    expect(body.error).toMatch(/nothing was (saved|changed)/i);
    expect(getEntry(id)!.content).toBe(before);
  });

  it('the dashboard create door refuses a long memory plainly and saves nothing', async () => {
    const res = await call('POST', '/entries', { content: 'z'.repeat(10_000), type: 'fact' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too long/i);
    expect(count()).toBe(0);
  });

  it('text under the cap is stored unchanged', async () => {
    const id = await seed();
    await call('PUT', `/entries/${id}`, { content: 'a short new fact' });
    expect(getEntry(id)!.content).toBe('a short new fact');
  });
});

describe('the dashboard checks kind and confidence', () => {
  it('refuses an unknown kind and saves nothing', async () => {
    const res = await call('POST', '/entries', { content: 'a fact', type: 'banana' });
    expect(res.status).toBe(400);
    expect(count()).toBe(0);
  });

  it.each(['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'])('accepts kind %s', async (type) => {
    const res = await call('POST', '/entries', { content: `a ${type} that is its own sentence`, type });
    expect(res.status).toBe(200);
  });

  it.each([7, -1, 'high'])('refuses confidence %s and leaves the row alone', async (confidence) => {
    const id = await seed();
    const before = getEntry(id)!.confidence;
    const res = await call('PUT', `/entries/${id}`, { confidence });
    expect(res.status).toBe(400);
    expect(getEntry(id)!.confidence).toBe(before);
  });

  it('accepts confidence 0.5', async () => {
    const id = await seed();
    const res = await call('PUT', `/entries/${id}`, { confidence: 0.5 });
    expect(res.status).toBe(200);
    expect(getEntry(id)!.confidence).toBe(0.5);
  });

  it('refuses empty content on an edit', async () => {
    const id = await seed();
    const res = await call('PUT', `/entries/${id}`, { content: '   ' });
    expect(res.status).toBe(400);
  });
});
