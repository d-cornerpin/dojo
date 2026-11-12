// The one patch rule: `undefined` = leave the field alone (key dropped), `null` = clear it (SQL NULL).
// Undefined keys drop before the encoder runs, so encoders never see `undefined` and need no `?? null`.

export type PatchOf<K extends string> = Partial<Record<K, unknown>>;

/** `sets.length === 0` means the patch said nothing: write nothing, not even an `updated_at` bump. */
export interface PatchAssignments {
  sets: string[];
  values: unknown[];
}

export interface PatchAssignmentOptions<K extends string> {
  /** Map a key to its column; `undefined` drops the key (not patchable). Defaults to the key. */
  column?: (key: K) => string | undefined;
  encode?: (key: K, value: unknown) => unknown;
}

export function patchedKeys<K extends string>(patch: PatchOf<K>): K[] {
  const out: K[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out.push(key as K);
  }
  return out;
}

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

/** The same rule for one JSON blob: absent leaves a key, `null` removes it (a stored null would read as
 *  not sent on the next round trip), anything else replaces it. */
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
