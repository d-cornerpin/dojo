// ════════════════════════════════════════
// RC-8: content-free courtesy inbound classifier
//
// Two Dojo boxes pointed at each other over the iMessage bridge volley stock
// pleasantries and stock engine acks, and every one of those inbound lines
// wakes a full model turn on the counterpart (the iMessage lane has none of the
// A2A lane's terminal-intent / hop-limit structure). This classifier is the
// deterministic gate the wake point consults: when the sender is a known agent
// (SafeSender.is_agent) AND the WHOLE message is content-free courtesy, the
// bridge persists the row but takes no turn, so the loop cannot self-sustain.
//
// Two matchers, both whole-message and conservative (a courtesy-shaped message
// that actually carries a request or a fact must NOT match. A missed turn is
// the cost of a false positive, so we lean toward NOT firing):
//   (a) a small pleasantry family (talk soon / sounds good / thanks / you too /
//       have a good one / no rush ...), short-only. It was modelled on the
//       strictness of `isGenericCloseout`, which PHASE-2 T6 DELETED; the
//       strictness stayed, the borrowed neighbour did not.
//   (b) exact string match against the engine's OWN ack pools (an inbound that
//       IS verbatim one of our emitted lines is provably machine courtesy).
//
// Pure, no I/O; shared by the wake point and its unit test.
// ════════════════════════════════════════

import {
  START_ACK_POOL,
  PROGRESS_ACK_POOL,
  A2A_HANDOFF_ACK_POOL,
  COMPLETION_ACK_POOL,
} from '../ack-copy.js';

// (b) The exact set of lines the engine itself emits as acks. An inbound that
// matches one verbatim (after trim) is our own copy bounced back off another
// box, courtesy by construction, no length gate, these lines run long.
const ACK_POOL_STRINGS: ReadonlySet<string> = new Set<string>([
  ...START_ACK_POOL,
  ...PROGRESS_ACK_POOL,
  ...A2A_HANDOFF_ACK_POOL,
  ...COMPLETION_ACK_POOL,
]);

// (a) The pleasantry family. Kept deliberately narrow: only sign-off / thanks /
// well-wish phrases that carry no request and no information. Anything with a
// referent ("let me know when you hear back", "thanks for the deploy update")
// contains a non-pleasantry token and therefore fails the whole-message anchor.
const PLEASANTRY_PHRASE =
  '(?:talk soon|talk later|talk to you soon|chat soon|catch you later|catch you soon|' +
  'sounds good|sounds great|sounds like a plan|sound good|works for me|good deal|' +
  'thanks|thanks so much|thanks again|thank you|thank you so much|much appreciated|appreciate it|' +
  'you too|same to you|likewise|' +
  'have a good one|have a good night|have a good day|have a good evening|have a great day|have a nice day|' +
  'no rush|no worries|no problem|not a problem|all good|all set|' +
  'sure thing|will do|take care|see you|see ya|cheers)';

// Whole-message only: one pleasantry, optionally chained with more via light
// connective punctuation or "and". Leading/trailing markdown + closing
// punctuation tolerated.
//
// PHASE-2 T6 note (C1): the sibling this comment used to point at — `CLOSEOUT_WHOLE_RE` in
// classifiers/output.ts — is DELETED. The resemblance was in the ANCHORING IDIOM, never in
// the job: that one read the model's OUTBOUND prose to decide whether the person had been
// answered (an honesty question, now keyed on the delivery ledger), while this one reads an
// INBOUND peer message to decide whether a content-free "thanks!" should wake an agent. The
// second is a routing question about somebody else's text and is not part of the answered
// edge, so it stays.
const PLEASANTRY_WHOLE_RE = new RegExp(
  `^[\\s\`*_>-]*${PLEASANTRY_PHRASE}(?:[.!,\\s]+(?:and\\s+)?${PLEASANTRY_PHRASE})*[.!\\s\`*_]*$`,
  'i',
);

// Real courtesy sign-offs are short. The cap only guards matcher (a); the
// exact ack-pool match in (b) is exempt (those lines are longer).
const PLEASANTRY_MAX_CHARS = 48;

/**
 * True when `text`, taken as a whole, is nothing but content-free courtesy:
 * either an exact engine ack-pool line (b) or a short pleasantry (a). Pure and
 * deterministic. Conservative by design, a message that also carries a request
 * or a fact will not match. The caller pairs this with a sender.is_agent check
 * before damping, so a human's "thanks!" is never affected.
 */
export function isContentFreeCourtesy(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  // (b) exact match against our own emitted ack lines, any length.
  if (ACK_POOL_STRINGS.has(t)) return true;
  // (a) short pleasantry family, whole-message only.
  if (t.length > PLEASANTRY_MAX_CHARS) return false;
  return PLEASANTRY_WHOLE_RE.test(t);
}
