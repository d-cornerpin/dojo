// Anthropic reports an empty account as an HTTP 400 (`invalid_request_error`) whose message
// names the money. An error that CARRIES its status used to be answered by the status block
// alone, before any prose was read, so this 400 came out `bad_request`: no QUOTA_EXHAUSTED
// card, the provider breaker never opened, and the router kept offering the dead provider.
// A 400 that says the account is out of credit is a quota verdict; a 400 that is OUR request's
// fault — too long, malformed — stays a bad request.

import { describe, it, expect } from 'vitest';
import { classifyProviderError, isRetryableProviderClass } from '../provider-error.js';

/** An `Anthropic.APIError` for an out-of-credit account, as the SDK hands it over. */
const OUT_OF_CREDIT_400 = {
  status: 400,
  message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
  error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } },
};

describe('the out-of-credit 400 — the status answers, and the money still decides', () => {
  it('THE DEFECT: Anthropic\'s "credit balance is too low" 400 is a quota verdict, not a bad request', () => {
    const facts = classifyProviderError(OUT_OF_CREDIT_400);
    expect(facts.class).toBe('quota');
    expect(facts.status).toBe(400);
  });

  it('CONTROL: the over-length 400 — our request\'s fault — is still a bad request', () => {
    const err = {
      status: 400,
      message: 'prompt is too long: 204015 tokens > 200000 maximum',
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 204015 tokens > 200000 maximum' } },
    };
    expect(classifyProviderError(err).class).toBe('bad_request');
  });

  it('CONTROL: a malformed-request 400 is still a bad request', () => {
    const err = { status: 400, message: 'messages.0.content: Input should be a valid list' };
    expect(classifyProviderError(err).class).toBe('bad_request');
  });

  it('the quota verdict is not retryable — the call fails identically until the owner pays', () => {
    expect(isRetryableProviderClass(classifyProviderError(OUT_OF_CREDIT_400).class)).toBe(false);
  });
});
