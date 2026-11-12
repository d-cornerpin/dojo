// What one cost row teaches the box: the estimator's chars-per-token divisor, observed per provider and
// never tuned. Each row holds `estimated_input_tokens`, the divisor that produced it and the billed counts,
// so chars = estimatedInputTokens * divisorUsed and ratio = chars / (inputTokens + cacheRead +
// cacheCreation) is exact for that request. The reading is the MINIMUM ratio ever charged: it errs toward a
// larger estimate, the safe side for admission, compaction and the pre-dial fit check.
// Guard 1: a char-derived `inputTokens` (`inputTokensEstimated`) would measure the estimator against itself
// and pin the reading at the divisor. Guard 2: the divisor must be positive and finite, any value (the
// constant included), because the estimate spends per-request measured divisors and `chars = estimated *
// divisorUsed` inverts exactly the arithmetic that made the row (requiring the constant would freeze the
// reading). Guard 3: a size floor, since ceil() rounding on a small estimate distorts the ratio. Guard 4 is
// the legal range below. One-way rule: only the write path knows an input was billed, so it ratchets the
// reading DOWN on each qualifying call and only the daily rescan may let it RISE.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { CHARS_PER_TOKEN } from '../memory/budget.js';
import { isUtilityPurpose } from '../agent/utility-dial.js';
import { recalibrateFromSample, type PrefillSample } from './prefill-calibration.js';

const logger = createLogger('ledger-calibration');

const rangeExcluded = new Set<string>();

export function resetRangeExclusionLogForTests(): void {
  rangeExcluded.clear();
}

export const ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS = 2_000;

export const ESTIMATOR_SAMPLE_WINDOW_DAYS = 30;

export const ESTIMATOR_RESCAN_AFTER = '-1 day';

export interface EstimatorSample {
  estimatedInputTokens: number | null | undefined;
  divisorUsed: number | null | undefined;
  inputTokens: number;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  inputTokensEstimated?: boolean;
  callPurpose?: string | null;
}

/** Whether a row may establish the PROSE reading: only a declared engine utility purpose (no tools array, so
 *  its characters are prose). NULL establishes nothing: "unknown" is not prose, and a NULL row may carry a
 *  tools array. `vision_caption` is refused because its billed input counts pixels, which a minimum fold
 *  cannot survive. */
export const PROSE_EXCLUDED_PURPOSES: readonly string[] = ['vision_caption'];

export function isProseSample(callPurpose: string | null | undefined): boolean {
  if (typeof callPurpose !== 'string' || callPurpose.length === 0) return false;
  if (PROSE_EXCLUDED_PURPOSES.includes(callPurpose)) return false;
  return isUtilityPurpose(callPurpose);
}

export function rawCharsPerTokenFrom(sample: EstimatorSample): number | null {
  const { estimatedInputTokens, divisorUsed, inputTokens } = sample;
  if (sample.inputTokensEstimated === true) return null;                                  // guard 1
  if (typeof divisorUsed !== 'number' || !Number.isFinite(divisorUsed) || divisorUsed <= 0) {
    return null;                                                                           // guard 2
  }
  if (typeof estimatedInputTokens !== 'number' || !Number.isFinite(estimatedInputTokens)) return null;
  if (estimatedInputTokens < ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS) return null;           // guard 3
  const billed = inputTokens + (sample.cacheReadTokens ?? 0) + (sample.cacheCreationTokens ?? 0);
  if (!Number.isFinite(billed) || billed <= 0) return null;
  const chars = estimatedInputTokens * divisorUsed;
  return chars / billed;
}

/** Guard 4, the legal range of the RESULT: the fold is a minimum, so one anomalous row (a vision call billing
 *  pixels can yield 0.001) would pin the reading. Floor 1: no tokeniser emits more than one token per
 *  character, so below it the numerator is not this request's characters (the load-bearing bound). Ceiling
 *  12: far above real text, so a row past it is likelier a provider under-reporting usage. The range lives
 *  with the reader, not in a CHECK constraint, so a value the schema never approved reads as unmeasured. */
export const ESTIMATOR_CHARS_PER_TOKEN_MIN = 1;
export const ESTIMATOR_CHARS_PER_TOKEN_MAX = 12;

export function isLegalCharsPerToken(ratio: number): boolean {
  return Number.isFinite(ratio)
    && ratio >= ESTIMATOR_CHARS_PER_TOKEN_MIN
    && ratio <= ESTIMATOR_CHARS_PER_TOKEN_MAX;
}

export function charsPerTokenFrom(sample: EstimatorSample): number | null {
  const raw = rawCharsPerTokenFrom(sample);
  if (raw === null) return null;
  return isLegalCharsPerToken(raw) ? raw : null;
}

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
  stale: number;
}

interface Reading {
  readonly column: string;
  readonly stampColumn: string;
  readonly admits: (sample: EstimatorSample) => boolean;
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

/** Re-read the whole window and return the minimum it supports. The population filter runs in TypeScript, not
 *  SQL, so `isProseSample` stays one predicate that cannot disagree with the write path. */
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

function recalibrateEstimator(providerId: string, sample: EstimatorSample, reading: Reading): void {
  if (!reading.admits(sample)) return;
  const raw = rawCharsPerTokenFrom(sample);
  // An out-of-range row is logged once per provider and reading per process.
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

/** The one door `recordCost` calls: what this row teaches the box. A dispatcher, not a third implementation:
 *  the prefill speedometer stays in prefill-calibration.ts, and the next reading the ledger supports is added
 *  here. */
export function recalibrateFromLedgerRow(providerId: string, sample: PrefillSample & EstimatorSample): void {
  recalibrateFromSample(providerId, sample);
  // BOTH readings from the one row: the all-rows reading admits every population, so a declared prose dial
  // feeds both, which is not double-counting.
  recalibrateEstimator(providerId, sample, ALL_ROWS_READING);
  recalibrateEstimator(providerId, sample, PROSE_READING);
}
