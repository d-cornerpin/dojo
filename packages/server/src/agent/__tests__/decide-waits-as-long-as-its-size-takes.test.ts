// t268 ruling 4 — decide()'s TIMEOUT IS B5'S MEASURED FORMULA FOR THE CALL'S OWN SIZE, NOT A FIXED 1,500 MS.
// B5 (`overhaul-plans/v35-writer-measure.md` → "decide() latency"): on a busy box a warm call takes
// 62 + 1.33·T + 94·(Q−1) ms (T = state tokens, Q = questions), observed ÷ fitted at p99 is 2.05, and a model
// that is not loaded adds about 1.3 s. The fixed 1,500 ms cut 22 of 24 cold calls and every call whose state
// was over 2,000 tokens. Every Ollama call here is a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decide, __forgetResidencyForTests, type Question } from '../decide.js';
import { decideTimeoutMs, fencedState } from '../decide-sizing.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';
import { B5_MEASURED_CHARS_PER_TOKEN, recordDensitySample } from '../../services/token-density.js';
import { writeThenCheck, summaryChecksSettled } from '../../memory/summary-check.js';

const BASE = 'http://127.0.0.1:47151';
const db = (): Database.Database => mockDb.current!;
const Q3: Record<string, Question> = Object.fromEntries(['a', 'b', 'c'].map((k) => [k, { type: 'noul', instructions: `${k}?` } as Question]));
const ollama = { up: true, fetches: [] as string[] };
let clocks: number[] = [];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(BASE);
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  ollama.up = true;
  ollama.fetches = [];
  clocks = [];
  __forgetResidencyForTests();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { clocks.push(ms); return timeout(ms); });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    ollama.fetches.push(new URL(url).pathname);
    if (!ollama.up) throw new Error('fetch failed: ECONNREFUSED');
    return Response.json({ answers: { a: { noul: 0.1 }, b: { noul: 0.1 }, c: { noul: 0.1 }, invented: { noul: 0.1 }, dropped: { noul: 0.1 }, stated_current: { noul: 0.1 } } });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

/** The clock decide() gave its /v1/systemone call: the last one it started. */
const callClock = (): number => clocks[clocks.length - 1];
const stateTokens = (state: unknown, cpt = B5_MEASURED_CHARS_PER_TOKEN): number => Math.ceil(JSON.stringify(fencedState(state)).length / cpt);

describe('the arithmetic (B5\'s worked examples)', () => {
  it('a per-turn call: T ≈ 800, nine questions, resident → about 3,850 ms; not resident → about 5,150 ms', () => {
    expect(decideTimeoutMs(800, 9, true)).toBe(3_850);
    expect(decideTimeoutMs(800, 9, false)).toBe(5_150);
  });
  it('a short state, three questions → about 1,060 ms; the largest call at an 8,192-token state → about 22.8 s', () => {
    expect(decideTimeoutMs(200, 3, true)).toBe(1_058);
    expect(decideTimeoutMs(8_192, 3, true)).toBe(22_848);
  });
});

describe('decide() gives each call the time its own size takes', () => {
  it('resident (a call it answered left the model loaded): the warm formula for its state tokens and its questions', async () => {
    await decide({ reply: 'warm it' }, Q3, { purpose: 'probe', patienceMs: 60_000 });
    const state = { reply: 'w'.repeat(6_000) };
    expect(await decide(state, Q3, { purpose: 'probe', patienceMs: 60_000 })).not.toBeNull();
    expect(callClock()).toBeGreaterThan(1_500);   // the provisional fixed figure would have cut it (B5)
    expect(callClock()).toBe(decideTimeoutMs(stateTokens(state), 3, true));
  });

  it('the cold path: the first call, and the first after any failure, get the load time too; no /api/ps is asked', async () => {
    const state = { reply: 'short' };
    await decide(state, Q3, { purpose: 'probe', patienceMs: 60_000 });
    expect(callClock()).toBe(decideTimeoutMs(stateTokens(state), 3, false));
    await decide(state, Q3, { purpose: 'probe', patienceMs: 60_000 });
    expect(callClock()).toBe(decideTimeoutMs(stateTokens(state), 3, true));
    ollama.up = false;
    expect(await decide(state, Q3, { purpose: 'probe', patienceMs: 60_000 })).toBeNull();
    ollama.up = true;
    await decide(state, Q3, { purpose: 'probe', patienceMs: 60_000 });
    expect(callClock()).toBe(decideTimeoutMs(stateTokens(state), 3, false));
    expect(ollama.fetches.every((p) => p === '/v1/systemone')).toBe(true);
  });

  it('T is counted at the decision model\'s OWN measured density when it has one', async () => {
    for (let i = 0; i < 3; i++) recordDensitySample('m-decision', 20_000, 10_000);   // 2.0 chars per token
    await decide({ reply: 'warm it' }, Q3, { purpose: 'probe', patienceMs: 60_000 });
    const state = { reply: 'd'.repeat(6_000) };
    await decide(state, Q3, { purpose: 'probe', patienceMs: 60_000 });
    expect(callClock()).toBe(decideTimeoutMs(stateTokens(state, 2.0), 3, true));
  });

  it('a caller that owns its budget still passes its own', async () => {
    await decide({ reply: 'x' }, Q3, { purpose: 'probe', patienceMs: 60_000, timeoutMs: 777 });
    expect(callClock()).toBe(777);
  });

  it('the summary check gets the formula too — the decision model\'s own time, not how long the writer took', async () => {
    await decide({ reply: 'warm it' }, Q3, { purpose: 'probe', patienceMs: 60_000 });
    const source = '[USER · the owner] draft the budget';
    const summary = 'The owner asked for a budget.';
    // A writer that answered at once (a fast cloud writer): its time says nothing about the decision model's.
    const r = await writeThenCheck({ content: source, agentId: 'agent-t', modelId: 'writer-fast' }, async () => ({ ok: true, text: summary }));
    expect(r.ok).toBe(true);
    await summaryChecksSettled();   // fix round 1 (M-2): in shadow it runs after the summary is kept
    expect(callClock()).toBe(decideTimeoutMs(stateTokens({ source_rows: source, summary }), 3, true));
  });
});
