// ════════════════════════════════════════════════════════════════════════════
// THE INBOUND WEBHOOK SIGNATURE, CHECKED AGAINST ITS OWN RULE.
//
// ── WHAT WAS UNGUARDED ──
// `verifyTwilioSignature` (src/twilio/client.ts) is the ONE gate that decides
// whether an inbound SMS/voice webhook really came from Twilio. It is the only
// thing standing between our public tunnel URL and a forged inbound message that
// would trigger the agent, and it is called from src/gateway/routes/twilio.ts:77
// with NO test naming it (`git grep verifyTwilioSignature` reaches only client.ts
// and that route). So a change to the sort order, the key+value join, or the
// length guard would ship unnoticed until forged messages — or every real one —
// slipped through.
//
// ── HOW THIS STAYS AN INDEPENDENT STATEMENT OF THE RULE ──
// Every signature below is recomputed HERE from `node:crypto`, with the data
// string spelled out by hand — never read back from the implementation. A
// regression in client.ts therefore changes the value IT expects, not the value
// this test computes, and the two diverge. Fake values only; nothing reaches Twilio.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyTwilioSignature } from '../client.js';

// Twilio's rule, restated: base64 HMAC-SHA1 of the URL plus the POST params
// sorted by key, each appended as key+value, keyed by the account token.
const sign = (data: string, token: string): string =>
  crypto.createHmac('sha1', token).update(data).digest('base64');

const WEBHOOK_URL = 'https://box.example.test/api/twilio/webhook/sms';
const TOKEN = 'tok-test';
const PARAMS = { From: '+15550100', Body: 'hello', To: '+15550199', MessageSid: 'SM123' };

// Keys sorted by character code — Body, From, MessageSid, To — each key then value.
const DATA = WEBHOOK_URL + 'Body' + 'hello' + 'From' + '+15550100' + 'MessageSid' + 'SM123' + 'To' + '+15550199';

describe('the inbound webhook signature', () => {
  it('verifies the signature Twilio computes for a well-formed request', () => {
    expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN), url: WEBHOOK_URL, params: PARAMS, authToken: TOKEN })).toBe(true);
  });

  it('REFUSES when the body moved, even by one character — the value rides in the data', () => {
    expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN), url: WEBHOOK_URL, params: { ...PARAMS, Body: 'hellO' }, authToken: TOKEN })).toBe(false);
  });

  it('REFUSES when the URL moved — a trailing slash changes the bytes that were signed', () => {
    expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN), url: WEBHOOK_URL + '/', params: PARAMS, authToken: TOKEN })).toBe(false);
  });

  it('REFUSES when the token is not the one the signature was made with', () => {
    expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN), url: WEBHOOK_URL, params: PARAMS, authToken: 'other' })).toBe(false);
  });

  // A signature whose LENGTH differs from the expected must be a refusal, not a
  // throw: `timingSafeEqual` throws on unequal buffers, so the guard that precedes
  // it is what keeps a malformed header from crashing the gate.
  describe('the length guard runs before the constant-time compare', () => {
    it('REFUSES an empty signature', () => {
      expect(verifyTwilioSignature({ signature: '', url: WEBHOOK_URL, params: PARAMS, authToken: TOKEN })).toBe(false);
    });

    it('REFUSES an empty token', () => {
      expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN), url: WEBHOOK_URL, params: PARAMS, authToken: '' })).toBe(false);
    });

    it('REFUSES a signature one character too long', () => {
      expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN) + 'A', url: WEBHOOK_URL, params: PARAMS, authToken: TOKEN })).toBe(false);
    });

    it('REFUSES a signature two characters too short', () => {
      expect(verifyTwilioSignature({ signature: sign(DATA, TOKEN).slice(0, -2), url: WEBHOOK_URL, params: PARAMS, authToken: TOKEN })).toBe(false);
    });
  });

  it('keeps repeated keys in arrival order — key, value, key, value', () => {
    const params = { Digits: ['1', '2'] };
    expect(verifyTwilioSignature({ signature: sign(WEBHOOK_URL + 'Digits1Digits2', TOKEN), url: WEBHOOK_URL, params, authToken: TOKEN })).toBe(true);
    // The reversed value order is a different message — it must not verify.
    expect(verifyTwilioSignature({ signature: sign(WEBHOOK_URL + 'Digits2Digits1', TOKEN), url: WEBHOOK_URL, params, authToken: TOKEN })).toBe(false);
  });

  it('signs a bare URL when the request carries no params', () => {
    expect(verifyTwilioSignature({ signature: sign(WEBHOOK_URL, TOKEN), url: WEBHOOK_URL, params: {}, authToken: TOKEN })).toBe(true);
  });

  it('sorts by CHARACTER CODE, so capital B precedes lowercase a — not a locale fold', () => {
    const params = { B: '2', a: '1' };
    expect(verifyTwilioSignature({ signature: sign(WEBHOOK_URL + 'B2a1', TOKEN), url: WEBHOOK_URL, params, authToken: TOKEN })).toBe(true);
    expect(verifyTwilioSignature({ signature: sign(WEBHOOK_URL + 'a1B2', TOKEN), url: WEBHOOK_URL, params, authToken: TOKEN })).toBe(false);
  });
});
