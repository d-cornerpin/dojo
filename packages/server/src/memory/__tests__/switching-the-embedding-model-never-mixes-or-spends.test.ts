// ════════════════════════════════════════════════════════════════════════════════════════
// SWITCHING THE EMBEDDING MODEL (owner ruling).
//
//  1. Search never mixes the vectors of two models, even when their widths are the same.
//  2. A switch to a LOCAL model re-embeds the old memories in the background, at no cost.
//  3. A switch to a PAID model re-embeds nothing by itself; the owner gets ONE notice (the existing
//     `chat:error` card) saying how many memories still use the old model.
//
// The embedding backend is a stubbed `fetch`; nothing leaves the process.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: Record<string, unknown>) => { sent.push(e); } }));

import { runMigrations } from '../../db/migrations.js';
import { setEmbeddingConfig } from '../embeddings.js';
import { vectorSearch } from '../vector-search.js';
import { runBackfill } from '../backfill.js';
import { semanticSearch, createEntry } from '../../vault/store.js';

const AGENT = 'agent-sw';
const OLD = 'ollama:old-embedder';
let tmpDir: string;
let fetchedModels: string[];

/** Same width for every model on purpose: only the model label can tell them apart. */
const VEC = [1, 0, 0, 0];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-emb-switch-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  sent.length = 0;
  fetchedModels = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    fetchedModels.push(JSON.parse(init.body).model);
    return {
      ok: true, status: 200,
      json: async () => ({ embedding: VEC, data: [{ embedding: VEC }] }),
      text: async () => '',
    } as unknown as Response;
  });
  const db = mockDb.current;
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Sw', 'idle')").run(AGENT);
  db.prepare("INSERT INTO config (key, value) VALUES ('embedding_config', ?)")
    .run(JSON.stringify({ provider: 'ollama', model: 'old-embedder' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const db = (): Database.Database => mockDb.current!;

/** A conversation memory and a vault memory, both embedded by the OLD model. */
function seedOldMemories(n: number): void {
  const vec = Buffer.from(new Float32Array(VEC).buffer);
  for (let i = 0; i < n; i++) {
    const id = `msg-${i}`;
    db().prepare('INSERT INTO messages (id, agent_id, role, lane, content) VALUES (?, ?, ?, ?, ?)')
      .run(id, AGENT, 'user', 'owner', `a message long enough to be embedded: ${id}`);
    db().prepare(`INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, embedding_model, created_at)
                  VALUES (?, 'message', ?, ?, ?, ?, 4, ?, datetime('now'))`).run(`emb-${i}`, id, AGENT, `preview ${id}`, vec, OLD);
  }
  db().prepare(`INSERT INTO vault_entries (id, agent_id, type, content, embedding, embedding_model, created_at, updated_at)
                VALUES ('v-old', ?, 'fact', 'the harbour ledger is kept in the blue cabinet', ?, ?, datetime('now'), datetime('now'))`)
    .run(AGENT, vec, OLD);
}
const modelsOf = (table: string): string[] =>
  (db().prepare(`SELECT DISTINCT embedding_model AS m FROM ${table} WHERE embedding IS NOT NULL`).all() as Array<{ m: string }>).map((r) => r.m);
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}
const notices = (): Array<Record<string, unknown>> => sent.filter((e) => e.code === 'EMBEDDING_MODEL_SWITCHED');

describe('search never mixes two models', () => {
  it('after a switch, a same-width vector from the old model is not a hit (conversation and vault)', async () => {
    seedOldMemories(1);
    // Save the new setting without the switch follow-up, as a box would look right after the save.
    db().prepare("UPDATE config SET value = ? WHERE key = 'embedding_config'")
      .run(JSON.stringify({ provider: 'ollama', model: 'new-embedder' }));
    expect(await vectorSearch('harbour ledger', AGENT, { minSimilarity: 0.1 })).toEqual([]);
    expect(await semanticSearch('harbour ledger', { agentId: AGENT })).toEqual([]);
  });

  it('a memory written after the switch is stamped with the new model and found', async () => {
    db().prepare("UPDATE config SET value = ? WHERE key = 'embedding_config'")
      .run(JSON.stringify({ provider: 'ollama', model: 'new-embedder' }));
    const entry = await createEntry({ agentId: AGENT, type: 'fact', content: 'the harbour ledger is kept in the blue cabinet' });
    const found = await semanticSearch('harbour ledger', { agentId: AGENT });
    expect(found.map((e) => e.id)).toContain(entry.id);
    expect(modelsOf('vault_entries')).toEqual(['ollama:new-embedder']);
  });
});

describe('switching to a LOCAL model', () => {
  it('re-embeds the old memories in the background and searches find them again', async () => {
    seedOldMemories(3);
    setEmbeddingConfig({ model: 'new-embedder' });
    await until(() => modelsOf('embeddings').join() === 'ollama:new-embedder' && modelsOf('vault_entries').join() === 'ollama:new-embedder');
    expect(modelsOf('embeddings')).toEqual(['ollama:new-embedder']);
    expect(modelsOf('vault_entries')).toEqual(['ollama:new-embedder']);
    expect((db().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c).toBe(3);
    expect(new Set(fetchedModels)).toEqual(new Set(['new-embedder']));
    expect(notices()).toEqual([]);
    expect((await vectorSearch('harbour ledger', AGENT, { minSimilarity: 0.1 })).length).toBe(3);
  });
});

describe('switching to a PAID model', () => {
  it('re-embeds nothing, and says so once, with how many memories still use the old model', async () => {
    seedOldMemories(3);   // 3 conversation vectors + 1 vault entry = 4 memories
    setEmbeddingConfig({ provider: 'openai', baseUrl: 'https://embeddings.example.test/v1', model: 'big-hosted' });
    await until(() => notices().length > 0);
    await new Promise((r) => setTimeout(r, 200));   // nothing else may follow
    expect(fetchedModels).toEqual([]);
    expect(modelsOf('embeddings')).toEqual([OLD]);
    expect(modelsOf('vault_entries')).toEqual([OLD]);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ type: 'chat:error', severity: 'warning', retryable: false });
    expect(String(notices()[0].error)).toMatch(/4 saved memories still use the old model/);
    expect(String(notices()[0].error)).toMatch(/search may miss them until they are re-processed/);
    // Saving the same setting again is not a switch: no second notice.
    setEmbeddingConfig({ model: 'big-hosted' });
    await new Promise((r) => setTimeout(r, 200));
    expect(notices()).toHaveLength(1);
  });

  it('the scheduled drain leaves the old vectors alone; the owner\'s own backfill re-processes them', async () => {
    seedOldMemories(2);
    db().prepare("UPDATE config SET value = ? WHERE key = 'embedding_config'")
      .run(JSON.stringify({ provider: 'openai', baseUrl: 'https://embeddings.example.test/v1', model: 'big-hosted' }));
    await runBackfill();                                   // the drain on a paid model
    expect(fetchedModels).toEqual([]);
    expect(modelsOf('embeddings')).toEqual([OLD]);
    await runBackfill({ includeStale: true });             // the owner asked
    expect(modelsOf('embeddings')).toEqual(['openai:big-hosted']);
  });
});
