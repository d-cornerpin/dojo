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
// tunable here; the only numbers are the qualification guards, each with its own argument).
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
import { recalibrateFromSample, type PrefillSample } from './prefill-calibration.js';

const logger = createLogger('ledger-calibration');

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
}

/**
 * The chars-per-token this one row actually charged at, or `null` when the row may not establish a
 * reading. Pure, and takes a plain row precisely so the arithmetic can be argued with in a test
 * rather than only observed against a live ledger.
 */
export function charsPerTokenFrom(sample: EstimatorSample): number | null {
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

/** Re-read the whole window for this provider and return the minimum it now supports. */
function rescanWindow(providerId: string): number | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT estimated_input_tokens, estimator_chars_per_token, input_tokens,
           cache_read_tokens, cache_creation_tokens
      FROM cost_records
     WHERE provider_id = ?
       AND estimated_input_tokens IS NOT NULL
       AND created_at >= datetime('now', ?)
  `).all(providerId, `-${ESTIMATOR_SAMPLE_WINDOW_DAYS} days`) as Array<{
    estimated_input_tokens: number | null; estimator_chars_per_token: number | null;
    input_tokens: number; cache_read_tokens: number | null; cache_creation_tokens: number | null;
  }>;

  return measuredCharsPerToken(rows.map(r => ({
    estimatedInputTokens: r.estimated_input_tokens,
    divisorUsed: r.estimator_chars_per_token,
    inputTokens: r.input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
  })));
}

/** Fold one freshly-recorded call into this provider's measured divisor. Best-effort, like every
 *  other post-insert step in `recordCost`: a reading that cannot be taken leaves the column exactly
 *  as it was, which is the state every provider is in today. */
function recalibrateEstimator(providerId: string, sample: EstimatorSample): void {
  const fresh = charsPerTokenFrom(sample);
  if (fresh === null) return;

  try {
    const db = getDb();
    const stored = db.prepare(`
      SELECT measured_chars_per_token AS divisor,
             (measured_chars_per_token_at IS NULL OR measured_chars_per_token_at < datetime('now', ?)) AS stale
        FROM providers
       WHERE id = ?
    `).get(ESTIMATOR_RESCAN_AFTER, providerId) as StoredReading | undefined;
    if (!stored) return;

    // The one-way rule, mirrored (see the header): the write path may only ratchet the reading
    // DOWN, and only the daily rescan may let it rise — because only the write path can know the
    // numerator was billed rather than estimated.
    const sanctioned = stored.divisor === null ? fresh : Math.min(stored.divisor, fresh);
    const next = stored.stale
      ? Math.max(sanctioned, rescanWindow(providerId) ?? sanctioned)
      : sanctioned;

    if (!stored.stale && next === stored.divisor) return;

    db.prepare(`
      UPDATE providers
         SET measured_chars_per_token = ?, measured_chars_per_token_at = datetime('now')
       WHERE id = ?
    `).run(next, providerId);

    logger.info('Measured chars-per-token updated from the cost ledger', {
      providerId,
      charsPerToken: Number(next.toFixed(3)),
      assertedConstant: CHARS_PER_TOKEN,
      sampleEstimatedTokens: sample.estimatedInputTokens ?? null,
      viaWindowRescan: Boolean(stored.stale),
    });
  } catch (err) {
    logger.warn('Could not update the measured chars-per-token reading; leaving it as it was', {
      providerId,
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
  recalibrateEstimator(providerId, sample);
}
