// THE DECLARED LIST OF `work_events.kind` VALUES: the single source of truth. Migration 152's CHECK admits
// exactly these, and `appendEvent` takes only a `WorkEventKind`. A kind reaches a call site as a literal or
// through a constant object bound to this list with `satisfies` (`AUDIT_KIND`, `OCCURRENCE_EVENT`,
// `WORK_EVENT`), so a value off the list is a compile error where it is declared. Kinds nothing writes any
// more stay while old rows carry them; the conformance test names each one.

/**
 * Every value `work_events.kind` may hold. Migration `152`'s CHECK constraint carries this
 * same list, and `work/__tests__/work-event-kinds-conformance.test.ts` asserts the two are
 * set-equal in both directions — the three-way drift (union / CHECK / writers) is the
 * disease this file exists to kill, so no two of the three are allowed to move alone.
 *
 * Sorted, because the CHECK is sorted and a human diffing the two should not have to.
 */
export const WORK_EVENT_KINDS = [
  'activity',
  'audit',
  'child_settled',
  'claim_rejected',
  'claim_turn',
  'claim_upheld',
  'compile_resolved',
  // v3.5 Task D1 (migration 200b, folded into the release's one rebuild): the engine continued a
  // turn that ended mid-job. Declared before its writer lands, named in the conformance exemption.
  'continued',
  // Migration 901: the one path to done. A hand-in (accepted or refused), a decision, and a decider's open of a proof item.
  'decided',
  'floor_ghosted',
  'hand_in_refused',
  'handed_in',
  'join_complete',
  'join_opened',
  // v3.5 DONE IS MEASURED (migration 200b). One reading of a task's measure: what it returned,
  // when, and whether it could be read (`work/ledger-store.ts`).
  'measured',
  'occurrence_fired',
  'occurrence_released',
  'occurrence_settled',
  'opened',
  'override_request',
  'override_resolved',
  // UX-REPAIR ROUND 6 T25 (migration 159). The owed mid-turn interrupt records, BY ID, which
  // asks a running turn still owes an answer to. It is the settlement authority's own
  // discriminator: the mechanism that KNOWS an ask is still owed now says so on that ask's
  // spine, instead of only quoting its text into a re-prompt nothing can read as evidence.
  'owed_interrupt',
  // `person_told`, `poke`, `poke_remediation`: old rows only; nothing writes them.
  'person_told',
  'poke',
  'poke_remediation',
  'proof_opened',
  'rearm_refused',
  'revert_reset',
  // v3.5 Task D1 (migration 200b): a continued turn came back with no momentum. As `continued`.
  'stalled',
  'transition',
  'user_verdict_cleared',
  'user_verdict_requested',
  'validation_escalated',
  'validation_requested',
] as const;

/** The type `appendWorkEvent`'s `kind` parameter is narrowed to. A kind that is not on the
 *  list above is refused by the COMPILER, before the database is ever asked — the cheapest
 *  half of the guard, and the only half that fires while somebody is still typing. */
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

/**
 * Is this string a declared kind? For the boundaries where a kind arrives as data rather
 * than as source — a route parameter, a payload, a row read back out of the database.
 * There is no such boundary in the tree today (every writer passes a literal or a constant);
 * it exists so that the first one that appears has somewhere to go other than a cast.
 */
export function isWorkEventKind(value: string): value is WorkEventKind {
  return (WORK_EVENT_KINDS as readonly string[]).includes(value);
}
