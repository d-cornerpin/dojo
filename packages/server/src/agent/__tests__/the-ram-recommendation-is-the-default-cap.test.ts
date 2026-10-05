// ════════════════════════════════════════════════════════════════════════════════════════
// THE RAM RECOMMENDATION IS THE DEFAULT CAP.
// (t103 item C — OWNER RULING 2026-10-05, decision #2: "the RAM recommendation becomes the
//  DEFAULT CAP, user-overridable".)
//
// ── WHAT WAS MEASURED AT `09514572` ──────────────────────────────────────────────────
// t88 wired both knobs. `services/num-ctx-calculator.ts` sizes a KV window against the box's
// real obligations and stores it in `models.num_ctx_recommended`; `callOllamaModel` sent it as
// `options.num_ctx`, so OLLAMA was told the truth about the machine.
//
// The ENGINE was not. Every decision about how much prompt to BUILD reads
// `getContextWindow(modelId)` — `memory/assembler.ts`, `memory/budget.ts`'s policy, the
// compaction trigger, `reassemble-for-fit`, the recovery compactor — and that returned
// `models.context_window`, the model's ADVERTISED maximum. On a tight box the assembler packed a
// full advertised window into a KV cache sized for a fraction of it, and the recommendation sat
// beside a number it did not affect. That gap is the backlog's "small models still land at max
// context".
//
// ── THE RULE THIS FILE IS ────────────────────────────────────────────────────────────
//   §1  no override → the engine's window IS the recommendation;
//   §2  override set → the override wins;
//   §3  BOTH DIRECTIONS: no recommendation and no override → today's advertised window, exactly.
//       Every hosted provider is this row, so the change cannot reach one that has nothing to
//       say about itself. And neither knob may ever talk the budget ABOVE the advertised window;
//   §4  the WIRE: the one door the whole budget reads (`getContextWindow`) returns the capped
//       window, the wire and the budget share ONE precedence resolver, and the honest line is
//       emitted — not a refusal — when an override exceeds the recommendation.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { getContextWindow, resolveNumCtx, effectiveContextWindow } from '../model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

function stripped(file: string): string {
  return fs.readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const ADVERTISED = 131_072;

/** A model row with its provider, in the shape `getModelInfo`'s join reads. */
function seedModel(p: {
  modelId: string; providerType?: string; contextWindow?: number | null;
  override?: number | null; recommended?: number | null;
}): void {
  const db = mockDb.current!;
  db.prepare('INSERT OR REPLACE INTO providers (id, type, name, base_url) VALUES (?, ?, ?, ?)')
    .run(`prov-${p.modelId}`, p.providerType ?? 'ollama', 'P', 'http://localhost:11434');
  db.prepare(
    `INSERT OR REPLACE INTO models
       (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens,
        thinking_enabled, num_ctx_override, num_ctx_recommended)
     VALUES (?, ?, 'M', 'm:latest', '["text"]', ?, 4096, 1, ?, ?)`,
  ).run(
    p.modelId, `prov-${p.modelId}`,
    p.contextWindow === undefined ? ADVERTISED : p.contextWindow,
    p.override ?? null, p.recommended ?? null,
  );
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, type TEXT, name TEXT, base_url TEXT, auth_type TEXT,
      behaves_like TEXT, first_chunk_timeout_ms INTEGER, stream_idle_timeout_ms INTEGER,
      prefill_tokens_per_sec REAL, measured_prefill_tokens_per_sec REAL);
    CREATE TABLE models (
      id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, api_model_id TEXT, capabilities TEXT,
      context_window INTEGER, max_output_tokens INTEGER, thinking_enabled INTEGER,
      num_ctx_override INTEGER, num_ctx_recommended INTEGER);
  `);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════ §1 NO OVERRIDE → THE RECOMMENDATION BITES ════════════════════

describe('§1 with no override, the window the engine budgets against IS the recommendation', () => {
  it('a RAM-sized 24,576-token window caps a model advertising 131,072', () => {
    seedModel({ modelId: 'tight', recommended: 24_576 });
    expect(getContextWindow('tight')).toBe(24_576);
  });

  it('the recommendation is reported as the source, and it is the one that wins', () => {
    expect(resolveNumCtx({ numCtxOverride: null, numCtxRecommended: 24_576 }))
      .toEqual({ effective: 24_576, source: 'recommended' });
  });

  it('a recommendation ABOVE the advertised window cannot raise the budget', () => {
    // The sizer clamps to the model's own max, but a stale row from before a model was
    // re-added with a smaller window is reachable, and "take more than the model has" is the
    // one direction that costs a truncated prompt rather than a compaction.
    seedModel({ modelId: 'stale', contextWindow: 32_768, recommended: 200_000 });
    expect(getContextWindow('stale')).toBe(32_768);
  });
});

// ════════════════════ §2 AN OVERRIDE WINS ════════════════════

describe('§2 a user override wins when it is set', () => {
  it('the override beats the recommendation, in both directions', () => {
    seedModel({ modelId: 'lower', override: 8_192, recommended: 24_576 });
    expect(getContextWindow('lower')).toBe(8_192);
    seedModel({ modelId: 'higher', override: 65_536, recommended: 24_576 });
    expect(getContextWindow('higher')).toBe(65_536);
  });

  it('an override with NO recommendation still caps the budget', () => {
    seedModel({ modelId: 'only-override', override: 16_384, recommended: null });
    expect(getContextWindow('only-override')).toBe(16_384);
  });

  it('an override above the ADVERTISED window still cannot raise the budget', () => {
    seedModel({ modelId: 'greedy', override: 1_000_000, recommended: 24_576 });
    expect(getContextWindow('greedy')).toBe(ADVERTISED);
  });

  it('the resolver names the override as the source', () => {
    expect(resolveNumCtx({ numCtxOverride: 8_192, numCtxRecommended: 24_576 }))
      .toEqual({ effective: 8_192, source: 'override' });
  });
});

// ════════════════════ §3 BOTH DIRECTIONS — THE UNTOUCHED ROW ════════════════════

describe('§3 a model with neither knob set behaves exactly as it does today', () => {
  it('no override and no recommendation → the ADVERTISED window, unchanged', () => {
    seedModel({ modelId: 'hosted', providerType: 'anthropic', override: null, recommended: null });
    expect(getContextWindow('hosted')).toBe(ADVERTISED);
    expect(resolveNumCtx({ numCtxOverride: null, numCtxRecommended: null }))
      .toEqual({ effective: null, source: 'default' });
  });

  it('a NULL context_window still falls back to the standing default, uncapped', () => {
    seedModel({ modelId: 'unknown-window', contextWindow: null, override: null, recommended: null });
    expect(getContextWindow('unknown-window')).toBe(200_000);
  });

  it('an unknown model still answers with the standing fallback', () => {
    expect(getContextWindow('nobody')).toBe(200_000);
  });

  it('a nonsense num_ctx is ignored rather than believed', () => {
    // Zero, negative and non-finite are not windows. Believing one would hand the budget a
    // cap of nothing at all, which is worse than the defect this item repairs.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveContextWindow(ADVERTISED, bad), `${bad} was believed`).toBe(ADVERTISED);
    }
    expect(effectiveContextWindow(ADVERTISED, null)).toBe(ADVERTISED);
  });

  it('the cap is a `min`, as a property over a sweep', () => {
    for (const n of [512, 8_192, 24_576, 131_072, 262_144]) {
      expect(effectiveContextWindow(ADVERTISED, n)).toBe(Math.min(ADVERTISED, n));
    }
  });
});

// ════════════════════ §4 THE WIRE, BOTH DIRECTIONS ════════════════════

describe('§4 the wire — one precedence rule, one door, and an honest line', () => {
  const modelSrc = stripped(path.join(SRC, 'agent/model.ts'));
  const configSrc = stripped(path.join(SRC, 'gateway/routes/config.ts'));

  it('getContextWindow APPLIES the cap — the one door every budget reads', () => {
    // The call shape AND its application (G4). `getContextWindow` is what
    // `memory/assembler.ts`, `memory/budget.ts`, `reassemble-for-fit` and the recovery
    // compactor read, so capping it there is what makes the recommendation bite everywhere
    // without touching any of them.
    expect(modelSrc).toMatch(
      /return effectiveContextWindow\(info\.contextWindow, resolveNumCtx\(info\)\.effective\);/,
    );
  });

  it('getModelInfo still reports the ADVERTISED window — the utility dial depends on it', () => {
    // t88 widens `num_ctx` PER CALL for a dial with a large input (a screenshot caption asks
    // for more window than its one sentence would). Capping `getModelInfo().contextWindow`
    // made `validateAtProviderBoundary` refuse the very assembly the dial had just widened the
    // window for — measured, as a red in `the-utility-dial-reaches-the-wire`. This clause is
    // the record of that boundary.
    expect(modelSrc).toMatch(/contextWindow: row\.context_window \?\? 200000,/);
    expect(modelSrc).toMatch(/contextWindow: modelInfo\.contextWindow,\n\s+maxOutputTokens: modelInfo\.maxOutputTokens,/);
  });

  it('the WIRE and the BUDGET share ONE precedence resolver — no second copy', () => {
    // The both-directions half: two hand-rolled copies of "which knob wins" is how the number
    // Ollama is sent and the number the engine budgets for come to disagree. The Ollama call
    // site reads the same resolver, and the old ternaries are gone.
    expect(modelSrc).toMatch(
      /const \{ effective: effectiveNumCtx, source: numCtxSource \} = resolveNumCtx\(modelInfo\);/,
    );
    expect(
      [...modelSrc.matchAll(/typeof modelInfo\.numCtxOverride === 'number'/g)].length,
      'a hand-rolled num_ctx precedence ternary came back',
    ).toBe(0);
  });

  it('the num_ctx override door SAYS what the recommendation was, and refuses nothing', () => {
    // One honest line, not a block — the ruling's own shape. The route still writes the
    // override the user asked for; the response carries the comparison.
    expect(configSrc).toMatch(/const exceedsRecommended = typeof override === 'number' && recommended !== null && override > recommended;/);
    expect(configSrc).toMatch(/return c\.json\(\{ ok: true, data: rowToModel\(row\), notice \}\);/);
    // …and the write is unconditional: no arm of the route rejects on the comparison.
    const route = configSrc.slice(configSrc.indexOf("configRouter.patch('/models/:id/num-ctx'"));
    const body = route.slice(0, route.indexOf('configRouter.patch', 1));
    expect(body).toMatch(/UPDATE models SET num_ctx_override = \?/);
    expect(body).not.toMatch(/exceedsRecommended[\s\S]{0,80}return c\.json\(\{ ok: false/);
  });

  it('the API still reports the model\'s ADVERTISED window, not the capped one', () => {
    // The card must keep showing the model's real ceiling beside the recommendation. Quietly
    // restating the cap as the model's context window would make the two numbers agree by
    // lying about one of them.
    expect(configSrc).toMatch(/contextWindow: row\.context_window as number \| null,/);
  });
});
