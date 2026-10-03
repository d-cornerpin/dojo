// PHASE-4 T5 Step 2 — WHAT THE PROVIDER ACTUALLY SAID.
//
// Every provider-error decision in this tree was made by searching the error's PROSE for
// digits: `message.includes('429')`, `lower.includes('401')`, `lower.includes('503')`. Five
// copies of that table lived in five files and they did not agree with each other.
//
// It is the banned class (receipt-keyed, never prose-keyed) wearing a number, and it is
// wrong in both directions:
//
//   FALSE POSITIVE — Anthropic's over-length error is a 400 that reads
//       "prompt is too long: 204015 tokens > 200000 maximum"
//     and the token count CONTAINS "401". `classifyPlatformError` returned `auth_invalid`,
//     the platform's most drastic verdict: agent locked, owner bannered and told his API key
//     is invalid, because his prompt was too long. Change the count to 250316 and the same
//     string contains "503", so `isServerError` marked a permanently-fatal 400 retryable.
//
//   FALSE NEGATIVE — a genuine 429 whose body reads "You exceeded your current quota, please
//     check your plan and billing details" contains neither "429" nor "rate_limit". The rate
//     limit went unrecognised: no background retry scheduled, the agent injured instead.
//
// THE RULE. When the provider ANSWERED, its HTTP STATUS decides and its structured body
// (`error.type` / `code`) refines. When the request never got an answer, the transport's own
// error CODE decides (`ECONNREFUSED`, `ENOTFOUND`, …). Prose is the LAST resort — reached
// only when there is neither — and even there a status is matched as a TOKEN with boundaries
// on both sides, so a digit run inside a token count can never be read as an HTTP status.
//
// `basis` is on the result on purpose: a caller (and a log line) can always see WHICH of
// those three the verdict came from, so "we guessed from the words" never looks like "the
// provider told us".

import { DECLARED_PATIENCE_EXCEEDED_CODE } from './stream-patience.js';

/** What the provider's answer means for what we should do next. */
export type ProviderErrorClass =
  /** 401 — the credential is invalid, expired or revoked. The owner must act. */
  | 'auth'
  /** 403 — the credential is fine; this account may not use this thing. */
  | 'access_denied'
  /** Billing/quota exhausted — distinct from a per-minute rate limit. */
  | 'quota'
  /** 429 — slow down and come back. */
  | 'rate_limit'
  /** 529/503 — the provider is up but has no capacity right now. */
  | 'overloaded'
  /** 5xx — the provider broke. */
  | 'server'
  /** A 4xx that is OUR request's fault: too long, malformed, unsupported. Retrying it
   *  unchanged will fail forever. */
  | 'bad_request'
  /** The request never got an HTTP answer at all. */
  | 'network'
  /**
   * T81a — a stream watchdog cut the call before the FIRST token, on a provider that DECLARED
   * how long it needed. Distinct from 'network' on purpose: the request did not fail to
   * connect, it failed to finish inside a bound its own owner set, and a declared bound this
   * large usually means the PROMPT was too big for the box, not that the box is offline. The
   * GPU livelock incident this class exists to prevent was exactly this case folding into
   * 'network' — indistinguishable from a dropped TCP connection — and collecting the same
   * blind auto-wake a dropped connection legitimately earns. Never retryable: re-dialing
   * restarts the whole prefill it was most of the way through, to fail at the same bound again.
   */
  | 'declared_patience_exceeded'
  /** We genuinely do not know. Never guessed at. */
  | 'unknown';

/** Where the verdict came from — never inferred, always recorded. */
export type ProviderErrorBasis = 'status' | 'body' | 'transport' | 'text' | 'none';

export interface ProviderErrorFacts {
  class: ProviderErrorClass;
  /** The HTTP status the provider answered with; null when it never answered. */
  status: number | null;
  /** The provider's own machine-readable type, e.g. `rate_limit_error`, `insufficient_quota`. */
  providerType: string | null;
  /** The transport error code for a call that never reached the provider, e.g. `ECONNREFUSED`. */
  transportCode: string | null;
  /** Seconds from a `retry-after` header, when the provider sent one. */
  retryAfterSeconds: number | null;
  basis: ProviderErrorBasis;
}

/** The classes a caller may retry as-is. A `bad_request` is NOT one of them: the same bytes
 *  will be refused the same way forever, and retrying it is how a fatal 400 became a loop. */
export const RETRYABLE_PROVIDER_CLASSES: ReadonlySet<ProviderErrorClass> =
  new Set<ProviderErrorClass>(['rate_limit', 'overloaded', 'server', 'network']);

export function isRetryableProviderClass(c: ProviderErrorClass): boolean {
  return RETRYABLE_PROVIDER_CLASSES.has(c);
}

/** Transport-level codes that mean "the request never reached the provider". */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * An HTTP status matched as a TOKEN.
 *
 * `\b401\b` cannot match inside `204015` — every neighbour of the `401` there is a word
 * character, so there is no boundary — and the lookarounds additionally refuse a decimal
 * (`1.401`) and a version-like run. This is the entire reason the prose fallback is safe to
 * keep at all.
 */
function hasStatusToken(text: string, status: number): boolean {
  return new RegExp(`(?<![\\w.])${status}(?![\\w.])`).test(text);
}

/**
 * The same number, but only where a STATUS can actually live. (v3.2.3 review, H2)
 *
 * `hasStatusToken` above refuses `204015` and `1.401` — but a HYPHEN and a SPACE are both
 * boundaries, so it says yes to `gpt-402-turbo`, to `completed 402 of 500 tokens`, and to another
 * hop's status quoted inside a message (`upstream 401 logged … failed with 503`). That was
 * tolerable while a mis-parse only cost a retry classification. It stopped being tolerable when
 * v3.2.3 gave a permanent class the power to latch a provider off the board: the review measured
 * **5 of 5** innocent status-shaped strings pausing a WORKING provider.
 *
 * So permanence asks a stricter question — not *does this number appear?* but *does it appear
 * where a status is announced?* Two positions qualify, and nothing else does:
 *
 *   1. LEADING — the message OPENS with it, optionally behind an HTTP version:
 *      `402 Payment Required`, `HTTP/1.1 402 …`.
 *   2. INTRODUCED — a word whose only job is to name a status sits immediately before it, with
 *      at most a few punctuation characters between: `API error 402:`, `status code 402`,
 *      `{"status": 402}`, `http 402`.
 *
 * Everything else is a number that happens to be in the sentence. The caller treats that as no
 * evidence at all, which is this module's documented default direction.
 *
 * ⚠ NARROWED TWICE MORE (t87b, after the H2 re-review anchored 8 of 10 fresh shapes): LEADING now
 * tolerates only whitespace, not any bracket or quote (`[402] cache …` is a log prefix); and `code`
 * is no longer BARE (`exit code 402` is a process exit code), only `error code` / `status code` —
 * which `status code 402` used to reach THROUGH the bare `code`, so dropping it alone would have
 * cost a true positive. `err`/`error` stay bare on purpose: the incident's string is `API error
 * 402: …`. Every shape, both directions and that residual are the `STILL_ANCHORED` and
 * `INNOCENT_SHAPES` tables in `memory/__tests__/the-freeze-cannot-happen-again.test.ts`.
 */
export function statusIsAnchored(text: string, status: number): boolean {
  const s = String(status);
  const sep = '[\\s:=>"\'\\-]{0,4}';
  // `(?:error|status)[\s_-]{1,2}code` is the compound form; bare `code` is deliberately absent.
  const introducer = '(?:https?|status|statuscode|status_code|httpstatus|http_status'
    + '|(?:error|status)[\\s_-]{1,2}code|err|error|errored)';
  return new RegExp(
    `^\\s*(?:http/\\d(?:\\.\\d)?\\s+)?${s}(?![\\w.])`
    + `|(?:^|[^\\w.])${introducer}${sep}${s}(?![\\w.])`,
    'i',
  ).test(text ?? '');
}

function statusToClass(status: number, providerType: string | null): ProviderErrorClass {
  const t = (providerType ?? '').toLowerCase();
  if (status === 401) return 'auth';
  if (status === 403) return 'access_denied';
  if (status === 402) return 'quota';
  if (status === 429) {
    // A 429 is a rate limit unless the provider says the money ran out, which is a different
    // fact with a different remedy: waiting fixes one and never fixes the other.
    return t.includes('quota') || t.includes('billing') || t.includes('insufficient') ? 'quota' : 'rate_limit';
  }
  if (status === 408) return 'overloaded';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Pull a number out of whatever shape the SDK put it in. */
function readStatus(err: Record<string, unknown>): number | null {
  for (const key of ['status', 'statusCode']) {
    const v = err[key];
    if (typeof v === 'number' && v >= 100 && v <= 599) return v;
  }
  const response = err.response;
  if (response && typeof response === 'object') {
    const v = (response as Record<string, unknown>).status;
    if (typeof v === 'number' && v >= 100 && v <= 599) return v;
  }
  return null;
}

/** The provider's own machine-readable type, from any of the three shapes in use. */
function readProviderType(err: Record<string, unknown>): string | null {
  // Anthropic: `err.error` is the parsed body `{ type: 'error', error: { type, message } }`.
  const body = err.error;
  if (body && typeof body === 'object') {
    const inner = (body as Record<string, unknown>).error;
    if (inner && typeof inner === 'object') {
      const t = (inner as Record<string, unknown>).type;
      if (typeof t === 'string' && t) return t;
      const c = (inner as Record<string, unknown>).code;
      if (typeof c === 'string' && c) return c;
    }
    const t = (body as Record<string, unknown>).type;
    if (typeof t === 'string' && t && t !== 'error') return t;
  }
  // OpenAI: `err.type` / `err.code` sit on the APIError itself.
  for (const key of ['type', 'code']) {
    const v = err[key];
    if (typeof v === 'string' && v && !TRANSPORT_CODES.has(v)) return v;
  }
  return null;
}

function readTransportCode(err: Record<string, unknown>): string | null {
  const direct = err.code;
  if (typeof direct === 'string' && TRANSPORT_CODES.has(direct)) return direct;
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    const c = (cause as Record<string, unknown>).code;
    if (typeof c === 'string' && TRANSPORT_CODES.has(c)) return c;
  }
  return null;
}

function readRetryAfter(err: Record<string, unknown>): number | null {
  const headers = err.headers;
  if (!headers || typeof headers !== 'object') return null;
  const raw = (headers as Record<string, unknown>)['retry-after']
    ?? (headers as Record<string, unknown>)['Retry-After'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const secs = parseInt(raw, 10);
  return Number.isNaN(secs) ? null : secs;
}

/**
 * The prose fallback — ONE table, in one place, for the callers that hold nothing but a
 * string (a persisted `last_error`, a message crossing a process boundary).
 *
 * Every status here is matched as a token, so the adversarial token counts cannot reach any
 * branch. Vocabulary matches stay substring matches because a provider's own words for
 * "rate_limit_error" carry no numeric ambiguity.
 */
export function classifyProviderErrorText(text: string): ProviderErrorFacts {
  const none: ProviderErrorFacts = {
    class: 'unknown', status: null, providerType: null,
    transportCode: null, retryAfterSeconds: null, basis: 'none',
  };
  if (!text) return none;
  const lower = text.toLowerCase();
  const decided = (c: ProviderErrorClass, status: number | null = null): ProviderErrorFacts => ({
    class: c, status, providerType: null, transportCode: null,
    retryAfterSeconds: null, basis: 'text',
  });

  // Order is the precedence: the most specific remedy first. A quota message and a rate limit
  // both arrive as 429s but only one of them is fixed by waiting.
  // ⚠ v3.2.3: this path probed 429/401/403/503/500 and NOT 402, and its quota branch wanted
  // `insufficient_quota` — so `API error 402: {"message":"Insufficient Balance"}` (a real box's
  // words) came out `unknown` and was retried for 27 hours, 3,604 times. `statusToClass` gets 402
  // right; a thrown error carrying its status as TEXT never reaches it. Hence the token + spellings.
  // ⚠ ANCHORED, not merely present (review H2): `completed 402 of 500 tokens` must not become a
  // quota verdict, because `quota` is what `classifyPlatformError` turns into a Tier-D
  // QUOTA_EXHAUSTED lock. A 402 that is not announced as a status falls through to the arms below
  // and is read on its other evidence, which is how a transient stays transient.
  const anchored402 = statusIsAnchored(lower, 402);
  if (anchored402
    || lower.includes('insufficient_quota') || lower.includes('insufficient balance')
    || lower.includes('insufficient_balance') || lower.includes('insufficient funds')
    || lower.includes('insufficient credit')
    || (lower.includes('quota') && (lower.includes('exceed') || lower.includes('exhaust')))) {
    return decided('quota', anchored402 ? 402 : null);
  }
  if (hasStatusToken(lower, 429) || lower.includes('rate_limit') || lower.includes('rate limit')
    || lower.includes('too many requests')) {
    return decided('rate_limit', hasStatusToken(lower, 429) ? 429 : null);
  }
  if (hasStatusToken(lower, 401) || lower.includes('unauthorized')
    || lower.includes('invalid_api_key') || lower.includes('invalid api key')
    || lower.includes('authentication_error')
    || (lower.includes('api key')
      && (lower.includes('expired') || lower.includes('revoked')
        || lower.includes('not valid') || lower.includes('invalid')))) {
    return decided('auth', hasStatusToken(lower, 401) ? 401 : null);
  }
  if (hasStatusToken(lower, 403) || lower.includes('forbidden') || lower.includes('permission_error')) {
    return decided('access_denied', hasStatusToken(lower, 403) ? 403 : null);
  }
  if (lower.includes('overloaded') || hasStatusToken(lower, 529) || hasStatusToken(lower, 503)
    || lower.includes('service unavailable')) {
    return decided('overloaded', hasStatusToken(lower, 529) ? 529 : hasStatusToken(lower, 503) ? 503 : null);
  }
  if (hasStatusToken(lower, 500) || hasStatusToken(lower, 502) || hasStatusToken(lower, 504)
    || lower.includes('internal server error') || lower.includes('bad gateway')) {
    return decided('server');
  }
  for (const code of TRANSPORT_CODES) {
    if (lower.includes(code.toLowerCase())) return decided('network');
  }
  if (lower.includes('fetch failed') || lower.includes('socket hang up')
    || lower.includes('getaddrinfo') || lower.includes('network')
    || lower.includes('timed out') || lower.includes('timeout')) {
    return decided('network');
  }
  if (hasStatusToken(lower, 400) || hasStatusToken(lower, 404) || hasStatusToken(lower, 413)
    || hasStatusToken(lower, 422) || lower.includes('invalid_request_error')) {
    return decided('bad_request');
  }
  return none;
}

/**
 * Classify a thrown provider error from what it actually carries.
 *
 * Reading order — status, then body, then transport code, then (last) prose.
 */
export function classifyProviderError(err: unknown): ProviderErrorFacts {
  if (!err || (typeof err !== 'object' && typeof err !== 'string')) {
    return classifyProviderErrorText(String(err ?? ''));
  }
  if (typeof err === 'string') return classifyProviderErrorText(err);

  const e = err as Record<string, unknown>;
  const status = readStatus(e);
  const providerType = readProviderType(e);
  const transportCode = readTransportCode(e);
  const retryAfterSeconds = readRetryAfter(e);
  const message = typeof e.message === 'string' ? e.message : '';

  if (status !== null) {
    return {
      class: statusToClass(status, providerType),
      status,
      providerType,
      transportCode: null,
      retryAfterSeconds,
      basis: providerType ? 'body' : 'status',
    };
  }

  if (transportCode !== null) {
    return {
      class: 'network', status: null, providerType, transportCode,
      retryAfterSeconds, basis: 'transport',
    };
  }

  // No status and no transport code. The provider may still have named itself in a structured
  // body (an SDK that wrapped a parsed error without a status), so that is tried before prose.
  if (providerType) {
    const t = providerType.toLowerCase();
    // T81a — the model layer's OWN identity for a declared-patience exhaustion, carried on
    // `AgentError.code` and read here exactly as every other provider `type`/`code` already is
    // (`readProviderType` above). Checked first and returned immediately rather than folded
    // into the `byType` ternary below: it is not host to any of that ternary's remedies
    // (waiting, re-authenticating, upgrading a plan), and reaching the ternary at all would put
    // it one edit away from being swept into whichever branch runs last. This is also the exact
    // point the GPU livelock incident's root cause lived: before this check, `t` fell through
    // to the prose table below, which matches the word "timeout" in this error's own message
    // and returns the generic 'network' class — indistinguishable from a dropped connection.
    if (t === DECLARED_PATIENCE_EXCEEDED_CODE) {
      return {
        class: 'declared_patience_exceeded', status: null, providerType, transportCode: null,
        retryAfterSeconds, basis: 'body',
      };
    }
    const byType: ProviderErrorClass | null =
      t.includes('rate_limit') ? 'rate_limit'
        : t.includes('overloaded') ? 'overloaded'
          : t.includes('authentication') ? 'auth'
            : t.includes('permission') ? 'access_denied'
              : t.includes('quota') || t.includes('insufficient') ? 'quota'
                : t.includes('invalid_request') ? 'bad_request'
                  : t.includes('api_error') ? 'server'
                    : null;
    if (byType) {
      return {
        class: byType, status: null, providerType, transportCode: null,
        retryAfterSeconds, basis: 'body',
      };
    }
  }

  const fromText = classifyProviderErrorText(message);
  return { ...fromText, providerType, retryAfterSeconds };
}

/**
 * The provider class behind a thrown error: the facts it CARRIES when it has them (the model
 * layer attaches them to every `AgentError` it raises), and its own status/code/words when it
 * does not. One question, one answer, at every call site downstream of a failed model call.
 *
 * The carried facts are read structurally rather than through `instanceof AgentError` on
 * purpose: `agent/errors.ts` imports this module, so naming the class here would close an
 * import cycle for a check that a shape test does exactly as well.
 */
export function providerFactsOf(err: unknown): ProviderErrorFacts {
  const carried = (err as { provider?: unknown } | null | undefined)?.provider;
  if (carried && typeof carried === 'object' && typeof (carried as { class?: unknown }).class === 'string') {
    return carried as ProviderErrorFacts;
  }
  return classifyProviderError(err);
}

export function providerClassOf(err: unknown): ProviderErrorClass {
  return providerFactsOf(err).class;
}
