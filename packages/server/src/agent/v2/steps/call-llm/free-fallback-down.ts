// ════════════════════════════════════════════════════════════════════════════════════════
// t149 round 3 (R-V333-18) — WHEN THE ROUTER'S FREE PICKS DID NOT ANSWER AND THE LIMIT TURNS THE REST AWAY.
//
// An auto agent under the spending limit is offered only the models the limit still lets through: the
// free ones, directly (no wall, so no redirect). If every model this turn tried was free and failed,
// and the router's remaining candidates are turned away by the LIMIT, the true cause is the limit
// with no free model answering — the same stop the wall's redirect raises for a pinned agent
// (`agent/budget-redirect.ts`), told once and held (`agent/v2/honest-stop.ts`), never the error path.
// The ladder's give-up sites hand their error through here; anything else comes back unchanged.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../../db/connection.js';
import { limitTurnsAway } from '../../limit-turns-away.js';
import { AgentError } from '../../../errors.js';
import { FREE_FALLBACK_DOWN_CODE } from '../../honest-stop-lock.js';

export function freeFallbackDown(err: unknown, agentId: string, tier: string | null | undefined, tried: string[]): unknown {
  try {
    const ids = [...new Set(tried)];
    if (ids.length === 0) return err;
    const free = getDb().prepare(
      `SELECT COUNT(*) AS n FROM models WHERE id IN (${ids.map(() => '?').join(',')}) AND input_cost_per_m = 0 AND output_cost_per_m = 0`,
    ).get(...ids) as { n: number };
    if (free.n !== ids.length) return err;   // a paid model failed: that is its own fault, not the limit's
    if (!limitTurnsAway(agentId, tier, ids)) return err;
    const why = err instanceof Error ? `: ${err.message}` : '';
    return new AgentError(`Today's spending limit is reached and no free model answered${why}`, agentId,
      { code: FREE_FALLBACK_DOWN_CODE, retryable: false, cause: err instanceof Error ? err : undefined });
  } catch {
    return err;
  }
}
