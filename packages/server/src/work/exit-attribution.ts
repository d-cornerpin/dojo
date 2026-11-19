import { getDb } from '../db/connection.js';
import type { HandBackCause, TurnEnd } from './ask-settlement.js';

// Model choices (`answered`, `handoff`, `no_reply_intended`, and a death nobody could place) are silence.
const PROVIDER_EXITS: ReadonlySet<string> = new Set(['provider_error', 'stream_idle', 'abort']);
const CUT_EXITS: ReadonlySet<string> = new Set([...PROVIDER_EXITS, 'brake', 'identical_call', 'terminated', 'iteration_cap', 'park']);
const FREE_EXITS: ReadonlySet<string> = new Set(['preempt', 'budget', 'stop']);

// Reads the turn's record, which `finalizeTurn` writes earlier in the same teardown (keep that order). No
// record, or a failed read, is null: read as silence, so the silence bound stays armed.
export function turnExitReason(agentId: string, turnNumber: number | null): string | null {
  if (turnNumber == null) return null;
  try {
    return (getDb().prepare('SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?')
      .get(agentId, turnNumber) as { exit_reason: string | null } | undefined)?.exit_reason ?? null;
  } catch {
    return null;
  }
}

/** THE EXIT TABLE: how a turn that did not answer hands its request back. A provider limit on the turn's
 *  first call waits for the reset; after paid calls it is a counted cut. A turn that parked its job, whatever
 *  its exit (a full context, a turn budget), re-opens it uncounted with no due: the job's continuation serves it. */
export function handBackCauseOf(exit: string | null, t: TurnEnd): HandBackCause {
  if (exit === null) return 'silence';
  if (t.parkedTheJob || FREE_EXITS.has(exit)) return 'free';
  if (PROVIDER_EXITS.has(exit) && t.retryAt && !t.paidBeforeLimit) return 'wait';
  return CUT_EXITS.has(exit) ? 'cut' : 'silence';
}
