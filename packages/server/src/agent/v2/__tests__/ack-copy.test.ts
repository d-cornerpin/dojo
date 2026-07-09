import { describe, it, expect } from 'vitest';
import { isForwardPromiseReply } from '../ack-copy.js';

describe('isForwardPromiseReply', () => {
  // A bare promise to START work, judged by the reply's ending. These must fire
  // the detector (one of the three promise-floor conditions).
  const POSITIVES: readonly string[] = [
    // The live 2026-07-08 case, verbatim minus names.
    'On it. Let me pull up all your calendars.',
    'Let me check your inbox real quick.',
    "I'll get those numbers together for you.",
    'Give me a sec.',
    'One moment while I dig into this.',
    'Hang on, pulling that now.',
    "Sure, I'll pull the report and send it over shortly.",
    "I'm about to check the calendar for conflicts.",
    'Back with you shortly.',
  ];

  // Real deliveries, questions, invitations, and answers that merely mention a
  // promise-ish word. These must NOT fire.
  const NEGATIVES: readonly string[] = [
    "Done, here's the file.",
    'Let me know if you need anything else.',
    // Would match a promise pattern, but the trailing question makes it a
    // legitimate ending (asking the user), so it must be excluded.
    'Let me pull that up, or would you rather I wait?',
    'Want me to draft a reply?',
    // Engine ack lines (origin-tagged in the loop, so they never reach the floor
    // as persistedContent anyway) that also do not trip the text detector.
    'Got it, starting on this now.',
    "On it. I'll let you know when it's done.",
    // A legitimate answer ending in "soon" inside quoted content, no "back" before
    // it, so the back-shortly/soon pattern must not match.
    'She replied, "the shipment lands soon."',
    'The total came to 42 dollars.',
    'Here are the three options I found.',
  ];

  for (const text of POSITIVES) {
    it(`treats as a forward promise: ${JSON.stringify(text)}`, () => {
      expect(isForwardPromiseReply(text)).toBe(true);
    });
  }

  for (const text of NEGATIVES) {
    it(`does NOT treat as a forward promise: ${JSON.stringify(text)}`, () => {
      expect(isForwardPromiseReply(text)).toBe(false);
    });
  }

  it('is empty/null safe', () => {
    expect(isForwardPromiseReply('')).toBe(false);
    expect(isForwardPromiseReply(null)).toBe(false);
    expect(isForwardPromiseReply(undefined)).toBe(false);
    expect(isForwardPromiseReply('   ')).toBe(false);
  });

  it('keys on the ENDING: a promise preamble that then delivers is not a promise', () => {
    expect(isForwardPromiseReply('Let me check the weather. It is sunny and 72 degrees.')).toBe(false);
  });
});
