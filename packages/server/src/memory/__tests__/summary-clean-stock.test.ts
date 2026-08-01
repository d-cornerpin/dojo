// ════════════════════════════════════════════════════════════════════════════════════════
// THE CLEAN-STOCK COUNTER — PHASE-3 T5 Step 2. The number SWEEP C retires the job on.
//
// The nightly summary rebuild exists to repair contamination that Step 2's write boundary
// now makes impossible to create. Research 06 §6: "Nightly scan then finds nothing by
// construction; degrades to one-time backfill." SWEEP C deletes it — but a deletion needs
// POSITIVE evidence, and "the log looked quiet" is exactly the reasoning roadmap #15 exists
// to forbid.
//
// So the counter must survive the two ways it could lie:
//   • ONE clean night is not a streak. The streak must be readable and it must persist
//     across restarts, or a nightly job's evidence is destroyed by every deploy.
//   • A run that scanned NOTHING found nothing. A fresh box, a broken query, or a summaries
//     table that failed to open all produce "0 flagged", and none of them is evidence the
//     stock is clean. `stockScanned === 0` must NOT advance the streak.
//
// Both are asserted below against the real config table, because both are the failure modes
// that would make the retirement decision wrong.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { recordCleanStock, readCleanStockStreak } from '../summary-clean-stock.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the clean-stock counter', () => {
  it('starts at zero and counts consecutive clean runs over a real stock', () => {
    expect(readCleanStockStreak()).toBe(0);
    expect(recordCleanStock(0, 47)).toBe(1);
    expect(recordCleanStock(0, 47)).toBe(2);
    expect(recordCleanStock(0, 48)).toBe(3);
    expect(readCleanStockStreak()).toBe(3);
  });

  it('RESETS the moment anything is flagged — a streak is consecutive or it is nothing', () => {
    recordCleanStock(0, 47);
    recordCleanStock(0, 47);
    expect(readCleanStockStreak()).toBe(2);
    expect(recordCleanStock(1, 47)).toBe(0);
    expect(readCleanStockStreak()).toBe(0);
    // and it has to earn the streak again from one
    expect(recordCleanStock(0, 47)).toBe(1);
  });

  it('a run that scanned NOTHING does not advance the streak, and clears it', () => {
    // The #15 clause. An empty summaries table, a failed query and a genuinely clean box all
    // report "0 flagged"; only the last is evidence. Without this, a fresh dev box would
    // manufacture a retirement case for a job that had never examined a single row.
    recordCleanStock(0, 47);
    expect(readCleanStockStreak()).toBe(1);
    expect(recordCleanStock(0, 0)).toBe(0);
    expect(readCleanStockStreak()).toBe(0);
  });

  it('PERSISTS in config, so a restart does not erase a nightly job\'s evidence', () => {
    recordCleanStock(0, 47);
    recordCleanStock(0, 47);
    const row = mockDb.current!
      .prepare("SELECT value FROM config WHERE key = 'summary_rebuild_clean_runs'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('2');
  });

  it('never throws when the config table is missing — it is an instrument, not a gate', () => {
    mockDb.current!.exec('DROP TABLE config');
    expect(() => recordCleanStock(0, 47)).not.toThrow();
    expect(readCleanStockStreak()).toBe(0);
  });
});
