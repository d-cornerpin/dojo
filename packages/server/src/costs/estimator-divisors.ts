// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE READER OF THE TWO MEASURED CHARS-PER-TOKEN READINGS.
//
// `costs/ledger-calibration.ts` WRITES them (migrations 174 and 181); `memory/budget.ts`'s
// `estimateRequestTokens` SPENDS them. This module is the single door between, and it exists for
// one structural reason: `memory/budget.ts` is a LEAF — its own header explains that taking a
// modelId, and therefore a database, would make the budget cyclic with its own consumers — so the
// arithmetic there is pure and takes the readings as an argument. The read has to live somewhere
// that may hold a connection, and `costs/` already does.
//
// ── UNMEASURED IS NOT AN ERROR, IT IS THE DEFAULT STATE ──
// Every return path yields `{prose: null, dense: null}` rather than throwing: a provider that has
// not measured itself yet, a provider row that is gone, a column a mid-upgrade body does not have
// yet, a database that is not there. `estimateRequestTokens` treats all-null as "use the asserted
// constant", which is byte-for-byte today's behaviour — the same promise migrations 167 and 174
// make about their own NULL columns. A reading that cannot be fetched must therefore cost a
// caller nothing but today's answer, and must never cost it a turn.
//
// ── WHY THERE IS NO CACHE HERE, DELIBERATELY ──
// This is read once per model call, immediately before a network dial that will take between
// hundreds of milliseconds and minutes. The read is a single indexed primary-key lookup of two
// REAL columns. A cache would buy an unmeasurable fraction of that and would owe an invalidation
// story to a value the write path can change on any call — which is exactly the kind of stale
// dial this campaign exists to remove, bought for nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import type { MeasuredDivisors } from '../memory/budget.js';

/** Nothing measured — the state every box is in until a qualifying call establishes a reading. */
const UNMEASURED: MeasuredDivisors = { prose: null, dense: null };

/** A reading is only a reading if it is a positive, finite number. A column can hold what a
 *  schema never approved (migration 167's own words about its reader), and the honest response
 *  to that is to treat it as unmeasured rather than to spend it. */
function reading(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * This provider's two measured chars-per-token readings, or nulls.
 *
 * `prose` is the minimum over rows whose `call_purpose` named a declared, non-pixel utility dial
 * (requests with no tools array at all); `dense` is migration 174's minimum over every qualifying
 * row, which is the conservative one and therefore the right answer wherever the population is
 * unknown.
 */
export function measuredDivisorsFor(providerId: string | null | undefined): MeasuredDivisors {
  if (typeof providerId !== 'string' || providerId.length === 0) return UNMEASURED;
  try {
    const row = getDb().prepare(`
      SELECT measured_chars_per_token_prose AS prose, measured_chars_per_token AS dense
        FROM providers
       WHERE id = ?
    `).get(providerId) as { prose: unknown; dense: unknown } | undefined;
    if (!row) return UNMEASURED;
    return { prose: reading(row.prose), dense: reading(row.dense) };
  } catch {
    // A missing column on a mid-upgrade body, or no database at all. Today's answer, never a throw.
    return UNMEASURED;
  }
}
