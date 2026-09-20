// ════════════════════════════════════════════════════════════════════════════════════════
// T82a FIX WAVE (round 2) — THE FALLBACK ONLY PICKS A MODEL THE ASSEMBLY FITS.
//
// Round 1 fixed the router's INITIAL pick. Re-review found the same hole one layer deeper,
// reachable: `callWithRetryAndFallback` (`model-call.ts`) calls `router/selector.js`'s
// `selectModel` directly when the first dial fails, reassigns `modelId`, and redials the
// SAME array unchecked. A tier mixes cloud rows (no declared ceiling) with a declared-local
// row (600s/180tps) by design, so a fallback pick can be exactly as oversized as the
// original.
//
// THE FIX, driven end to end against a REAL scratch DB (so the selector's own fit filter and
// `reassembleForFitIfNeeded`'s `getProviderCeilingTokens` read the SAME seeded facts, never
// two independently-mocked answers that could drift):
//   FILTER-FIRST  — the fallback selection call carries the current assembled estimate; a
//                   candidate whose declared ceiling cannot cover it is excluded.
//   RESCUE-IF-EMPTIED — if that leaves nothing, but a candidate was excluded ONLY for fit,
//                   re-assemble against it (the SAME helper round 1 built) and re-select.
//
// R-FIXTURE (never a code constant): 600s/180tps -> ceiling 102,600 -> fit budget 51,300.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { stoppedAgents, preemptedAgents } from '../../../../shared-state.js';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

const callModelSpy = vi.fn();
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: (...a: unknown[]) => callModelSpy(...(a as [])),
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../../../../credentials/secret-values.js', () => ({
  hydrateCredentialsInMessages: (_agentId: string, messages: unknown) => messages,
}));
vi.mock('../../../../../credentials/secret-fields.js', () => ({
  noteDeclaredSecretsFromToolCalls: () => undefined,
}));
vi.mock('../../../../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 0 }));

const assembleContextSpy = vi.fn();
vi.mock('../../../../../memory/assembler.js', () => ({
  assembleContext: (...a: unknown[]) => assembleContextSpy(...(a as [])),
}));

import { callWithRetryAndFallback, type ModelCallInputs } from '../model-call.js';
import { runMigrations } from '../../../../../db/migrations.js';

const AGENT = 'kevin';
const CLOUD_MODEL = 'cloud-a';
const SLOW_MODEL = 'slow-b';
const CONTEXT_WINDOW = 200_000;

const SIXTY_K_TOKEN_BLOB = 'x'.repeat(240_000); // ~60,000 tokens via the /4 estimator
const THIRTY_K_TOKEN_BLOB = 'x'.repeat(120_000); // ~30,000 tokens

function seedTwoModelTier(db: Database.Database, opts: { slowDeclaresBoth: boolean }): void {
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`).run(AGENT, 'Kevin');

  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('cloud', 'Cloud', 'openai', 'api_key')`).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, context_window, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'cloud', 'Cloud A', ?, 1, '["tools","text"]', ?, 0, 0)
  `).run(CLOUD_MODEL, CLOUD_MODEL, CONTEXT_WINDOW);

  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec)
    VALUES ('slow-local', 'Slow Local', 'openai', 'api_key', ?, ?)
  `).run(opts.slowDeclaresBoth ? 600_000 : null, opts.slowDeclaresBoth ? 180 : null);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, context_window, output_cost_per_m, input_cost_per_m)
    VALUES (?, 'slow-local', 'Slow B', ?, 1, '["tools","text"]', ?, 0, 0)
  `).run(SLOW_MODEL, SLOW_MODEL, CONTEXT_WINDOW);

  const insertTierModel = db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');
  insertTierModel.run('standard', CLOUD_MODEL, 0);
  insertTierModel.run('standard', SLOW_MODEL, 1);
}

/** A second all-cloud tier, for the CONTROL that proves nothing changes when no
 *  candidate ever declares a ceiling. */
function seedAllCloudTier(db: Database.Database): void {
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`).run(AGENT, 'Kevin');
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('cloud', 'Cloud', 'openai', 'api_key')`).run();
  const insertModel = db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, context_window, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'cloud', ?, ?, 1, '["tools","text"]', ?, 0, 0)
  `);
  insertModel.run('cloud-a', 'Cloud A', 'cloud-a', CONTEXT_WINDOW);
  insertModel.run('cloud-b', 'Cloud B', 'cloud-b', CONTEXT_WINDOW);
  const insertTierModel = db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');
  insertTierModel.run('standard', 'cloud-a', 0);
  insertTierModel.run('standard', 'cloud-b', 1);
}

function ctxFor(overrides: Partial<ModelCallInputs> = {}): ModelCallInputs {
  return {
    agentId: AGENT,
    turnCtx: {} as ModelCallInputs['turnCtx'],
    turnNumber: 1,
    messageId: 'msg-1',
    messages: [{ role: 'user', content: SIXTY_K_TOKEN_BLOB }] as unknown as ModelCallInputs['messages'],
    systemPrompt: 'you are kevin',
    useTools: true,
    isAutoRouted: true,
    isA2ATurn: false,
    excludedModels: [],
    revertTriggerStampOnAbort: () => undefined,
    setAgentStatus: () => undefined,
    assembled: { systemVolatile: '', reserveTokens: 0 } as unknown as ModelCallInputs['assembled'],
    routerTier: 'standard',
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as ModelCallInputs['counterparty'],
    volatileFrom: 1,
    assemblyTurnContext: { latestUserSource: null },
    ...overrides,
  };
}

function freshState(): AgentTurnState {
  return advance(initState(AGENT, CLOUD_MODEL), { loopCount: 1 });
}

const OK_RESULT = {
  content: 'here you go', toolCalls: [], inputTokens: 10, outputTokens: 3, stopReason: 'end_turn',
};

beforeEach(() => {
  vi.clearAllMocks();
  stoppedAgents.clear();
  preemptedAgents.clear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T82a fix 2 — the fallback only picks a model the assembly fits', () => {
  it('RED: A fails on a 60K-assembled turn, B is fit-excluded, the rescue re-assembles to fit, and B is dialed with the trimmed array', async () => {
    seedTwoModelTier(mockDb.current!, { slowDeclaresBoth: true });
    callModelSpy.mockRejectedValueOnce(new Error('cloud-a exploded')).mockResolvedValue(OK_RESULT);
    assembleContextSpy.mockResolvedValue({
      systemPrompt: 'you are kevin (re-assembled for slow-b)',
      messages: [{ role: 'user', content: 'trimmed to fit slow-b' }],
      systemVolatile: '', reserveTokens: 0,
    });

    const out = await callWithRetryAndFallback(freshState(), CLOUD_MODEL, ctxFor());

    expect(out.abandoned).toBeUndefined();
    if (out.abandoned) throw new Error('unreachable');
    expect(out.modelId).toBe(SLOW_MODEL);

    // The ONE assembler was asked, once, for the rescue candidate.
    expect(assembleContextSpy).toHaveBeenCalledTimes(1);
    expect(assembleContextSpy).toHaveBeenCalledWith(AGENT, SLOW_MODEL, { latestUserSource: null });

    // Two dials: A (failed, original array) then B (succeeded, TRIMMED array).
    expect(callModelSpy).toHaveBeenCalledTimes(2);
    const [firstDial, secondDial] = callModelSpy.mock.calls.map((c) => c[0] as { modelId: string; messages: Array<{ content: unknown }> });
    expect(firstDial.modelId).toBe(CLOUD_MODEL);
    expect(firstDial.messages.map((m) => m.content)).toContain(SIXTY_K_TOKEN_BLOB);
    expect(secondDial.modelId).toBe(SLOW_MODEL);
    const secondContents = secondDial.messages.map((m) => m.content);
    expect(secondContents).not.toContain(SIXTY_K_TOKEN_BLOB);
    expect(secondContents).toContain('trimmed to fit slow-b');
  });

  it('CONTROL: a 30K estimate passes B\'s fit filter on the first try — no re-assembly', async () => {
    seedTwoModelTier(mockDb.current!, { slowDeclaresBoth: true });
    callModelSpy.mockRejectedValueOnce(new Error('cloud-a exploded')).mockResolvedValue(OK_RESULT);

    const out = await callWithRetryAndFallback(freshState(), CLOUD_MODEL, ctxFor({
      messages: [{ role: 'user', content: THIRTY_K_TOKEN_BLOB }] as unknown as ModelCallInputs['messages'],
    }));

    expect(out.abandoned).toBeUndefined();
    if (out.abandoned) throw new Error('unreachable');
    expect(out.modelId).toBe(SLOW_MODEL);
    expect(assembleContextSpy).not.toHaveBeenCalled();
    const secondDial = callModelSpy.mock.calls[1][0] as { messages: Array<{ content: unknown }> };
    expect(secondDial.messages.map((m) => m.content)).toContain(THIRTY_K_TOKEN_BLOB);
  });

  it('CONTROL: pinned-model retries are untouched — the fallback/selector path never runs', async () => {
    seedTwoModelTier(mockDb.current!, { slowDeclaresBoth: true });
    // A stream-idle timeout on a FIXED model earns exactly one same-model retry — the
    // pre-existing behaviour this fix must not disturb.
    callModelSpy
      .mockRejectedValueOnce(new Error('model stream idle timeout'))
      .mockResolvedValue(OK_RESULT);

    const out = await callWithRetryAndFallback(freshState(), CLOUD_MODEL, ctxFor({
      isAutoRouted: false,
    }));

    expect(out.abandoned).toBeUndefined();
    if (out.abandoned) throw new Error('unreachable');
    expect(out.modelId).toBe(CLOUD_MODEL); // same model both times — no fallback, no rescue
    expect(assembleContextSpy).not.toHaveBeenCalled();
    expect(callModelSpy).toHaveBeenCalledTimes(2);
    const secondDial = callModelSpy.mock.calls[1][0] as { messages: Array<{ content: unknown }> };
    expect(secondDial.messages.map((m) => m.content)).toContain(SIXTY_K_TOKEN_BLOB);
  });

  it('CONTROL: an all-cloud tier is zero new behaviour — no candidate ever declares a ceiling', async () => {
    seedAllCloudTier(mockDb.current!);
    callModelSpy.mockRejectedValueOnce(new Error('cloud-a exploded')).mockResolvedValue(OK_RESULT);

    const out = await callWithRetryAndFallback(freshState(), 'cloud-a', ctxFor());

    expect(out.abandoned).toBeUndefined();
    if (out.abandoned) throw new Error('unreachable');
    expect(out.modelId).toBe('cloud-b');
    expect(assembleContextSpy).not.toHaveBeenCalled();
    const secondDial = callModelSpy.mock.calls[1][0] as { messages: Array<{ content: unknown }> };
    expect(secondDial.messages.map((m) => m.content)).toContain(SIXTY_K_TOKEN_BLOB);
  });
});

// ── The shared-helper extraction: one implementation, two call sites, grep-zero duplicate ──
describe('the re-assemble-for-fit helper is not duplicated', () => {
  const CALL_LLM_DIR = path.resolve(__dirname, '..');
  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(path.join(d, e.name)); }
        else if (e.name.endsWith('.ts')) out.push(path.join(d, e.name));
      }
    };
    walk(CALL_LLM_DIR);
    return out;
  }

  it('exactly one file calls the real assembler (`assembleContext(agentId,`) in this package', () => {
    const hits = sourceFiles()
      .map((f) => ({ f, n: (fs.readFileSync(f, 'utf8').match(/assembleContext\(agentId,/g) ?? []).length }))
      .filter((r) => r.n > 0);
    expect(hits.map((r) => path.basename(r.f))).toEqual(['reassemble-for-fit.ts']);
    expect(hits[0].n).toBe(1);
  });

  it('both call sites import the SAME helper, not a re-implementation', () => {
    const index = fs.readFileSync(path.join(CALL_LLM_DIR, 'index.ts'), 'utf8');
    const modelCall = fs.readFileSync(path.join(CALL_LLM_DIR, 'model-call.ts'), 'utf8');
    expect(index).toMatch(/from '\.\/reassemble-for-fit\.js'/);
    expect(modelCall).toMatch(/from '\.\/reassemble-for-fit\.js'/);
  });
});
