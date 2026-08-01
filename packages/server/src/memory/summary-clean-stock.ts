// ════════════════════════════════════════════════════════════════════════════════════════
// THE CLEAN-STOCK COUNTER — the number SWEEP C retires the nightly rebuild on.
// PHASE-3 T5 Step 2.
// ════════════════════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';

//
// This job exists to repair contamination that Step 2's write boundary now makes impossible
// to create: the summariser's input goes through ONE filter (`buildLeafSummaryInput`) and
// its truncation fallback can no longer persist raw text (it returns `{ok:false}`). Research
// 06 §6's own words: "Nightly scan then finds nothing by construction; degrades to one-time
// backfill." SWEEP C retires it — but a retirement needs a NUMBER, not an impression.
//
// One clean night is not evidence. It is equally consistent with "the stock is clean" and
// "the detector broke", and inferring health from an absent finding is the reasoning roadmap
// #15 exists to forbid. So the counter records THREE facts on every run:
//
//   stockScanned            how many summaries were actually examined. A run that scanned
//                           ZERO is not a clean run — it is a run that measured nothing, and
//                           it does not advance the streak.
//   flaggedBefore           what it found. Non-zero RESETS the streak to 0.
//   consecutiveCleanRuns    the streak. This is the number SWEEP C reads.
//
// Persisted in `config` so it survives restarts, which a nightly job's streak must.
const CLEAN_RUNS_KEY = 'summary_rebuild_clean_runs';

function readCleanRuns(): number {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(CLEAN_RUNS_KEY) as
      { value: string } | undefined;
    const n = Number(row?.value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

function writeCleanRuns(n: number): void {
  try {
    getDb().prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(CLEAN_RUNS_KEY, String(n));
  } catch { /* the counter is an instrument; never fail the job for it */ }
}

/** Count the whole summary stock, so "found nothing" can be distinguished from
 *  "looked at nothing". */
export function countSummaryStock(): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM summaries').get() as { c: number };
    return row?.c ?? 0;
  } catch { return 0; }
}

/**
 * Record this run's verdict and return the streak. Exported so a dev box or SWEEP C can read
 * the same number the job writes rather than re-deriving it.
 */
export function recordCleanStock(flaggedCount: number, stockScanned: number): number {
  if (flaggedCount > 0 || stockScanned === 0) {
    if (readCleanRuns() !== 0) writeCleanRuns(0);
    return 0;
  }
  const next = readCleanRuns() + 1;
  writeCleanRuns(next);
  return next;
}

export function readCleanStockStreak(): number {
  return readCleanRuns();
}
