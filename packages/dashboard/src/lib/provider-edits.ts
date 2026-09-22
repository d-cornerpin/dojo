// ════════════════════════════════════════════════════════════════════════════════════════
// THE TWO PROVIDER NUMBERS THAT HAD DOORS BUT NO FORM, AND THE RULE FOR SENDING THEM.
//
// `providers.prefill_tokens_per_sec` (T81b) and `providers.max_unattended_minutes` (T79b) have
// had write doors, validation and live readers since they were built, and until now neither
// was reachable from the dashboard at all: the only way to set either was to hand-write an
// HTTP request. This module is the part of closing that which can be argued with in a test —
// the parsing, the bounds, and the ONLY-WHAT-MOVED decision — rather than only observed in a
// browser.
//
// ── WHY THIS IS NOT IN `Settings.tsx` ──
// T66b's editor states the invariant as "TWO DOORS, ONE SAVE": each door owns its own columns,
// the user sees one button, and a field the user did not touch is never mentioned in any
// request. That second half is the anti-trap, and it is the half a `.tsx` file cannot prove —
// `packages/dashboard` has no test runner, so every rule that lives inside the component is a
// rule nothing checks. Both new doors REFUSE their field by name on the identity door
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

/** `agent/unattended-budget.ts` — `UNATTENDED_MIN_MINUTES` / `UNATTENDED_MAX_MINUTES`. */
export const UNATTENDED_MIN_MINUTES = 15;
export const UNATTENDED_MAX_MINUTES = 24 * 60;
/** What a NULL row resolves to: a 15-minute turn budget times 1 + 3 continuations. */
export const UNATTENDED_STANDARD_MINUTES = 60;
/**
 * The one digit that means "no cap at all". Unambiguous rather than a typo risk, and the
 * migration's own header says why: every legal positive declaration is floored at 15, so a
 * dropped digit lands either above the floor (a strict but real budget) or below it (refused
 * back to the standard hour). Zero is never reachable by accident.
 */
export const UNATTENDED_UNCAPPED = 0;

/** Typed whole number → the wire. `''` is "say nothing" (null), the form-wide convention. */
export type WholeParse = { ok: true; value: number | null } | { ok: false; error: string };

export const parseWholeNumber = (
  raw: string, label: string, min: number, max: number, alsoAllow?: number,
): WholeParse => {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: `${label} must be a whole number` };
  }
  if (n === alsoAllow) return { ok: true, value: n };
  if (n < min || n > max) {
    return { ok: false, error: `${label} must be between ${min} and ${max}` };
  }
  return { ok: true, value: n };
};

export const parseReadingSpeed = (raw: string): WholeParse =>
  parseWholeNumber(raw, 'Reading speed', THROUGHPUT_MIN_TOK_PER_SEC, THROUGHPUT_MAX_TOK_PER_SEC);

export const parseUnattendedMinutes = (raw: string): WholeParse =>
  parseWholeNumber(
    raw, 'Working time on its own', UNATTENDED_MIN_MINUTES, UNATTENDED_MAX_MINUTES, UNATTENDED_UNCAPPED,
  );

/** What the two narrow doors should be sent. A key is PRESENT only when that field moved. */
export interface ProviderNumberEdits {
  prefillTokensPerSec?: number | null;
  unattendedBudgetMinutes?: number | null;
}

/**
 * THE ONLY-WHAT-MOVED RULE, as one function.
 *
 * `'field' in edits` is the question each door's `if` asks, and an ABSENT key is categorically
 * different from a `null` one: absent means "this door is not called at all", null means "call
 * it and clear the stored value". Collapsing the two is exactly how a save that only renamed a
 * provider would also wipe a reading speed its owner had deliberately set.
 *
 * Refuses the whole batch on the first unparseable field rather than sending the half that
 * parsed: a save that partly succeeded is the state a user cannot reason about, and both of
 * these are single numbers with no ordering between them worth preserving.
 */
export const numberEditsFor = (
  provider: { prefillTokensPerSec: number | null; unattendedBudgetMinutes: number | null },
  form: { tokensPerSec: string; unattendedMinutes: string },
): { ok: true; edits: ProviderNumberEdits } | { ok: false; error: string } => {
  const speed = parseReadingSpeed(form.tokensPerSec);
  if (!speed.ok) return { ok: false, error: speed.error };
  const unattended = parseUnattendedMinutes(form.unattendedMinutes);
  if (!unattended.ok) return { ok: false, error: unattended.error };

  const edits: ProviderNumberEdits = {};
  if (speed.value !== provider.prefillTokensPerSec) edits.prefillTokensPerSec = speed.value;
  if (unattended.value !== provider.unattendedBudgetMinutes) {
    edits.unattendedBudgetMinutes = unattended.value;
  }
  return { ok: true, edits };
};

/** A stored number as the form holds it: `''` is "nothing declared". */
export const numInput = (n: number | null): string => (n === null ? '' : String(n));
