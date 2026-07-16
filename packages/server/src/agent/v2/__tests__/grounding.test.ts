// RC-12 grounding classifier tests: the POSITIVE claim guard (existing) and the
// new DENIAL guard (F-5 / F-22, "Not yet" said after a receipted send). The denial
// detector is deliberately generous (the durable receipt ledger is the true gate in
// the loop), so these pin the TEXT shapes it must and must not treat as a denial.

import { describe, it, expect } from 'vitest';
import { detectUngroundedDeliveryClaim, detectDeliveryDenial } from '../classifiers/grounding.js';

describe('detectUngroundedDeliveryClaim (positive direction)', () => {
  it('fires on a past-tense delivery claim to a named third party with no send tool', () => {
    const r = detectUngroundedDeliveryClaim({
      responseText: 'Already done. Sent it to Sam a minute ago.',
      toolCallsThisTurn: [],
      counterpartyName: 'Alex',
    });
    expect(r.ungrounded).toBe(true);
    if (r.ungrounded) expect(r.recipient).toBe('Sam');
  });

  it('does NOT fire when a delivery tool ran this turn', () => {
    const r = detectUngroundedDeliveryClaim({
      responseText: 'Sent it to Sam.',
      toolCallsThisTurn: [{ name: 'imessage_send' }],
      counterpartyName: 'Alex',
    });
    expect(r.ungrounded).toBe(false);
  });

  it('does NOT fire when the "recipient" is the current counterparty (that is the reply)', () => {
    const r = detectUngroundedDeliveryClaim({
      responseText: 'Sent it to Sam.',
      toolCallsThisTurn: [],
      counterpartyName: 'Sam',
    });
    expect(r.ungrounded).toBe(false);
  });

  it('does NOT fire on a future/intent statement', () => {
    const r = detectUngroundedDeliveryClaim({
      responseText: "I'll text Sam now.",
      toolCallsThisTurn: [],
      counterpartyName: 'Alex',
    });
    expect(r.ungrounded).toBe(false);
  });
});

describe('detectDeliveryDenial (denial direction)', () => {
  it('fires on "Not yet, sending now." with a delivery word present', () => {
    const r = detectDeliveryDenial({ responseText: 'Not yet, sending now.' });
    expect(r.denied).toBe(true);
  });

  it('fires on a negated past delivery and captures the named recipient', () => {
    const r = detectDeliveryDenial({ responseText: "Haven't sent it to Nova yet." });
    expect(r.denied).toBe(true);
    expect(r.recipient).toBe('Nova');
  });

  it('fires on "still need to send it" with no named recipient', () => {
    const r = detectDeliveryDenial({ responseText: 'Still need to send that over.' });
    expect(r.denied).toBe(true);
    expect(r.recipient).toBeNull();
  });

  it('does NOT fire on a bare "not yet" with no delivery context', () => {
    expect(detectDeliveryDenial({ responseText: "I haven't decided yet." }).denied).toBe(false);
    expect(detectDeliveryDenial({ responseText: 'Not yet sure what you mean.' }).denied).toBe(false);
  });

  it('does NOT fire on an ordinary confirmation', () => {
    expect(detectDeliveryDenial({ responseText: 'All set, let me know if you need anything else.' }).denied).toBe(false);
  });
});
