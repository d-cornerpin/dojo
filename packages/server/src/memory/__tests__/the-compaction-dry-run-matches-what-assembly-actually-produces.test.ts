// ════════════════════════════════════════════════════════════════════════════════════════
// T82a FIX WAVE — THE COMPACTION DRY RUN MATCHES WHAT ASSEMBLY ACTUALLY PRODUCES.
//
// `estimateAssembledTokens` (memory/compaction.ts) is a DRY RUN of the assembler's own
// admission math — "what would `assembleContext` actually admit" — used to cap the summary
// total at the SAME budget the assembler applies (its own header: "the gate's own model of
// [the assembler's budget]"). T82a's first commit taught `contextWindowPolicy` a provider-
// aware admission budget, but the dry run's own `contextWindowPolicy` call never passed the
// ceiling through — so on a slow, declared box the dry run modelled a BIGGER budget than the
// real assembler would honour, silently understating what a real assembly produces.
//
// This threads `getProviderCeilingTokens(modelId)` into the SAME `contextWindowPolicy` call,
// off the same `getModelInfo` join `refuseIfDoomed` already trusts. `modelId` undefined, or a
// model whose provider declared nothing, is R6's byte-preservation control — untouched.
//
// R-FIXTURE (never a code constant): 600s declared patience, 180 tok/s declared prefill
// throughput -> ceiling 102,600 -> provider-aware budget 51,300 -> summary share 0.7 ->
// summary cap 35,910 (an exact integer: 51,300 * 0.7 = 35,910.0).
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

import { estimateAssembledTokens } from '../compaction.js';
import { runMigrations } from '../../db/migrations.js';
import { SUMMARY_SHARE } from '../budget.js';

const AGENT = 'agent-t82a-dry-run';
const CEILING_MODEL = 'slow-box-model';
const NULL_MODEL = 'cloud-model';
const CONTEXT_WINDOW = 200_000;
// The fixture's own pinned numbers (resolveDoomCeiling(600_000, 180) === 102_600, pinned
// already by `a-provider-declares-its-own-prefill-throughput.test.ts`).
const FIXTURE_CEILING = 102_600;
const PROVIDER_AWARE_BUDGET = 51_300; // floor(102_600 * 0.5)
const SUMMARY_CAP = Math.floor(PROVIDER_AWARE_BUDGET * SUMMARY_SHARE); // 35,910

function seedAgentAndModels(db: Database.Database): void {
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`)
    .run(AGENT, 'Dry Run Test');

  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec)
    VALUES ('slow-provider', 'Slow', 'openai', 'api_key', 600000, 180)
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m, context_window)
    VALUES (?, 'slow-provider', 'Slow Model', ?, 1, '["text"]', 1, ?)
  `).run(CEILING_MODEL, CEILING_MODEL, CONTEXT_WINDOW);

  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type) VALUES ('cloud-provider', 'Cloud', 'openai', 'api_key')
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m, context_window)
    VALUES (?, 'cloud-provider', 'Cloud Model', ?, 1, '["text"]', 1, ?)
  `).run(NULL_MODEL, NULL_MODEL, CONTEXT_WINDOW);
}

/** A single summary carrying WAY more tokens than either budget could admit whole, so
 *  BOTH arms cap it — the question this file asks is at WHAT number. */
function seedHugeSummary(db: Database.Database): void {
  db.prepare(`
    INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count, earliest_at, latest_at, created_at)
    VALUES ('sum-huge', ?, 1, 'leaf', 'a very long summary', 500000, 4, '2026-08-01 09:00:00', '2026-08-01 10:00:00', '2026-08-01 10:00:00')
  `).run(AGENT);
  db.prepare(`
    INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', 'sum-huge', 0)
  `).run(AGENT);
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

describe('estimateAssembledTokens — RED: the dry run threads the provider-aware ceiling', () => {
  it('a declared 600s/180tps model caps the summary total at the SAME budget a real assembly would admit', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    const result = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL);

    expect(result.summaryTokens).toBe(SUMMARY_CAP);
    expect(result.total).toBe(SUMMARY_CAP);
  });

  it('CONTROL (byte-preservation, R6): a NULL-ceiling model is capped only by the raw window, unchanged', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    const withCeiling = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL);
    const withoutCeiling = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, NULL_MODEL);

    // The raw-window cap is far larger than the provider-aware one — the whole point of
    // the fixture — so the NULL-ceiling arm is NOT pinned to the smaller number.
    expect(withoutCeiling.summaryTokens).toBeGreaterThan(withCeiling.summaryTokens);
    expect(withoutCeiling.summaryTokens).toBeGreaterThan(SUMMARY_CAP);
  });

  it('CONTROL (byte-preservation, R6): an unknown modelId (undefined) is the same as before this task', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    const withoutModelId = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW);
    const withNullCeilingModel = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, NULL_MODEL);

    // `modelId` absent means "the reserve's own output-cap floor applies", the same
    // control `getModelOutputCap` already exercises for this argument — matching a
    // known-NULL-ceiling model's summary total confirms the ceiling side of the same
    // call is equally inert when the model is unknown.
    expect(withoutModelId.summaryTokens).toBe(withNullCeilingModel.summaryTokens);
  });
});
