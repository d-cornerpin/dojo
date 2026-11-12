// What paces both nightly rebuild passes: the agent not mid-turn, the budget, and the no-overlap guard.

import { getDb } from '../db/connection.js';
import { checkBudget } from '../costs/budget.js';
import { activeRuns } from '../agent/shared-state.js';

/** True while a rebuild run (nightly, or the boot-time start) is working; a second one steps aside. */
export const rebuildGuard = { running: false };

export function agentBusy(agentId: string): boolean {
  if (activeRuns.has(agentId)) return true;
  const row = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
  return row?.status === 'working';
}

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const m = getDb().prepare('SELECT input_cost_per_m, output_cost_per_m FROM models WHERE id = ?').get(modelId) as
    { input_cost_per_m: number | null; output_cost_per_m: number | null } | undefined;
  return ((m?.input_cost_per_m ?? 0) * inputTokens + (m?.output_cost_per_m ?? 0) * outputTokens) / 1_000_000;
}

export function waitReason(agentId: string, modelId: string, inputTokens: number, outputTokens: number): string | null {
  if (agentBusy(agentId)) return 'the agent is mid-turn';
  const budget = checkBudget(agentId, estimateCost(modelId, inputTokens, outputTokens));
  return budget.allowed ? null : `the spending limit is reached (${budget.reason ?? 'budget'})`;
}
