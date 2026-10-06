// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT ONE COST ROW TEACHES THE BOX — the estimator's divisor, observed instead of asserted.
//
// OWNER DESIGN RULING, 2026-09-22, verbatim, the same one `prefill-calibration.ts` was written
// under: "never ask the user for a number the platform can observe."
//
// ── THE NUMBER, AND WHY IT IS A DEFECT AND NOT A NICETY ──
// Every token estimate in this tree is `ceil(chars / CHARS_PER_TOKEN)` with the divisor hand-set
// to 4 (`memory/budget.ts:71`). That file's own header records the derivation — /4 measured 2%
// UNDER the real cost, /3.5 12% over, /3 30% over — and ends with an instruction to whoever came
// next: "Step 3 records the provider's own `input_tokens` beside this estimate on every call, so
// the error is measured and trending. Re-derive before changing it; never tune it."
//
// Nobody re-derived it. The behavioural harness did, from these same rows, and measured the
// estimate running 1.88-2.08x UNDER what the provider billed. That does not refute the header: it
// is a DIFFERENT POPULATION. 4 chars/token is about right for prose and about twice too generous
// for a request dominated by a 72 KB JSON tools array. A single global constant cannot be right
// for both, which is exactly why the answer is to observe it per provider rather than to pick a
// better constant — and why this module REFUSES to be a place where someone tunes one (there is no
// tunable here; the only numbers are the qualification guards and the legal range, each with its own
// argument — and review C caught that first sentence being true of the guards while the RANGE was
// missing entirely, which is the one gap a minimum-fold cannot survive: see guard 4).
//
// ── THE ARITHMETIC ──
// Migration 149 put both halves of the comparison in every row: `estimated_input_tokens` (what the
// estimator said the input would cost) and `estimator_chars_per_token` (the divisor that produced
// it), beside the provider's own billed counts — `input_tokens` plus `cache_read_tokens` and
// `cache_creation_tokens` (migration 086). So:
//
//     chars           = estimatedInputTokens * divisorUsed
//     billed tokens   = inputTokens + cacheReadTokens + cacheCreationTokens
//     charsPerToken   = chars / billed tokens
//
// That is EXACT for that request — not a bound, which is the one way this module's claim differs
// from the prefill speedometer's. What makes a MINIMUM the right fold is the population argument
// above: the smallest ratio a provider has ever charged us at is the only divisor that does not
// under-estimate anything that box has actually been asked to process. It approaches the truth
// from ABOVE (a smaller divisor yields a LARGER estimate), which is the safe side of every
// decision an estimate feeds — admission plans smaller, compaction fires sooner, a pre-dial fit
// check refuses sooner. The mirror of 167's "an under-measured box is a cautious box".
//
// ── THE THREE GUARDS, AND WHY EACH EXISTS ──
//  1. THE NUMERATOR MUST BE BILLED. `agent/model.ts` has one branch where `inputTokens` is itself
//     char-derived (an OpenAI-compatible stream with no usage block). Dividing an estimate by an
//     estimate measures the estimator against itself and always answers `divisorUsed`, which would
//     silently pin the reading at 4 forever. `recordCost` already knows which rows those are and
//     passes `inputTokensEstimated`; such a row establishes nothing.
//  2. THE DIVISOR MUST BE THE ONE IN FORCE. A row written under a different divisor describes a
//     different estimator; `tracker.ts`'s own comment at the INSERT makes the same point ("4-chars
//     and 3.5-chars rows are different measurements and a trend that mixes them silently is #14's
//     class"). Rows whose `estimator_chars_per_token` is not the live constant are skipped rather
//     than rescaled, because rescaling assumes the estimator's error is linear in the divisor and
//     nothing has measured that.
//  3. A SIZE FLOOR. `ceil()` quantises a small estimate — at 50 estimated tokens one token of
//     rounding is a 2% error in the ratio — and a tiny request is also unrepresentative of the
//     decisions the reading exists to inform (they are all about large ones). 2,000 estimated
//     tokens puts the rounding error under 0.05% and is far below any real turn on this platform
//     (the owner's measured range is 42-52K), so the floor excludes noise without excluding the
//     measurement. It is deliberately LOWER than the prefill module's 4,000: that floor defends
//     against a batch effect in a rate, and there is no batch effect in a ratio — only rounding.
//
// ── THE ONE-WAY RULE, MIRRORED ──
// The live write path is the only place that can know whether `inputTokens` was billed (guard 1);
// the window rescan reads raw rows and cannot tell. So, exactly as in `prefill-calibration.ts` but
// in the opposite direction: a fresh sample ratchets the reading DOWN in O(1) on every qualifying
// call, and the daily rescan may only let it RISE. The property that buys: the stored reading can
// never be smaller than the minimum over samples the write path approved, so a historical
// self-measuring row can at worst prevent a legitimate rise.
//
// ── WHAT THIS MODULE IS NOT ──
// It is not a second estimator, and `estimateTokens` does not read it YET — that function is
// provider-agnostic and called from 71 sites, so spending this reading is its own change with its
// own blast radius (argued in the lane report rather than smuggled in here). It arms no clock: the
// recompute happens inline on the call that produced a qualifying row, and the staleness question
// is answered by SQLite comparing two of its own timestamps.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { CHARS_PER_TOKEN } from '../memory/budget.js';
import { isUtilityPurpose } from '../agent/utility-dial.js';
import { recalibrateFromSample, type PrefillSample } from './prefill-calibration.js';

const logger = createLogger('ledger-calibration');

/** Providers already reported as producing an out-of-legal-range row this process. See guard 4. */
const rangeExcluded = new Set<string>();

/** Test seam: forget which providers have already been reported. */
export function resetRangeExclusionLogForTests(): void {
  rangeExcluded.clear();
}

/** Guard 3: the smallest estimate a row may carry and still establish a reading. See the header. */
export const ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS = 2_000;

/** How far back the rolling window reaches — the same 30 days the prefill reading uses, for the
 *  same reason: long enough that an ordinary week still holds a big call, short enough that a
 *  model swap or an endpoint change ages out in a month rather than never. */
export const ESTIMATOR_SAMPLE_WINDOW_DAYS = 30;

/** How stale a stored reading may be before the next qualifying call pays for a window rescan. */
export const ESTIMATOR_RESCAN_AFTER = '-1 day';

/** One `cost_records` row, reduced to the fields this reading needs. */
export interface EstimatorSample {
  /** `estimated_input_tokens` — what the estimator said this request's input would cost. */
  estimatedInputTokens: number | null | undefined;
  /** The divisor that produced that estimate (`estimator_chars_per_token`). */
  divisorUsed: number | null | undefined;
  /** `input_tokens` — the BILLED, UNCACHED input. */
  inputTokens: number;
  /** `cache_read_tokens` / `cache_creation_tokens`: input the provider processed and billed too. */
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  /** True when `inputTokens` is itself char-derived — guard 1. Such a row establishes nothing. */
  inputTokensEstimated?: boolean;
  /** `call_purpose` (migration 181) — WHAT the call was, whatever the router decided. This is the
   *  axis that makes the population split measurable; see `isProseSample`. */
  callPurpose?: string | null;
}

/**
 * ── THE POPULATION PREDICATE, and the whole reason migration 181 added a column ──
 *
 * A whole-request ratio is all the ledger can measure, so a per-population reading needs rows
 * that are PURE. A row whose `call_purpose` names one of the engine's own declared utility
 * purposes is exactly that: every engine utility dial passes `tools: false` — asserted over all
 * fourteen of them by `costs/__tests__/a-utility-dial-is-not-an-agent-turn.test.ts`, which goes
 * red if a fifteenth appears or an existing one starts shipping schemas — so such a request
 * carries NO tools array and its characters are prose. A served turn always carries the ~72 KB
 * schema array, which is the dense population `measured_chars_per_token` already reads.
 *
 * NULL ESTABLISHES NOTHING, and that direction is the load-bearing one. Every row written before
 * 181, and the five dials that deliberately stay undeclared, carry NULL — and "unknown" is not
 * "prose". Admitting them would seat the PROSE reading on rows that may be dense, and the prose
 * reading is the one a caller spends on the LARGER divisor; a wrong guess there is the only
 * direction that can make a consumer less safe than no reading at all.
 *
 * `vision_caption` IS A DECLARED UTILITY PURPOSE AND IS STILL REFUSED, for guard 4's measured
 * reason rather than a new one: that dial's billed input counts PIXELS, which are not characters
 * of a prompt, so its ratio does not measure a text tokeniser at all. Guard 4's floor already
 * catches the clear cases (they land below 1 and are excluded and logged), but a small image
 * beside a lot of text can land INSIDE the legal range while still being part-pixel — and a
 * minimum fold cannot survive one such row. Naming the purpose refuses the whole class instead
 * of hoping each instance trips a bound.
 */
export const PROSE_EXCLUDED_PURPOSES: readonly string[] = ['vision_caption'];

/** Whether this row may establish the PROSE reading. See the comment above for every arm. */
export function isProseSample(callPurpose: string | null | undefined): boolean {
  if (typeof callPurpose !== 'string' || callPurpose.length === 0) return false;
  if (PROSE_EXCLUDED_PURPOSES.includes(callPurpose)) return false;
  return isUtilityPurpose(callPurpose);
}

/**
 * The chars-per-token this one row actually charged at, or `null` when the row may not establish a
 * reading. Pure, and takes a plain row precisely so the arithmetic can be argued with in a test
 * rather than only observed against a live ledger.
 */
export function rawCharsPerTokenFrom(sample: EstimatorSample): number | null {
  const { estimatedInputTokens, divisorUsed, inputTokens } = sample;
  if (sample.inputTokensEstimated === true) return null;                                  // guard 1
  if (typeof divisorUsed !== 'number' || divisorUsed !== CHARS_PER_TOKEN) return null;     // guard 2
  if (typeof estimatedInputTokens !== 'number' || !Number.isFinite(estimatedInputTokens)) return null;
  if (estimatedInputTokens < ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS) return null;           // guard 3
  const billed = inputTokens + (sample.cacheReadTokens ?? 0) + (sample.cacheCreationTokens ?? 0);
  if (!Number.isFinite(billed) || billed <= 0) return null;
  const chars = estimatedInputTokens * divisorUsed;
  return chars / billed;
}

/**
 * GUARD 4 — THE LEGAL RANGE, the half of migration 167's discipline this module was missing
 * (review C, L3-F2). The three guards above all bound the INPUT; none bounded the RESULT, and the
 * fold is a MINIMUM, so one anomalous row pins the reading for a whole window.
 *
 * MEASURED, not hypothetical: `{estimatedInputTokens: 2_000, divisorUsed: 4, inputTokens: 0,
 * cacheReadTokens: 8_000_000}` passes every guard above and yields **0.001** — and the daily rescan
 * cannot rescue it, because the row sits inside its own window and the rescan takes the min too. Spend
 * that and every estimate inflates 4000×. That row is not a corrupt record either: it is the SHAPE OF
 * A VISION CALL, where the provider bills thousands of input tokens for pixels that are not characters
 * of a prompt. The estimator estimates CHARACTERS, so such a call is not a measurement of a text
 * tokeniser and must not establish one.
 *
 * FLOOR of 1: no tokeniser emits more than one token per character of real text, so below 1 the
 * numerator is not the characters of this request (images, audio, a usage block counting something
 * else). This is the load-bearing bound — it is the only direction that can make a future consumer
 * LESS safe than no reading at all.
 *
 * CEILING of 12: ordinary prose measures near 4 and whitespace-heavy or highly repetitive text can run
 * higher, so the ceiling sits well clear of real text; above it a row is far more likely a provider
 * under-reporting usage (a partial usage block, a zeroed cache column) than a tokeniser. It protects
 * no decision by itself — a high ratio is already inert under a minimum — and it is here so a row no
 * tokeniser could produce cannot reach the log line, a future per-sample reader, or a future fold that
 * is not a minimum.
 *
 * 167's own words for why this lives with the READER and not in a CHECK constraint: the reader "must
 * survive a value this schema never approved … by treating it as unmeasured".
 */
export const ESTIMATOR_CHARS_PER_TOKEN_MIN = 1;
export const ESTIMATOR_CHARS_PER_TOKEN_MAX = 12;

/** Whether a computed ratio is inside the legal range — a number this box could really have been
 *  charged at. Pure and exported so the boundary is argued in a test, not only here. */
export function isLegalCharsPerToken(ratio: number): boolean {
  return Number.isFinite(ratio)
    && ratio >= ESTIMATOR_CHARS_PER_TOKEN_MIN
    && ratio <= ESTIMATOR_CHARS_PER_TOKEN_MAX;
}

/**
 * THE RATIO A ROW MAY ESTABLISH: the raw arithmetic, then the legal range. All four guards, one
 * function, and the ONE the fold and the window rescan both call — so there is no path that skips
 * the range, and no second copy of it in SQL.
 */
export function charsPerTokenFrom(sample: EstimatorSample): number | null {
  const raw = rawCharsPerTokenFrom(sample);
  if (raw === null) return null;
  return isLegalCharsPerToken(raw) ? raw : null;
}

/**
 * THE READING: the smallest chars-per-token a set of rows was charged at, or `null` when not one
 * of them qualifies. The minimum, not the mean — see the header's population argument.
 */
export function measuredCharsPerToken(samples: readonly EstimatorSample[]): number | null {
  let best: number | null = null;
  for (const sample of samples) {
    const ratio = charsPerTokenFrom(sample);
    if (ratio === null) continue;
    if (best === null || ratio < best) best = ratio;
  }
  return best;
}

interface StoredReading {
  divisor: number | null;
  /** 1 when SQLite says the stored reading is missing or older than `ESTIMATOR_RESCAN_AFTER`. */
  stale: number;
}

/**
 * ── THE TWO READINGS, AS DATA RATHER THAN AS TWO COPIES OF THE MACHINERY ──
 *
 * Migration 181 adds a SECOND chars-per-token reading (the prose population) with the identical
 * shape and the identical one-way rule as 174's. The ratchet-down / rescan-up logic below is
 * therefore parameterised by WHICH reading is being taken rather than duplicated: this module's
 * header refuses to let a threshold or an estimator exist twice, and two hand-rolled copies of a
 * ratchet is precisely the shape that drifted into four answers in `agent/session-forget.ts`'s
 * measured census.
 *
 * `admits` is the only difference between them, and it is the population predicate:
 *   ALL   — every qualifying row, whatever it was. The conservative, denser reading, unchanged
 *           in meaning and in writer from migration 174.
 *   PROSE — only rows whose `call_purpose` names a declared, non-pixel utility dial, i.e. rows
 *           with no tools array at all. See `isProseSample`.
 */
interface Reading {
  /** `providers` column holding the reading. */
  readonly column: string;
  /** `providers` column holding when it was established — the half that lets a minimum RISE. */
  readonly stampColumn: string;
  /** Which rows may establish it. */
  readonly admits: (sample: EstimatorSample) => boolean;
  /** For the log line, so a reader can tell the two apart. */
  readonly label: string;
}

const ALL_ROWS_READING: Reading = {
  column: 'measured_chars_per_token',
  stampColumn: 'measured_chars_per_token_at',
  admits: () => true,
  label: 'all-rows',
};

const PROSE_READING: Reading = {
  column: 'measured_chars_per_token_prose',
  stampColumn: 'measured_chars_per_token_prose_at',
  admits: (sample) => isProseSample(sample.callPurpose),
  label: 'prose',
};

/**
 * Re-read the whole window for this provider and return the minimum it now supports.
 *
 * The population filter runs in TypeScript over the fetched rows rather than as SQL, for the
 * reason guard 4's own comment gives about living with the reader: `isProseSample` is one
 * predicate with one argument, and a second copy of it in a WHERE clause is a copy that can
 * disagree with the one the write path used. The window is already narrowed by the two
 * predicates that do the work (`provider_id`, `estimated_input_tokens IS NOT NULL`), and this
 * runs at most once per provider per day.
 */
function rescanWindow(providerId: string, reading: Reading): number | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT estimated_input_tokens, estimator_chars_per_token, input_tokens,
           cache_read_tokens, cache_creation_tokens, call_purpose
      FROM cost_records
     WHERE provider_id = ?
       AND estimated_input_tokens IS NOT NULL
       AND created_at >= datetime('now', ?)
  `).all(providerId, `-${ESTIMATOR_SAMPLE_WINDOW_DAYS} days`) as Array<{
    estimated_input_tokens: number | null; estimator_chars_per_token: number | null;
    input_tokens: number; cache_read_tokens: number | null; cache_creation_tokens: number | null;
    call_purpose: string | null;
  }>;

  return measuredCharsPerToken(rows.map(r => ({
    estimatedInputTokens: r.estimated_input_tokens,
    divisorUsed: r.estimator_chars_per_token,
    inputTokens: r.input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    callPurpose: r.call_purpose,
  })).filter(reading.admits));
}

/** Fold one freshly-recorded call into this provider's measured divisor. Best-effort, like every
 *  other post-insert step in `recordCost`: a reading that cannot be taken leaves the column exactly
 *  as it was, which is the state every provider is in today. */
function recalibrateEstimator(providerId: string, sample: EstimatorSample, reading: Reading): void {
  if (!reading.admits(sample)) return;
  const raw = rawCharsPerTokenFrom(sample);
  // AN OUT-OF-RANGE ROW IS SAID OUT LOUD, ONCE PER PROVIDER PER PROCESS. A silent exclusion and a
  // silent poisoning look identical from outside, and the likeliest cause is structural rather than
  // freakish — a vision-capable model billing pixels as input tokens will produce one of these on
  // every image call. Once per provider keeps a vision-heavy box from filling its log with a fact it
  // already reported, and the reading it protects is one number per provider anyway.
  if (raw !== null && !isLegalCharsPerToken(raw)) {
    const logKey = `${providerId}::${reading.label}`;
    if (!rangeExcluded.has(logKey)) {
      rangeExcluded.add(logKey);
      logger.info('Ledger row excluded from the chars-per-token reading: ratio outside the legal range', {
        providerId,
        reading: reading.label,
        ratio: Number(raw.toFixed(6)),
        legalRange: [ESTIMATOR_CHARS_PER_TOKEN_MIN, ESTIMATOR_CHARS_PER_TOKEN_MAX],
        estimatedInputTokens: sample.estimatedInputTokens ?? null,
        billedInputTokens: sample.inputTokens + (sample.cacheReadTokens ?? 0) + (sample.cacheCreationTokens ?? 0),
        likelyCause: raw < ESTIMATOR_CHARS_PER_TOKEN_MIN
          ? 'billed input is not characters of a prompt (image/audio tokens), so it cannot measure a text tokeniser'
          : 'the provider appears to under-report usage for this call',
      });
    }
    return;
  }
  const fresh = raw === null ? null : (isLegalCharsPerToken(raw) ? raw : null);
  if (fresh === null) return;

  try {
    const db = getDb();
    const stored = db.prepare(`
      SELECT ${reading.column} AS divisor,
             (${reading.stampColumn} IS NULL OR ${reading.stampColumn} < datetime('now', ?)) AS stale
        FROM providers
       WHERE id = ?
    `).get(ESTIMATOR_RESCAN_AFTER, providerId) as StoredReading | undefined;
    if (!stored) return;

    // The one-way rule, mirrored (see the header): the write path may only ratchet the reading
    // DOWN, and only the daily rescan may let it rise — because only the write path can know the
    // numerator was billed rather than estimated.
    const sanctioned = stored.divisor === null ? fresh : Math.min(stored.divisor, fresh);
    const next = stored.stale
      ? Math.max(sanctioned, rescanWindow(providerId, reading) ?? sanctioned)
      : sanctioned;

    if (!stored.stale && next === stored.divisor) return;

    db.prepare(`
      UPDATE providers
         SET ${reading.column} = ?, ${reading.stampColumn} = datetime('now')
       WHERE id = ?
    `).run(next, providerId);

    logger.info('Measured chars-per-token updated from the cost ledger', {
      providerId,
      reading: reading.label,
      charsPerToken: Number(next.toFixed(3)),
      assertedConstant: CHARS_PER_TOKEN,
      sampleEstimatedTokens: sample.estimatedInputTokens ?? null,
      viaWindowRescan: Boolean(stored.stale),
    });
  } catch (err) {
    logger.warn('Could not update the measured chars-per-token reading; leaving it as it was', {
      providerId,
      reading: reading.label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * THE ONE DOOR `recordCost` CALLS: what this row teaches the box.
 *
 * A dispatcher, not a third implementation — the prefill speedometer stays entirely in
 * `prefill-calibration.ts` and is called here with the same fields it has always read. It exists so
 * the writer has ONE line to own instead of one per reading: the next reading the ledger can support
 * is added here, and `costs/tracker.ts` does not change again.
 */
export function recalibrateFromLedgerRow(providerId: string, sample: PrefillSample & EstimatorSample): void {
  recalibrateFromSample(providerId, sample);
  // BOTH readings, from the one row, because a row belongs to one population and the all-rows
  // reading admits every population. A turn feeds only the first; a declared prose dial feeds
  // both — which is correct and is not double-counting: the all-rows reading IS the minimum over
  // every population, and excluding prose from it would turn it into a third, undeclared reading.
  recalibrateEstimator(providerId, sample, ALL_ROWS_READING);
  recalibrateEstimator(providerId, sample, PROSE_READING);
}
