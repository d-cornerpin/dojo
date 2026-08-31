// ════════════════════════════════════════════════════════════════════════════════════════
// HOW LONG A PROVIDER IS WORTH WAITING FOR (UX-REPAIR T64b).
//
// The two standing bounds and the one function that decides whether a provider's own
// declaration replaces them. This is a LEAF module on purpose: `config/schema.ts` validates
// what may be written and `agent/model.ts` decides what is honoured, and if the two read
// different numbers a value could be storable and unhonourable at the same time. Making them
// import one pair of constants is the same discipline T63 applied to `BEHAVES_LIKE_PROFILES`
// — and `model.ts` is far too heavy an import for a schema module to take, so the shared
// truth lives here rather than there.
//
// `model.ts` re-exports the two constants, so `STREAM_FIRST_CHUNK_TIMEOUT_MS` and
// `STREAM_IDLE_TIMEOUT_MS` keep the public identity they have had since 2026-07-10.
// ════════════════════════════════════════════════════════════════════════════════════

// ── The standing bounds ──
//
// Derived from HOSTED behaviour and correct for it: an endpoint that accepted a request and
// said nothing for ninety seconds is a dead connection, which is the 602-second hang that put
// the watchdog here in the first place (DOJO-ISSUES-LOG 2026-07-10). They remain the answer
// for every provider that does not say otherwise.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 90_000;
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

// ── What a provider may declare ──
//
// FLOOR — ten seconds. Below the standing idle bound on purpose: the point of a floor is that
// a typo (a value meant as seconds, or a stray keystroke) cannot make every call on a
// provider fail before it can possibly succeed. Ten seconds is long enough that no healthy
// endpoint is inside it and short enough to still be a real choice for a fast local box.
//
// CEILING — thirty minutes. Patience that outlives the turn it belongs to is a hang wearing a
// better name: the watchdog exists so a wedged call cannot hold a reminder or a scheduled
// turn hostage, and a bound of hours would hand that back. Thirty minutes is far past any
// measured prompt-processing time and still bounded.
export const STREAM_PATIENCE_MIN_MS = 10_000;
export const STREAM_PATIENCE_MAX_MS = 30 * 60_000;

/** The two nullable `providers` columns migration 163 adds, as read off the row. */
export interface DeclaredPatience {
  firstChunkTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
}

/** What `makeStreamWatchdog` is armed with. Never null: there is always an answer. */
export interface StreamPatience {
  /** How long the machine may think before token 1. Prompt processing lives here. */
  firstChunkMs: number;
  /** How long it may go quiet AFTER it has started. The dead-connection detector. */
  idleMs: number;
}

/**
 * A stored bound is honoured when it is a COHERENT one: a whole, positive number of
 * milliseconds that still bounds the call. Anything else is not a bound at all and resolves
 * to the standing default. It never throws — a model call is not the place to discover a
 * schema opinion.
 *
 * ── WHY THE READER'S RULE IS NOT THE DOOR'S RULE ──
 * The write door refuses anything below `STREAM_PATIENCE_MIN_MS`; this reader does not, and
 * the asymmetry is deliberate rather than an oversight. They are answering different
 * questions. The floor is a KINDNESS TO THE PERSON TYPING: `60` meant as seconds would
 * otherwise be stored as sixty milliseconds and make every call on that provider fail before
 * it could possibly succeed, and a form should catch that. But a row that says 300 ms is a
 * COHERENT instruction — impatient, and almost certainly not what anyone wants, but
 * meaningful, self-announcing (the calls fail loudly with the timeout phrase) and trivially
 * reversible. Silently substituting 90 s for it would be the reader deciding it knows better
 * than the database, with no signal anywhere that it had done so.
 *
 * What the reader must refuse is INCOHERENCE — zero, negative, fractional, NaN, a string, a
 * value past the ceiling — because there is no such bound to honour, and the failure modes
 * are severe in both directions: a non-positive bound aborts before the request is made, and
 * an unbounded one re-opens the 602-second hang the watchdog exists to end.
 *
 * Everything the door can store is inside what this reader honours, so a value that can be
 * written can always be honoured; the reader is only more permissive about rows that did not
 * come through the door (a hand-edited database, a restored backup, a writer that does not
 * exist yet).
 */
function honour(stored: unknown, standing: number): number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return standing;
  if (stored <= 0 || stored > STREAM_PATIENCE_MAX_MS) return standing;
  return stored;
}

/**
 * The one reader of `providers.first_chunk_timeout_ms` / `providers.stream_idle_timeout_ms`.
 *
 * NULL on both — every provider configured before T64b, and every preset since — returns the
 * two standing constants unchanged, which is what makes "existing providers are byte-
 * identical" a fact about the code rather than a hope.
 *
 * The two bounds are resolved INDEPENDENTLY. Declaring that a machine may think for six
 * minutes before it speaks says nothing about how long it may go silent once it has proven it
 * can emit, and a reader that widened both from one declaration would be buying back the
 * stall the watchdog catches every time someone bought patience for a long prompt.
 */
export function resolveStreamPatience(declared?: DeclaredPatience | null): StreamPatience {
  return {
    firstChunkMs: honour(declared?.firstChunkTimeoutMs, STREAM_FIRST_CHUNK_TIMEOUT_MS),
    idleMs: honour(declared?.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_MS),
  };
}
