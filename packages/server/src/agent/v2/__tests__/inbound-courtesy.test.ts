import { describe, it, expect } from 'vitest';
import { isContentFreeCourtesy } from '../classifiers/inbound-courtesy.js';
import {
  START_ACK_POOL,
  PROGRESS_ACK_POOL,
  A2A_HANDOFF_ACK_POOL,
  COMPLETION_ACK_POOL,
} from '../ack-copy.js';

describe('isContentFreeCourtesy: pleasantry family (a)', () => {
  const positives = [
    'Talk soon',
    'Talk soon!',
    'talk soon.',
    'Sounds good',
    'sounds good!',
    'Thanks',
    'thanks!',
    'Thank you',
    'thank you so much',
    'You too',
    'you too!',
    'Have a good one',
    'have a good night',
    'No rush',
    'no worries',
    'Will do',
    'Take care',
    'Cheers',
    // chained pleasantries
    'Thanks, you too!',
    'Sounds good, talk soon',
    'thanks so much, have a good one',
    'Talk soon, take care',
  ];
  for (const t of positives) {
    it(`matches: ${JSON.stringify(t)}`, () => {
      expect(isContentFreeCourtesy(t)).toBe(true);
    });
  }
});

describe('isContentFreeCourtesy: exact ack-pool match (b)', () => {
  const allPool = [
    ...START_ACK_POOL,
    ...PROGRESS_ACK_POOL,
    ...A2A_HANDOFF_ACK_POOL,
    ...COMPLETION_ACK_POOL,
  ];
  for (const line of allPool) {
    it(`matches engine ack verbatim: ${JSON.stringify(line)}`, () => {
      expect(isContentFreeCourtesy(line)).toBe(true);
    });
  }
  it('matches an ack line with surrounding whitespace (trimmed)', () => {
    expect(isContentFreeCourtesy(`  ${START_ACK_POOL[0]}  `)).toBe(true);
  });
  it('does NOT match a paraphrased ack line', () => {
    expect(isContentFreeCourtesy('On it, give me a couple minutes please.')).toBe(false);
  });
});

describe('isContentFreeCourtesy: conservative rejections', () => {
  const negatives = [
    '',
    '   ',
    // carries a request / referent
    'Sounds good, no rush. Just let me know when you hear back.',
    'Thanks for the update on the deploy',
    'No rush, take your time with the report',
    'Talk soon about the Q4 numbers',
    // real content
    'Can you ask Sam for his SkyMiles number?',
    '5550001234',
    'The meeting is at noon tomorrow',
    'All set on my side, here is the confirmation code ZZ00000',
    // pleasantry token embedded but message is substantive
    'thanks for sending over the itinerary and the seat numbers',
  ];
  for (const t of negatives) {
    it(`does not match: ${JSON.stringify(t)}`, () => {
      expect(isContentFreeCourtesy(t)).toBe(false);
    });
  }

  it('respects the short-only length cap for pleasantries', () => {
    // A long string, even one that starts with a pleasantry, is not damped.
    const long = 'Thanks '.repeat(20);
    expect(isContentFreeCourtesy(long)).toBe(false);
  });
});
