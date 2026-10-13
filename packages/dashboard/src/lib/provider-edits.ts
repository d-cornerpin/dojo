// ════════════════════════════════════════════════════════════════════════════════════════
// THE PROVIDER NUMBER THAT HAD A DOOR BUT NO FORM, AND THE RULE FOR SENDING IT.
//
// `providers.prefill_tokens_per_sec` (T81b) had a write door, validation and a live reader
// since it was built, and until T66b it was not reachable from the dashboard at all: the only
// way to set it was to hand-write an HTTP request. (t137: its sibling, the per-provider
// unattended budget, is deleted with the total-time cap it set — OR-LONG-JOBS.) This module is
// the part of closing that which can be argued with in a test — the parsing, the bounds, and
// the ONLY-WHAT-MOVED decision — rather than only observed in a browser.
//
// ── WHY THIS IS NOT IN `Settings.tsx` ──
// T66b's editor states the invariant as "TWO DOORS, ONE SAVE": each door owns its own columns,
// the user sees one button, and a field the user did not touch is never mentioned in any
// request. That second half is the anti-trap, and it is the half a `.tsx` file cannot prove: a
// component test (this package has had a runner since 2026-09-26) can assert what was RENDERED,
// not what a door would accept. The throughput door's field is REFUSED by name on the identity door
// (`gateway/routes/config.ts`), so an "only what changed" bug here is not a cosmetic one: it
// either 400s the whole save or silently clears a number nobody meant to clear.
//
// The bounds below are the server's own, restated in the unit the field is typed in, exactly
// as `Settings.tsx`'s patience fields restate `agent/stream-patience.ts`'s. They exist so the
// user gets a sentence instead of a 400; the server still enforces every one of them.
// ════════════════════════════════════════════════════════════════════════════════════════

/** `agent/stream-patience.ts` — `PREFILL_THROUGHPUT_MIN/MAX_TOK_PER_SEC`. */
export const THROUGHPUT_MIN_TOK_PER_SEC = 1;
export const THROUGHPUT_MAX_TOK_PER_SEC = 100_000;

/** Typed whole number → the wire. `''` is "say nothing" (null), the form-wide convention. */
export type WholeParse = { ok: true; value: number | null } | { ok: false; error: string };

export const parseWholeNumber = (
  raw: string, label: string, min: number, max: number,
): WholeParse => {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: `${label} must be a whole number` };
  }
  if (n < min || n > max) {
    return { ok: false, error: `${label} must be between ${min} and ${max}` };
  }
  return { ok: true, value: n };
};

export const parseReadingSpeed = (raw: string): WholeParse =>
  parseWholeNumber(raw, 'Reading speed', THROUGHPUT_MIN_TOK_PER_SEC, THROUGHPUT_MAX_TOK_PER_SEC);

/** What the narrow door should be sent. The key is PRESENT only when that field moved. */
export interface ProviderNumberEdits {
  prefillTokensPerSec?: number | null;
}

/**
 * THE ONLY-WHAT-MOVED RULE, as one function.
 *
 * `'field' in edits` is the question each door's `if` asks, and an ABSENT key is categorically
 * different from a `null` one: absent means "this door is not called at all", null means "call
 * it and clear the stored value". Collapsing the two is exactly how a save that only renamed a
 * provider would also wipe a reading speed its owner had deliberately set.
 *
 * Refuses on an unparseable field rather than sending anything: a save that partly succeeded
 * is the state a user cannot reason about.
 */
export const numberEditsFor = (
  provider: { prefillTokensPerSec: number | null },
  form: { tokensPerSec: string },
): { ok: true; edits: ProviderNumberEdits } | { ok: false; error: string } => {
  const speed = parseReadingSpeed(form.tokensPerSec);
  if (!speed.ok) return { ok: false, error: speed.error };

  const edits: ProviderNumberEdits = {};
  if (speed.value !== provider.prefillTokensPerSec) edits.prefillTokensPerSec = speed.value;
  return { ok: true, edits };
};

/** A stored number as the form holds it: `''` is "nothing declared". */
export const numInput = (n: number | null): string => (n === null ? '' : String(n));
