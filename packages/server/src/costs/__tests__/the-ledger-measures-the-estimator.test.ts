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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-ledger-calibration', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

/** Every line the module logged, so the "excluded AND said so" clause can read it. The platform
 *  logger writes through its own sink, so the module boundary is where a test can see it. */
const logged: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: (message: string, meta?: Record<string, unknown>) => { logged.push({ level: 'info', message, meta }); },
    warn: (message: string, meta?: Record<string, unknown>) => { logged.push({ level: 'warn', message, meta }); },
    error: (message: string, meta?: Record<string, unknown>) => { logged.push({ level: 'error', message, meta }); },
    debug: () => {},
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import { CHARS_PER_TOKEN } from '../../memory/budget.js';
import {
  charsPerTokenFrom,
  rawCharsPerTokenFrom,
  isLegalCharsPerToken,
  measuredCharsPerToken,
  recalibrateFromLedgerRow,
  resetRangeExclusionLogForTests,
  ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS,
  ESTIMATOR_CHARS_PER_TOKEN_MIN,
  ESTIMATOR_CHARS_PER_TOKEN_MAX,
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

  it('guard 2: a divisor must be a positive finite number — but NOT the constant any more', () => {
    // ⚠ THIS CLAUSE WAS DELIBERATELY WIDENED BY t108 (BACKLOG 56), and this is where the change
    // is argued rather than discovered. Its previous form asserted
    // `charsPerTokenFrom(sample(10_000, 20_000, { divisorUsed: 3.5 })) === null` — "a row written
    // under a DIFFERENT divisor describes a different estimator".
    //
    // WHY THAT NO LONGER HOLDS. `memory/budget.ts`'s `estimateRequestTokens` now divides each
    // population by that provider's own MEASURED reading, so `estimator_chars_per_token`
    // legitimately differs PER REQUEST and `costs/tracker.ts` stores the one that really produced
    // the estimate. Under the old equality, every row from a box that had measured itself would
    // be skipped and the reading would freeze at whatever it was the day the box began spending
    // it — a silent, self-sealing failure, strictly worse than having no reading.
    //
    // WHY WIDENING IT IS SAFE, which is the half that matters. The module computes
    // `chars = estimatedInputTokens * divisorUsed`, which is the exact INVERSE of the arithmetic
    // that produced the row, so it recovers this request's character count exactly whatever
    // divisor was used. No rescaling happens and no error term appears — the thing being measured
    // is the PROVIDER'S tokeniser, which is indifferent to what we guessed. The old guard's
    // stated worry ("rescaling assumes the estimator's error is linear in the divisor") was about
    // a divisor that moved only when someone edited a constant, and it does not apply to an
    // exact inverse.
    //
    // WHAT STILL FAILS, and it is the guard's real content: a divisor that is not a number.
    expect(charsPerTokenFrom(sample(10_000, 20_000, { divisorUsed: null })),
      'the estimate and its divisor must travel together; without one, `chars` is meaningless')
      .toBeNull();
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(charsPerTokenFrom(sample(10_000, 20_000, { divisorUsed: bad })),
        `divisorUsed ${String(bad)} is not a divisor`).toBeNull();
    }
    // AND WHAT NOW MEASURES: a row recorded under a measured divisor. 10,000 tokens estimated at
    // 3.5 chars/token is 35,000 characters; billed 20,000 tokens, that is 1.75 chars/token —
    // recovered exactly, which is the property the widening rests on.
    expect(charsPerTokenFrom(sample(10_000, 20_000, { divisorUsed: 3.5 })))
      .toBeCloseTo(35_000 / 20_000, 10);
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
// 2b — GUARD 4, THE LEGAL RANGE (review C, L3-F2). 167's reader-side discipline, mirrored.
// ════════════════════════════════════════════════════════════════════════

describe('a ratio no tokeniser could charge is not a measurement', () => {
  // THE POISONED ROW, verbatim from the review: it passes guards 1-3 and yields 0.001, and the daily
  // rescan cannot rescue it because the row is inside its own window and the rescan takes the min too.
  // It is not a corrupt record — it is the shape of a VISION call, where the provider bills thousands
  // of input tokens for pixels that are not characters of a prompt.
  const poisoned: EstimatorSample = {
    estimatedInputTokens: 2_000, divisorUsed: CHARS_PER_TOKEN, inputTokens: 0, cacheReadTokens: 8_000_000,
  };

  it('the poisoned row still computes 0.001 RAW — the guards above really do admit it', () => {
    expect(rawCharsPerTokenFrom(poisoned)).toBeCloseTo(0.001, 6);
  });

  it('RED-CRITICAL: and the range EXCLUDES it, so it can never establish the reading', () => {
    expect(charsPerTokenFrom(poisoned)).toBeNull();
  });

  it('the fold keeps the honest rows when a poisoned one is in the set', () => {
    // Without the range this returns 0.001 and every future estimate inflates 4000x.
    expect(measuredCharsPerToken([sample(10_000, 10_000), poisoned, sample(10_000, 10_000)]))
      .toBeCloseTo(CHARS_PER_TOKEN, 10);
  });

  it('both review-measured extremes are refused, and the boundaries themselves are legal', () => {
    expect(isLegalCharsPerToken(8_000)).toBe(false);
    expect(isLegalCharsPerToken(8e-9)).toBe(false);
    expect(isLegalCharsPerToken(ESTIMATOR_CHARS_PER_TOKEN_MIN)).toBe(true);
    expect(isLegalCharsPerToken(ESTIMATOR_CHARS_PER_TOKEN_MAX)).toBe(true);
    expect(isLegalCharsPerToken(ESTIMATOR_CHARS_PER_TOKEN_MIN - 0.001)).toBe(false);
    expect(isLegalCharsPerToken(ESTIMATOR_CHARS_PER_TOKEN_MAX + 0.001)).toBe(false);
    expect(isLegalCharsPerToken(Number.NaN)).toBe(false);
    expect(isLegalCharsPerToken(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('the floor is the load-bearing bound: a text row just inside it still measures', () => {
    // 4,000 estimated tokens at 4 chars/token = 16,000 chars billed as 16,000 tokens = exactly 1.0.
    expect(charsPerTokenFrom(sample(4_000, 16_000))).toBeCloseTo(1, 10);
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

  it('THE POISONED ROW ON THE LIVE PATH: the column is left alone, and the exclusion is LOGGED', () => {
    resetRangeExclusionLogForTests();
    logged.length = 0;
    // First an honest reading, so there is something a poisoned row could have destroyed.
    recalibrateFromLedgerRow('local', { inputTokens: 10_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN });
    expect(reading().divisor).toBeCloseTo(CHARS_PER_TOKEN, 10);
    const before = reading();

    // Then the vision-shaped row: 2,000 estimated, 8,000,000 billed → 0.001.
    recalibrateFromLedgerRow('local', { inputTokens: 0, latencyMs: 1_000, estimatedInputTokens: 2_000, divisorUsed: CHARS_PER_TOKEN, cacheReadTokens: 8_000_000 });
    expect(reading(), 'the poisoned row moved the stored reading').toEqual(before);

    const line = logged.find((l) => l.message.includes('outside the legal range'));
    expect(line, 'the exclusion was silent — a silent exclusion and a silent poisoning look the same '
      + `from outside. Logged instead: ${JSON.stringify(logged.map((l) => l.message))}`).toBeTruthy();
    expect(line?.meta?.ratio).toBeCloseTo(0.001, 6);
    expect(String(line?.meta?.likelyCause)).toContain('not characters of a prompt');

    // ...and it says so ONCE per provider, so a vision-heavy box does not fill its log with it.
    const firstCount = logged.filter((l) => l.message.includes('outside the legal range')).length;
    recalibrateFromLedgerRow('local', { inputTokens: 0, latencyMs: 1_000, estimatedInputTokens: 2_000, divisorUsed: CHARS_PER_TOKEN, cacheReadTokens: 8_000_000 });
    expect(logged.filter((l) => l.message.includes('outside the legal range')).length).toBe(firstCount);
  });

  it('an unknown provider is a no-op, never a throw — accounting owes the instrument nothing', () => {
    expect(() => recalibrateFromLedgerRow('no-such-provider', {
      inputTokens: 20_000, latencyMs: 1_000, estimatedInputTokens: 10_000, divisorUsed: CHARS_PER_TOKEN,
    })).not.toThrow();
  });
});
