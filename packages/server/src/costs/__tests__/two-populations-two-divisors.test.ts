// ════════════════════════════════════════════════════════════════════════════════════════
// TWO POPULATIONS, TWO DIVISORS — and the design call BACKLOG line 36 deferred.
//
// ── THE QUESTION, AS THE BACKLOG LEFT IT ──
// Line 36 deferred "letting estimateTokens spend the learned divisor" and named the open item:
// "a per-population vs single-minimum design call". Line 56 is the same question from the other
// end: "estimator_chars_per_token pinned at 4.0 but provider-reported totals run 1.88-2.08x the
// estimate on dense prompts".
//
// ── THE CALL IS PER-POPULATION, AND THIS TREE'S OWN MEASUREMENTS MAKE IT, NOT A PREFERENCE ──
// Two readings of the same estimator are recorded durably, both from platform records:
//
//   `memory/budget.ts`'s derivation header, on PROSE:  /4 was 2% UNDER, /3.5 12% OVER, /3 30% OVER
//   the behavioural harness, on DENSE SCHEMA requests: the estimate ran 1.88-2.08x UNDER
//
// Inverted, a dense request charges at ~4/2.0 ≈ 1.9-2.1 chars/token against prose's ≈4.08 — two
// populations a factor of two apart. `measured_chars_per_token` is a MINIMUM over all rows, so
// the single-minimum answer is the DENSE one, and spending it on prose would over-estimate the
// dominant population by ~2.1x. The same header that set the 4 already ruled on that direction:
// "/3 30% over … A 30% over-estimate is not caution; it is the assembler dropping history the
// window did not require." A single minimum is that rejected 1.3x, doubled. So the single
// minimum is refused on the module's own recorded evidence, and the two populations are read
// separately. §THE DESIGN CALL below is that arithmetic as an executable clause, so the argument
// cannot rot into prose nobody re-checks.
//
// ── WHY IT IS MEASURABLE AT ALL, WHICH IS WHY IT WAS DEFERRED AND IS NOW POSSIBLE ──
// A whole-request ratio is all the ledger can measure, so the split needs PURE rows. Migration
// 181's `call_purpose` supplies them structurally: every engine utility dial passes `tools:
// false`, so a declared non-turn purpose is a request with no schema array — prose. A turn always
// carries the ~72 KB array. NULL establishes nothing, because unknown is not prose, and that is
// the one direction that could leave a consumer worse off than no reading at all.
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-two-populations', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { CHARS_PER_TOKEN } from '../../memory/budget.js';
import {
  isProseSample,
  PROSE_EXCLUDED_PURPOSES,
  recalibrateFromLedgerRow,
  resetRangeExclusionLogForTests,
  ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS,
  type EstimatorSample,
} from '../ledger-calibration.js';
import { isUtilityPurpose } from '../../agent/utility-dial.js';

const db = (): Database.Database => mockDb.current!;

/**
 * A qualifying row, parameterised by the chars-per-token it was REALLY charged at.
 * `estimated` tokens at the live divisor means `estimated * divisor` characters; billing those at
 * `realRatio` chars/token means `chars / realRatio` billed tokens. So the fixture is written in
 * the units the defect is reported in, and the module has to recover the ratio from the row.
 */
const rowChargedAt = (realRatio: number, callPurpose: string | null, estimated = 20_000): EstimatorSample => {
  const chars = estimated * CHARS_PER_TOKEN;
  return {
    estimatedInputTokens: estimated,
    divisorUsed: CHARS_PER_TOKEN,
    inputTokens: Math.round(chars / realRatio),
    latencyMs: 40_000,
    callPurpose,
  } as EstimatorSample;
};

const readings = (providerId = 'prov'): { all: number | null; prose: number | null } => {
  const r = db().prepare(`
    SELECT measured_chars_per_token AS all_rows, measured_chars_per_token_prose AS prose
      FROM providers WHERE id = ?
  `).get(providerId) as { all_rows: number | null; prose: number | null };
  return { all: r.all_rows, prose: r.prose };
};

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  resetRangeExclusionLogForTests();
  d.prepare(`
    INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))
  `).run();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('THE DESIGN CALL — why not a single minimum (BACKLOG line 36)', () => {
  // The two measurements this tree recorded, as numbers rather than as a story.
  const PROSE_MEASURED = 4.08;   // budget.ts header: /4 ran 2% UNDER the real cost
  const DENSE_MEASURED = 4 / 2.0; // BACKLOG 56: the estimate ran 1.88-2.08x UNDER → ~2.0 chars/token
  const REJECTED_OVER_ESTIMATE = 1.30; // budget.ts header: "/3 30% over" was refused

  it('a single minimum over-estimates prose by MORE than the factor this tree already refused', () => {
    const singleMinimum = Math.min(PROSE_MEASURED, DENSE_MEASURED);
    expect(singleMinimum).toBeCloseTo(DENSE_MEASURED, 6);
    // Spending the dense divisor on a prose request inflates the estimate by prose/dense.
    const inflation = PROSE_MEASURED / singleMinimum;
    expect(inflation).toBeGreaterThan(REJECTED_OVER_ESTIMATE);
    expect(
      inflation,
      'if this ever drops to or below the 1.30 this tree refused at /3, the single-minimum answer '
      + 'stops being refutable on these grounds and the design call must be re-argued from new '
      + 'measurements rather than inherited from this comment.',
    ).toBeGreaterThan(2.0);
  });

  it('the two populations really are far enough apart to be worth separating', () => {
    // If they ever converge, two readings cost complexity for nothing and this file is the place
    // the simplification gets argued — on the measurements, not on taste.
    expect(
      PROSE_MEASURED / DENSE_MEASURED,
      'the populations have converged; a single reading may now be the honest answer',
    ).toBeGreaterThan(1.5);
  });
});

describe('the two readings are taken from the same rows, separately', () => {
  it('RED-CRITICAL: a DENSE TURN does not move the PROSE reading', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(2.0, 'agent_turn'));
    const r = readings();
    expect(r.all, 'the all-rows reading must take every population').toBeCloseTo(2.0, 2);
    expect(
      r.prose,
      'a schema-dense agent turn established the PROSE divisor. Every prose estimate on this box '
      + 'then inflates ~2.1x — the single-minimum defect this split exists to avoid, arriving '
      + 'through the back door.',
    ).toBeNull();
  });

  it('RED-CRITICAL: a DECLARED PROSE DIAL sets the prose reading to the prose truth', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(4.08, 'ask_title'));
    expect(readings().prose).toBeCloseTo(4.08, 2);
  });

  it('both populations present: each reading lands on its OWN truth, not on the other', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(2.0, 'agent_turn'));
    recalibrateFromLedgerRow('prov', rowChargedAt(4.08, 'memory_summarize'));
    const r = readings();
    expect(r.all, 'the all-rows minimum is the dense one, by construction').toBeCloseTo(2.0, 2);
    expect(r.prose, 'the prose reading must NOT have been dragged down to the dense minimum').toBeCloseTo(4.08, 2);
  });

  it('a prose row feeds the all-rows reading too — it is the minimum over EVERY population', () => {
    // Excluding prose from the all-rows reading would silently turn it into a third, undeclared
    // reading, and the 174 column's meaning is load-bearing elsewhere.
    recalibrateFromLedgerRow('prov', rowChargedAt(4.08, 'ask_title'));
    expect(readings().all).toBeCloseTo(4.08, 2);
  });
});

describe('NULL establishes nothing — the load-bearing direction', () => {
  it('RED-CRITICAL: an UNDECLARED row cannot set the prose reading', () => {
    // Every row written before migration 181, and the five dials that stay undeclared on purpose.
    recalibrateFromLedgerRow('prov', rowChargedAt(4.08, null));
    expect(
      readings().prose,
      'an undeclared row established the PROSE divisor. "Unknown" is not "prose": such a row may '
      + 'be a dense turn, and seating the LARGER divisor on it is the only guess that can leave a '
      + 'consumer less safe than no reading at all.',
    ).toBeNull();
  });

  it('but it still feeds the conservative all-rows reading', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(3.0, null));
    expect(readings().all).toBeCloseTo(3.0, 2);
  });

  it('`isProseSample` refuses every non-string and every unknown word', () => {
    for (const v of [null, undefined, '', 'agent_turn', 'light', 'completion', 'not_a_purpose']) {
      expect(isProseSample(v as string | null | undefined), `admitted ${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe('the VISION dial is a declared utility purpose and is STILL refused', () => {
  it('RED-CRITICAL: `vision_caption` bills pixels, so it cannot measure a text tokeniser', () => {
    // Guard 4's floor catches the clear cases, but a small image beside a lot of text lands
    // INSIDE the legal range while still being part-pixel — and one such row pins a minimum.
    expect(isUtilityPurpose('vision_caption'), 'the premise: it IS a declared dial').toBe(true);
    recalibrateFromLedgerRow('prov', rowChargedAt(1.4, 'vision_caption'));
    expect(
      readings().prose,
      'a vision caption established the prose divisor. Its billed input counts pixels, which are '
      + 'not characters of a prompt, so the ratio is not a reading of a text tokeniser at all.',
    ).toBeNull();
  });

  it('the exclusion list names purposes that really exist — a typo would exclude nothing', () => {
    expect(PROSE_EXCLUDED_PURPOSES.length).toBeGreaterThan(0);
    for (const p of PROSE_EXCLUDED_PURPOSES) {
      expect(isUtilityPurpose(p), `${p} is not a declared purpose, so excluding it is a no-op`).toBe(true);
    }
  });
});

describe('the prose reading keeps every guard the all-rows reading has', () => {
  it('guard 1: a self-measuring row (char-derived input) establishes nothing', () => {
    recalibrateFromLedgerRow('prov', { ...rowChargedAt(4.08, 'ask_title'), inputTokensEstimated: true });
    expect(readings().prose).toBeNull();
  });

  it('guard 3: a row below the size floor establishes nothing', () => {
    recalibrateFromLedgerRow('prov',
      rowChargedAt(4.08, 'ask_title', ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS - 1));
    expect(readings().prose).toBeNull();
  });

  it('guard 4: a ratio outside the legal range establishes nothing', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(0.001, 'ask_title'));
    expect(readings().prose).toBeNull();
  });

  it('the one-way rule: a fresh prose sample ratchets the reading DOWN and never up by itself', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(4.08, 'ask_title'));
    expect(readings().prose).toBeCloseTo(4.08, 2);
    // A LOWER ratio must take, immediately.
    recalibrateFromLedgerRow('prov', rowChargedAt(3.20, 'ask_title'));
    expect(readings().prose).toBeCloseTo(3.20, 2);
    // A HIGHER one must not, while the stamp is fresh: only the daily rescan may let it rise.
    recalibrateFromLedgerRow('prov', rowChargedAt(4.50, 'ask_title'));
    expect(
      readings().prose,
      'a higher sample raised the reading on the hot path, which is the rule 174 and 167 both '
      + 'turn on: only the write path knows the numerator was billed, so only the rescan may rise.',
    ).toBeCloseTo(3.20, 2);
  });

  it('the stamp is written beside the reading, or a minimum could never rise again', () => {
    recalibrateFromLedgerRow('prov', rowChargedAt(4.08, 'ask_title'));
    const at = db().prepare(
      'SELECT measured_chars_per_token_prose_at AS at FROM providers WHERE id = ?',
    ).get('prov') as { at: string | null };
    expect(at.at).toBeTruthy();
  });
});
