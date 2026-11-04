// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix 3 (#11, owner ruling OR-FIELD3 (a)): A CLOUD MODEL GETS ITS FULL WINDOW.
//
// The field box: a fixed 1,000,000-token cloud model whose admission budget sat at 125-133K. The
// provider-ceiling cap (T82a, "the admission budget learns the box") read a first-chunk patience
// the provider row declared and a prefill rate the ledger MEASURED off cached cloud calls (a lower
// bound far below the real speed), and capped the budget at half the resulting ceiling. The owner:
// cloud models get their full context window; the prefill doom cap applies to local models only.
//
// Local means the code's own two notions: a provider type that runs on the owner's hardware
// (`ollama`, `local`: the free-and-local set the spend wall already exempts), or a base URL that
// points at this machine. A slow local box keeps its doom guard.
//
// The second defect (diagnosis Problem 5a): the reserve for tools and output was taken BEFORE the
// cap, so a capped budget no longer left room for them. The cap now bounds the window figure and
// the reserve comes off what the cap leaves.
//
// Real: the migrated DB, the provider and model rows, `getProviderCeilingTokens`, and the gauge
// (`estimateAssembledTokens`) the routine check and the assembler share. Fixture names invented.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 2_000 }));

import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { estimateAssembledTokens } from '../compaction.js';
import { contextWindowPolicy, toolAndOutputReserve, CONTEXT_THRESHOLD } from '../budget.js';
import { getProviderCeilingTokens, getModelOutputCap } from '../../agent/model.js';
import { resolveDoomCeiling, PROVIDER_CEILING_SAFETY } from '../../agent/stream-patience.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-full-window';
const MODEL = 'model-full-window';
const WINDOW = 1_000_000;
/** The field shape: a declared 120s first chunk and a ledger-measured 2,800 tok/s (diagnosis 5a). */
const FIRST_CHUNK_MS = 120_000;
const MEASURED_TPS = 2_800;

function seed(provider: { type: string; baseUrl: string | null }): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, measured_prefill_tokens_per_sec)
              VALUES ('prov', 'Prov', ?, ?, 'api_key', ?, ?)`).run(provider.type, provider.baseUrl, FIRST_CHUNK_MS, MEASURED_TPS);
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m, context_window, max_output_tokens)
              VALUES (?, 'prov', 'Big Window', 'big-window', 1, '["text","tools"]', 1, ?, 8192)`).run(MODEL, WINDOW);
  db.prepare(`INSERT INTO agents (id, name, status, model_id, created_at) VALUES (?, 'Full Window', 'idle', ?, datetime('now'))`).run(AGENT, MODEL);
  db.prepare(`INSERT INTO messages (id, agent_id, role, content, token_count, created_at) VALUES ('m1', ?, 'user', 'hello', 2, unixepoch() * 1000)`).run(AGENT);
}

const reserve = (): number => toolAndOutputReserve({ toolPayloadTokens: 2_000, maxOutputTokens: getModelOutputCap(MODEL) });

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  __resetEstimateCacheForTests();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a cloud model with a declared first chunk and a slow measured rate', () => {
  it('has no provider ceiling, and its budget is 0.96 of its window minus the reserve', async () => {
    seed({ type: 'anthropic', baseUrl: null });
    expect(getProviderCeilingTokens(MODEL), 'a cloud provider arms no doom ceiling').toBeNull();
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 2_000, maxOutputTokens: getModelOutputCap(MODEL), providerCeilingTokens: getProviderCeilingTokens(MODEL) });
    expect(policy.assemblyBudgetTokens).toBe(Math.floor(CONTEXT_THRESHOLD * WINDOW) - reserve());
    // The gauge the routine check reads (what the system prompt and the off-the-top lanes leave of it).
    const { view } = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    expect(view.budgetTokens).toBeGreaterThan(900_000);
  });

  it('the same for an OpenAI-compatible provider that is not on this machine', async () => {
    seed({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1' });
    expect(getProviderCeilingTokens(MODEL)).toBeNull();
  });
});

describe('a slow LOCAL box keeps its doom guard', () => {
  const ceiling = resolveDoomCeiling(FIRST_CHUNK_MS, null, MEASURED_TPS) as number;

  it('an Ollama provider (on this machine or another of the owner\'s) is capped', () => {
    seed({ type: 'ollama', baseUrl: 'http://gpu-box.example.com:11434' });
    expect(getProviderCeilingTokens(MODEL)).toBe(ceiling);
  });

  it('an OpenAI-compatible server on this machine is capped, and the reserve comes off what the cap leaves', async () => {
    seed({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(getProviderCeilingTokens(MODEL)).toBe(ceiling);
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 2_000, maxOutputTokens: getModelOutputCap(MODEL), providerCeilingTokens: getProviderCeilingTokens(MODEL) });
    expect(policy.assemblyBudgetTokens).toBe(Math.floor(ceiling * PROVIDER_CEILING_SAFETY) - reserve());
    const { view } = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    expect(view.budgetTokens).toBeLessThan(policy.assemblyBudgetTokens);
  });
});

describe('the reserve is taken after the cap', () => {
  it('a capped budget still leaves the tools and output reserve', () => {
    const measured = { toolPayloadTokens: 17_502, maxOutputTokens: 64_000 };
    const r = toolAndOutputReserve(measured);
    const capped = contextWindowPolicy(200_000, { ...measured, providerCeilingTokens: 102_600 });
    expect(capped.assemblyBudgetTokens).toBe(51_300 - r);
    const uncapped = contextWindowPolicy(200_000, measured);
    expect(uncapped.assemblyBudgetTokens, 'no ceiling: unchanged').toBe(Math.floor(0.96 * 200_000) - r);
  });
});
