// Each coercer takes a field path or a number and emits only what that field's declaration admits; there
// is no generic string path (a charset filter is redaction). Null is `ABSENT`, a miss `UNRECOGNISED`.

import {
  TELEMETRY_WHITELIST, UNRECOGNISED, ABSENT, whitelistField, enumMembers,
} from './telemetry-whitelist.js';

export const nonNeg = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

const SQLITE_UTC_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/** A 'timestamp'. A zoneless SQLite stamp is UTC; `new Date` would read it as LOCAL (an offset leak). */
export const iso = (s: string | null | undefined): string | null => {
  if (typeof s !== 'string') return null;
  const instant = SQLITE_UTC_STAMP.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  return Number.isNaN(Date.parse(instant)) ? null : new Date(instant).toISOString();
};

export const asEnum = (path: string, value: string | null | undefined, toolName?: string): string => {
  const f = whitelistField(path);
  if (!f || f.kind !== 'enum') return UNRECOGNISED;
  if (value === null || value === undefined) return ABSENT;
  return enumMembers(f, toolName).includes(value) ? value : UNRECOGNISED;
};

/** A 'version' or 'digest', by path. The `typeof` guard is needed: `RegExp.test` stringifies a Buffer. */
export const asShape = (path: string, value: string | null | undefined): string => {
  const f = whitelistField(path);
  if (!f || f.pattern === undefined) return UNRECOGNISED;
  if (value === null || value === undefined) return ABSENT;
  return typeof value === 'string' && f.pattern.test(value) ? value : UNRECOGNISED;
};

/** One record keyed by the whitelist: a value with no whitelist row is never emitted. */
export function emit(prefix: string, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TELEMETRY_WHITELIST) {
    if (!f.path.startsWith(`${prefix}.`)) continue;
    const leaf = f.path.slice(prefix.length + 1);
    // A dotted leaf admits its container key only; the nested records must be their own `emit()` call.
    const key = leaf.includes('.') ? leaf.slice(0, leaf.indexOf('.')) : leaf;
    if (key in out || !(key in values)) continue;
    out[key] = values[key];
  }
  return out;
}
