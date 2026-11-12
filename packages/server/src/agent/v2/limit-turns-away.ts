import { getDb } from '../../db/connection.js';
import { exceededBudget, WALL_ESTIMATE_USD } from '../../costs/budget.js';
import { routedSkipReasons } from '../../router/selector.js';

/** Park and release judge one number or the park flips: WALL_ESTIMATE_USD if pinned, router's if routed. */
export function limitTurnsAway(agentId: string, tier?: string | null, excluded: string[] = []): boolean {
  const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  if (row?.model_id !== 'auto') return exceededBudget(agentId, WALL_ESTIMATE_USD) !== null;
  return routedSkipReasons(tier, agentId, excluded, ['tools']).some((r) => r.skip === 'budget');
}
