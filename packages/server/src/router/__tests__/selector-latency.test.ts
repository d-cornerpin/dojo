// PHASE-0 T7 — the router-latency + no-model-call guard.
//
// What this pins: model SELECTION is a local, deterministic, sub-2ms lookup.
// `selectModel()` reads three SQLite tables (router_tier_models, models,
// budgets) and consults two in-memory maps. It must never reach the network,
// and it must never become "ask a model which model to use".
//
// Scope note (P7's amended wording): the plan's pillar is "deterministic, no
// GENERATIVE model call". `decideTier()`'s semantic path may legitimately call
// the LOCAL embedder behind its 1500ms bail — that is a different function and
// is NOT what this file measures. The SELECTION function is what is pinned here.
//
// Only the DB connection is mocked (the fixture idiom used across this suite —
// see src/agent/__tests__/permissions-log-deny.test.ts and
// src/tracker/__tests__/task-stamps.test.ts). Everything the selector calls —
// capabilities, rate limits, budget — runs for real, because a test that stubs
// those out would prove nothing about whether selection reaches the network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { selectModel } from '../selector.js';

const AGENT = 'primary';
const ITERATIONS = 200;
const AVG_BUDGET_MS = 2;

// The real fetch, captured once at module load so afterEach always restores the
// genuine article even if a test throws mid-way.
const realFetch = globalThis.fetch;
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const db = new Database(':memory:');
  // Schema copied from the live DDL: providers/models from db/migrations.ts,
  // router_tiers/router_tier_models/budgets/cost_records from
  // db/migrations/004_phase4.sql.
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      base_url TEXT, auth_type TEXT NOT NULL, is_validated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL,
      api_model_id TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '[]',
      context_window INTEGER, input_cost_per_m REAL, output_cost_per_m REAL,
      is_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE router_tiers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE router_tier_models (
      tier_id TEXT NOT NULL, model_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tier_id, model_id)
    );
    CREATE TABLE budgets (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, limit_usd REAL NOT NULL, period TEXT NOT NULL,
      alert_50_sent INTEGER DEFAULT 0, alert_75_sent INTEGER DEFAULT 0, alert_90_sent INTEGER DEFAULT 0
    );
    CREATE TABLE cost_records (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, model_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO providers VALUES ('deepseek', 'DeepSeek', 'openai-compatible', 'https://openrouter.ai/api', 'api_key', 1);
    INSERT INTO router_tiers VALUES ('light', 'Light'), ('standard', 'Standard'), ('heavy', 'Heavy');
  `);
  // Three rows — one model per tier, so the standard-tier request has a real
  // answer AND the fallback chain (standard -> heavy -> light) has real rows
  // behind it rather than resolving through an empty table.
  const insertModel = db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        input_cost_per_m, output_cost_per_m, is_enabled)
    VALUES (?, 'deepseek', ?, ?, '["tools","text"]', 128000, ?, ?, 1)
  `);
  insertModel.run('light-model', 'Light Model', 'vendor/light', 0.1, 0.2);
  insertModel.run('standard-model', 'Standard Model', 'vendor/standard', 0.5, 1.5);
  insertModel.run('heavy-model', 'Heavy Model', 'vendor/heavy', 3.0, 15.0);
  const insertTierModel = db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  insertTierModel.run('light', 'light-model');
  insertTierModel.run('standard', 'standard-model');
  insertTierModel.run('heavy', 'heavy-model');
  mockDb.current = db;

  // A fetch that THROWS, not one that resolves: a selector that quietly ignored
  // a rejected promise would still be caught, because the throw is synchronous.
  fetchStub = vi.fn(() => {
    throw new Error('selectModel reached the network — model selection must be local');
  });
  globalThis.fetch = fetchStub as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

describe('selectModel — local, deterministic, fast (PHASE-0 T7 / P7 guard)', () => {
  it(`averages under ${AVG_BUDGET_MS}ms across ${ITERATIONS} iterations`, () => {
    // Warm-up: module init, statement compilation and JIT belong to nobody's
    // per-call budget.
    const warm = selectModel('standard', AGENT, undefined, ['tools']);
    expect(warm?.modelId).toBe('standard-model');

    const started = performance.now();
    let last: ReturnType<typeof selectModel> = null;
    for (let i = 0; i < ITERATIONS; i++) {
      last = selectModel('standard', AGENT, undefined, ['tools']);
    }
    const avgMs = (performance.now() - started) / ITERATIONS;

    // Guards the measure against a vacuous pass: a selector returning null on
    // every call would also be fast.
    expect(last).not.toBeNull();
    expect(last?.modelId).toBe('standard-model');
    expect(last?.providerId).toBe('deepseek');
    expect(last?.fallbackUsed).toBe(false);

    console.log(`[T7] selectModel average over ${ITERATIONS} iterations: ${avgMs.toFixed(4)}ms (budget ${AVG_BUDGET_MS}ms)`);
    expect(avgMs).toBeLessThan(AVG_BUDGET_MS);
  });

  it('never calls fetch — selection is a lookup, not a model call', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      selectModel('standard', AGENT, undefined, ['tools']);
    }

    expect(fetchStub).not.toHaveBeenCalled();
    expect(fetchStub.mock.calls.length).toBe(0);
  });
});
