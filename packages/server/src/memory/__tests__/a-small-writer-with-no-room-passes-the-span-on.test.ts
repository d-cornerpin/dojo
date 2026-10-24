// t268 fix round 4 (N-B, N-C, orchestrator rulings) — THE SMALL WRITER'S FALLBACK, AS THE MEMORY REALLY IS.
// · N-B: when the Dojo's small writer cannot fit even a summary in the memory free at that moment (on a 16 GB box,
//   with the decision model's memory counted, it never can), the fallback passes at once to the NEXT writer in the
//   order — never a refused span halved again and again. With no writer able to run, the rows are kept (nothing is
//   lost, nothing is dialled) and the span is tried again when the agent's own model is reachable again.
// · N-C: the free memory counts what the models loaded on Ollama REALLY hold — Ollama's own loaded size (`/api/ps`),
//   their working memory included — never their weights alone.
// THE DOOR: the real `checkAndCompact` on the real migration chain. The writers and Ollama are scripted;
// os.totalmem is the test's; the decision check is held to the rule (nothing here asks the decision model).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));
const writers = vi.hoisted(() => ({ calls: [] as string[], unreachable: new Set<string>() }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string }) => {
    writers.calls.push(p.modelId);
    if (writers.unreachable.has(p.modelId)) throw new Error('OpenAI call failed: fetch failed');
    return { content: `Summary by ${p.modelId}: the crew counted the depot and filed the manifests.`, toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact } from '../compaction.js';
import { generateSummary } from '../summarize.js';
import { generateOrPassOn } from '../leaf-writer-fallback.js';
import { insertMessage } from '../message-store.js';
import { eligibleSummaryWriters, noteAPersonSpoke, noteSummaryWriterOutcome, __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { resolveSummaryWriterModel } from '../compaction.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { backgroundDrains } from '../../agent/shared-state.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { pickDesktopReserve, ENGINE_RESERVE_BYTES } from '../../services/num-ctx-calculator.js';
import { freeWriterWindowTokens } from '../../agent/local-model-fit.js';

const GIB = 1024 ** 3;
const AGENT = 'agent-no-room';
const OWN = 'model-own';      // the agent's own (cloud) model
const NEXT = 'model-next';    // the next writer in the order after the small writer
const WRITER = 'm-writer';
const NINE_B = 'agent-local:9b';
/** t252's test shape: 36 blocks, 8 KV heads of 128 → 147,456 bytes a token, for the writer and the decision model alike. */
const arch = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144 };
const KV = 147_456;
const SIZES = { writer: 3_400_000_000, decision: 2_800_000_000, embedder: 274_302_471, nineB: 6_600_000_000 };
const db = (): Database.Database => mockDb.current!;
const ollama = { ps: [] as Array<{ name: string; size: number }>, psCalls: 0, tagsCalls: 0 };

function box(totalGib: number): void {
  vi.spyOn(os, 'totalmem').mockImplementation(() => totalGib * GIB);
}

beforeEach(() => {
  writers.calls = []; writers.unreachable = new Set([OWN]);
  ollama.ps = []; ollama.psCalls = 0; ollama.tagsCalls = 0;
  backgroundDrains.clear(); __resetBrakesForTests(); __resetBreakersForTests(); __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  box(16);
  const prov = db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url, is_validated) VALUES (?, ?, ?, ?, ?, 1)");
  prov.run('ollama-local', 'Ollama', 'ollama', 'none', 'http://localhost:11434');
  prov.run('p-own', 'Own', 'openai-compatible', 'api_key', 'http://localhost:11441/v1');
  prov.run('p-next', 'Next', 'openai-compatible', 'api_key', 'http://localhost:11442/v1');
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?, 4096, ?, 1)`);
  model.run(OWN, 'p-own', 'Own', 'own', '["text","tools"]', 32_000, 3);
  model.run(NEXT, 'p-next', 'Next', 'next', '["text","tools"]', 32_000, 1);
  model.run(WRITER, 'ollama-local', STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag, '["chat"]', 262_144, 0);
  model.run('m-decision', 'ollama-local', STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag, '["decision"]', 262_144, 0);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, OWN);
  // The decision model's derived tag exists (its window, 27,648 tokens, is reserved); the check is held to the rule.
  db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_window', '27648'), ('decision_mode.summary_check.invented', 'rule'), ('decision_mode.summary_check.dropped', 'rule'), ('decision_mode.summary_check.stated_current', 'rule')").run();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const p = new URL(url).pathname;
    if (p === '/api/tags') ollama.tagsCalls++;
    if (p === '/api/tags') return Response.json({ models: [
      { name: STANDARD_WRITER_MODEL.tag, size: SIZES.writer }, { name: STANDARD_DECISION_MODEL.tag, size: SIZES.decision },
      { name: 'nomic-embed-text:latest', size: SIZES.embedder }, { name: NINE_B, size: SIZES.nineB },
    ] });
    if (p === '/api/ps') { ollama.psCalls++; return Response.json({ models: ollama.ps }); }
    if (p === '/api/show') {
      const name = (JSON.parse(init?.body ?? '{}') as { name?: string; model?: string });
      return [STANDARD_WRITER_MODEL.tag, STANDARD_DECISION_MODEL.tag].includes(name.name ?? name.model ?? '') ? Response.json({ model_info: arch }) : new Response('nf', { status: 404 });
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const ROW = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(40);
function seed(turns = 24): void {
  for (let t = 1; t <= turns; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] ${ROW}` });
  }
}
const realSummaries = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind != 'uncondensed'").get(AGENT) as { n: number }).n;
const messages = (): number => (db().prepare('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?').get(AGENT) as { n: number }).n;

describe('N-B: on a 16 GB box the small writer never fits a summary; the span passes on', () => {
  it('the agent\'s model unreachable: the next writer in the order writes the summaries, the small writer is never dialled, and it is asked once', async () => {
    seed();
    const result = await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(result.leafCreated).toBeGreaterThan(0);
    expect(realSummaries()).toBeGreaterThan(0);
    expect(writers.calls).not.toContain(WRITER);
    expect(writers.calls.filter((m) => m === NEXT).length).toBeGreaterThan(0);
    expect(ollama.tagsCalls, 'the free memory was read once: no refused span was halved and asked again').toBe(1);
    expect(eligibleSummaryWriters(OWN, AGENT)).toEqual([NEXT]);
  });

  it('no writer can run: nothing is dialled again, the rows are kept, and the span is written once the agent\'s own model answers', async () => {
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id = ?').run(NEXT);
    seed();
    const before = messages();
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(writers.calls.filter((m) => m !== OWN)).toEqual([]);   // only the own model's failed try; the small writer never
    expect(realSummaries()).toBe(0);
    expect(messages(), 'nothing lost').toBe(before);
    expect(eligibleSummaryWriters(OWN, AGENT), 'no writer can run: nothing to retry until something changes').toEqual([]);
    expect(resolveSummaryWriterModel(AGENT, OWN, { background: true }), 'the background fold waits').toBeNull();

    writers.unreachable.clear();
    noteAPersonSpoke(AGENT);   // the agent's own model is tried again
    expect(eligibleSummaryWriters(OWN, AGENT)[0]).toBe(OWN);
    __resetBrakesForTests();   // the zero-yield pass's own low-yield hold is another mechanism; it is not what is tested here
    const calls = writers.calls.length;
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(writers.calls.slice(calls).every((m) => m === OWN)).toBe(true);
    expect(realSummaries()).toBeGreaterThan(0);
    expect(eligibleSummaryWriters(OWN, AGENT), 'its own model answered: the small writer is its fallback again').toEqual([OWN, WRITER]);
  });

  it('a generateSummary call on the small writer, as the fallback, is refused as "no room" without dialling it', async () => {
    const r = await generateSummary({ content: 'r'.repeat(4_000), depth: 0, targetTokens: 5_000, agentId: AGENT, modelId: WRITER });
    expect(r).toMatchObject({ ok: false, noRoom: true });
    expect(writers.calls).toEqual([]);
  });

  it('a condensation batch on the small writer with no room passes whole to the next writer (never halved)', async () => {
    noteSummaryWriterOutcome(OWN, false);   // the agent's own model is not answering: the small writer is next
    const content = 'Earlier summary: the crew counted the depot. '.repeat(200);
    const r = await generateOrPassOn({ content, depth: 1, targetTokens: 2_000, agentId: AGENT, modelId: WRITER });
    expect(r.ok).toBe(true);
    expect(writers.calls).toEqual([NEXT]);
  });
});

describe('N-C: the free memory counts what loaded models really hold', () => {
  it('a 9B loaded at 32K on a 32 GB box: the writer window offered beside it fits the memory that is really free', async () => {
    box(32);
    const total = 32 * GIB;
    const nineBLoaded = SIZES.nineB + KV * 32_000;   // Ollama reports the runner's whole size: weights + its KV at 32K
    ollama.ps = [{ name: NINE_B, size: nineBLoaded }];
    const open = total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - SIZES.embedder - SIZES.writer - SIZES.decision
      - KV * (2_048 + 27_648);   // the writer's reserved room and the decision model's window
    const free = await freeWriterWindowTokens();
    expect(free).toBe(2_048 + Math.max(0, Math.floor((open - nineBLoaded) / KV)));
    expect(free! * KV, 'never more working memory than is really free beside the 9B').toBeLessThanOrEqual(2_048 * KV + Math.max(0, open - nineBLoaded));
    // A halved leaf span (~9K tokens of window): more than is free beside the 9B, so the writer is not dialled with it.
    const r = await generateSummary({ content: 'r'.repeat(12_000), depth: 0, targetTokens: 5_000, agentId: AGENT, modelId: WRITER });
    expect(r.ok).toBe(false);
    expect(writers.calls).toEqual([]);
  });

  it('the Dojo\'s own two models and the embedder, loaded, are not charged twice', async () => {
    box(32);
    ollama.ps = [{ name: STANDARD_WRITER_MODEL.tag, size: 9e9 }, { name: STANDARD_DECISION_MODEL.windowTag, size: 7e9 }, { name: 'nomic-embed-text:latest', size: 3e8 }];
    const total = 32 * GIB;
    const open = total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - SIZES.embedder - SIZES.writer - SIZES.decision - KV * (2_048 + 27_648);
    expect(await freeWriterWindowTokens()).toBe(2_048 + Math.floor(open / KV));
  });
});
