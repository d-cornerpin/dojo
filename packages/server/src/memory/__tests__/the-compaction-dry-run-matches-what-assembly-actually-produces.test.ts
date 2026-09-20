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

// ════════════════════════════════════════════════════════════════════════════════════════
// T82 FIX WAVE, Important I1 — THE CEILING MUST COME FROM THE TURN MODEL, NOT THE (POSSIBLY
// REASSIGNED) OUTPUT-CAP MODEL.
//
// `runCheckAndCompact` (`memory/compaction.ts`) keys its EXTERNAL threshold on `turnModelId`
// (the box actually serving this agent's turns, captured before `resolveSummaryWriterModel` can
// reassign `modelId` to a cheaper/different-provider summary writer) — correct, and unchanged
// by this fix. But it passed the REASSIGNED writer model into this dry run for BOTH roles
// (output cap AND ceiling), so on a mixed config — an UNDECLARED turn model paired with a
// DECLARED-ceiling writer model — the dry run's own `assemblyBudgetTokens` shrank against a
// ceiling that has nothing to do with the box serving the turn, while the external threshold it
// is compared against stayed unceilinged (the turn model declared nothing). That asymmetry made
// the compaction trigger fire LATER than the R6 byte-preservation control promises for a
// genuinely undeclared row.
//
// `estimateAssembledTokens` now takes an optional `ceilingModelId`, threaded independently of
// `modelId` (which stays the output-cap source — unchanged). This suite drives that new
// parameter directly, matching exactly how `runCheckAndCompact` calls it.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('estimateAssembledTokens — I1: the ceiling model may differ from the output-cap model', () => {
  it('mixed config: a declared-ceiling model in the modelId (output-cap) position, an undeclared model in ceilingModelId — matches TODAY\'S un-ceilinged behavior, not the declared one', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    // The exact shape `runCheckAndCompact` produces on a mixed config: `modelId` is the
    // resolved summary-WRITER (here, the one with a declared ceiling — CEILING_MODEL stands in
    // for "the cheap floor model Settings resolved"), `ceilingModelId` is the UNDECLARED turn
    // model (NULL_MODEL stands in for "the cloud model actually serving this agent's turns").
    const mixed = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL, { ceilingModelId: NULL_MODEL });
    // The un-ceilinged control: an entirely undeclared model in BOTH roles.
    const unceilinged = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, NULL_MODEL);

    // Both models in this fixture declare no `max_output_tokens`, so the reserve (and therefore
    // the assembly budget) is identical whichever of the two sits in the output-cap position —
    // isolating this assertion to the ceiling side alone, which is this test's whole point.
    expect(mixed.summaryTokens).toBe(unceilinged.summaryTokens);
    expect(mixed.total).toBe(unceilinged.total);
    // And, the other half of the asymmetry this fix closes: the mixed call must NOT be capped
    // at the writer's declared ceiling — that would be the pre-fix defect (a caller with a
    // completely undeclared turn model still landing on the smaller, wrong number).
    expect(mixed.summaryTokens).toBeGreaterThan(SUMMARY_CAP);
  });

  it('CONTROL: ceilingModelId absent falls back to modelId — every pre-existing caller (single model, both roles) is byte-identical', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    const withoutOpts = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL);
    const withExplicitSameCeiling = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL, { ceilingModelId: CEILING_MODEL });

    expect(withExplicitSameCeiling.summaryTokens).toBe(withoutOpts.summaryTokens);
    expect(withExplicitSameCeiling.total).toBe(withoutOpts.total);
  });

  it('CONTROL: ceilingModelId genuinely drives the ceiling when modelId itself is undeclared (the reverse mix)', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    // Output-cap side undeclared (NULL_MODEL), ceiling side declared (CEILING_MODEL) — the
    // dry run should be capped at the SAME budget the single-model declared case produces.
    const reverseMix = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, NULL_MODEL, { ceilingModelId: CEILING_MODEL });
    const declaredBoth = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL);

    expect(reverseMix.summaryTokens).toBe(SUMMARY_CAP);
    expect(reverseMix.summaryTokens).toBe(declaredBoth.summaryTokens);
  });
});
