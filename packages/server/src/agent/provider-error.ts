// WHAT THE PROVIDER ACTUALLY SAID. When it ANSWERED, the HTTP status decides and
// the structured body (error.type / code) refines; no answer means the transport
// code decides; prose is LAST and matches a status only as a boundary-edged TOKEN.
// basis records which answered, so "we guessed from words" never reads as fact.

import { DECLARED_PATIENCE_EXCEEDED_CODE } from './stream-patience.js';

export type ProviderErrorClass =
  | 'auth'
  | 'access_denied'
  /** Billing/quota exhausted: distinct from a per-minute rate limit. */
  | 'quota'
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  /** Our request's fault (4xx): too long, malformed, unsupported. Retrying unchanged fails forever. */
  | 'bad_request'
  /** The request never got an HTTP answer at all. */
  | 'network'
  /** A watchdog cut the call before the FIRST token on a provider that DECLARED its bound.
   *  Never retryable: re-dialing restarts the whole prefill only to fail at the same bound. */
  | 'declared_patience_exceeded'
  /** We genuinely do not know. Never guessed at. */
  | 'unknown';

/** Where the verdict came from: never inferred, always recorded. */
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

/** bad_request is NOT retryable: the same bytes are refused the same way forever. */
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

/** Statuses match as boundary-edged tokens, never digit runs: the reason prose is safe at all. */
function hasStatusToken(text: string, status: number): boolean {
  return new RegExp(`(?<![\\w.])${status}(?![\\w.])`).test(text);
}

/** Permanence asks the stricter question: does the number appear WHERE A STATUS IS
 *  ANNOUNCED? Only LEADING (the message opens with it, optional HTTP version prefix) or
 *  INTRODUCED (a status-word sits just before: `status code 402`, `API error 402:`).
 *  LEADING takes whitespace only; bare `code` is no introducer. Else: no evidence. A token alone matches
 *  `gpt-402-turbo` and `completed 402 of 500 tokens`; a permanent verdict must not. `err`/`error` stay bare
 *  on purpose (`API error 402:`); the test tables STILL_ANCHORED / INNOCENT_SHAPES hold the shapes. */
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

/** "quota" names two facts: OUT OF CREDIT (owner's to fix) and a per-minute limit (a wait).
 *  Only money words return `quota`: `billing` counts unless the text names a window. */
export function namesMoney(lower: string): boolean {
  if (lower.includes('insufficient_quota') || lower.includes('insufficient balance') || lower.includes('insufficient_balance')
    || lower.includes('insufficient funds') || lower.includes('insufficient credit')
    || lower.includes('credit balance is too low')) return true;
  return (lower.includes('billing') || lower.includes('exceeded your current quota'))
    && !/per (second|minute|hour|day)|resource_exhausted/.test(lower);
}

function statusToClass(status: number, providerType: string | null): ProviderErrorClass {
  const t = (providerType ?? '').toLowerCase();
  if (status === 401) return 'auth';
  if (status === 403) return 'access_denied';
  if (status === 402) return 'quota';
  if (status === 429) {
    // A 429 is a rate limit unless the provider names the money: waiting fixes one, never the other.
    return t.includes('billing') || t.includes('insufficient') ? 'quota' : 'rate_limit';
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

/** The prose fallback: ONE table in one place for callers holding only a string (a persisted
 *  `last_error`, text crossing a process boundary). Statuses match as tokens, words as substrings. */
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

  // Order IS the precedence: quota before rate_limit (only one is fixed by waiting);
  // 402 ANCHORED, so an innocent count cannot latch the QUOTA_EXHAUSTED lock.
  const anchored402 = statusIsAnchored(lower, 402);
  if (anchored402 || namesMoney(lower)) {
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
  if (lower.includes('fetch failed') || lower.includes('socket hang up') || /(?:^|:\s*)terminated\.?$/.test(lower.trim())
    || lower.includes('other side closed') || lower.includes('getaddrinfo') || lower.includes('network')
    || lower.includes('timed out') || lower.includes('timeout')) {
    return decided('network');
  }
  if (hasStatusToken(lower, 400) || hasStatusToken(lower, 404) || hasStatusToken(lower, 413)
    || hasStatusToken(lower, 422) || lower.includes('invalid_request_error')) {
    return decided('bad_request');
  }
  return none;
}

/** Reading order: status, then body, then transport code, then (last) prose. */
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
    let cls = statusToClass(status, providerType);
    // A 400 naming the money is not our request's fault: Anthropic bills an empty account as a 400.
    if (cls === 'bad_request' && status === 400 && namesMoney(message.toLowerCase())) cls = 'quota';
    return {
      class: cls,
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

  // No status and no transport code: a structured body may still name the provider, tried before prose.
  if (providerType) {
    const t = providerType.toLowerCase();
    // Checked BEFORE byType: the prose table matches "timeout" in this error's own message
    // and would misclassify it 'network'; it earns none of the ternary's remedies.
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
              : t.includes('insufficient') || t.includes('billing') ? 'quota'
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

/** Carried facts first, classification second: one question, one answer, after any failed model call.
 *  Never `instanceof AgentError`: errors.ts imports this module; naming the class closes a cycle. */
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
