// Prefill self-calibration: a cost row's `input_tokens / (latency_ms / 1000)` is a LOWER BOUND on the box's
// prefill rate (latency includes prefill), so the MAXIMUM over qualifying rows approaches the truth from
// below, the safe side: a smaller rate makes the pre-dial gate refuse sooner and admission plan smaller.
// The numerator must be a billed count: the no-usage fallback (`inputTokensEstimated`) is JSON-inflated and
// never establishes a reading, and old ledger rows cannot be told apart, so the rescan may only LOWER the
// reading. The key is provider_id, so a box serving several models reads the faster one's rate (the gate
// then fails to fire). Only a local provider's reading is spent (`doomGuardApplies`).
// The `input_tokens` floor is the load-bearing part: prefill is batched, so a short call's quotient is
// wildly optimistic and a max would adopt it; lowering the floor is the one change that makes this less
// safe. No clock: the recompute runs inline on the call that produced the row.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('prefill-calibration');

export const PREFILL_SAMPLE_MIN_INPUT_TOKENS = 4_000;

export const PREFILL_SAMPLE_WINDOW_DAYS = 30;

/** Calls ratchet the reading UP in O(1); once per interval a rescan lets it FALL. The day it may read high
 *  is absorbed by memory/budget.ts and router/selector.ts spending only PROVIDER_CEILING_SAFETY (half). */
export const PREFILL_RESCAN_AFTER = '-1 day';

export interface PrefillSample {
  inputTokens: number;
  latencyMs: number | null | undefined;
  inputTokensEstimated?: boolean;
}

/** Whether a row may set the reading: the ONE place this rule lives (the rescan reuses it, no SQL copy). */
function qualifies(sample: PrefillSample): boolean {
  const { inputTokens, latencyMs } = sample;
  if (sample.inputTokensEstimated === true) return false;
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs <= 0) return false;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return false;
  return inputTokens >= PREFILL_SAMPLE_MIN_INPUT_TOKENS;
}

export function prefillRateFrom(sample: PrefillSample): number | null {
  if (!qualifies(sample)) return null;
  return sample.inputTokens / ((sample.latencyMs as number) / 1000);
}

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
  stale: number;
}

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

/** Fold one freshly-recorded call into this provider's measured reading; best-effort, never fails the call. */
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

    // `?? sanctioned` keeps the measurement if the rescan comes back empty.
    const sanctioned = Math.max(stored.rate ?? 0, fresh);
    const next = stored.stale
      ? Math.min(sanctioned, rescanWindow(providerId) ?? sanctioned)
      : sanctioned;

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
    logger.warn('Could not update the measured prefill reading; leaving it as it was', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
