// ════════════════════════════════════════════════════════════════════════════════════════
// HOW LONG A PROVIDER MAY RUN UNATTENDED (SLOW-INFERENCE T79b).
//
// `agent/v2/steps/pre-call-gates/turn-budget.ts` parks a turn every 15 minutes so it can
// checkpoint and self-continue; `MAX_TURN_AUTO_CONTINUATIONS = 3` used to cap that ladder at a
// flat 60 minutes for every provider, metered cloud API and free local box alike. This is a
// LEAF module on the same principle T64b's `stream-patience.ts` established: `config/schema.ts`
// validates what may be WRITTEN and `turn-budget.ts` decides what is HONOURED, and if the two
// read different numbers a value could be storable and unhonourable at the same time. One pair
// of constants, imported by both doors, is what keeps that impossible.
//
// This module holds no database access and mirrors `stream-patience.ts`'s shape deliberately:
// a resolver that turns a stored (or absent) declaration into a real number, pure enough to
// test without a connection. The one DB read — `providers.max_unattended_minutes` via the same
// `models JOIN providers` join migration 163 already rides for response patience — lives at
// `turn-budget.ts`'s cap check, its only call site, read fresh on every evaluation.
// ════════════════════════════════════════════════════════════════════════════════════════

// ── The standing default ──
//
// Derived from what the tree already did: a 15-minute turn budget times
// `(1 + 3 continuations)` is 60 minutes, so every provider that has never declared a budget
// keeps running exactly that ladder. This is the ONE number `resolveUnattendedBudget` falls
// back to, on a NULL row or an incoherent one.
export const UNATTENDED_DEFAULT_MINUTES = 60;

// ── What a provider may declare ──
//
// FLOOR — fifteen minutes: one full turn budget. Below this a "budget" could not survive a
// single checkpoint, which is not a budget, it is an instant trip — and it makes the floor a
// KINDNESS TO THE PERSON TYPING for the same reason 163's floor is: a value meant as SECONDS
// (`15` instead of `15` minutes read as `900000` ms — the door and this module both speak
// minutes, so the realistic typo is dropping a digit, e.g. `5` for `50`) still lands on a real,
// if strict, budget rather than a value so small every long turn trips it before the model has
// any chance to finish a checkpoint.
export const UNATTENDED_MIN_MINUTES = 15;

// CEILING — twenty-four hours. A budget that outlives a calendar day is indistinguishable from
// no budget at all for the purpose this cap exists to serve (an eventual honest pause, not an
// eternal one), and the write door's own bound has to mean something.
export const UNATTENDED_MAX_MINUTES = 1440;

// UNCAPPED — the one legal value below the floor, and it means the opposite of "broken". A
// provider that types `0` is not making a typo (see migration 164's header for why zero cannot
// be reached by accident): it is declaring "let this box run to completion, however long that
// takes." `resolveUnattendedBudget` turns it into `Infinity`, and `continuationCapFor` turns
// `Infinity` into a cap no continuation count can ever exceed.
export const UNCAPPED = 0;

/**
 * A stored declaration is honoured when it is COHERENT: a whole number of minutes inside
 * [`UNATTENDED_MIN_MINUTES`, `UNATTENDED_MAX_MINUTES`]. Zero is handled by the caller before
 * this runs — it is a legal value OUTSIDE this range, not a coherence failure. Anything else
 * incoherent (negative, fractional, NaN, a string, past the ceiling) falls back to the standing
 * default, the same asymmetry 163's `isCoherent` documents: the write door refuses these
 * shapes outright, but the reader must survive a row the door never approved (a hand-edited
 * database, a restored backup, a writer that does not exist yet) rather than throw at cap-check
 * time, which is not the place to discover a schema opinion.
 */
function isCoherentMinutes(stored: unknown): stored is number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return false;
  if (stored < UNATTENDED_MIN_MINUTES || stored > UNATTENDED_MAX_MINUTES) return false;
  return true;
}

/**
 * The one reader of `providers.max_unattended_minutes`, as a resolved number of minutes.
 * Never null and never throws — a cap check is not the place to discover a schema opinion.
 *
 * `null` / `undefined` (every provider configured before T79b, and every preset since) —
 * "declared nothing" — resolves to `UNATTENDED_DEFAULT_MINUTES`, which is what makes "existing
 * providers keep today's 3-continuation ladder" a fact about the code rather than a hope.
 *
 * `0` resolves to `Infinity` — see `UNCAPPED`'s own comment for why zero is safe to spend on
 * this meaning rather than being read as an accident.
 *
 * Any other coherent whole number inside the legal range is honoured as declared. Anything
 * incoherent falls back to the default, exactly as a foreign value in the patience columns
 * falls back rather than aborting a call.
 */
export function resolveUnattendedBudget(declared: number | null | undefined): number {
  if (declared === UNCAPPED) return Infinity;
  if (isCoherentMinutes(declared)) return declared;
  return UNATTENDED_DEFAULT_MINUTES;
}

/**
 * How many auto-continuations a resolved budget buys, given the turn-time budget each
 * continuation spends.
 *
 * `Math.ceil(budgetMinutes / turnBudgetMinutes) - 1` — the `-1` because the FIRST 15 minutes is
 * the original turn, not a continuation; everything past it is what the ladder counts. Rounding
 * UP means a declared budget that does not divide evenly still gets the continuation that would
 * carry it past its own ceiling, rather than being cut one short of what was promised.
 *
 * NULL-ROW CONTROL (byte-preserves today): `continuationCapFor(UNATTENDED_DEFAULT_MINUTES, 15)`
 * = `Math.ceil(60 / 15) - 1` = `4 - 1` = `3` — the exact `MAX_TURN_AUTO_CONTINUATIONS` this
 * replaces.
 *
 * `Infinity` in (an uncapped budget) produces `Infinity` out, by ordinary IEEE-754 arithmetic
 * (`Math.ceil(Infinity / 15) - 1 = Infinity`) — no special case needed, and `continuationCount
 * > Infinity` is `false` for every finite count, which is exactly "no cap".
 */
export function continuationCapFor(budgetMinutes: number, turnBudgetMinutes: number): number {
  return Math.ceil(budgetMinutes / turnBudgetMinutes) - 1;
}
