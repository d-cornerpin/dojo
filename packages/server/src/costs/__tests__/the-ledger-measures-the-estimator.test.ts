// ════════════════════════════════════════════════════════════════════════════════════════
// LANE-3 — THE LEDGER MEASURES THE ESTIMATOR'S OWN DIVISOR.
//
// `memory/budget.ts:71` hand-sets `CHARS_PER_TOKEN = 4` and its header ends with an instruction:
// "Step 3 records the provider's own `input_tokens` beside this estimate on every call, so the
// error is measured and trending. Re-derive before changing it; never tune it." Nobody re-derived
// it; the behavioural harness did and measured 1.88-2.08x UNDER real billing on requests dominated
// by dense JSON tool schemas. `costs/ledger-calibration.ts` is that re-derivation as code — the
// arithmetic, the guards and the one-way rule are argued in its header, and this file is where each
// of them is proven against fixtures and then against a real migrated body.
//
// The clauses are deliberately arithmetic-first: the number this module produces is one a future
// consumer will spend on admission and compaction decisions, so "it wrote something to a column" is
// not the property worth pinning. What is worth pinning is that the ratio is computed from the
// BILLED input including cached prefix, that a row which measures the estimator against itself
// establishes nothing, and that the fold is a MINIMUM that can fall on a fresh sample and rise only
// through the window rescan.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-ledger-calibration', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { CHARS_PER_TOKEN } from '../../memory/budget.js';
import {
  charsPerTokenFrom,
  measuredCharsPerToken,
  recalibrateFromLedgerRow,
  ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS,
  type EstimatorSample,
} from '../ledger-calibration.js';

/** A qualifying row: `estimated` tokens estimated at the live divisor, `billed` really billed. */
const sample = (estimated: number, billed: number, over: Partial<EstimatorSample> = {}): EstimatorSample => ({
  estimatedInputTokens: estimated,
  divisorUsed: CHARS_PER_TOKEN,
  inputTokens: billed,
  ...over,
});

// ════════════════════════════════════════════════════════════════════════
// 1 — THE ARITHMETIC
// ════════════════════════════════════════════════════════════════════════

describe('LANE-3 — what one row says the divisor really is', () => {
  it('the measured ratio is chars over BILLED tokens', () => {
    // 10,000 estimated at 4 chars/token = 40,000 chars; the provider billed 20,000 tokens for
    // them, so this request really ran at 2 chars/token — the measured 2x undercount, exactly.
    expect(charsPerTokenFrom(sample(10_000, 20_000))).toBeCloseTo(2, 10);
    // An honest prose request comes back at the asserted constant, which is why the constant is
    // not simply wrong: it is right for one population and wrong for another.
    expect(charsPerTokenFrom(sample(10_000, 10_000))).toBeCloseTo(CHARS_PER_TOKEN, 10);
  });

  it('CACHED prefix counts as input, because the provider processed and billed it', () => {
    // The same request with a warm cache: 5,000 uncached + 15,000 cache reads = 20,000 billed.
    const withCache = charsPerTokenFrom(sample(10_000, 5_000, { cacheReadTokens: 15_000 }));
    expect(withCache).toBeCloseTo(2, 10);
    // THE COUNTERFACTUAL that makes this clause load-bearing: ignoring the cache columns reads
    // 8 chars/token — DOUBLE the asserted constant and in the dangerous direction (a larger
    // divisor means a smaller estimate), on the very rows a cache-friendly platform produces most.
    expect(10_000 * CHARS_PER_TOKEN / 5_000).toBe(8);
    expect(charsPerTokenFrom(sample(10_000, 5_000, { cacheCreationTokens: 15_000 }))).toBeCloseTo(2, 10);
  });

  it('the fold is a MINIMUM — the divisor that under-estimates nothing the box has processed', () => {
    expect(measuredCharsPerToken([sample(10_000, 10_000), sample(10_000, 20_000), sample(10_000, 13_333)]))
      .toBeCloseTo(2, 3);
    expect(measuredCharsPerToken([])).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2 — THE GUARDS. Each one is a row that must establish NOTHING.
// ════════════════════════════════════════════════════════════════════════

describe('LANE-3 — a row that cannot measure the estimator is refused', () => {
  it('guard 1: a row whose input count was itself char-derived measures the estimator against itself', () => {
    // Dividing an estimate by an estimate always answers the divisor in force, which would pin
    // the reading at 4 forever and call it a measurement.
    expect(charsPerTokenFrom(sample(10_000, 20_000, { inputTokensEstimated: true }))).toBeNull();
  });

  it('guard 2: a row written under a DIFFERENT divisor describes a different estimator', () => {
    expect(charsPerTokenFrom(sample(10_000, 20_000, { divisorUsed: 3.5 }))).toBeNull();
    expect(charsPerTokenFrom(sample(10_000, 20_000, { divisorUsed: null }))).toBeNull();
  });

  it('guard 3: a tiny estimate is rounding noise, not a measurement', () => {
    expect(charsPerTokenFrom(sample(ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS - 1, 4_000))).toBeNull();
    expect(charsPerTokenFrom(sample(ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS, 4_000))).not.toBeNull();
  });

  it('a row the provider billed nothing for is not a ratio', () => {
    expect(charsPerTokenFrom(sample(10_000, 0))).toBeNull();
    expect(charsPerTokenFrom({ estimatedInputTokens: null, divisorUsed: CHARS_PER_TOKEN, inputTokens: 10 })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3 — THE LIVE PATH, against a real migrated body.
// ════════════════════════════════════════════════════════════════════════

const seedProvider = (): void => {
  mockDb.current!.prepare(`
    INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local floor model', 'openai-compatible', 'none', 1, datetime('now'), datetime('now'))
  `).run();
};

/** One ledger row, `ageDays` old, carrying both halves of the comparison. */
const seedCostRow = (id: string, estimated: number, billed: number, ageDays = 0): void => {
  mockDb.current!.prepare(`
    INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                              cost_usd, latency_ms, estimated_input_tokens, estimator_chars_per_token, created_at)
    VALUES (?, 'agent-1', 'm-local', 'local', ?, 10, 0, 1000, ?, ?, datetime('now', ?))
  `).run(id, billed, estimated, CHARS_PER_TOKEN, `-${ageDays} days`);
};

const reading = (): { divisor: number | null; at: string | null } =>
  mockDb.current!.prepare(
    'SELECT measured_chars_per_token AS divisor, measured_chars_per_token_at AS at FROM providers WHERE id = ?',
  ).get('local') as { divisor: number | null; at: string | null };

const ageTheReading = (days: number): void => {
  mockDb.current!.prepare(
    "UPDATE providers SET measured_chars_per_token_at = datetime('now', ?) WHERE id = 'local'",
  ).run(`-${days} days`);
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seedProvider();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('LANE-3 — migration 174 gives the reading somewhere to live', () => {
  it('the two columns exist on a migrated body, NULL until something measures', () => {
    const cols = (mockDb.current!.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('measured_chars_per_token');
    expect(cols).toContain('measured_chars_per_token_at');
    expect(reading()).toEqual({ divisor: null, at: null });
  });
});

describe('LANE-3 — recordCost\'s one door folds the row into the reading', () => {
  it('a qualifying call establishes the measured divisor', () => {
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor).toBeCloseTo(2, 10);
    expect(reading().at).not.toBeNull();
  });

  it('a WORSE sample ratchets the reading down immediately', () => {
    recalibrateFromLedgerRow('local', { inputTokens: 13_333, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor).toBeCloseTo(3, 3);
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor).toBeCloseTo(2, 10);
  });

  it('THE ONE-WAY RULE: a kinder sample cannot raise a fresh reading', () => {
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    recalibrateFromLedgerRow('local', { inputTokens: 10_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor, 'the write path raised the reading without a window rescan').toBeCloseTo(2, 10);
  });

  it('a non-qualifying call leaves the column exactly as it was', () => {
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN, inputTokensEstimated: true });
    expect(reading()).toEqual({ divisor: null, at: null });
  });

  it('a STALE reading may RISE through the window rescan — a minimum whose row aged out', () => {
    // Establish 2.0, then age the stamp past the rescan cadence and leave only a 3.0-ratio row in
    // the window: the fresh sample cannot raise it, and the rescan can.
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor).toBeCloseTo(2, 10);
    ageTheReading(2);
    seedCostRow('row-3', 10_000, 13_333, 1);
    recalibrateFromLedgerRow('local', { inputTokens: 13_333, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor, 'the rescan could not let the minimum rise after its row aged out').toBeCloseTo(3, 3);
  });

  it('the rescan reads the window through the SAME guards, not a second copy of them in SQL', () => {
    // A window full of rows written under a different divisor supports no reading, so a stale
    // reading is left in hand rather than cleared on a technicality.
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    ageTheReading(2);
    mockDb.current!.prepare(
      "UPDATE cost_records SET estimator_chars_per_token = 3.5 WHERE provider_id = 'local'",
    ).run();
    recalibrateFromLedgerRow('local', { inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor).toBeCloseTo(2, 10);
  });

  it('an unknown provider is a no-op, never a throw — accounting owes the instrument nothing', () => {
    expect(() => recalibrateFromLedgerRow('no-such-provider', {
      inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN,
    })).not.toThrow();
  });
});
