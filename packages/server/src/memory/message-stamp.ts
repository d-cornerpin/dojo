// ════════════════════════════════════════════════════════════════════════════════════════
// THE RECORDED-INSTANT STAMP — one formatter, for every block that has to say WHEN.
//
// ── WHY IT IS ITS OWN MODULE (T69b) ─────────────────────────────────────────────────────
// `renderMessageTimeStamp` was declared inside `memory/assembler.ts`, a 2,500-line module
// that imports the recall lane, which imports the outbound ledger. T69b needs the same
// formatter in the outbound ledger, in `work/obligations.ts` and in the deliveries lane —
// every one of them UPSTREAM of the assembler — so importing it from there would close an
// import cycle. It moves here whole; `memory/assembler.ts` re-exports it, so every existing
// caller and every existing test import is byte-unchanged.
//
// ── WHAT IT IS FOR, WHICH IS THE WHOLE OF T69b's TAIL HYGIENE ───────────────────────────
// A tail block that renders "3 hours ago" is a function of the WALL CLOCK, so it emits
// different bytes once an hour with nothing in the world having changed — and every token
// behind it in the prompt is re-billed when it does. A block that renders the RECORDED
// INSTANT is a pure function of its rows: it changes when a row changes and never otherwise.
//
// The model loses nothing, because `msg.current-time` is the LAST message in the tail and
// its legend already tells the model to do exactly this subtraction, naming this format:
//
//     "Bracketed times like [Jul 16, 2026, 11:41 AM] before earlier messages are when EACH
//      message happened; subtract from the current time for any 'how long ago' question
//      instead of guessing."
//
// So the whole fresh tail is already stamped this way and the model is already instructed
// to read it this way. T69b makes the tail's ENGINE blocks say when in the same words the
// conversation above them already does, instead of in a second vocabulary that costs cache.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a stored timestamp to an ISO instant. `messages.created_at` is epoch-ms INTEGER
 * (migration 131) while `deliveries.created_at` is still TEXT, so BOTH shapes are real and
 * the conversion belongs here, once, rather than at each site guessing its column's type.
 */
export function normalizeCreatedAtUtc(createdAt: string | number): string | null {
  if (typeof createdAt === 'number') {
    return Number.isFinite(createdAt) && createdAt >= 1600000000000
      ? new Date(createdAt).toISOString() : null;
  }
  let s = createdAt.trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return s;
}

/**
 * Render a recorded time as a compact, deterministic stamp in the box's local timezone:
 * `[Jul 16, 2026, 11:41 AM]`. Same en-US 12-hour family as `renderCurrentTimeMessage` so the
 * model compares like with like. Returns null for missing/unparseable timestamps (the caller
 * renders unstamped, never throws).
 */
export function renderMessageTimeStamp(createdAt: string | number | null | undefined): string | null {
  if (!createdAt) return null;
  const iso = normalizeCreatedAtUtc(createdAt);
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStr = d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `[${localStr}]`;
}

/**
 * The same stamp, with a declared fallback for a row whose timestamp will not parse.
 *
 * T69b: every tail block that used to say "3 hours ago" says this instead, and each of them
 * had a `relativeTimeAgo` that returned the string `'recently'` on an unparseable input. That
 * word is kept — it is the one honest thing to say about a time nobody can read — so the
 * degraded path is byte-stable too, rather than falling back to a clock reading.
 */
export function recordedInstant(createdAt: string | number | null | undefined): string {
  return renderMessageTimeStamp(createdAt) ?? '[time not recorded]';
}
