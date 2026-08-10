// THE DECLARED LIST OF `work_events.kind` VALUES — the single source of truth.
// PHASE-4 T4-SCHEMA (orchestrator ruling P4-R1).
//
// WHAT WAS BROKEN, and it is not "the enum needs one more value". There was no enum.
// Migration `135_work_spine.sql:75` reads
//
//     kind TEXT NOT NULL,  -- 12-value enum per 19 s1c incl. 'poke','override_request','observation'
//
// and that comment was the whole of it: no CHECK on the column, no TypeScript union,
// and `appendEvent(workId, kind: string, …)` — a bare `string`. Research
// `19-rebuild-map-lifts.md:33` really does say *"work_event DDL 12-kind enum"*; `135`
// transcribed a DESIGN DOCUMENT's enum into a SCHEMA COMMENT and nothing ever made it
// true. The declared list and the written list had never been the same list, and no
// mechanism existed that could notice.
//
// ── THE LIST BELOW IS DERIVED, NOT INHERITED (roadmap #14). Commands, at dojo dc6da8b: ──
//
//   11 literal kinds, over 29 call sites:
//     git grep -ohE "append(Work)?Event\([^,]+, *'[a-z_]+'" HEAD -- packages/server/src \
//       | grep -v __tests__ | sed -E "s/.*'([a-z_]+)'/\1/" | sort -u
//   13 more reached through five constant objects, which are the ONLY other route:
//     work/audit-trail.ts       AUDIT_KIND        audit
//     work/occurrences.ts       OCCURRENCE_EVENT  occurrence_fired|released|settled
//     work/override-requests.ts OVERRIDE_EVENT    override_request, override_resolved
//     work/poke-ladder.ts       POKE_EVENT / REMEDIATION_EVENT   poke, poke_remediation
//     work/tracker-view.ts      WORK_EVENT        validation_escalated, user_verdict_requested,
//                                                 user_verdict_cleared, revert_reset, activity
//   = 24 writable from production code. Every one of the 29 call sites passes either a
//   literal or one of those constants — there is no computed or variable `kind` anywhere,
//   which is what makes narrowing the parameter possible without a single cast.
//
//   + `floor_ghosted` = 25. PHASE-4 T4's Step 2 writes its first row (OR2: when a floor's
//   steer is refused twice and the agent truly ghosts, the platform records the ghost
//   instead of speaking in the agent's voice). It is DECLARED HERE and UNWRITTEN TODAY,
//   deliberately and with an owner, and the conformance walk asserts that set EXACTLY so
//   the exemption cannot silently grow.
//
// ── AND THE HISTORY WAS SWEPT, because a stable box carries rows this build never wrote ──
// `work_events` was born at migration `135` (commit 6f17259). Every commit from there to
// HEAD — 178 of them — was re-enumerated with the two commands above. The writable set has
// never differed from the 24 above: not one kind was ever added and later removed. The
// three chain files that INSERT into this table directly (`135b`, `144`, `146`) write only
// `poke`, `override_request`, `occurrence_settled` and `audit`, all four on the list. So an
// off-list row on a real body cannot be a product of any version of this platform — which
// is the fact migration `152`'s quarantine branch is sized against, and the reason that
// branch is a safety net rather than a data transform.
//
// ── WHY A LIST AND NOT FIVE LISTS ──
// The five constant objects above stay: they are what stops a WRITER and a READER
// disagreeing by typo (`poke-ladder.ts` writes `POKE_EVENT`, `currentRung` reads it). What
// they stop being is five independent DECLARATIONS. Each now carries
// `satisfies WorkEventKind` / `satisfies Record<string, WorkEventKind>`, so a value that is
// not on this list is a compile error at the constant object itself, and this file is the
// only place a kind comes into existence.

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
  'floor_ghosted',
  'join_complete',
  'join_opened',
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
  'poke',
  'poke_remediation',
  'rearm_refused',
  'revert_reset',
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
