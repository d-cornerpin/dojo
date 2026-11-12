// The router's tiers and their fallback order, read by the summary writers too so one place owns
// the rule. A leaf: it reads the database and nothing else. Standing filters are in standing-filters.ts.

import { getDb } from '../db/connection.js';

// Every tier can fall back downward: a rate-limited heavy model falls back to standard, not a crash.
export const TIER_FALLBACK: Record<string, string[]> = {
  light: ['light', 'standard', 'heavy'],
  standard: ['standard', 'heavy', 'light'],
  heavy: ['heavy', 'standard', 'light'],
};

export interface TierModelRow {
  model_id: string;
  provider_id: string;
  api_model_id: string;
  priority: number;
  input_cost_per_m: number | null;
  output_cost_per_m: number | null;
}

export function getTierModels(tierId: string): TierModelRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT tm.model_id, m.provider_id, m.api_model_id, tm.priority,
           m.input_cost_per_m, m.output_cost_per_m
    FROM router_tier_models tm
    JOIN models m ON m.id = tm.model_id
    WHERE tm.tier_id = ? AND m.is_enabled = 1
    ORDER BY tm.priority ASC
  `).all(tierId) as TierModelRow[];
}

/** Every enabled model a standard-tier request may walk to, in the router's order, before any filter of the moment. */
export const standardTierModels = (): string[] => [...new Set(TIER_FALLBACK.standard.flatMap((t) => getTierModels(t).map((m) => m.model_id)))];
