// t144 — THE REAL SIGNALS THE NIGHTLY REBUILDS ARE PACED BY (owner ruling 2026-10-13: no hard limits).
// Shared by the rebuild of older mixed notes and the contamination pass: the agent not mid-turn, the money
// guardrail (`checkBudget`), and the one guard that keeps two rebuild runs from overlapping. A summary
// writer answering is asked of `summary-writer-health.ts`, which honours the provider's breaker.

import { getDb } from '../db/connection.js';
import { checkBudget } from '../costs/budget.js';
import { activeRuns } from '../agent/shared-state.js';

/** True while a rebuild run (nightly, or the boot-time start) is working; a second one steps aside. */
export const rebuildGuard = { running: false };

/** The agent is mid-turn: its rebuild waits (its notes stay in view, labelled) — never a clock. */
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

/** Why a model call for this agent should wait now, or null: the agent is mid-turn, or the call would pass the budget. */
export function waitReason(agentId: string, modelId: string, inputTokens: number, outputTokens: number): string | null {
  if (agentBusy(agentId)) return 'the agent is mid-turn';
  const budget = checkBudget(agentId, estimateCost(modelId, inputTokens, outputTokens));
  return budget.allowed ? null : `the spending limit is reached (${budget.reason ?? 'budget'})`;
}
