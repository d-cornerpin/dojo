import { describe, it, expect } from 'vitest';
import { isForwardPromiseReply, isStandingPromiseReply } from '../ack-copy.js';

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

// UX-REPAIR ROUND 8 T33 — the second member of the family. Round-8 S5's reply is the pin, and
// the negatives are what keeps a re-prompt off ordinary replies: the predicate is one of the
// floor's conditions, not the floor.
describe('isStandingPromiseReply', () => {
  const POSITIVES: readonly string[] = [
    // THE PIN: round-8 S5, verbatim (catalog §9.1, row aa027e6c, seq 61093).
    "Yes, I can. From now on, when a reminder fires I'll post it here first — and if you haven't "
    + "replied within a few minutes, I'll text it to your phone as a backup.",
    "From now on I'll add a line for gym stuff to the weekly checklist.",
    "Going forward I will copy you on every one of those replies.",
    "Whenever a package tracking number shows up, I'll drop it in the tracker for you.",
    "Every time the flight price drops I'll let you know here.",
    "Any time you send me a receipt, I'm going to file it under expenses.",
    "In future I'll check the calendar before I answer that.",
  ];

  const NEGATIVES: readonly string[] = [
    // A standing scope with no first-person commitment: a statement about the world.
    'From now on the reminders fire at 7am in your local timezone.',
    // A question is a legitimate ending (the reply asked the user something).
    'From now on, should I text your phone when you have not replied?',
    // The honest half already done — the floor's own acceptable alternative.
    "From now on I'll post reminders here, but I can't text your phone — only the primary agent can send SMS.",
    "Whenever you need that, I'm not able to reach your phone from this account.",
    // Two facts in two sentences are not one standing promise.
    "I'll send that over now. Whenever you're free, we can review it together.",
    // An invitation, not a promise.
    'Your reminder is set for 7pm. Whenever you want to change it, let me know.',
    // The immediate class, which keeps its own predicate and its own steer.
    'On it. Let me pull up all your calendars.',
    // A plain answer.
    'The Mariners lost 4-2 to the Angels.',
  ];

  for (const text of POSITIVES) {
    it(`treats as a standing promise: ${JSON.stringify(text.slice(0, 70))}`, () => {
      expect(isStandingPromiseReply(text)).toBe(true);
    });
  }

  for (const text of NEGATIVES) {
    it(`does NOT treat as a standing promise: ${JSON.stringify(text.slice(0, 70))}`, () => {
      expect(isStandingPromiseReply(text)).toBe(false);
    });
  }

  it('is empty/null safe', () => {
    expect(isStandingPromiseReply('')).toBe(false);
    expect(isStandingPromiseReply(null)).toBe(false);
    expect(isStandingPromiseReply(undefined)).toBe(false);
    expect(isStandingPromiseReply('   ')).toBe(false);
  });

  it('the two predicates are independent: neither answers for the other', () => {
    expect(isForwardPromiseReply("From now on I'll add a line for gym stuff to the weekly checklist.")).toBe(false);
    expect(isStandingPromiseReply('On it. Let me pull up all your calendars.')).toBe(false);
  });
});
