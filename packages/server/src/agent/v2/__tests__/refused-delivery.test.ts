// The refused-report guard's evidence and its steer: did every dojo_report call this turn refuse,
// and what the model is handed when they did.

import { describe, it, expect } from 'vitest';
import { decideRefusedDelivery, refusedDeliverySteer } from '../refused-delivery.js';

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
