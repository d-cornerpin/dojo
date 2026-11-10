// The identity door refuses this field by name, so a wrong send 400s a save
// or clears a number nobody meant to clear.

/** The bounds are the server's: `agent/stream-patience.ts` `PREFILL_THROUGHPUT_MIN/MAX_TOK_PER_SEC`. */
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

// Absent means the door is not called at all; null means clear the stored value; collapsing them wipes data.
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

export const numInput = (n: number | null): string => (n === null ? '' : String(n));
