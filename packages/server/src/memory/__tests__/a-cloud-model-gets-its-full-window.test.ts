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
import { resolveDoomCeiling, PROVIDER_CEILING_SAFETY, doomGuardApplies, LOCAL_PROVIDER_TYPES } from '../../agent/stream-patience.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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
    // Review round L3: a prefill ceiling bounds INPUT, so only the tool payload (input) comes off it, not the output reserve.
    expect(policy.assemblyBudgetTokens).toBe(Math.floor(ceiling * PROVIDER_CEILING_SAFETY) - 2_000);
    const { view } = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    expect(view.budgetTokens).toBeLessThan(policy.assemblyBudgetTokens);
  });
});

describe('the reserve is taken after the cap', () => {
  it('a capped budget still leaves the tools and output reserve', () => {
    const measured = { toolPayloadTokens: 17_502, maxOutputTokens: 64_000 };
    const r = toolAndOutputReserve(measured);
    const capped = contextWindowPolicy(200_000, { ...measured, providerCeilingTokens: 102_600 });
    // Review round L3: the tool payload is prefilled, so it sits inside the ceiling; the output is not prefill, so it does
    // not. 51,300 - 17,502 = 33,798 (the output reserve stays on the WINDOW side, where the output really lives).
    expect(capped.assemblyBudgetTokens).toBe(51_300 - 17_502);
    // A window smaller than the cap is still bounded by the window minus the whole reserve.
    expect(contextWindowPolicy(40_000, { ...measured, providerCeilingTokens: 102_600 }).assemblyBudgetTokens).toBe(Math.floor(0.96 * 40_000) - r);
    const uncapped = contextWindowPolicy(200_000, measured);
    expect(uncapped.assemblyBudgetTokens, 'no ceiling: unchanged').toBe(Math.floor(0.96 * 200_000) - r);
  });
});

// ── Review round (M4): local means WHERE THE MODEL RUNS: the owner's own machines, not only this one ──
// LM Studio, llama.cpp, vLLM or MLX on another of his Macs is typed `openai-compatible` and reached over the LAN. It is
// exactly the slow box the doom guard exists for, so it keeps the budget cap AND the pre-dial backstop (one predicate).
describe('review round M4: a model on the owner\'s own network is local', () => {
  const compat = (baseUrl: string): boolean => doomGuardApplies({ providerType: 'openai-compatible', providerBaseUrl: baseUrl });
  it.each([
    ['loopback', 'http://127.0.0.1:1234/v1'],
    ['localhost', 'http://localhost:8080/v1'],
    ['IPv6 loopback', 'http://[::1]:8080/v1'],
    ['any-address', 'http://0.0.0.0:8080/v1'],
    ['RFC1918 192.168/16', 'http://192.168.1.20:1234/v1'],
    ['RFC1918 10/8', 'http://10.0.4.7:8000/v1'],
    ['RFC1918 172.16/12 (low edge)', 'http://172.16.0.9:8000/v1'],
    ['RFC1918 172.16/12 (high edge)', 'http://172.31.255.1:8000/v1'],
    ['IPv4 link-local', 'http://169.254.10.3:8000/v1'],
    ['IPv6 link-local', 'http://[fe80::1c2:3ff:fe4a:1]:8000/v1'],
    ['IPv6 unique-local', 'http://[fd12:3456::7]:8000/v1'],
    ['mDNS .local', 'http://studio.local:8080/v1'],
    ['.lan', 'http://gpu.lan:8080/v1'],
    ['.home.arpa', 'http://mini.home.arpa:8080/v1'],
    ['single-label host', 'http://studio:8080/v1'],
    ['this machine\'s hostname', `http://${os.hostname()}:8080/v1`],
  ])('%s is local', (_label, url) => { expect(compat(url)).toBe(true); });

  it.each([
    ['public IP', 'http://203.0.113.10:8000/v1'],
    ['172.32 (just past RFC1918)', 'http://172.32.0.1:8000/v1'],
    ['a public hostname', 'https://api.example.com/v1'],
    ['a name that only looks local', 'https://local.example.com/v1'],
    ['no base URL on a cloud type', ''],
  ])('CONTROL: %s is cloud', (_label, url) => { expect(compat(url)).toBe(false); });

  it('Ollama is local by type wherever it runs; the nonexistent "local" type is not in the set', () => {
    expect(doomGuardApplies({ providerType: 'ollama', providerBaseUrl: 'http://203.0.113.10:11434' })).toBe(true);
    expect([...LOCAL_PROVIDER_TYPES]).toEqual(['ollama']);
  });

  it('a LAN OpenAI-compatible row keeps its ceiling, so the budget is capped', () => {
    seed({ type: 'openai-compatible', baseUrl: 'http://192.168.1.20:1234/v1' });
    expect(getProviderCeilingTokens(MODEL)).toBe(resolveDoomCeiling(FIRST_CHUNK_MS, null, MEASURED_TPS));
  });

  it('ONE predicate: the budget door and the pre-dial door both ask doomGuardApplies first', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../agent/model.ts'), 'utf8');
    const preDial = /function refuseIfDoomed\([\s\S]*?\): void \{\s*\n[^\n]*\n\s*if \(!doomGuardApplies\(provider\)\) return;/;
    expect(src).toMatch(preDial);
    expect(src).toMatch(/export function getProviderCeilingTokens[\s\S]{0,120}if \(!doomGuardApplies\(info\)\) return null;/);
  });
});
