// A passing low-memory moment stamps no permanent verdict: with the Dojo's small writer refused for the memory free
// now, the placeholder pass marks nothing and ends; the next pass, with memory free, replaces them. The own model
// is down and the writers are scripted; the gate, the writer choice and the replacer are real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {},
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const mem = vi.hoisted(() => ({ free: Number.MAX_SAFE_INTEGER }));
vi.mock('../../agent/local-model-fit.js', async (orig) => ({ ...(await orig<object>()), freeWriterWindowTokens: async () => mem.free }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string }) => {
    if (p.modelId === 'own-down') throw new Error('connection refused');
    return { content: 'The owner asked which bay; the agent answered.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders, hasUncondensedPlaceholders } from '../out-of-view.js';
import { __resetSummaryWriterHealthForTests, clearOn } from '../writer.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-low-memory';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mem.free = Number.MAX_SAFE_INTEGER;
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47125', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('paid', 'Paid', 'openai-compatible', 'http://127.0.0.1:47126', 'api_key', 1)").run();
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '[\"decision\"]', 1)").run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m-writer', 'ollama-local', ?, ?, '[\"chat\"]', 32000, 1)").run(STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag);
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('own-down', 'paid', 'p', 'p', '[\"chat\"]', 200000, 3, 1)").run();
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'A', 'own-down', 'idle', '{}')").run(AGENT);
  for (let t = 1; t <= 6; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] Bay ${t}, after inspection.` });
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answers: { stated_current: { noul: 0.04 } } })));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a low-memory moment leaves the placeholders for the next pass', () => {
  it('nothing is marked and the pass ends; with memory free the next pass replaces them', async () => {
    const maxSeq = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    expect(writeUncondensedPlaceholders(AGENT, maxSeq)).toBeGreaterThan(0);
    mem.free = 50;
    expect(await replaceUncondensedPlaceholders(AGENT)).toBe(0);
    expect(hasUncondensedPlaceholders(AGENT), 'non-vacuity: the placeholders are still there').toBe(true);
    expect(db().prepare("SELECT COUNT(*) AS n FROM healer_state WHERE scope = 'writer_wait.cannot-hold'").get(), 'no note is marked cannot-hold').toEqual({ n: 0 });
    mem.free = Number.MAX_SAFE_INTEGER;
    clearOn({ kind: 'person-spoke', agentId: AGENT });   // the writer's wait for room ends when a person speaks
    expect(await replaceUncondensedPlaceholders(AGENT)).toBeGreaterThan(0);
    expect(hasUncondensedPlaceholders(AGENT)).toBe(false);
  });
});
