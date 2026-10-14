// ════════════════════════════════════════════════════════════════════════════════════════
// t149 round 4 — ONE PREDICATE FOR "THE SPENDING LIMIT TURNS THIS AGENT'S NEXT CALL AWAY".
//
// A "free fallback did not answer" park (`honest-stop.ts`) is MADE on one number and must be lifted on
// the same one, or the 30-second tick flips it (lift on a looser number, the turn dials the dead free
// model again, parks again, re-tells the owner, every tick):
//   * a PINNED agent's call meets the money wall, which judges it by `WALL_ESTIMATE_USD`;
//   * a ROUTED agent's candidates are judged by the router's own per-model estimate
//     (`router/selector.ts`, `routedSkipReasons`, skip `budget`) — a number up to twice the wall's.
// The park (`call-llm/free-fallback-down.ts`, for a routed agent; the wall's redirect for a pinned one)
// and the release (`honest-stop.ts`) both ask this.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { exceededBudget, WALL_ESTIMATE_USD } from '../../costs/budget.js';
import { routedSkipReasons } from '../../router/selector.js';

/** `tier` / `excluded`: the router's view at the moment of the failure (absent at release). */
export function limitTurnsAway(agentId: string, tier?: string | null, excluded: string[] = []): boolean {
  const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  if (row?.model_id !== 'auto') return exceededBudget(agentId, WALL_ESTIMATE_USD) !== null;
  return routedSkipReasons(tier, agentId, excluded, ['tools']).some((r) => r.skip === 'budget');
}
