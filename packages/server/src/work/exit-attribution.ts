import { getDb } from '../db/connection.js';

// ENGINE- or OWNER-imposed exits: the re-serve ladder (`work/ask-settlement.ts`) spends no rung on them.
// Model choices stay out: `answered`, `handoff`, `no_reply_intended` (adding it disarms the silence bound).
export const ENGINE_IMPOSED_EXITS: ReadonlySet<string> = new Set([
  'iteration_cap', 'park', 'brake', 'stop', 'preempt', 'provider_error',
  'stream_idle', 'abort', 'terminated', 'budget', 'identical_call',
]);

// Reads the turn's record, which `finalizeTurn` writes earlier in the same teardown (keep that order). No
// record, or a failed read, means no: inferring a cut there would disarm the ladder's bound.
export function turnWasEngineCut(agentId: string, turnNumber: number | null): boolean {
  if (turnNumber == null) return false;
  try {
    const r = getDb().prepare(
      'SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?',
    ).get(agentId, turnNumber) as { exit_reason: string | null } | undefined;
    return r?.exit_reason ? ENGINE_IMPOSED_EXITS.has(r.exit_reason) : false;
  } catch {
    return false;
  }
}

export function engineCutHandBackReason(turnNumber: number | null): string {
  return `re-opened: the engine ended the turn (${turnNumber ?? '?'}) before it delivered an answer `
    + '— the model never declined this ask, so the person is still waiting and the re-serve ladder '
    + 'is NOT spent on a turn the model did not get to finish';
}
