// The work-transition boundary's outcome types, mapped onto the shared `Outcome` vocabulary. A lost CAS
// race is `refused` ('state-conflict'), so the unknown arm stays unreachable here.
import type {
  LiveOutcome, OutcomeApplied, OutcomeNoChange, OutcomeRefused,
} from '@dojo/shared';
import { createLogger } from '../logger.js';
import type { WorkState } from './store.js';

const logger = createLogger('work-outcome');

/** The one sentence for a missing work row, so every door steers alike: list the open work. */
export function noSuchWorkDetail(workId: string): string {
  return `No work row ${workId}. It may be from an earlier session; list the open work and use a current id.`;
}

export type TransitionGate =
  | 'no-such-work'
  | 'reason-required'
  | 'illegal-transition'
  | 'engine-needs-evidence'
  | 'engine-evidence-unresolved'
  | 'done-requires-delivery'
  | 'delivery-unresolved'
  | 'needs-decision'
  | 'reopen-requires-authority'
  | 'owner-hold'
  | 'not-a-join-child'
  | 'empty-piece'
  // The commitment door refusing an OWNER ASK: an ask is closed by the record that answers it.
  | 'ask-not-a-commitment';

/** Gates plus non-gate reasons: transition()'s no-op and lost race, and the status writer's refusals. */
export type WorkOutcomeReason =
  | TransitionGate
  | 'already-in-state'
  | 'state-conflict'
  | 'takeover-needs-the-owner'
  | 'measure-items-left';   // a measured task's last reading shows items left (`work/measure-close-gate.ts`)

export interface TransitionApplied {
  readonly workId: string;
  readonly from: WorkState;
  readonly to: WorkState;
  readonly eventId: number;
}

/** What `transition()` answers: rows are live, so no `unknown`; `failed` is unreachable (a fault throws). */
export type WorkOutcome = WorkSettledOutcome | WorkUnsettledOutcome;

export type WorkSettledOutcome =
  | OutcomeApplied<TransitionApplied>
  | (OutcomeNoChange<'already-in-state'> & { readonly workId: string; readonly state: WorkState });

export type WorkUnsettledOutcome =
  | (OutcomeRefused<'state-conflict'> & {
      readonly workId: string; readonly expected: WorkState; readonly actual: WorkState;
    })
  | (OutcomeRefused<TransitionGate> & { readonly workId: string })
  | (OutcomeRefused<'takeover-needs-the-owner'> & { readonly workId: string })
  | (OutcomeRefused<'measure-items-left'> & { readonly workId: string })
  | Extract<LiveOutcome<TransitionApplied, WorkOutcomeReason>, { kind: 'failed' }>;

export type WorkPatchOutcome =
  | OutcomeApplied<number>
  | (OutcomeNoChange<'empty-patch'> & { readonly workId: string })
  | (OutcomeRefused<'no-such-work'> & { readonly workId: string });

/** The one merge `Outcome` sanctions, a TYPE GUARD so `!workSettled(r)` narrows to the arms with a reason. */
export function workSettled(o: WorkOutcome): o is WorkSettledOutcome {
  return o.kind === 'applied' || o.kind === 'no_change';
}

/** The lost-CAS arm, narrowed: callers read `expected`/`actual` off it, never off a parsed string. */
export function isStateConflict(
  o: WorkOutcome,
): o is OutcomeRefused<'state-conflict'> & { workId: string; expected: WorkState; actual: WorkState } {
  return o.kind === 'refused' && o.reason === 'state-conflict';
}

/** Consume by recording, for the caller with no branch to take: the refusal reaches a log with its
 * gate name and row.
 * Deliberately not a branch: what a refused move does is its own change; each use owes a decision. */
export function noteUnsettled(
  o: WorkOutcome | WorkPatchOutcome, where: string, ctx: Record<string, unknown> = {},
): void {
  if (o.kind === 'applied' || o.kind === 'no_change') return;
  logger.warn(`work write refused: ${where}`, {
    ...ctx,
    reason: o.reason,
    detail: o.detail,
    ...(o.kind === 'failed' ? {} : { workId: o.workId }),
  });
}
