// The dedicated-A2A-turn budget scales with the recipient's provider through `patienceFloorFor`.
// A max() against `MAX_A2A_TURN_RETRIES`: a floor on patience, so the engine never gives up sooner.
// Missing or unreadable rows resolve to the default floor: an unknown provider buys no extra silence.

import { patienceFloorFor } from '../tracker/assignee-patience.js';
import { MAX_A2A_TURN_RETRIES } from './turn-state.js';

export interface A2ARetryBudget {
  turns: number;
  floorSeconds: number;
  baselineSeconds: number;
  basis: 'declared' | 'default' | 'measured';
}

export function a2aRetryBudgetFor(agentId: string | null | undefined): A2ARetryBudget {
  const baselineSeconds = patienceFloorFor(null).floorSeconds;
  const floor = patienceFloorFor(agentId);
  const scaled = baselineSeconds > 0
    ? Math.ceil((MAX_A2A_TURN_RETRIES * floor.floorSeconds) / baselineSeconds)
    : MAX_A2A_TURN_RETRIES;
  return {
    turns: Math.max(MAX_A2A_TURN_RETRIES, Number.isFinite(scaled) ? scaled : MAX_A2A_TURN_RETRIES),
    floorSeconds: floor.floorSeconds,
    baselineSeconds,
    basis: floor.basis,
  };
}
