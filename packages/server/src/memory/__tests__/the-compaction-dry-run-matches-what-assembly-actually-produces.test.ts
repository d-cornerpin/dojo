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
// throughput -> ceiling 102,600 -> provider-aware budget 51,300.
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
import { assembleContext } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t82a-dry-run';
const CEILING_MODEL = 'slow-box-model';
const NULL_MODEL = 'cloud-model';
const CONTEXT_WINDOW = 200_000;
// The fixture's own pinned number (resolveDoomCeiling(600_000, 180) === 102_600, pinned
// already by `a-provider-declares-its-own-prefill-throughput.test.ts`; half of it is the budget).
const PROVIDER_AWARE_BUDGET = 51_300; // floor(102_600 * 0.5)

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

// ════════════════════════════════════════════════════════════════════════════════════════
// t194 (v3.4 D1, owner decision 7a): THE DRY RUN IS THE ASSEMBLER'S OWN FIT. The clauses that stood
// here pinned `estimateAssembledTokens`' private model of the summary admission — 0.7 × the
// provider-aware budget (35,910), a number the summaries lane never sends (it is capped at its own
// ceiling, 6,000) — and T82's `ceilingModelId` split, which existed only because the summary
// WRITER's id leaked into the measurement. Both are deleted: the gauge measures the view of the one
// model it is asked about, ceiling and output cap together. What the clauses protected — "the dry run
// honours the box's declared ceiling exactly as a real assembly does" — is asserted below as identity
// with the real assembly's own fit, which is strictly stronger than a remembered number.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('estimateAssembledTokens — the dry run honours the declared box ceiling exactly as assembly does', () => {
  it('a declared 600s/180tps model: the gauge\'s budget IS the real assembly\'s content budget', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    const gauge = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL);
    const real = await assembleContext(AGENT, CEILING_MODEL);

    expect(gauge.view.budgetTokens).toBe(real.allocation!.budgetTokens);
    expect(gauge.view.budgetTokens, 'and it is inside the declared ceiling\'s budget').toBeLessThan(PROVIDER_AWARE_BUDGET);
  });

  it('CONTROL (byte-preservation, R6): a NULL-ceiling model is bounded only by its window, and still equals assembly', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);

    const declared = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, CEILING_MODEL);
    const undeclared = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, NULL_MODEL);
    const real = await assembleContext(AGENT, NULL_MODEL);

    expect(undeclared.view.budgetTokens).toBe(real.allocation!.budgetTokens);
    expect(undeclared.view.budgetTokens).toBeGreaterThan(declared.view.budgetTokens);
  });

  it('the huge summary is admitted at what the summaries lane sends, on either box', async () => {
    const db = mockDb.current!;
    seedAgentAndModels(db);
    seedHugeSummary(db);
    for (const model of [CEILING_MODEL, NULL_MODEL]) {
      const gauge = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, model);
      const grant = (await assembleContext(AGENT, model)).allocation!.grants.find((g) => g.id === 'lane.summaries')!;
      expect(gauge.summaryTokens, model).toBe(grant.granted);
      expect(gauge.view.summaryRawTokens, 'what the agent holds is reported beside it').toBe(500_000);
    }
  });
});
