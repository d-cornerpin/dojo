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
  /**
   * True iff `firstChunkMs` came from the PROVIDER's own coherent declaration rather than
   * the standing default.
   *
   * T72b claim 2. This exists for exactly one decision: whether a first-chunk timeout may
   * collect the loop's single same-model retry. A provider whose owner declared how long it
   * needs before token 1, and which then blew through that bound, has already answered the
   * question the retry would be asking — and the retry re-dials COLD, so it restarts the
   * whole prompt-processing run it was most of the way through. A provider that declared
   * nothing has said nothing, so it keeps the retry it has always had; that is the control.
   */
  firstChunkDeclared: boolean;
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
function isCoherent(stored: unknown): stored is number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return false;
  if (stored <= 0 || stored > STREAM_PATIENCE_MAX_MS) return false;
  return true;
}

function honour(stored: unknown, standing: number): number {
  return isCoherent(stored) ? stored : standing;
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
    firstChunkDeclared: isCoherent(declared?.firstChunkTimeoutMs),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T81a — THE TWO IDENTITIES A WATCHDOG ABORT MAY CARRY, AND WHY THEY ARE NOT ONE.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// The GPU livelock incident (2026-09-18/19): a first-chunk timeout on a provider that
// DECLARED its patience, and a genuine mid-stream stall, threw the SAME `AgentError` code
// (`stream_idle_timeout`) — T72b/T65b split the MESSAGE PHRASE `model.ts` throws (so the loop's
// same-model retry already refuses the first-chunk case) but nothing downstream of the throw
// ever read the phrase, only the code. `provider-error.ts` had nothing coded to key on but the
// word "timeout" IN the message, so both cases fell into the generic `'network'` class, and
// `healer/injury-recovery.ts`'s blind 5-second auto-wake treated a request that PROVABLY cannot
// finish faster on a cold re-dial exactly like a dropped TCP connection — cold-re-dialing the
// identical un-finishable 110K-token prompt, over and over, on a 5s cadence.
//
// `firstChunkDeclared` (above) already answers "was this bound something the OWNER set, or a
// standing default a cloud provider never agreed to" — these two codes reuse that same fact
// rather than re-deriving it: a first-chunk timeout WITHOUT a declaration is the unmodified
// cloud-provider control and keeps the code (and every behaviour) it always had.
export const DECLARED_PATIENCE_EXCEEDED_CODE = 'declared_patience_exceeded';
export const STREAM_IDLE_TIMEOUT_CODE = 'stream_idle_timeout';

// ════════════════════════════════════════════════════════════════════════════════════════
// T73b — THE TRANSPORT HAS A CLOCK TOO, AND IT WAS THE SHORTER ONE.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above decides what the WATCHDOG is armed with. Underneath the watchdog sits an
// HTTP client with its own timers, and until T73b nobody had told it anything. Node's
// built-in `fetch` is undici, and an unconfigured undici dispatcher carries:
//
//     headersTimeout: 300_000    request sent  ->  response headers
//     bodyTimeout:    300_000    inter-chunk gap on the response body
//
// `STREAM_PATIENCE_MAX_MS` is thirty minutes, so the door above would store — and the reader
// above would honour, and the watchdog would arm — any bound up to 1,800,000 ms, while the
// socket underneath died at 300,000. A value that is storable and unhonourable at the same
// time is the exact defect this module's header says it exists to prevent; it simply had the
// wrong floor in view. THE OWNER'S STAKES, measured: cold prefill on his DS4 box runs about
// 200 tok/s, so a 300-second ceiling caps him at roughly 55K prompt tokens. His conversations
// run 42–52K. He is inside the ceiling by a margin that a single long day erases.
//
// And when the undici timer is the one that fires, the abort is not ours: the watchdog never
// ran, `timedOut()` is false, and the error is a transport error carrying NEITHER of the two
// phrases the v2 loop reads — so the single same-model retry T65b grants is not withheld on
// purpose (T72b's rule) but lost by accident. Deriving the transport's clock from the declared
// patience is what makes the watchdog the binding bound again, and therefore what puts the
// retry decision back in the hands of the code that reasons about it.
//
// ── WHY A MARGIN, AND WHY IT IS THE WATCHDOG THAT MUST WIN ──
// These two clocks must never be equal. The bounds above have meanings — "prompt processing",
// "the connection is dead" — and produce an error that names which one fired, whether the
// retry is granted, and what the owner reads. A transport timeout has none of that. So the
// transport is always given strictly more rope than the watchdog, and the margin is the
// distance by which the watchdog is guaranteed to get there first.
//
// ── WHY THE DEFAULT IS NOT SIMPLY REPLACED ──
// A provider that declares nothing, and a provider whose declaration already fits inside the
// standing transport bounds, get `null` here: no dispatcher is built, no client option is set,
// and their calls go out on the shared global pool byte-for-byte as they did yesterday. That
// is not caution, it is the control — the thing that makes "existing providers are unchanged"
// a fact about the code rather than a hope, exactly as the NULL row is for the two bounds
// above. We only ever LIFT: the derived numbers are floored at the standing defaults, so no
// declaration can make the transport LESS patient than it is today.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * undici's unconfigured `headersTimeout` and `bodyTimeout`, which are the same number. This is
 * a fact about Node's built-in `fetch`, not a choice of ours, and it is written here rather
 * than read from anywhere because there is nothing to read it from: Node exposes no accessor
 * for the global dispatcher's options.
 */
export const TRANSPORT_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The Stainless clients (`openai`, `@anthropic-ai/sdk`) arm one more timer of their own around
 * the `fetch` call, defaulting to ten minutes. It is cleared the moment the response headers
 * land — it bounds time-to-headers only, never the streamed body — but it is still a ceiling,
 * and a provider allowed thirty minutes to think would hit it on a server that withholds its
 * headers until the first token.
 */
export const TRANSPORT_REQUEST_TIMEOUT_DEFAULT_MS = 600_000;

/**
 * How much longer the transport waits than the watchdog does.
 *
 * Thirty seconds, and the size is chosen so the ORDER of the two timers is not a close-run
 * thing. Both clocks start at roughly the same instant but not the same one — the watchdog is
 * armed before `create()` is called, the transport's timers start when the socket is written
 * — and undici's timer wheel is coarse (it fires in ~1-second buckets, which the driven test
 * in `the-transport-honours-the-declared-patience.test.ts` shows as a 1.5 s bound firing at
 * ~2.0 s). A margin of a second or two would be inside that noise. Thirty is far outside it,
 * costs nothing when the watchdog fires as intended, and is the only amount of extra hang a
 * wedged provider can buy with it.
 */
export const TRANSPORT_MARGIN_MS = 30_000;

/** What the HTTP client is configured with, when the declared patience needs more than today's. */
export interface TransportTimeouts {
  /** undici `headersTimeout`: request written -> response headers. */
  headersTimeoutMs: number;
  /** undici `bodyTimeout`: the gap between two bytes of the response body. */
  bodyTimeoutMs: number;
  /** The SDK's own per-request timer, which bounds time-to-headers. */
  requestTimeoutMs: number;
}

/**
 * The transport clock that this patience requires, or `null` when today's defaults already
 * cover it and nothing should be configured at all.
 *
 * WHY `headersTimeout` IS THE FIRST-CHUNK BOUND AND `bodyTimeout` IS BOTH: whether a long
 * prefill is spent waiting for headers or waiting for the first body byte is the SERVER's
 * choice, not ours. llama.cpp, vLLM and LM Studio flush the SSE headers as soon as the request
 * is accepted, which puts the whole prefill in the body gap; a reverse proxy that buffers, or
 * a server that writes its status only once it has something to say, puts the same wait in
 * front of the headers. Both are ordinary, so both bounds have to carry the first-chunk
 * grant — and `bodyTimeout` additionally has to carry the idle grant, because after the first
 * token every remaining gap is a body gap.
 *
 * Pure, and deliberately so: the undici `Agent` these numbers configure is built in
 * `model.ts` beside the client caches, so the arithmetic can be argued with in a test instead
 * of only observed on a socket.
 */
export function resolveTransportTimeouts(patience: StreamPatience): TransportTimeouts | null {
  const headersNeeded = patience.firstChunkMs + TRANSPORT_MARGIN_MS;
  const bodyNeeded = Math.max(patience.firstChunkMs, patience.idleMs) + TRANSPORT_MARGIN_MS;
  if (headersNeeded <= TRANSPORT_DEFAULT_TIMEOUT_MS && bodyNeeded <= TRANSPORT_DEFAULT_TIMEOUT_MS) {
    return null;
  }
  return {
    headersTimeoutMs: Math.max(TRANSPORT_DEFAULT_TIMEOUT_MS, headersNeeded),
    bodyTimeoutMs: Math.max(TRANSPORT_DEFAULT_TIMEOUT_MS, bodyNeeded),
    requestTimeoutMs: Math.max(TRANSPORT_REQUEST_TIMEOUT_DEFAULT_MS, headersNeeded),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T81b (NO-DOOMED-DIALS) — CENSUS ROW 37: THE PRE-DIAL SIZE-VS-PATIENCE RECONCILIATION.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above answers "how long may we wait". Nothing above ever asked the question the
// GPU livelock incident needed answered BEFORE the call went out: "given how long we may wait
// and how fast this box chews through a prompt, can this particular request possibly finish at
// all?" A provider that has declared its first-chunk patience (163) and now ALSO declares its
// prefill throughput (migration 166) has said everything needed to answer that — in tokens,
// which is exactly the unit both transports already estimate for the request about to be sent
// (`agent/model.ts`'s `finalInputEstimate` / `inputEstimate`).
//
// ── THE FLOOR AND CEILING ON WHAT A PROVIDER MAY DECLARE ──
//
// Anchored on the owner's own measured box (`T73b`'s header, above: his DS4 runs cold prefill
// at roughly 200 tok/s) and the incident's own number (180 tok/s) — both comfortably inside
// [1, 100_000]. FLOOR of 1: below it the declared speed could not process even a one-token
// prompt inside any legal patience, which is functionally "this box does not work", not a real
// declaration — a typo (a decimal point, a units slip) lands here and is refused back to
// "undeclared" (the feature stays off) rather than silently refusing every call the provider
// will ever receive. CEILING of 100,000: an order of magnitude past any single-stream prefill
// speed measured on consumer or datacenter hardware, so a value above it is far more likely a
// units mistake (tokens per MINUTE or per HOUR typed into a tokens-per-SECOND field) than a
// real benchmark, and honouring it would make the ceiling below effectively infinite — quietly
// turning the safety feature off while it still looks configured.
export const PREFILL_THROUGHPUT_MIN_TOK_PER_SEC = 1;
export const PREFILL_THROUGHPUT_MAX_TOK_PER_SEC = 100_000;

/**
 * A stored throughput is honoured only when it is COHERENT, the same asymmetry `isCoherent`
 * documents above: the write door refuses these shapes outright, but the reader must survive a
 * row the door never approved (a hand-edited database, a restored backup, a writer that does
 * not exist yet) by treating it as undeclared, not by throwing at estimate time.
 */
function isCoherentThroughput(stored: unknown): stored is number {
  if (typeof stored !== 'number' || !Number.isInteger(stored)) return false;
  if (stored < PREFILL_THROUGHPUT_MIN_TOK_PER_SEC || stored > PREFILL_THROUGHPUT_MAX_TOK_PER_SEC) return false;
  return true;
}

/**
 * The largest input a declared prefill throughput can chew through inside a declared patience
 * — the number census row 37 is missing, and the one number `agent/model.ts`'s pre-dial gate
 * needs. `null` when `prefillTokensPerSec` is undeclared or incoherent: there is no fact to
 * derive a ceiling FROM, so per P2 there is no bound to enforce, and the gate this feeds is
 * skipped entirely — every request dials exactly as it does today. This is the byte-preserving
 * NULL-row control migration 166 promises, expressed as code rather than as a hope.
 *
 * ── THE MARGIN, AND WHY IT IS `TRANSPORT_MARGIN_MS` RATHER THAN A NEW NUMBER ──
 * Census row 37's own fix shape is `estimate / declaredThroughput + margin > declaredPatience`
 * — refuse when the estimated processing time, PLUS a margin, would not fit inside the
 * declared bound. Solved for the token ceiling this function returns, that is
 * `ceiling = (declaredPatienceMs − marginMs) / 1000 × tokensPerSec`: the same slack, spent on
 * the token side instead of the time side.
 *
 * `resolveTransportTimeouts` above already has exactly one constant whose entire job is
 * "how much slack to leave between two derived time bounds so a call that is genuinely on the
 * edge does not depend on the arithmetic being exact" — `TRANSPORT_MARGIN_MS`. Minting a SECOND
 * such number here, sized differently for no reason but that it lives in a different function,
 * is precisely the "invent a constant" this task's brief refuses. Reusing it is not a claim
 * that undici's timer-wheel granularity (the reasoning `TRANSPORT_MARGIN_MS` itself documents)
 * is what is at stake here — it plainly is not. It is a claim that this module has already
 * decided, once, how much unclaimed time a declared bound should keep in reserve against
 * ordinary measurement slop, and a second, un-derived margin would only be able to disagree
 * with the first one by accident.
 *
 * Floored at zero: a declared patience no longer than the margin itself leaves no time at all
 * to spend on tokens, and every positive estimate is doomed — which is the honest answer, not
 * an edge case to special-case around.
 */
export function resolveDoomCeiling(
  declaredPatienceMs: number,
  prefillTokensPerSec: number | null | undefined,
): number | null {
  if (!isCoherentThroughput(prefillTokensPerSec)) return null;
  const usableMs = Math.max(0, declaredPatienceMs - TRANSPORT_MARGIN_MS);
  return Math.floor((usableMs / 1000) * prefillTokensPerSec);
}
