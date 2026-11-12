// Reads what costs/ledger-calibration.ts writes, so memory/budget.ts stays a database-free leaf. All-null
// (never a throw) means the asserted constant. No cache: any recorded cost may rewrite a reading.

import { getDb } from '../db/connection.js';
import type { MeasuredDivisors } from '../memory/budget.js';

const UNMEASURED: MeasuredDivisors = { prose: null, dense: null };

export function reading(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** `prose`: minimum over rows with no tools array; `dense`: minimum over all qualifying rows. */
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
    return UNMEASURED;
  }
}
