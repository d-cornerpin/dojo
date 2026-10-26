// ════════════════════════════════════════════════════════════════════════════════════════
// THE FALSE-DELIVERY GUARD'S TWO DECISIONS, ON THEIR OWN.
//
// `refused-delivery.ts` holds the two halves of the fifth truth guard: `claimsDelivery` (the
// GATE — does the reply claim the artifact went out, and is that claim not itself a denial) and
// `decideRefusedDelivery` (the EVIDENCE — did the turn's `dojo_report` calls all refuse). Neither
// had coverage: the only tests that name the file are the guard census and the author-tag test,
// and neither calls a decision. Every expectation below is the two regexes run on the input.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { claimsDelivery, decideRefusedDelivery, refusedDeliverySteer } from '../refused-delivery.js';

describe('claimsDelivery — the gate half, prose only', () => {
  const CLAIMS = [
    'Submitted!',
    'Your report has been submitted.',
    'It was delivered to the builders.',
    'I submitted it for you.',
    'Posted it for you',
    'Sent it in',
    'Filed it with the team',
    'delivered?',
  ];
  it('claims the artifact went out on every reserved delivery sentence', () => {
    for (const text of CLAIMS) {
      expect(claimsDelivery(text), text).toBe(true);
    }
  });

  // Honest sentences the lane keeps saying on a failing turn: they never match the claim regex at
  // all. A bare "sent it in chat" or "published the draft to the shared folder" is NOT a delivery.
  const NEVER_CLAIMS = [
    '',
    'hi',
    'I will submit it later',
    'I sent you the link in chat',
    'I published the draft to the shared folder',
  ];
  it('never claims on the honest non-delivery sentences', () => {
    for (const text of NEVER_CLAIMS) {
      expect(claimsDelivery(text), text).toBe(false);
    }
  });

  // These MATCH the claim regex, but a denial inside the same sentence quietens them: a guard that
  // steered a truthful "it did not go out" would teach the model to distrust the engine.
  const DENIALS = [
    'I could not submit it',
    'The submit failed',
    'it is not submitted',
    'Submitting failed, so no.',
    'Nothing was submitted',
    'Not sure it was delivered',
  ];
  it('a denial inside the sentence quietens the claim', () => {
    for (const text of DENIALS) {
      expect(claimsDelivery(text), text).toBe(false);
    }
  });
});

describe('decideRefusedDelivery — the evidence half', () => {
  it('is null when the turn made no dojo_report call', () => {
    expect(decideRefusedDelivery([])).toBeNull();
  });

  it('is null when only another tool ran, even if it erred', () => {
    expect(decideRefusedDelivery([{ name: 'gmail_send', isError: true, content: 'x' }])).toBeNull();
  });

  it('returns the one refusal, quoted from the tool', () => {
    expect(
      decideRefusedDelivery([{ name: 'dojo_report', isError: true, content: 'Cancelled: no brief to submit' }]),
    ).toEqual({ refused: 1, quoted: 'Cancelled: no brief to submit' });
  });

  it('counts two refusals and quotes the LAST one', () => {
    expect(
      decideRefusedDelivery([
        { name: 'dojo_report', isError: true, content: 'Cancelled: first' },
        { name: 'dojo_report', isError: true, content: 'Cancelled: second' },
      ]),
    ).toEqual({ refused: 2, quoted: 'Cancelled: second' });
  });

  it('is null when any call succeeded — a later or earlier success makes the claim live', () => {
    // a later success
    expect(
      decideRefusedDelivery([
        { name: 'dojo_report', isError: true, content: 'Cancelled' },
        { name: 'dojo_report', isError: false, content: 'ok' },
      ]),
    ).toBeNull();
    // a success with isError MISSING is also not an explicit refusal
    expect(
      decideRefusedDelivery([
        { name: 'dojo_report', isError: true, content: 'Cancelled' },
        { name: 'dojo_report', content: 'ok' },
      ]),
    ).toBeNull();
    // an earlier success
    expect(
      decideRefusedDelivery([
        { name: 'dojo_report', isError: false, content: 'ok' },
        { name: 'dojo_report', isError: true, content: 'Cancelled' },
      ]),
    ).toBeNull();
  });

  it('normalises the quote and cuts it to 240', () => {
    expect(
      decideRefusedDelivery([{ name: 'dojo_report', isError: true, content: '  line one\n\n   line   two  ' }])?.quoted,
    ).toBe('line one line two');
    expect(decideRefusedDelivery([{ name: 'dojo_report', isError: true, content: 'x'.repeat(300) }])?.quoted.length).toBe(
      240,
    );
    expect(decideRefusedDelivery([{ name: 'dojo_report', isError: true }])?.quoted).toBe('');
  });
});

describe('refusedDeliverySteer — the quote, not a paraphrase', () => {
  it('hands the model the tool\'s own words beside the plain consequence', () => {
    const text = refusedDeliverySteer({ refused: 1, quoted: 'Cancelled' });
    expect(text).toContain('"Cancelled"');
    expect(text).toContain('Nothing was delivered');
  });
});
