// PHASE-4 T5 Step 1 — M7: THE ONE PATCH RULE, in one place.
//
//   `undefined`  =  LEAVE THIS FIELD ALONE.   (the key is dropped; no assignment is emitted)
//   `null`       =  CLEAR THIS FIELD.         (an explicit assignment of SQL NULL)
//
// There is no third meaning, and there is no per-site dialect. Before this module every
// patch boundary in the tree wrote its own loop and every one of them made the same mistake
// in the same shape:
//
//     for (const [key, raw] of Object.entries(patch)) { ...; values.push(enc(raw)); }
//     const UPDATABLE = { email: v => v ?? null, connected: v => (v ? 1 : 0), ... };
//
// A JavaScript object cannot distinguish "I never mentioned this field" from "I mentioned
// it and my expression evaluated to undefined" once the key exists, so `?? null` and
// `v ? 1 : 0` both silently turn a caller's *leave it alone* into *erase it*. That is
// P495 (a Google reconnect wiping the account email after a userinfo blip), P527 (the same
// line for Microsoft — its own text generalizes it: "Same mechanism applies to any future
// undefined-valued key in a patch"), and the tracker's own `keys.map(k => patch[k] ?? null)`
// on the work spine.
//
// WHY A HELPER AND NOT A CONVENTION: a convention is what those five sites already had. The
// rule only holds if the undefined-dropping happens BEFORE the encoder can see the value,
// and the only way to guarantee that at every door is for the doors to share the code that
// does it. Encoders therefore never receive `undefined` and must not defend against it —
// a `?? null` inside an encoder is now dead prose and should be deleted, not carried.
//
// P706 IS THE OTHER HALF OF THE SAME RULE. The dashboard used `undefined` as a
// clear-this-field sentinel over JSON, and `JSON.stringify` drops it — so "Unassigned"
// produced an empty PUT body and unassigning was impossible. Under this rule that sentinel
// is spelled `null`, which JSON carries, and every reader below already treats it as CLEAR.

/** A patch: the fields a caller chose to mention, with `undefined` meaning "not mentioned". */
export type PatchOf<K extends string> = Partial<Record<K, unknown>>;

/** The SQL fragment halves a patch turns into. `sets.length === 0` means the patch said
 *  nothing at all — the caller must then write NOTHING, including any `updated_at` bump,
 *  because a clock that moves without a change is a false receipt. */
export interface PatchAssignments {
  sets: string[];
  values: unknown[];
}

export interface PatchAssignmentOptions<K extends string> {
  /** Map a patch key to its column. Returning `undefined` drops the key (not patchable).
   *  Defaults to the key itself. */
  column?: (key: K) => string | undefined;
  /** Encode a MENTIONED value for storage. Never called with `undefined`. */
  encode?: (key: K, value: unknown) => unknown;
}

/**
 * The keys this patch actually mentions, in insertion order, with the undefined ones gone.
 *
 * This is the whole rule; everything else in this file is convenience on top of it.
 */
export function patchedKeys<K extends string>(patch: PatchOf<K>): K[] {
  const out: K[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out.push(key as K);
  }
  return out;
}

/** Build `col = ?` fragments and their bound values from a patch, under the one rule. */
export function patchAssignments<K extends string>(
  patch: PatchOf<K>,
  opts: PatchAssignmentOptions<K> = {},
): PatchAssignments {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of patchedKeys(patch)) {
    const column = opts.column ? opts.column(key) : key;
    if (column === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(opts.encode ? opts.encode(key, patch[key]) : patch[key]);
  }
  return { sets, values };
}

/**
 * The same rule for a JSON blob rather than a column set — the shape PATCH routes need when
 * the storage is one opaque document (P362: `PATCH /api/credentials/:id` handed `body.credentials`
 * straight to a whole-blob overwrite, so a client sending only the changed field destroyed
 * every key it did not resend, irrecoverably).
 *
 * Absent  = leave the existing key alone.
 * `null`  = REMOVE the key (the explicit clear; a stored `null` value would be indistinguishable
 *           from "I did not send it" on the next round trip, so removal is the only honest
 *           reading of an explicit null here).
 * else    = replace the key.
 */
export function mergeObjectPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) { delete merged[key]; continue; }
    merged[key] = value;
  }
  return merged;
}
