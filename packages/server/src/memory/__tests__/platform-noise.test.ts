// ════════════════════════════════════════════════════════════════════════════════════════
// T82d (ANSWER-ANYWAY) FIX ROUND 1, IMPORTANT — the two declared-patience Heads-up lines are
// owner-VISIBLE IN CHAT (R3, "silence is never an acceptable failure mode") but must NOT
// fossilize into persisted compaction summaries (the Bob-class lesson: a transient status line
// read back weeks later as if it were still true). `platform-noise.ts` had no dedicated
// behavioral suite before this file; `marker-ownership.test.ts`'s "deliberate non-folds" census
// only asserts this module's SHAPE is imported from `@dojo/shared` and its MEMBERSHIP stays
// local policy — it never drives `isPlatformNoise` against real content.
//
// Fixtures come from `agent/v2/recovery.ts`'s OWN exported builders, not hand-typed copies —
// if the wording ever drifts, this suite drifts with it instead of silently testing a stale
// string.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { isPlatformNoise } from '../platform-noise.js';
import { declaredPatienceStatusLine, declaredPatienceHonestFailNote } from '../../agent/v2/recovery.js';

describe('T82d: the declared-patience Heads-up lines are chat-visible but never fossilize into a summary', () => {
  it('CASE 1\'s status line is platform noise (must not enter a compaction summary)', () => {
    expect(isPlatformNoise(declaredPatienceStatusLine())).toBe(true);
  });

  it('CASE 3\'s honest-fail line is platform noise, with no triggering ask on record', () => {
    expect(isPlatformNoise(declaredPatienceHonestFailNote(null, true))).toBe(true);
  });

  it('CASE 3\'s honest-fail line is platform noise WITH a triggering ask quoted in the variable middle', () => {
    const note = declaredPatienceHonestFailNote('can you pull together the Q3 board deck by tomorrow?', true);
    expect(note).toContain('Q3 board deck'); // sanity: the fixture actually exercises the variable tail
    expect(isPlatformNoise(note)).toBe(true);
  });

  it('CASE 3\'s honest-fail line is STILL platform noise once the inbound channel marker is stripped (CRITICAL 1\'s fix)', () => {
    const note = declaredPatienceHonestFailNote('[SOURCE: IMESSAGE FROM John Smith] how did the presentation go?', true);
    expect(note).not.toContain('[SOURCE:'); // CRITICAL 1's own fix, re-asserted here as a precondition
    expect(isPlatformNoise(note)).toBe(true);
  });

  // T82 FIX WAVE, I2 — the SECOND wording variant (`didCompact: false`, the bail cases: the
  // agent's model is the 'auto' sentinel, or `checkAndCompact` itself threw) must ALSO be
  // platform noise. `platform-noise.ts`'s anchor is an alternation over both templates; this is
  // the fixture that proves the second branch of that alternation, not just the first.
  it('CASE 3 (I2, didCompact=false): the "never got to trim" variant is ALSO platform noise', () => {
    const note = declaredPatienceHonestFailNote('can you pull together the Q3 board deck by tomorrow?', false);
    expect(note).toContain("couldn't trim it down enough to try again");
    expect(note).not.toContain('even after I trimmed it once and tried again');
    expect(isPlatformNoise(note)).toBe(true);
  });

  it('CONTROL: a genuine human message that happens to start "Heads up:" is NOT platform noise', () => {
    // Anchored tightly on purpose (review note: "anchor tightly"). A bare `Heads up:` prefix
    // match would have swallowed ordinary human chatter; these two patterns key on the WHOLE
    // stable shape of the two specific templates, not the greeting.
    expect(isPlatformNoise('Heads up: I will be about 10 minutes late to pick up the kids.')).toBe(false);
    expect(isPlatformNoise("Heads up: I hit send too early on that email, ignore it.")).toBe(false);
  });

  it('CONTROL: OTHER owner-alert writers\' own "Heads up:" notes are real memory and must NOT be stripped', () => {
    // The same OWNER_ALERT_HEADS_UP_PREFIX idiom, from the two OTHER live writers
    // (agent/destructive-gate.ts's expired-approval note, scheduler/runner.ts's
    // failed-final-run / skipped-reminder notes) — genuinely worth remembering, unlike the two
    // transient status lines this task adds. Wording mirrors those writers' own templates
    // closely enough to prove the anchor does not accidentally widen to cover them too.
    expect(isPlatformNoise(
      'Heads up: "Assistant" asked me to approve a sensitive action (delete the old backups), '
      + 'but it went unanswered for over an hour, so I let the request expire. Nothing was '
      + "changed or deleted. If you still want it done, just tell me and I'll approve it.",
    )).toBe(false);
    expect(isPlatformNoise(
      'Heads up: a scheduled reminder, "Renew passport", failed on its final attempt and was '
      + 'not delivered. Nothing more is scheduled for it, so it will not try again. Let me know '
      + 'if you want me to set it up again.',
    )).toBe(false);
  });

  it('CONTROL: an unrelated platform-noise entry (a plain [System: ...] note) is untouched by this addition', () => {
    // Sanity that the two new entries are additive, not a replacement of the existing
    // `/^\s*\[System: /i` coverage every OTHER note in recovery.ts still relies on.
    expect(isPlatformNoise('[System: The model provider returned a rate limit error. The platform is retrying automatically.]')).toBe(true);
  });
});
