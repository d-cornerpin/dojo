// ════════════════════════════════════════════════════════════════════════════════════════
// PREFILL SELF-CALIBRATION — THE PLATFORM MEASURES WHAT IT USED TO ASK FOR.
//
// OWNER DESIGN RULING, 2026-09-22, verbatim: "never ask the user for a number the platform
// can observe."
//
// Migration 166 gave a provider somewhere to DECLARE its prefill throughput, and three
// consumers spend it: the pre-dial gate (`agent/model.ts`'s `refuseIfDoomed`), the admission
// budget and compaction trigger (`memory/budget.ts`, `memory/compaction.ts`), and the router's
// fit filter (`router/selector.ts`). All three are OFF while the column is NULL — and the
// column stays NULL, because filling it means benchmarking a box by hand and typing
// tokens-per-second into a form. The engine was asking its owner for a number it had already
// written down thousands of times, in its own cost ledger.
//
// ── THE OBSERVATION (why a cost row is a speedometer) ──
//
// Every model call writes a `cost_records` row carrying `input_tokens` — the BILLED, UNCACHED
// input; cache reads have had their own column since migration 086 — alongside `latency_ms`
// and `provider_id`. A call's latency is its prefill time PLUS its generation time PLUS
// overhead, so latency is never SHORTER than the prefill inside it. Therefore, for EVERY row,
// unconditionally:
//
//     input_tokens / (latency_ms / 1000)   is a LOWER BOUND on that box's prefill rate
//
// and the MAXIMUM of those lower bounds is the tightest statement the ledger can make. It
// converges on the true rate FROM BELOW, which is the safe side of the only decisions that
// read it: a smaller rate yields a smaller doom ceiling, so the pre-dial check refuses sooner
// and the admission budget plans smaller. An under-measured box is a CAUTIOUS box. There is no
// reading of this number that lets the engine dial something a true measurement would have
// refused.
//
// The same arithmetic run on the incident's own row: the dev box's local-deepseek call billed
// 35,237 uncached input tokens with a 194.6-second latency, which is 181 tok/s — within 10% of
// the ~200 tok/s the owner measured by hand and wrote into `agent/stream-patience.ts`'s T73b
// header. `__tests__/the-ledger-measures-the-box.test.ts` reproduces that arithmetic from a
// fixture row rather than asserting it here.
//
// ── WHY A FLOOR ON `input_tokens`, AND WHY IT IS THE LOAD-BEARING PART ──
//
// Every row's quotient is a valid lower bound, but not every row's quotient is a bound worth
// MAXIMISING over, and the max is exactly the operation that is sensitive to this. Prefill is
// BATCHED: a 100-token prompt is processed in roughly the same wall-clock as a 1-token one,
// because the cost is dominated by per-call fixed work (queue admission, tokenisation, the
// first kernel launches) rather than by the tokens themselves. So a short chatty call returns
// a quotient that is TRUE about that call and WILDLY optimistic about the sustained rate on a
// 110,000-token prompt — 100 tokens answered in 20 ms is "5,000 tok/s", and a max that saw it
// would hand the doom ceiling a speed the box cannot hold for a second. That is the one way
// this estimator could ever become less safe than no estimator at all, and the floor is what
// closes it: the sample must be big enough that its PREFILL dominates its latency.
//
// 4,000 tokens is the floor. At the slowest rate this feature is meant for (a local box around
// 180 tok/s) that is ~22 seconds of prefill, so a full second of fixed overhead moves the
// quotient by under 5%; at a fast cloud endpoint (say 5,000 tok/s) it is still ~0.8 s, which is
// past the batch-ramp regime where throughput is still climbing. It is also comfortably below
// any real conversation turn on this platform — the owner's run 42–52K — so the floor excludes
// the chatter without excluding the measurement.
//
// `__tests__/the-ledger-measures-the-box.test.ts` plants the counterfactual: drop the floor to
// zero and one tiny chatty row corrupts the reading.
//
// NO FILTER ON `output_tokens`, AND NONE ON `cache_read_tokens`. Both were considered and both
// are unnecessary, because neither can push a quotient UP. A long generation makes latency
// larger, which makes the quotient SMALLER — a looser bound that simply loses the max. A large
// `cache_read_tokens` beside a small `input_tokens` does the same thing: the cached prefix is
// not in the numerator (it was never prefilled at this rate) and its read time is in the
// denominator. Filtering on either would only discard rows the max already ignores, at the cost
// of a second rule to keep honest.
//
// ── WHAT THIS MODULE IS NOT ──
// It never arms a clock. There is no `setTimeout`, no `setInterval`, and no scheduled pass:
// the recompute happens inline on the call that produced a qualifying row, and the one
// staleness question it asks ("was the stored reading established more than a day ago?") is
// answered by SQLite comparing two of its own timestamps. Reading a ledger is not arming a
// timer, and no census row is owed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('prefill-calibration');

/**
 * The smallest `input_tokens` a row may carry and still be allowed to set the reading. See the
 * header's floor argument — this constant is the whole defence against the batch-effect
 * over-read, and lowering it is the one change to this module that can make the engine LESS
 * safe rather than more.
 */
export const PREFILL_SAMPLE_MIN_INPUT_TOKENS = 4_000;

/**
 * How far back the rolling window reaches. Thirty days is long enough that an ordinary week of
 * light use still holds a big call to measure from, and short enough that a reading survives a
 * hardware change (a new GPU, a model swapped for a heavier quant, a box moved onto a busier
 * host) by at most a month rather than forever. The window is what makes the stored maximum
 * able to FALL — see `recalibrateFromSample`.
 */
export const PREFILL_SAMPLE_WINDOW_DAYS = 30;

/**
 * How stale a stored reading may be before the next qualifying call pays for a full window
 * rescan. One day.
 *
 * ── WHY A TWO-TIER CADENCE AND NOT "RESCAN EVERY TIME" ──
 * A maximum over a rolling window is cheap to RAISE and expensive to LOWER. Raising is O(1) —
 * a new sample either beats the stored number or it does not, and no other row can matter.
 * Lowering requires looking at the whole window, because the only reason a max falls is that
 * the row which set it has aged out, and nothing about the new sample announces that. Rescanning
 * on every call would pay the expensive question's price to answer the cheap one, on the hot
 * path of every model call the platform makes.
 *
 * So: every qualifying call ratchets the reading UP in O(1), and at most once a day one of them
 * also pays for the window rescan that lets it fall. The cost of the delay is bounded and
 * one-directional — for up to a day after its setting sample ages out, the stored reading can be
 * HIGHER than the window now supports. That is the same magnitude of staleness a hand-typed
 * declaration carries permanently, it is bounded by the 30-day window rather than unbounded, and
 * the consumers already spend only half of the ceiling they derive (`PROVIDER_CEILING_SAFETY`).
 */
export const PREFILL_RESCAN_AFTER = '-1 day';

/** One `cost_records` row, reduced to the two fields the estimator reads. */
export interface PrefillSample {
  /** `cost_records.input_tokens` — the BILLED, UNCACHED input. Cached prefix is not in here. */
  inputTokens: number;
  /** `cost_records.latency_ms`. Null/absent on rows the provider never timed. */
  latencyMs: number | null | undefined;
}

/**
 * Whether a row may set the reading at all: a real, positive latency and an input big enough
 * that its prefill dominates that latency (the header's floor argument).
 *
 * This predicate is the ONE place the rule lives. The window rescan below deliberately fetches
 * candidate rows and runs them through here rather than re-expressing the same thresholds in
 * SQL, so there is no second copy to drift — the fixture test exercises the same function the
 * live path does.
 */
function qualifies(sample: PrefillSample): boolean {
  const { inputTokens, latencyMs } = sample;
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs <= 0) return false;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return false;
  return inputTokens >= PREFILL_SAMPLE_MIN_INPUT_TOKENS;
}

/**
 * The lower bound this one row places on its provider's prefill rate, in tokens per second, or
 * `null` when the row does not qualify.
 */
export function prefillRateFrom(sample: PrefillSample): number | null {
  if (!qualifies(sample)) return null;
  return sample.inputTokens / ((sample.latencyMs as number) / 1000);
}

/**
 * THE ESTIMATOR: the maximum of the lower bounds a set of rows places on the box, or `null`
 * when not one of them qualifies.
 *
 * Pure, and takes plain rows rather than a provider id, precisely so the arithmetic can be
 * argued with in a test instead of only observed against a live ledger.
 */
export function estimatePrefillTokensPerSec(samples: readonly PrefillSample[]): number | null {
  let best: number | null = null;
  for (const sample of samples) {
    const rate = prefillRateFrom(sample);
    if (rate === null) continue;
    if (best === null || rate > best) best = rate;
  }
  return best;
}

interface StoredReading {
  rate: number | null;
  /** 1 when SQLite says the stored reading is missing or older than `PREFILL_RESCAN_AFTER`. */
  stale: number;
}

/**
 * Re-read the whole window for this provider and return what it now supports. Called at most
 * once a day per provider (see `PREFILL_RESCAN_AFTER`); the partial index migration 167 adds
 * (`idx_cost_records_prefill_sample`) is what keeps it a bounded range scan rather than a full
 * table scan of the largest table on a lived-in box.
 */
function rescanWindow(providerId: string): number | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT input_tokens, latency_ms
      FROM cost_records
     WHERE provider_id = ?
       AND latency_ms IS NOT NULL
       AND created_at >= datetime('now', ?)
  `).all(providerId, `-${PREFILL_SAMPLE_WINDOW_DAYS} days`) as Array<{ input_tokens: number; latency_ms: number | null }>;

  return estimatePrefillTokensPerSec(
    rows.map(r => ({ inputTokens: r.input_tokens, latencyMs: r.latency_ms })),
  );
}

/**
 * Fold one freshly-recorded call into this provider's measured prefill reading.
 *
 * Called from `costs/tracker.ts`'s `recordCost`, immediately after the row it describes lands,
 * and a silent no-op for every row that does not qualify — which is most of them, and is why
 * this sits on the hot path without costing anything on the calls that cannot inform it.
 *
 * Best-effort in the same sense every other post-insert step in `recordCost` is: a reading that
 * cannot be taken leaves the column exactly as it was, which is the state every provider is in
 * today. Nothing about a model call's success may depend on the speedometer working.
 */
export function recalibrateFromSample(providerId: string, sample: PrefillSample): void {
  const fresh = prefillRateFrom(sample);
  if (fresh === null) return;

  try {
    const db = getDb();
    const stored = db.prepare(`
      SELECT measured_prefill_tokens_per_sec AS rate,
             (measured_prefill_at IS NULL OR measured_prefill_at < datetime('now', ?)) AS stale
        FROM providers
       WHERE id = ?
    `).get(PREFILL_RESCAN_AFTER, providerId) as StoredReading | undefined;
    if (!stored) return;

    // The daily rescan is the only path that may LOWER the reading, and it is authoritative
    // when it runs: the window it looks at already contains the sample that triggered it.
    // `?? fresh` covers the one arrangement where the rescan can come back empty — a clock or a
    // window boundary that excludes the row we just wrote — by falling back to the measurement
    // in hand rather than clearing a column on a technicality.
    const next = stored.stale ? (rescanWindow(providerId) ?? fresh) : Math.max(stored.rate ?? 0, fresh);

    // Nothing moved and nothing was owed: skip the write entirely so an unchanging box does not
    // rewrite `providers.updated_at` on every large call.
    if (!stored.stale && next === stored.rate) return;

    db.prepare(`
      UPDATE providers
         SET measured_prefill_tokens_per_sec = ?, measured_prefill_at = datetime('now')
       WHERE id = ?
    `).run(next, providerId);

    logger.info('Measured prefill reading updated from the cost ledger', {
      providerId,
      tokensPerSec: Number(next.toFixed(2)),
      sampleInputTokens: sample.inputTokens,
      sampleLatencyMs: sample.latencyMs ?? null,
      viaWindowRescan: Boolean(stored.stale),
    });
  } catch (err) {
    // Deliberately quiet at warn, not error: a box whose ledger cannot be read still dials
    // exactly as it did before this feature existed.
    logger.warn('Could not update the measured prefill reading; leaving it as it was', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
