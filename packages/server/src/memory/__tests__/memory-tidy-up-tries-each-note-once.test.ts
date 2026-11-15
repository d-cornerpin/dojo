// The memory tidy-up offers each note to the writer once at its depth, and an idle agent then pays nothing.
// A lived-in agent whose writer cannot shrink its notes enough (every merge comes back at 90% of its input) is
// driven through the owner's compact-now and then many turns and idle cycles with no rows leaving the view.
// Only the provider call is a stand-in; the gate, the compactor, the writer choice and the keep rule are real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../logger.js', async (orig) => {
  const actual = await orig<typeof import('../../logger.js')>();
  const at = (message: string): void => { logs.push(message); };
  return { ...actual, createLogger: () => ({ debug: at, info: at, warn: at, error: at }) };
});
vi.mock('../../agent/local-model-fit.js', async (orig) => ({ ...(await orig<object>()), freeWriterWindowTokens: async () => Number.MAX_SAFE_INTEGER }));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../summary-check.js', async (orig) => ({
  ...(await orig<typeof import('../summary-check.js')>()),
  writeThenCheck: (p: unknown, write: (p: unknown) => unknown) => write(p),
}));
const writer = vi.hoisted(() => ({ calls: [] as Array<{ modelId: string; content: string; rewrite: boolean }>, ratio: 0.9 }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; systemPrompt: string; messages: Array<{ content: string }> }) => {
    const content = p.messages[0].content;
    writer.calls.push({ modelId: p.modelId, content, rewrite: p.systemPrompt.includes('REWRITE:') });
    return { content: 'w'.repeat(Math.floor(content.length * writer.ratio)), toolCalls: [], usage: {}, stopReason: 'stop' };
  },
  getContextWindow: () => 128_000,
  getModelOutputCap: () => 8192,
  getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact, rebuildContextItems } from '../compaction.js';
import { createLeafSummary } from '../dag.js';
import { insertMessage } from '../message-store.js';
import { __resetBrakesForTests, LOW_YIELD_BACKOFF_MS } from '../compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { __resetSummaryWriterHealthForTests, clearOn } from '../writer.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { condenseForTheDialedModel } from '../../agent/v2/steps/pre-call-gates/context-gates.js';
import { backgroundDrains } from '../../agent/shared-state.js';

const AGENT = 'agent-lived-in';
const OWN = 'model-own-128k';
const WINDOW = 128_000;
const db = (): Database.Database => mockDb.current!;
const NOTE = (i: number): string => `Note ${i}: the crew counted bay ${i}, filed manifest M-${1000 + i} and logged seal S-${2000 + i}. `.repeat(70);

/** `leaves` leaf notes over old rows, optionally one lone deep note, then a short live tail nothing pushes out. */
function seed(leaves: number, lone?: { depth: number; chars: number }): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-own', 'Own', 'openai-compatible', 'api_key', 'http://127.0.0.1:1/v1')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'p-own', 'own', 'Own', ?, 8192, '["text","tools"]', 1, 0.1, 0.4)`).run(OWN, WINDOW);
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-local', 'Local', 'ollama', 'none', 'http://127.0.0.1:11434')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES ('model-local-writer', 'p-local', ?, 'Writer', 32000, 4096, '["text"]', 1, 0, 0)`).run(STANDARD_WRITER_MODEL.tag);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Keeper', 'idle', ?, '{}')").run(AGENT, OWN);
  let turn = 0;
  const row = (role: 'user' | 'assistant', content: string): string =>
    insertMessage({ agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, content, turnNumber: ++turn }).id;
  const day = (i: number): string => `2026-09-${String(1 + (i % 28)).padStart(2, '0')} 09:00:00`;
  if (lone) {
    const id = createLeafSummary(AGENT, 'x'.repeat(lone.chars), Math.ceil(lone.chars / 4), [row('user', 'old ask'), row('assistant', 'old answer')], day(0), day(0)).id;
    db().prepare('UPDATE summaries SET depth = ?, kind = ? WHERE id = ?').run(lone.depth, 'condensed', id);
  }
  for (let i = 0; i < leaves; i++) {
    createLeafSummary(AGENT, NOTE(i), Math.ceil(NOTE(i).length / 4), [row('user', `ask ${i}`), row('assistant', `answer ${i}`)], day(i + 1), day(i + 1));
  }
  for (let i = 0; i < 6; i++) row(i % 2 === 0 ? 'user' : 'assistant', `live line ${i}`);
  rebuildContextItems(AGENT);
}

/** One model call's routine gate, as a turn runs it, with its background run allowed to land. */
async function turn(aPersonSpoke = false): Promise<void> {
  if (aPersonSpoke) clearOn({ kind: 'person-spoke', agentId: AGENT });
  await condenseForTheDialedModel({ agentId: AGENT, dialedModelId: OWN, contextWindow: WINDOW, writerModelId: OWN });
  while (backgroundDrains.has(AGENT)) await new Promise<void>((r) => setImmediate(r));
}

/** A long quiet stretch: many turns, the brake's whole backoff passing, a person speaking now and then. */
async function idleStretch(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await turn(i % 10 === 0);
    if (i % 10 === 9) {
      vi.setSystemTime(Date.now() + LOW_YIELD_BACKOFF_MS + 1);
      await checkAndCompact(AGENT, OWN, WINDOW, { inTheBackground: true });
    }
  }
}

/** Each merge job (a first answer, not its rewrite) and the note ids it was shown. */
const mergeJobs = (): Array<{ modelId: string; notes: string[] }> => writer.calls.filter((c) => !c.rewrite && c.content.includes('<summary id='))
  .map((c) => ({ modelId: c.modelId, notes: [...c.content.matchAll(/<summary id="([^"]+)"/g)].map((m) => m[1]) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 20, 6, 0, 0));
  writer.calls = []; writer.ratio = 0.9; logs.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  __resetBrakesForTests(); __resetEstimateCacheForTests(); __resetSummaryWriterHealthForTests();
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('the memory tidy-up tries each note once', () => {
  it('merges that come back at 90% of their input: each note is offered once, to the own model only, and then never again', async () => {
    seed(12, { depth: 3, chars: 36_000 });
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    const jobs = mergeJobs();
    expect(jobs.length, 'non-vacuity: the writer was asked to merge').toBeGreaterThan(0);
    const offers = new Map<string, number>();
    for (const j of jobs) for (const n of j.notes) offers.set(n, (offers.get(n) ?? 0) + 1);
    expect([...offers.values()].filter((n) => n > 1), 'no note is offered twice at its depth').toEqual([]);
    expect(jobs.filter((j) => j.modelId !== OWN), 'a refused merge is not handed to the local writer').toEqual([]);
    expect(writer.calls.length, 'each job is an answer and at most one rewrite').toBeLessThanOrEqual(2 * jobs.length);

    const paid = writer.calls.length;
    await idleStretch();
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(writer.calls.length, 'nothing new left the view: the writer is never called again').toBe(paid);
  });

  it('a lone oversized old note at its own depth starts no run and costs nothing', async () => {
    seed(1, { depth: 4, chars: 40_000 });
    await idleStretch();
    expect(logs.filter((l) => l.startsWith('v2: condensing rows')), 'no turn starts a memory run').toEqual([]);
    expect(writer.calls, 'nothing is paid for it').toEqual([]);
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(writer.calls, 'and even the forced pass dials nothing for it').toEqual([]);
  });
});
