// ════════════════════════════════════════
// The WORK-TRANSITION boundary's `Outcome` (PHASE-4 T1 Step 2, cluster 1 of 3).
//
// ── STRIP: `TransitionResult` (work/store.ts:144-148 at dojo `1249866`) ──
// verdict: STRIP (rename + widen, same commit — §T0-PINS A)
// requirement preserved: "every gate refuses by RETURNING, never by throwing, and
//   the type makes the ignoring visible" (store.ts's own doc comment above
//   `transition`). The four arms `applied | rejected | noop | conflict` said the
//   same five-way thing in a private vocabulary, one boundary wide; `WorkOutcome`
//   below is that vocabulary renamed onto the shared one, with NOTHING dropped:
//     applied  -> applied      (same payload: workId, from, to, eventId)
//     noop     -> no_change    (reason 'already-in-state'; `state` still carried)
//     rejected -> refused      (`gate` becomes `reason`; the 12 gate names are
//                               unchanged, so no caller's branch changes meaning)
//     conflict -> refused      (reason 'state-conflict'; `expected`/`actual` still
//                               carried and still TYPED — the caller that renders
//                               "moved to X while you were working on it" reads
//                               them structurally, and demoting them to a `detail`
//                               string would be exactly the prose-keying the
//                               phase's binding caution forbids)
// `TransitionResult` does not survive beside `Outcome` — shipping both is this
//   project's named disease, and §T0-PINS A said so before this file existed.
//
// ── WHY conflict FOLDED INTO refused RATHER THAN TAKING THE FIFTH ARM ──
// `unknown` is quarantined to non-live data. A lost CAS race is not "we cannot
// say what happened" — it is a gate refusing on evidence it holds: the row moved,
// here is what it moved to. That is a refusal with a name, and it keeps the fifth
// arm unreachable at this boundary, which is what `LiveOutcome` below enforces.
//
// ── WHY THIS FILE, AND NOT store.ts ──
// The single-writer conformance walk (`work/__tests__/single-writer-conformance.test.ts`)
// scopes SQL WRITES, not types: clause (a) is "every write to work/work_events/
// adjudications lives under `work/`" and clause (b) is "`work.state` UPDATEs exist
// only in store.ts, inside transition()". This module holds no SQL at all, so both
// clauses are untouched — and store.ts, pinned at its ratchet ceiling, shrinks.
// ════════════════════════════════════════
import type {
  LiveOutcome, OutcomeApplied, OutcomeNoChange, OutcomeRefused,
} from '@dojo/shared';
import { createLogger } from '../logger.js';
import type { WorkState } from './store.js';

const logger = createLogger('work-outcome');

/**
 * The gate that refused. Unchanged from `TransitionGate` — twelve names, each one
 * a branch some caller already reads, so the rename of the FIELD (`gate` ->
 * `reason`) deliberately did not touch the VALUES.
 */
export type TransitionGate =
  | 'no-such-work'
  | 'reason-required'
  | 'illegal-transition'
  | 'engine-needs-evidence'
  | 'engine-evidence-unresolved'
  | 'done-requires-delivery'
  | 'delivery-unresolved'
  | 'authoritative-claim-not-permitted'
  | 'requires-validation'
  | 'reopen-requires-authority'
  // PHASE-2 T4: the two refusals the fan-out join owes. Both were caller-side `if`s in the
  // string machine and both are structural here, so no caller can forget them.
  | 'not-a-join-child'
  | 'empty-piece';

/** The two reasons that are not gates: G4's "already there" and G3's lost race. */
export type WorkOutcomeReason = TransitionGate | 'already-in-state' | 'state-conflict';

/** The applied proof. `eventId` is the row somebody can go and read. */
export interface TransitionApplied {
  readonly workId: string;
  readonly from: WorkState;
  readonly to: WorkState;
  readonly eventId: number;
}

/**
 * What `transition()` answers.
 *
 * Built from `LiveOutcome`, not `Outcome`: `work` rows are live by construction —
 * they are opened by this platform, in this process, for something somebody asked
 * for. There is no honest `unknown` here, and the type makes saying one impossible
 * rather than merely discouraged.
 *
 * `failed` is DECLARED and currently unreachable, and that is stated rather than
 * hidden: `transition()` runs inside one `db.transaction`, so a storage fault
 * throws and the caller's own catch owns it. If a future step converts that throw
 * into a returned outcome, the arm is already here and every caller already has to
 * consider it.
 */
export type WorkOutcome = WorkSettledOutcome | WorkUnsettledOutcome;

/** The row is in the asked-for state: this call moved it, or it was already there. */
export type WorkSettledOutcome =
  | OutcomeApplied<TransitionApplied>
  | (OutcomeNoChange<'already-in-state'> & { readonly workId: string; readonly state: WorkState });

/** It is not, and every arm says why by NAME. */
export type WorkUnsettledOutcome =
  | (OutcomeRefused<'state-conflict'> & {
      readonly workId: string; readonly expected: WorkState; readonly actual: WorkState;
    })
  | (OutcomeRefused<TransitionGate> & { readonly workId: string })
  | Extract<LiveOutcome<TransitionApplied, WorkOutcomeReason>, { kind: 'failed' }>;

/**
 * The one merge `Outcome` sanctions — the shape fourteen call sites had already
 * written by hand as `r.kind !== 'applied' && r.kind !== 'noop'`.
 *
 * A TYPE GUARD, not a boolean, and that is the point: `if (!workSettled(r))`
 * narrows `r` to the arms that carry a `reason`, so the refusal branch cannot
 * reach for a field the applied arm never had. A plain boolean would leave every
 * caller re-narrowing by hand, which is where the original `'gate' in result`
 * idiom came from.
 */
export function workSettled(o: WorkOutcome): o is WorkSettledOutcome {
  return o.kind === 'applied' || o.kind === 'no_change';
}

/** The lost-CAS arm, narrowed. Callers that render "somebody moved it under you"
 *  read `expected`/`actual` off the result of this, never off a parsed string. */
export function isStateConflict(
  o: WorkOutcome,
): o is OutcomeRefused<'state-conflict'> & { workId: string; expected: WorkState; actual: WorkState } {
  return o.kind === 'refused' && o.reason === 'state-conflict';
}

/**
 * CONSUME BY RECORDING — for the caller that has no branch to take.
 *
 * Twenty sites move a tracker row for effect: the scheduler firing an occurrence,
 * the PM auto-resetting a stalled task, the join relay settling a delivered piece.
 * None of them has a second thing to do if the gate refuses, and every one of them
 * DISCARDED the answer, so a refusal there was a silence — the exact defect T1
 * exists to close, one layer above "it said it sent the message".
 *
 * This is what consuming means at those sites: the refusal reaches a log with its
 * gate NAME and the row it was about. It is deliberately NOT a branch. Changing
 * what the platform DOES on a refused status move is a behaviour change with its
 * own evidence to gather; T1's remit is making the refusal visible, and inventing
 * recovery at twenty sites under a type rename is how a refactor becomes an
 * incident. Whoever picks each one up now has a log line to start from.
 *
 * It is not an escape hatch and it does not silence anything: it is greppable, it
 * is one name, and every use of it is a site that owes a decision later.
 *
 * `null` is accepted for `revertAskClaimOnAbort`'s deliberate hold, which is
 * already recorded as a `rearm_refused` event and is not an unsettled outcome.
 */
export function noteUnsettled(
  o: WorkOutcome | null, where: string, ctx: Record<string, unknown> = {},
): void {
  if (o === null || workSettled(o)) return;
  logger.warn(`work transition refused: ${where}`, {
    ...ctx,
    reason: o.reason,
    detail: o.detail,
    ...(o.kind === 'failed' ? {} : { workId: o.workId }),
  });
}
