// ════════════════════════════════════════
// `Outcome<T>` — the five-way answer to "what actually happened?"  (PHASE-4 T1)
//
// ── WHY THIS EXISTS ──
// The platform used to answer that question with a boolean, a nullable id, or a
// thrown exception, and all three lose the same fact: the difference between
// "I did it", "there was nothing to do", "I was not allowed", "it broke", and
// "I cannot honestly say". Those are five different things to tell a person, and
// a system that collapses them tells the person a lie roughly one time in five.
//
//   applied    the state changed, and here is the proof (`value`)
//   no_change  the caller asked for something that was already true; nothing moved
//   refused    a gate said no, and the gate has a NAME (`reason`)
//   failed     it broke — the effect did not happen and we know it did not
//   unknown    we cannot say, and saying so is the honest answer  ← QUARANTINED
//
// ── THE `unknown` QUARANTINE (research 19 §1a, MAP:601/1240; OR5/Stable Bridge) ──
// `unknown` is the arm that rots a ledger if it is available for free: every
// caller with an awkward case reaches for it, and a table of `unknown` is a table
// nobody can act on. It is therefore legal ONLY where the data in play is not
// live — `messages.provenance` is `'live' | 'migrated' | 'rescued'` by CHECK
// (migration `127_unified_messages.sql:115`), and only a `migrated`/`rescued` row
// carries history nobody in this system observed. Three enforcements, because one
// is a suggestion:
//   1. TYPE — `OutcomeUnknown` demands `provenance: NonLiveProvenance`, so the
//      literal `'live'` will not compile.
//   2. TYPE — `LiveOutcome<T,R>` is the four-way with the arm EXCLUDED. A boundary
//      that only ever touches live data declares that type and cannot return
//      `unknown` at all; the compiler is the quarantine wall.
//   3. RUNTIME — `unknownOutcome()` refuses a provenance value that arrived from
//      data rather than from a literal, and `quarantineUnknown()` re-checks an
//      already-built outcome against the subject it claims to describe.
//
// ── MUST-CONSUME ──
// An `Outcome` nobody looks at is worse than no `Outcome`: it is a refusal that
// was reported and discarded. The rule that forbids that is
// `deploy/checks/eslint-rules/must-consume-outcome.cjs`, keyed on the SHAPE
// declared here (a `kind` whose literals are a subset of `OUTCOME_KINDS`), never
// on a type name — a name is a string a rename can silently break.
//
// ── WHAT THIS IS NOT ──
// It is not an error type and it is not `Result`. Boundaries here refuse by
// RETURNING, never by throwing (`work/store.ts`'s own doc comment said this before
// this file existed), so a caller that ignores a refusal has a value it did not
// use rather than an exception it swallowed — and that is a thing a lint can see.
// ════════════════════════════════════════

/** The five arms, in the order they are argued above. */
export type OutcomeKind = 'applied' | 'no_change' | 'refused' | 'failed' | 'unknown';

/** Runtime copy of the union, for checkers that must not re-type the list. */
export const OUTCOME_KINDS: readonly OutcomeKind[] = [
  'applied', 'no_change', 'refused', 'failed', 'unknown',
] as const;

// ── Provenance: the quarantine's subject ──

/** `messages.provenance`, exactly as the column's CHECK declares it. */
export type Provenance = 'live' | 'migrated' | 'rescued';

/** The only provenances an `unknown` outcome may speak about. */
export type NonLiveProvenance = Exclude<Provenance, 'live'>;

export const PROVENANCES: readonly Provenance[] = ['live', 'migrated', 'rescued'] as const;
export const NON_LIVE_PROVENANCES: readonly NonLiveProvenance[] = ['migrated', 'rescued'] as const;

export function isNonLiveProvenance(p: unknown): p is NonLiveProvenance {
  return p === 'migrated' || p === 'rescued';
}

// ── The tool seam's reason vocabulary (research 22) ──

/**
 * Why a tool call did not simply work.
 *   blocked    a gate said no (policy, permission, rate limit). Nothing ran.
 *   crashed    it ran and broke. The effect may or may not have landed.
 *   cancelled  it was abandoned before an answer (timeout, abort, spin brake).
 */
export type ToolSeamReason = 'blocked' | 'crashed' | 'cancelled';
export const TOOL_SEAM_REASONS: readonly ToolSeamReason[] = ['blocked', 'crashed', 'cancelled'] as const;

// ── The arms ──
//
// Declared as five named interfaces rather than one inline union so a boundary can
// INTERSECT extra evidence onto a single arm (`OutcomeRefused<G> & { workId }`)
// without re-declaring the shape. That is how `work/outcome.ts` keeps the
// conflict arm's `expected`/`actual` typed instead of demoting them to prose —
// the binding caution is receipt-keyed, never prose-keyed, and a `detail` string
// a caller has to parse is prose.

export interface OutcomeApplied<T> {
  readonly kind: 'applied';
  /** The proof. `void` where the act itself is the whole fact. */
  readonly value: T;
  /** Human-readable colour. Never the carrier of a machine-read fact. */
  readonly detail?: string;
}

export interface OutcomeNoChange<R extends string = string> {
  readonly kind: 'no_change';
  readonly reason: R;
  readonly detail: string;
}

export interface OutcomeRefused<R extends string = string> {
  readonly kind: 'refused';
  readonly reason: R;
  readonly detail: string;
}

export interface OutcomeFailed<R extends string = string> {
  readonly kind: 'failed';
  readonly reason: R;
  readonly detail: string;
}

export interface OutcomeUnknown<R extends string = string> {
  readonly kind: 'unknown';
  readonly reason: R;
  readonly detail: string;
  /** Quarantine wall 1: `'live'` is not assignable here. */
  readonly provenance: NonLiveProvenance;
}

/** The five-way. `T` is the applied proof; `R` is the boundary's reason vocabulary. */
export type Outcome<T = void, R extends string = string> =
  | OutcomeApplied<T>
  | OutcomeNoChange<R>
  | OutcomeRefused<R>
  | OutcomeFailed<R>
  | OutcomeUnknown<R>;

/**
 * Quarantine wall 2 — the four-way, for a boundary whose data is always live.
 *
 * Declaring this instead of `Outcome` is not a style choice: it makes `unknown`
 * UNREPRESENTABLE at that seam, which is the same move `LEGAL[]` makes for work
 * states. Both of Phase 4's live boundaries (work transition, tool execution)
 * declare it.
 */
export type LiveOutcome<T = void, R extends string = string> =
  | OutcomeApplied<T>
  | OutcomeNoChange<R>
  | OutcomeRefused<R>
  | OutcomeFailed<R>;

// ── Constructors ──
//
// Present so every construction site reads the same and so the quarantine has ONE
// runtime door. A boundary may still write an object literal (the arms are plain
// interfaces); what it may not do is build an `unknown` without passing this door,
// because the door is where a provenance that came from a ROW rather than from a
// literal gets checked.

export function applied<T>(value: T, detail?: string): OutcomeApplied<T> {
  return detail === undefined ? { kind: 'applied', value } : { kind: 'applied', value, detail };
}

export function noChange<R extends string>(reason: R, detail: string): OutcomeNoChange<R> {
  return { kind: 'no_change', reason, detail };
}

export function refused<R extends string>(reason: R, detail: string): OutcomeRefused<R> {
  return { kind: 'refused', reason, detail };
}

export function failed<R extends string>(reason: R, detail: string): OutcomeFailed<R> {
  return { kind: 'failed', reason, detail };
}

/**
 * Quarantine wall 3 — the only door to `unknown`.
 *
 * `provenance` is typed `Provenance`, not `NonLiveProvenance`, ON PURPOSE: the
 * realistic caller reads the value off a row, where the type system has already
 * been told whatever the row said. A door that only accepted the safe type would
 * be a door that never fires. It throws rather than returning a refusal because
 * there is no honest outcome to return — the caller asked to record "I cannot
 * say" about data the platform itself produced, and that is a bug in the caller,
 * not a state of the world.
 */
export function unknownOutcome<R extends string>(
  reason: R, detail: string, provenance: Provenance,
): OutcomeUnknown<R> {
  if (!isNonLiveProvenance(provenance)) {
    throw new Error(
      `Outcome 'unknown' is quarantined to non-live data (research 19 §1a): refused for provenance='${String(provenance)}' ` +
      `[reason=${String(reason)}]. Live data has an observable answer — report applied/no_change/refused/failed instead.`,
    );
  }
  return { kind: 'unknown', reason, detail, provenance };
}

/**
 * Re-check a built outcome against the subject it claims to describe.
 *
 * For the case the constructor cannot see: an outcome assembled elsewhere (a
 * fixture, a deserialised row, a helper that was handed the wrong subject) and
 * only later matched against the provenance of the thing it is about.
 */
export function quarantineUnknown<T, R extends string>(
  outcome: Outcome<T, R>, subjectProvenance: Provenance,
): LiveOutcome<T, R> | OutcomeUnknown<R> {
  if (outcome.kind !== 'unknown') return outcome;
  if (!isNonLiveProvenance(subjectProvenance)) {
    throw new Error(
      `Outcome 'unknown' is quarantined to non-live data (research 19 §1a): the subject is provenance='${String(subjectProvenance)}' ` +
      `[reason=${String(outcome.reason)}]. Quarantine breach.`,
    );
  }
  return outcome;
}

// ── Readers ──

export function isApplied<T, R extends string>(o: Outcome<T, R>): o is OutcomeApplied<T> {
  return o.kind === 'applied';
}
export function isNoChange<T, R extends string>(o: Outcome<T, R>): o is OutcomeNoChange<R> {
  return o.kind === 'no_change';
}
export function isRefused<T, R extends string>(o: Outcome<T, R>): o is OutcomeRefused<R> {
  return o.kind === 'refused';
}
export function isFailed<T, R extends string>(o: Outcome<T, R>): o is OutcomeFailed<R> {
  return o.kind === 'failed';
}
export function isUnknown<T, R extends string>(o: Outcome<T, R>): o is OutcomeUnknown<R> {
  return o.kind === 'unknown';
}

/**
 * "Did the caller get what it asked for, or is the world already that way?"
 *
 * The one predicate that legitimately merges two arms, because a dozen call sites
 * ask exactly this question and every one of them wrote it as
 * `r.kind !== 'applied' && r.kind !== 'noop'`. It merges NOTHING ELSE: a refusal,
 * a failure and an unknown stay three different answers.
 */
export function isSettled<T, R extends string>(o: Outcome<T, R>): o is OutcomeApplied<T> | OutcomeNoChange<R> {
  return o.kind === 'applied' || o.kind === 'no_change';
}

/** The gate name, or `null` on the arm that has none. Never parses `detail`. */
export function outcomeReason<T, R extends string>(o: Outcome<T, R>): R | null {
  return o.kind === 'applied' ? null : o.reason;
}

/** One line for a log or a steer. Diagnostics only — nothing load-bearing reads it. */
export function describeOutcome<T, R extends string>(o: Outcome<T, R>): string {
  if (o.kind === 'applied') return o.detail ? `applied: ${o.detail}` : 'applied';
  if (o.kind === 'unknown') return `unknown (${o.provenance}/${String(o.reason)}): ${o.detail}`;
  return `${o.kind} (${String(o.reason)}): ${o.detail}`;
}

/**
 * Structural recogniser, exported so a CHECKER can share it with the type.
 *
 * The must-consume lint rule asks the TypeScript checker the same question this
 * asks a value: does it carry a `kind` drawn from `OUTCOME_KINDS`? Keeping the
 * predicate here means the rule and the type cannot drift apart the way a
 * hand-copied list of names does.
 */
export function isOutcomeShaped(v: unknown): v is Outcome<unknown, string> {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { kind?: unknown }).kind;
  return typeof k === 'string' && (OUTCOME_KINDS as readonly string[]).includes(k);
}
