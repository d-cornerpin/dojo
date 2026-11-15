// ════════════════════════════════════════════════════════════════════════════════════════
// A box whose stored vectors name a different model than the one in use (a restored or imported copy).
//
//  1. Search never mixes the vectors of two models, even when their widths are the same.
//  2. The scheduled drain makes a vector for every memory with none from the current model (a local embedder only).
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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../db/migrations.js';
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

describe('search never mixes two models', () => {
  it('after a switch, a same-width vector from the old model is not a hit (conversation and vault)', async () => {
    seedOldMemories(1);
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

describe('the scheduled drain', () => {
  it('re-makes a vector another model made, and leaves a current one alone', async () => {
    seedOldMemories(1);
    db().prepare("UPDATE config SET value = ? WHERE key = 'embedding_config'")
      .run(JSON.stringify({ provider: 'ollama', model: 'new-embedder' }));
    db().prepare('INSERT INTO messages (id, agent_id, role, lane, content) VALUES (?, ?, ?, ?, ?)')
      .run('msg-current', AGENT, 'user', 'owner', 'a message long enough, already embedded by the current model');
    db().prepare(`INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, embedding_model, created_at)
                  VALUES ('emb-current', 'message', 'msg-current', ?, 'p', ?, 4, 'ollama:new-embedder', datetime('now'))`)
      .run(AGENT, Buffer.from(new Float32Array(VEC).buffer));
    await runBackfill();
    expect(fetchedModels).toEqual(['new-embedder']);
    expect(modelsOf('embeddings')).toEqual(['ollama:new-embedder']);
    expect(db().prepare("SELECT COUNT(*) AS c FROM embeddings WHERE source_id = 'msg-0'").get()).toEqual({ c: 1 });
    expect(db().prepare("SELECT id FROM embeddings WHERE source_id = 'msg-current'").get()).toEqual({ id: 'emb-current' });
    expect((await vectorSearch('a message long enough', AGENT, { minSimilarity: 0.1 })).length).toBeGreaterThan(0);
  });

  it('leaves another model\'s vectors alone when the embedder is not local', async () => {
    seedOldMemories(1);
    db().prepare("UPDATE config SET value = ? WHERE key = 'embedding_config'")
      .run(JSON.stringify({ provider: 'openai', baseUrl: 'https://embeddings.example.test/v1', model: 'big-hosted' }));
    await runBackfill();
    expect(fetchedModels).toEqual([]);
    expect(modelsOf('embeddings')).toEqual([OLD]);
  });
});
