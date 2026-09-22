// RE-REVIEW HARNESS (temporary, not committed): drive the two vault embed sites
// for real. Nothing about the embeddings module is mocked — the real latch, the
// real classifier and the real generateEmbedding run; only `fetch` is stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    warns, errors,
    db: { current: null as Database.Database | null },
    logger: {
      debug: () => {}, info: () => {},
      warn: (...a: unknown[]) => { warns.push(a); },
      error: (...a: unknown[]) => { errors.push(a); },
    },
  };
});

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!h.db.current) throw new Error('test DB not initialized');
    return h.db.current;
  },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => h.logger }));

const LATCH = 'Embedding backend unavailable — embeddings are paused until it answers again';
const CREATE_GENUINE = 'Failed to generate embedding for vault entry';
const SEARCH_GENUINE = 'Failed to generate query embedding, falling back to text search';
const NOT_FOUND = '{"error":"model \\"nomic-embed-text\\" not found, try pulling it first"}';
const OK_BODY = JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] });

const said = (msg: string): number => h.warns.filter((w) => w[0] === msg).length;

const realFetch = globalThis.fetch;
let body = NOT_FOUND;
let status = 404;
let fetchCount = 0;

async function fresh(): Promise<typeof import('../store.js')> {
  vi.resetModules();
  return import('../store.js');
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, classification TEXT, group_id TEXT);
    CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT,
      type TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, context TEXT,
      confidence REAL DEFAULT 1.0, is_permanent INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]', is_pinned INTEGER DEFAULT 0, is_obsolete INTEGER DEFAULT 0,
      superseded_by TEXT, retrieval_count INTEGER DEFAULT 0, last_retrieved_at TEXT,
      source_conversation_id TEXT, source TEXT DEFAULT 'agent', citation TEXT,
      embedding BLOB, namespace TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, classification, group_id) VALUES ('a1','Tester','sensei',NULL)").run();
  h.db.current = db;
  h.warns.length = 0;
  h.errors.length = 0;
  fetchCount = 0;
  globalThis.fetch = (async () => { fetchCount++; return new Response(body, { status }); }) as unknown as typeof fetch;
});

afterEach(() => {
  h.db.current?.close();
  h.db.current = null;
  globalThis.fetch = realFetch;
});

const write = async (s: typeof import('../store.js'), n: number): Promise<void> => {
  await s.createEntry({ agentId: 'a1', type: 'fact', content: `a vault fact long enough to be real, number ${n}` });
};

describe('DRIVEN: both vault sites share the one latch', () => {
  it('absence at createEntry AND semanticSearch is ONE warn across both sites', async () => {
    body = NOT_FOUND; status = 404;
    const s = await fresh();

    for (let i = 0; i < 3; i++) await write(s, i);
    expect(said(LATCH), 'three vault writes, one absence').toBe(1);

    for (let i = 0; i < 3; i++) await s.semanticSearch(`query ${i}`, { agentId: 'a1' });
    expect(said(LATCH), 'a second SITE does not re-announce the same absence').toBe(1);

    // The graceful path is preserved: every one of the six still TRIED.
    expect(fetchCount).toBe(6);
    expect(h.errors).toHaveLength(0);
    expect(said(CREATE_GENUINE) + said(SEARCH_GENUINE)).toBe(0);
  });

  it('CONTROL: a genuine 500 still speaks EVERY time, at BOTH sites', async () => {
    body = 'internal failure in the inference runtime'; status = 500;
    const s = await fresh();

    for (let i = 0; i < 3; i++) await write(s, i);
    expect(said(CREATE_GENUINE), 'createEntry: a real failure is said every time').toBe(3);

    for (let i = 0; i < 3; i++) await s.semanticSearch(`query ${i}`, { agentId: 'a1' });
    expect(said(SEARCH_GENUINE), 'semanticSearch: a real failure is said every time').toBe(3);

    expect(said(LATCH), 'a 500 is not absence and must not be latched').toBe(0);
  });

  it('RE-ARM, driven from the vault: a successful EMBED that stores NOTHING re-arms', async () => {
    body = NOT_FOUND; status = 404;
    const s = await fresh();

    await write(s, 1);
    expect(said(LATCH)).toBe(1);

    // vault_search embeds and never writes an `embeddings` row. Under the old
    // store-based reset this answer would have left the latch shut.
    body = OK_BODY; status = 200;
    await s.semanticSearch('the backend is back', { agentId: 'a1' });

    body = NOT_FOUND; status = 404;
    await write(s, 2);
    expect(said(LATCH), 'it ANSWERED, so the next absence is a new fact').toBe(2);
    expect(h.errors).toHaveLength(0);
  });
});
