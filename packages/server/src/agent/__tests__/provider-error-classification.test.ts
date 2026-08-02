// PHASE-4 T5 Step 2 — provider errors are classified from STATUS CODES and STRUCTURED
// BODIES, never from prose substrings.
//
// THE ADVERSARIAL FIXTURE, and it is not hypothetical. Anthropic's over-length error reads
//
//     "prompt is too long: 204015 tokens > 200000 maximum"     (HTTP 400)
//
// and a classifier that asks `message.includes('401')` finds one INSIDE THE TOKEN COUNT.
// Before this task that single substring was enough to make `classifyPlatformError` return
// `auth_invalid`, which is the platform's most drastic verdict: it LOCKS the agent, banners
// the owner, and tells him his API key is invalid — because his prompt was too long. Swap the
// count for 250316 and the same string contains "503", so the model layer's
// `isServerError = message.includes('503')` marks a permanently-fatal 400 as retryable and the
// platform retries it forever.
//
// The misclassification runs the other way too, and that half is invisible without a status:
// a REAL 429 whose body says "You exceeded your current quota, please check your plan and
// billing details" contains neither "429" nor "rate_limit", so the prose path read a genuine
// rate limit as an unclassified error — no background retry scheduled, agent injured.
//
// The rule: when the provider ANSWERED, its status code decides, and its structured body
// (`error.type`) refines. Prose is the LAST resort, reached only when there is no status and
// no error code — a network throw — and even then it matches STATUS TOKENS with word
// boundaries, so a digit run inside a token count can never look like an HTTP status.

import { describe, it, expect } from 'vitest';
import {
  classifyRecoverableProviderError,
  classifyPlatformError,
} from '../v2/classifiers/provider.js';
import {
  classifyProviderError,
  classifyProviderErrorText,
  providerClassOf,
  isRetryableProviderClass,
} from '../provider-error.js';
import { errorRecoveryClassifier } from '../v2/classifiers/errors.js';
import { AgentError } from '../errors.js';
import { classifyToolResult, toolErrorCodeForThrow, toolWasBlocked } from '../tool-outcome.js';

/** An `Anthropic.APIError` as the SDK hands it over: status, parsed body, headers. */
function anthropicApiError(
  status: number, type: string, message: string, headers?: Record<string, string>,
): Error {
  const err = new Error(`${status} ${JSON.stringify({ type: 'error', error: { type, message } })}`);
  Object.assign(err, {
    status,
    error: { type: 'error', error: { type, message } },
    headers: headers ?? {},
  });
  return err;
}

/** An `OpenAI.APIError`: status plus its own flat `type`/`code`. */
function openaiApiError(status: number, type: string, code: string | null, message: string): Error {
  const err = new Error(message);
  Object.assign(err, { status, type, code, headers: {} });
  return err;
}

/** A `fetch` that never reached the provider: no status, a transport code on `cause`. */
function transportError(code: string): Error {
  const err = new Error('fetch failed');
  Object.assign(err, { cause: Object.assign(new Error(code), { code }) });
  return err;
}

/** Real Anthropic 400 bodies whose token counts contain an HTTP status as a substring. */
const OVERLONG_WITH_401 = 'prompt is too long: 204015 tokens > 200000 maximum';
const OVERLONG_WITH_503 = 'prompt is too long: 250316 tokens > 200000 maximum';

describe('provider errors — the adversarial token counts (prose path)', () => {
  it('sanity: the fixtures really do contain the fatal substrings', () => {
    expect(OVERLONG_WITH_401).toContain('401');
    expect(OVERLONG_WITH_503).toContain('503');
  });

  it('THE DEFECT: an over-length 400 must NOT be classified as an auth failure', () => {
    // `auth_invalid` locks the agent and tells the owner his API key is bad.
    expect(classifyPlatformError(OVERLONG_WITH_401)).toBeNull();
  });

  it('an over-length 400 is not a platform error of any kind', () => {
    expect(classifyPlatformError(OVERLONG_WITH_503)).toBeNull();
  });

  it('CONTROL: a real 401 IS still an auth failure', () => {
    expect(classifyPlatformError('401 Unauthorized')).toEqual({ kind: 'auth_invalid' });
    expect(classifyPlatformError('invalid_api_key')).toEqual({ kind: 'auth_invalid' });
  });

  it('CONTROL: a real 403 is still access_denied and a real quota message still quota_exhausted', () => {
    expect(classifyPlatformError('403 Forbidden')).toEqual({ kind: 'access_denied' });
    expect(classifyPlatformError('insufficient_quota')).toEqual({ kind: 'quota_exhausted' });
  });

  it('a digit run that merely CONTAINS 403 is not access denied', () => {
    expect(classifyPlatformError('prompt is too long: 140399 tokens > 200000 maximum')).toBeNull();
  });

  it('CONTROL: the recoverable classifier still refuses a genuine transient', () => {
    expect(classifyRecoverableProviderError('429 rate_limit_exceeded')).toBeNull();
    expect(classifyRecoverableProviderError('overloaded_error 529')).toBeNull();
    expect(classifyRecoverableProviderError('503 Service Unavailable')).toBeNull();
  });
});

describe('provider errors — the status decides when the provider answered', () => {
  it('THE ADVERSARIAL 400: an over-length prompt is a bad request, whatever its digits say', () => {
    const err = anthropicApiError(
      400, 'invalid_request_error', 'prompt is too long: 204015 tokens > 200000 maximum',
    );
    const facts = classifyProviderError(err);
    expect(facts.class).toBe('bad_request');
    expect(facts.status).toBe(400);
    expect(facts.providerType).toBe('invalid_request_error');
    expect(facts.basis).toBe('body');
    // It is NOT retryable: the same bytes will be refused the same way forever, and
    // `isServerError = message.includes('503')` used to mark exactly this retryable.
    expect(isRetryableProviderClass(facts.class)).toBe(false);
    // And it is not the owner's problem to fix — no lock, no "your API key is invalid".
    expect(classifyPlatformError(err.message, facts)).toBeNull();
  });

  it('the same 400 with a token count containing 503 is still not a server error', () => {
    const err = anthropicApiError(
      400, 'invalid_request_error', 'prompt is too long: 250316 tokens > 200000 maximum',
    );
    expect(classifyProviderError(err).class).toBe('bad_request');
    expect(errorRecoveryClassifier(err).kind).toBe('context_overflow');
  });

  it('THE FALSE NEGATIVE: a 429 whose body never says "429" or "rate_limit" is still a rate limit', () => {
    // OpenAI's billing 429. The prose path saw no digits and no vocabulary it knew, so a
    // genuine rate limit was an unclassified error: no background retry, agent injured.
    const err = openaiApiError(
      429, 'insufficient_quota', 'insufficient_quota',
      'You exceeded your current quota, please check your plan and billing details.',
    );
    const facts = classifyProviderError(err);
    // A 429 that says the money ran out is a QUOTA problem — waiting fixes a rate limit and
    // never fixes this one — but both are the retry manager's, not the healer's.
    expect(facts.class).toBe('quota');
    expect(facts.status).toBe(429);
    expect(classifyPlatformError(err.message, facts)).toEqual({ kind: 'quota_exhausted' });
  });

  it('a plain 429 is a rate limit and carries its retry-after', () => {
    const err = anthropicApiError(
      429, 'rate_limit_error', 'Number of tokens has exceeded your per-minute limit',
      { 'retry-after': '42' },
    );
    const facts = classifyProviderError(err);
    expect(facts.class).toBe('rate_limit');
    expect(facts.retryAfterSeconds).toBe(42);
    expect(isRetryableProviderClass(facts.class)).toBe(true);
  });

  it('a 401 whose words never say "unauthorized" is still an auth failure', () => {
    // "invalid x-api-key" contains no "401", no "unauthorized", and not even "api key"
    // (the hyphen). The prose path missed it entirely and the agent was injured instead of
    // the owner being told his credential is dead.
    const err = anthropicApiError(401, 'authentication_error', 'invalid x-api-key');
    const facts = classifyProviderError(err);
    expect(facts.class).toBe('auth');
    expect(classifyPlatformError(err.message, facts)).toEqual({ kind: 'auth_invalid' });
  });

  it('529 and 503 are overloaded; 500 and 502 are the provider breaking', () => {
    expect(classifyProviderError(anthropicApiError(529, 'overloaded_error', 'Overloaded')).class)
      .toBe('overloaded');
    expect(classifyProviderError({ status: 503, message: 'Service Unavailable' }).class)
      .toBe('overloaded');
    expect(classifyProviderError({ status: 500, message: 'oops' }).class).toBe('server');
    expect(classifyProviderError({ status: 502, message: 'oops' }).class).toBe('server');
  });

  it('a 403 is access denied and NOT the same fact as a bad credential', () => {
    const err = anthropicApiError(403, 'permission_error', 'not allowed to use this model');
    expect(classifyProviderError(err).class).toBe('access_denied');
    expect(classifyPlatformError(err.message, classifyProviderError(err)))
      .toEqual({ kind: 'access_denied' });
  });

  it('a call that never reached the provider is classified from its transport code', () => {
    const facts = classifyProviderError(transportError('ECONNREFUSED'));
    expect(facts.class).toBe('network');
    expect(facts.status).toBeNull();
    expect(facts.transportCode).toBe('ECONNREFUSED');
    expect(facts.basis).toBe('transport');
    // A refused connection is not a name-resolution failure, so it is not the owner's to fix.
    expect(classifyPlatformError('fetch failed', facts)).toBeNull();
  });

  it('a name-resolution failure IS the owner\'s to fix', () => {
    const facts = classifyProviderError(transportError('ENOTFOUND'));
    expect(facts.class).toBe('network');
    expect(classifyPlatformError('fetch failed', facts)).toEqual({ kind: 'dns_failure' });
  });

  it('the basis is always visible, so a guess never reads like a fact', () => {
    expect(classifyProviderError(anthropicApiError(429, 'rate_limit_error', 'x')).basis).toBe('body');
    expect(classifyProviderError({ status: 429, message: 'x' }).basis).toBe('status');
    expect(classifyProviderError(transportError('ETIMEDOUT')).basis).toBe('transport');
    expect(classifyProviderErrorText('429 Too Many Requests').basis).toBe('text');
    expect(classifyProviderErrorText('something nobody has ever seen').basis).toBe('none');
  });
});

describe('provider errors — the facts ride the error', () => {
  it('an AgentError carrying facts is never re-classified from its prose', () => {
    const facts = classifyProviderError(
      anthropicApiError(429, 'rate_limit_error', 'slow down'),
    );
    // The message deliberately says nothing a substring search could use.
    const err = new AgentError('Model call failed: slow down', 'kevin', {
      code: 'MODEL_CALL_FAILED', retryable: true, provider: facts,
    });
    expect(providerClassOf(err)).toBe('rate_limit');
    expect(err.provider?.status).toBe(429);
  });

  it('an error carrying nothing falls back to its words, and says so', () => {
    expect(providerClassOf(new Error('429 Too Many Requests'))).toBe('rate_limit');
    expect(providerClassOf(new Error('prompt is too long: 204015 tokens'))).toBe('unknown');
  });
});

describe('provider errors — the prose fallback matches a status as a token', () => {
  const cases: Array<[string, string]> = [
    ['prompt is too long: 204015 tokens > 200000 maximum', 'unknown'],
    ['prompt is too long: 250316 tokens > 200000 maximum', 'unknown'],
    ['prompt is too long: 142900 tokens > 200000 maximum', 'unknown'],
    ['HTTP 401 Unauthorized', 'auth'],
    ['status=429 rate limited', 'rate_limit'],
    ['503 Service Unavailable', 'overloaded'],
    ['500 Internal Server Error', 'server'],
    ['ECONNREFUSED 127.0.0.1:11434', 'network'],
  ];
  for (const [text, expected] of cases) {
    it(`"${text.slice(0, 46)}" -> ${expected}`, () => {
      expect(classifyProviderErrorText(text).class).toBe(expected);
    });
  }
});

describe('the tool seam — `ToolErrorCode` gains a structured population, and only that', () => {
  it('a provider 429 thrown out of a tool becomes RATE_LIMITED, so the door reads `blocked`', () => {
    const err = anthropicApiError(429, 'rate_limit_error', 'slow down');
    expect(toolErrorCodeForThrow(err)).toBe('RATE_LIMITED');
    const outcome = classifyToolResult({
      toolCallId: '1', name: 'web_search', content: 'Tool execution failed: slow down',
      isError: true, errorCode: toolErrorCodeForThrow(err),
    });
    expect(outcome.kind).toBe('refused');
    expect(toolWasBlocked(outcome)).toBe(true);
  });

  it('a transport failure becomes NETWORK_ERROR and still reads `crashed`', () => {
    expect(toolErrorCodeForThrow(transportError('ECONNRESET'))).toBe('NETWORK_ERROR');
    const outcome = classifyToolResult({
      toolCallId: '1', name: 'web_browse', content: 'Tool execution failed: fetch failed',
      isError: true, errorCode: 'NETWORK_ERROR',
    });
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.reason).toBe('crashed');
  });

  it('THE LINE: a verdict reached from WORDS populates nothing', () => {
    // These would each classify from prose, and stamping a structured code on a guess is the
    // banned move — a tool whose own error text happens to say "unauthorized" would be moved
    // into `blocked` ("the door refused, nothing ran") on the strength of a substring.
    expect(toolErrorCodeForThrow(new Error('401 Unauthorized'))).toBeUndefined();
    expect(toolErrorCodeForThrow(new Error('429 Too Many Requests'))).toBeUndefined();
    expect(toolErrorCodeForThrow(new Error('some tool blew up'))).toBeUndefined();
    expect(toolErrorCodeForThrow(new Error('prompt is too long: 204015 tokens'))).toBeUndefined();
  });

  it('a provider 5xx stays `crashed` — the provider breaking is what crashed means', () => {
    expect(toolErrorCodeForThrow({ status: 500, message: 'oops' })).toBeUndefined();
    expect(toolErrorCodeForThrow(anthropicApiError(529, 'overloaded_error', 'x'))).toBeUndefined();
  });

  it('facts CARRIED by an AgentError are honoured at the tool seam too', () => {
    const facts = classifyProviderError(anthropicApiError(429, 'rate_limit_error', 'x'));
    const err = new AgentError('Tool execution failed', 'kevin', {
      code: 'MODEL_CALL_FAILED', provider: facts,
    });
    expect(toolErrorCodeForThrow(err)).toBe('RATE_LIMITED');
  });
});
