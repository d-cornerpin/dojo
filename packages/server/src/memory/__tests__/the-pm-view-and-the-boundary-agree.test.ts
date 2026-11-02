// ════════════════════════════════════════════════════════════════════════════════════════
// The PM's gauge and the provider-boundary validator must read ONE budget.
//
// Paid run H9: the compaction check said the PM's view was 98,153 tokens against a budget of
// 98,963 (it fits, nothing to fold), and the same turn's boundary validator counted 100,187
// against the SAME 98,963 and refused (`ASSEMBLY_VALIDATION_UNREPAIRABLE`), forcing a
// mid-turn condense. Cause: the PM's lightweight assembly filled the whole of
// `assemblyBudget - systemPrompt` with conversation and reserved nothing for what the loop
// appends AFTER the fit (turn context, current time, hints) - the off-the-top reserve ladder
// every other agent's assembly takes (`reserveLadderFor`). The view (the gauge) is that same
// fit, so it reported "fits" for an array the loop then grew past the boundary.
//
// Fictional rows only.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

import { assembleContext, measureView } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';
import { contextWindowPolicy, estimateTokens } from '../budget.js';
import { validateAssembly, assemblyTokens, type ValidatedMessage } from '../assembly-validation.js';
import { reserveLadderFor, POST_BUDGET_LANES } from '../lanes.js';
import { measureAgentToolPayloadTokens } from '../../tools/tool-docs.js';

const PM = 'pm';
const MODEL = 'pm-boundary-model';
const WINDOW = 128000;

const db = (): Database.Database => mockDb.current!;
let seq = 0;

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'pmb', 'PM B', ?, 4096, '["tools"]')`,
  ).run(MODEL, WINDOW);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'PM', 'idle', ?, '{}')").run(PM, MODEL);
}

function row(role: string, content: string): void {
  seq += 1;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES (?, ?, ?, 'owner', 'owner', ?, ?, 'user-visible', ?, 'live', 1, ?)`,
  ).run(`pmb-${seq}`, PM, role, content, role === 'assistant' ? 'agent-text' : 'user-text', seq, 1785000000000 + seq * 1000);
}

beforeEach(() => { seq = 0; mockDb.current = new Database(':memory:'); runMigrations(); seed(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the PM gauge and the boundary validator share one budget', () => {
  it('a PM tail that fills its room still leaves the loop-tail room under the boundary budget', async () => {
    // A long conversation: far more than the window holds, in rows of ~2,000 tokens each.
    const big = 'The filing task is waiting on validation and the report task is on deck. '.repeat(110);
    for (let i = 0; i < 120; i += 1) row(i % 2 === 0 ? 'user' : 'assistant', `${i}: ${big}`);

    const ctx = await assembleContext(PM, MODEL);
    const view = await measureView(PM, MODEL, { contextWindow: WINDOW });
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: await measureAgentToolPayloadTokens(PM), maxOutputTokens: 4096 });
    const boundaryBudget = policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt);

    // The gauge and the fit are one number (a dry run IS the fit).
    expect(view.tailKeptTokens).toBeLessThanOrEqual(view.budgetTokens);
    // What the loop appends after the fit: the declared post-budget ladder every other agent reserves.
    const loopTail = POST_BUDGET_LANES.find((l) => l.id === 'lane.loop-tail')!.reserveTokens;
    const appended: ValidatedMessage[] = [...ctx.messages, { role: 'user', content: 'x'.repeat(loopTail * 4) } as ValidatedMessage];

    expect(assemblyTokens(ctx.messages) + loopTail, 'the PM tail left no room for what the loop appends')
      .toBeLessThanOrEqual(boundaryBudget);
    expect(validateAssembly(appended, { budgetTokens: boundaryBudget }).ok, 'the boundary refuses what the gauge called a fit').toBe(true);
    // And the budget the view reports is the content budget the other agents' assembly uses.
    expect(view.budgetTokens).toBe(boundaryBudget - reserveLadderFor(boundaryBudget, 0).offTheTop);
  });
});
