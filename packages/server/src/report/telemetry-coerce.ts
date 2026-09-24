// ════════════════════════════════════════════════════════════════════════════
// THE COERCION LAYER — WHERE A DECLARED DOMAIN IS ENFORCED (DOJO-REPORT T1)
//
// `telemetry-whitelist.ts` DECLARES what a telemetry field may contain. This
// file is what makes the declaration bite: five small functions, each of which
// takes a FIELD PATH or a number, and none of which will emit a value it could
// not check against that field's own declaration.
//
// Split out of `telemetry-build.ts` in the T1 fix round. The builder composes a
// SHAPE; this is the privacy boundary, and the boundary is worth reading on its
// own — it is also the half that budget pressure would otherwise squeeze first,
// which is the wrong half to squeeze.
//
// ── WHY THERE ARE FOUR COERCERS AND NOT THE THREE THE PLAN PINNED ──
// The plan pinned three (`nonNeg`, `iso`, `asEnum`) and, in the same breath, the
// stronger rule: "it never writes a value it did not route through one of them".
// Those two cannot both hold. `'version'` and `'digest'` are string kinds that no
// enum declares and no number coercer accepts, and `asEnum` opens by returning
// the sentinel for any field whose kind is not `'enum'` — so with three coercers
// the schema, the platform version and the report signature would either be
// written RAW (breaking the invariant the privacy model rests on) or be blanked
// on every report. `asShape` closes that hole, and the invariant wins.
//
// ── WHY `asShape` TAKES A PATH AND NOT A STRING (the C1/C2 fix) ──
// The first cut of this coercer was a single shared regex — a "safe character
// set" that banned whitespace, quotes and slashes and passed everything else.
// Review killed it, correctly. A charset filter is SUBTRACTIVE: it enumerates
// what is dangerous and lets the rest by, which is REDACTION, the exact mechanism
// owner ruling D1 rejects, reintroduced inside the file that exists to replace
// it. Fifteen of twenty-three hostile probes walked straight through it —
// `taxes.pdf`, `Sarah-divorce-settlement.docx`, `Dave-Cliff`, `DavesMacStudio`,
// `mothers_maiden_name`, `AKIAIOSFODNN7EXAMPLE`, a 64-character blob — and
// end-to-end the builder emitted `report.signature = "taxes.pdf"`: the exact
// string the suite's flagship clause exists to keep off a public issue, arriving
// through a different door.
//
// The replacement is CONSTRUCTIVE and per-field. `asShape` takes a path, looks up
// that field's declared anchored `pattern`, and applies IT — so a signature must
// be `ds1-` plus twelve hex digits, a version must be a semver, and the schema
// must be the schema constant. A field that declares no pattern gets the
// sentinel, never a pass. THERE IS NO GENERIC STRING PATH and there must never be
// one: a shared filter is how the blacklist grows back.
//
// ── WHY NULL BECOMES `ABSENT` AND NOT A MEMBER ──
// A null column is a FACT ("this turn had no lane"), not a failure to recognise
// something, so it must not read as `UNRECOGNISED` — a triager would hunt a bug
// that is not there. But the first cut emitted the literal `'none'`, which
// FABRICATED a member on the 9 enum fields whose declared domain never contained
// one. That was production-reachable, not theoretical: `turns.exit_reason` is
// NULL for every OPEN turn, and an open turn is exactly what a `silence`-lane
// report captures. `ABSENT` is its own sentinel — honest about absence, never
// mistakable for a value the platform actually recorded, and never a member.
//
// ── THE INVARIANT THESE FIVE FUNCTIONS HOLD TOGETHER ──
// Every string in an attachment is either a declared member of its own field, a
// value matching its own field's declared pattern, or one of the two sentinels.
// `__tests__/the-telemetry-whitelist-admits-no-free-text.test.ts` asserts exactly
// that over a fully-populated source and over an all-null one.
// ════════════════════════════════════════════════════════════════════════════

import {
  TELEMETRY_WHITELIST, UNRECOGNISED, ABSENT, whitelistField, enumMembers,
} from './telemetry-whitelist.js';

/** A count/millis/bytes/ordinal. Non-finite or negative is not a measurement. */
export const nonNeg = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

/** A 'timestamp'. Anything `Date.parse` rejects is not an instant. */
export const iso = (s: string | null | undefined): string | null =>
  typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;

/**
 * An 'enum'. The domain is the FIELD'S — inline `members`, or the live
 * platform set named by `membersFrom` (resolved through `enumMembers`, which
 * returns `[]` on every unresolvable branch, so an unknown tool matches nothing).
 */
export const asEnum = (path: string, value: string | null | undefined, toolName?: string): string => {
  const f = whitelistField(path);
  if (!f || f.kind !== 'enum') return UNRECOGNISED;
  if (value === null || value === undefined) return ABSENT;
  return enumMembers(f, toolName).includes(value) ? value : UNRECOGNISED;
};

/**
 * A 'version' or a 'digest'. Takes a PATH, never a bare string: the domain
 * belongs to the field, and a field declaring no `pattern` gets the sentinel.
 *
 * N1 — THE `typeof` GUARD IS LOAD-BEARING, NOT DEFENSIVE NOISE.
 * `RegExp.prototype.test` coerces its argument through `toString()`, so a
 * `Buffer` or a `String` object whose text matches PASSES the test — and this
 * function returns the VALUE, not the matched text, so the raw object would land
 * in the attachment (`{"type":"Buffer","data":[…]}`). The declared parameter type
 * does not stop it: `gather.ts` fills these fields from `better-sqlite3`, which
 * hands back `any`, and a BLOB column is a realistic route. The other coercers
 * all hold their type — this one dropped the guard in the C2 rewrite.
 */
export const asShape = (path: string, value: string | null | undefined): string => {
  const f = whitelistField(path);
  if (!f || f.pattern === undefined) return UNRECOGNISED;
  if (value === null || value === undefined) return ABSENT;
  return typeof value === 'string' && f.pattern.test(value) ? value : UNRECOGNISED;
};

/**
 * ONE RECORD, KEYED BY THE WHITELIST — the gate every emitted key passes.
 * Walks the whitelist rows directly under `prefix` and emits only those the
 * caller supplied a value for. Both directions fail closed on purpose: a
 * whitelist row with no value here is OMITTED (a missing field, the designed
 * mistake), and a value here with no whitelist row is NEVER EMITTED — the
 * whitelist decides the key set, so a "helpful" extra value cannot reach a
 * public issue without being declared first.
 */
export function emit(prefix: string, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TELEMETRY_WHITELIST) {
    if (!f.path.startsWith(`${prefix}.`)) continue;
    const leaf = f.path.slice(prefix.length + 1);
    // A dotted leaf names a NESTED section (`tool.arg_shape.key`): the gate admits
    // the container `arg_shape`, whose records are their own `emit()` call. I2 —
    // that container used to be spread in AFTER the gate, which made "add a key
    // outside the whitelist" an established pattern in the builder itself.
    const key = leaf.includes('.') ? leaf.slice(0, leaf.indexOf('.')) : leaf;
    if (key in out || !(key in values)) continue;
    out[key] = values[key];
  }
  return out;
}
