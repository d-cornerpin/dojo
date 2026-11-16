// A memory run that rests notes because their merges were refused only writes a log line: it records no compaction
// failure, so when the writer later fails the owner still gets his card, and a healthy agent over its room gets
// none. Driven through the owner's compact-now (`checkAndCompact` forced) on a migrated database; only the writer
// is a stand-in.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));
const sent = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }>, ratio: 0.9 as number | null }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { type?: string }) => { sent.cards.push(e); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/model.js', () => ({
  // Every merge comes back at `ratio` of its input (0.9: none can be kept; 0.35: each is); null answers empty.
  callModel: async (p: { messages: Array<{ content: string }> }) =>
    ({ content: sent.ratio === null ? '' : 'w'.repeat(Math.floor(p.messages[0].content.length * sent.ratio)), toolCalls: [], usage: {}, stopReason: 'stop' }),
  getContextWindow: () => 128_000, getModelOutputCap: () => 8192, getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createLeafSummary } from '../dag.js';
import { checkAndCompact } from '../compaction.js';
import { __resetBrakesForTests, LOW_YIELD_BACKOFF_MS } from '../compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { __resetCompactionFailuresForTests } from '../compaction-defect.js';
import { __resetSummaryWriterHealthForTests } from '../writer.js';

const AGENT = 'agent-lived-in';
const OWN = 'model-own-128k';
const NOTE = (i: number): string => `Note ${i}: the crew counted bay ${i}, filed manifest M-${1000 + i} and logged seal S-${2000 + i}. `.repeat(70);

let n = 0;
const row = (role: 'user' | 'assistant', content: string): string =>
  insertMessage({ agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, content, turnNumber: ++n }).id;
const at = (i: number): string => new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString();
const leaves = (from: number, count: number): void => {
  for (let i = from; i < from + count; i++) createLeafSummary(AGENT, NOTE(i), Math.ceil(NOTE(i).length / 4), [row('user', `ask ${i}`), row('assistant', `answer ${i}`)], at(i + 1), at(i + 1));
};
const failingCards = (): number => sent.cards.filter((c) => c.code === 'COMPACTION_FAILING').length;
const ownerCards = (): number => sent.cards.filter((c) => c.type === 'chat:error').length;
/** The owner's compact-now, after any brake's backoff has passed (the brakes and the failure record are kept). */
const compactNow = async (): Promise<void> => {
  vi.setSystemTime(Date.now() + LOW_YIELD_BACKOFF_MS + 1);
  __resetEstimateCacheForTests();
  await checkAndCompact(AGENT, OWN, 128_000, { force: true });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 20, 6, 0, 0));
  sent.cards = []; sent.ratio = 0.9; n = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  __resetBrakesForTests(); __resetCompactionFailuresForTests(); __resetSummaryWriterHealthForTests();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-own', 'Own', 'openai-compatible', 'api_key', 'http://127.0.0.1:1/v1')").run();
  db.prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'p-own', 'own', 'Own', 128000, 8192, '["text","tools"]', 1, 0.1, 0.4)`).run(OWN);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Keeper', 'idle', ?, '{}')").run(AGENT, OWN);
  const lone = createLeafSummary(AGENT, 'x'.repeat(36_000), 9_000, [row('user', 'old ask'), row('assistant', 'old answer')], at(0), at(0)).id;
  db.prepare("UPDATE summaries SET depth = 3, kind = 'condensed' WHERE id = ?").run(lone);
  leaves(0, 12);
  for (let i = 0; i < 6; i++) row(i % 2 === 0 ? 'user' : 'assistant', `live line ${i}`);
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('a run that leaves notes out writes one line', () => {
  it('a run whose merges are refused shows nothing, and a writer failure after it still shows the owner his card', async () => {
    await compactNow();
    expect(ownerCards(), 'resting notes is no card').toBe(0);
    leaves(20, 4);   // fresh notes, so the next run dials the writer again
    sent.ratio = null;
    await compactNow();
    expect(failingCards(), 'the writer failure is carded').toBe(1);
  });

  it('a healthy agent over its room shows no card', async () => {
    sent.ratio = 0.35;
    await compactNow();
    expect(ownerCards()).toBe(0);
  });
});
