// ════════════════════════════════════════════════════════════════════════════════════════
// T82a FIX WAVE (round 2) — THE SELECTOR FILTERS ON FIT.
//
// `selectModel` already filters candidates on capability, rate-limit and budget. A tier
// mixes cloud rows (no declared ceiling) with a declared-slow local row by design, and until
// now nothing stopped a fallback pick from being a candidate whose own declared patience and
// prefill throughput cannot possibly cover what is already assembled. This adds ONE more
// predicate to the SAME walk: `inputEstimate`, optional, and skipped entirely (R6, and the
// `selector-latency.test.ts` sub-2ms guard) when the caller does not supply one.
//
// R-FIXTURE (never a code constant): 600s declared patience, 180 tok/s declared prefill
// throughput -> ceiling 102,600 (resolveDoomCeiling's own pin) -> fit budget 51,300
// (floor(102,600 * 0.5), `PROVIDER_CEILING_SAFETY`).
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

import { selectModel } from '../selector.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t82a-selector-fit';
const CLOUD_MODEL = 'cloud-a';
const SLOW_MODEL = 'slow-b';
const FIT_BUDGET = 51_300; // floor(resolveDoomCeiling(600_000, 180) * 0.5)

function seedTier(db: Database.Database): void {
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`)
    .run(AGENT, 'Selector Fit Test');

  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('cloud', 'Cloud', 'openai', 'api_key')`).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, context_window, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'cloud', 'Cloud A', ?, 1, '["tools","text"]', 200000, 0, 0)
  `).run(CLOUD_MODEL, CLOUD_MODEL);

  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec)
    VALUES ('slow-local', 'Slow Local', 'openai', 'api_key', 600000, 180)
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, context_window, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'slow-local', 'Slow B', ?, 1, '["tools","text"]', 200000, 0, 0)
  `).run(SLOW_MODEL, SLOW_MODEL);

  const insertTierModel = db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');
  insertTierModel.run('standard', CLOUD_MODEL, 0);
  insertTierModel.run('standard', SLOW_MODEL, 1);
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('selectModel — RED: a candidate whose declared ceiling cannot cover the estimate is excluded', () => {
  it('excludes the slow-local candidate when the estimate exceeds its provider-aware fit budget', () => {
    const db = mockDb.current!;
    seedTier(db);

    // Both candidates excluded EXCEPT the slow one, isolating the fit filter as the only
    // thing that can still refuse it.
    const picked = selectModel('standard', AGENT, [CLOUD_MODEL], ['tools'], FIT_BUDGET + 1);

    expect(picked).toBeNull();
  });

  it('admits the slow-local candidate at exactly its fit budget, and one token over refuses it', () => {
    const db = mockDb.current!;
    seedTier(db);

    const atBudget = selectModel('standard', AGENT, [CLOUD_MODEL], ['tools'], FIT_BUDGET);
    expect(atBudget?.modelId).toBe(SLOW_MODEL);

    const overBudget = selectModel('standard', AGENT, [CLOUD_MODEL], ['tools'], FIT_BUDGET + 1);
    expect(overBudget).toBeNull();
  });

  it('a small estimate picks the slow-local candidate normally', () => {
    const db = mockDb.current!;
    seedTier(db);

    const picked = selectModel('standard', AGENT, [CLOUD_MODEL], ['tools'], 30_000);
    expect(picked?.modelId).toBe(SLOW_MODEL);
  });
});

describe('selectModel — CONTROL (byte-preservation, R6): inputEstimate omitted is untouched', () => {
  it('every existing call shape (no 5th argument) is unaffected, at any real size', () => {
    const db = mockDb.current!;
    seedTier(db);

    // Cloud picked first by priority regardless — the fit filter never even runs.
    expect(selectModel('standard', AGENT, undefined, ['tools'])?.modelId).toBe(CLOUD_MODEL);
    // And the slow candidate, alone, is still pickable with no estimate at all — a
    // declared ceiling this large is not, by itself, a reason to exclude anything.
    expect(selectModel('standard', AGENT, [CLOUD_MODEL], ['tools'])?.modelId).toBe(SLOW_MODEL);
  });
});

describe('selectModel — CONTROL: a NULL-ceiling candidate is never fit-excluded, at any estimate', () => {
  it('the cloud candidate is picked even against an enormous estimate', () => {
    const db = mockDb.current!;
    seedTier(db);

    const picked = selectModel('standard', AGENT, undefined, ['tools'], 10_000_000);
    expect(picked?.modelId).toBe(CLOUD_MODEL);
  });
});
