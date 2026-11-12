// The clean-stock counter the nightly rebuild retires on: each run records the stock scanned, what it flagged
// and the streak. A run that scanned ZERO measured nothing and does not advance the streak; a flag resets it to 0.
import { getDb } from '../db/connection.js';

// Persisted in `config` so the streak survives restarts.
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

/** Count the whole summary stock, so "found nothing" differs from "looked at nothing". */
export function countSummaryStock(): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM summaries').get() as { c: number };
    return row?.c ?? 0;
  } catch { return 0; }
}

/** Record this run's verdict and return the streak; exported so other readers use the number the job writes. */
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
