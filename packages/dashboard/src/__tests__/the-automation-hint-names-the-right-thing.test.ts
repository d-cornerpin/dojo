// ════════════════════════════════════════════════════════════════════════════════════════
// THE AUTOMATION COPY NAMES THE SWITCH THE USER HAS TO FLIP (BACKLOG line 27, clause 1).
//
// ── WHAT SHIPPED ──
//   SetupDeps.tsx  "This permission is granted automatically the first time DOJO tries to
//                   send an iMessage. ... You can also find it in System Settings >
//                   Privacy & Security > Automation > node."
//
// This is item D's defect for a different permission, and item D's own clause said so
// rather than fixing it: *"the Automation hint's 'node' is the same CLASS of vagueness and
// is reported rather than silently widened into here."*
// (`packages/server/.../full-disk-access-names-the-right-thing.test.ts`.)
//
// ── THIS FILE IS THAT CLAUSE, ON THE DASHBOARD SIDE ──
// Same shape as the FDA one: the words are pinned, the two surfaces are held to ONE copy,
// and the PREMISES the copy depends on are pinned against the code that creates them — so
// if the sender or the permission route changes, this reds instead of the copy quietly
// going stale. The one deliberate difference is the verify clause, which asserts the
// copy does NOT borrow its FDA sibling's confidence; see below.
//
// It lives in `packages/dashboard` because both surfaces are dashboard surfaces. The files
// it READS from `packages/server` and `deploy/` are read as evidence, never written.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  automationInstructions,
  AUTOMATION_PANE, AUTOMATION_TARGET_APP, AUTOMATION_VERIFY, AUTOMATION_SEND_HINT,
} from '../lib/automation-permission';

describe('the words name the right target', () => {
  it('⚠ names the APPLICATION being driven, which the old hint never did', () => {
    // The old copy stopped at the asking process ("node") and never said the word
    // Messages, so a user who found the row still did not know what to switch on.
    expect(AUTOMATION_TARGET_APP).toBe('Messages');
    for (const words of [automationInstructions('/x/node'), AUTOMATION_SEND_HINT]) {
      expect(words, 'the copy has to name the app being controlled').toContain(AUTOMATION_TARGET_APP);
    }
  });

  it('⚠ with a known path, the instruction is that exact path', () => {
    const p = '/Users/someone/.nvm/versions/node/v22.22.3/bin/node';
    const s = automationInstructions(p);
    expect(s).toContain(p);
    expect(s).toContain(AUTOMATION_PANE);
  });

  it('⚠ it says the grant comes from USING the feature, not from adding an entry', () => {
    // The actionable half, and the half the old hint got backwards: this pane has no
    // "+", so there is nothing to go and add, and the row does not exist until a send
    // has been attempted. "Not listed" is normal, not broken.
    const s = automationInstructions('/x/node');
    expect(s, 'must say the pane has no "+"').toMatch(/no "\+" button/i);
    // t115: WHAT TRIGGERS THE ASK CHANGED. t113's copy told the owner to send a test iMessage,
    // because nothing else would make macOS ask. The probe now asks on its own, so the hint has
    // to warn that CHECKING is what raises the pop-up — otherwise an accepted dialog arrives
    // unannounced and reads as a fault.
    expect(s, 'the check itself is what makes macOS ask').toMatch(/checking this row is itself the asking/i);
    expect(s, 'and the pop-up must be predicted, not sprung').toMatch(/expect a macos popup/i);
    expect(s, 'must cover the already-denied case, where no popup returns').toMatch(/don't allow/i);
  });

  it('⚠ with an UNKNOWN path it says so rather than guessing one', () => {
    // Item D's rule, for the same reason: a wrong target is worse than an absent one,
    // because the user grants something that is not doing the asking.
    for (const absent of [undefined, null, '', '   ']) {
      const s = automationInstructions(absent);
      expect(s).not.toMatch(/\/bin\/node/);
      expect(s).toMatch(/reports its exact path/i);
    }
  });

  it('⚠ the verify line CLAIMS the check, because as of t115 there is one', () => {
    // t113's version of this clause asserted the OPPOSITE — `toMatch(/cannot check this
    // one/i)` and `not.toMatch(/proof/i)` — and it was right then: the probe answered
    // `unknown` on every box. The owner ruled (2026-10-06) that the check becomes real and
    // the macOS consent dialog is accepted, so the copy is now allowed its FDA sibling's
    // confidence for the same reason: the probe performs the operation the permission
    // governs. This clause is the pair of the server one; see the premises block below.
    expect(AUTOMATION_VERIFY, 'it must no longer disclaim a check that happens')
      .not.toMatch(/cannot check this one/i);
    expect(AUTOMATION_VERIFY, 'it says what the check is worth').toMatch(/\bproof\b/i);
    expect(AUTOMATION_VERIFY, 'and it names what is actually read')
      .toMatch(/asks Messages for its own name/i);
    expect(AUTOMATION_VERIFY, 'the read has to be stated as harmless')
      .toMatch(/sends nothing and changes nothing/i);
    // THE ONE THING ITS FDA SIBLING HAS NO EQUIVALENT FOR: the check is also the request, so
    // the pop-up is the check working. Copy that omitted this would have the owner reading a
    // consent dialog as a fault.
    expect(AUTOMATION_VERIFY, 'the accepted pop-up must be explained, not sprung')
      .toMatch(/popup/i);
    // All three outcomes stay legible, including the one that keeps the manual steps.
    expect(AUTOMATION_VERIFY).toMatch(/denied/i);
    expect(AUTOMATION_VERIFY).toMatch(/unknown/i);
  });
});
