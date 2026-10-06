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
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  automationInstructions, automationWhy,
  AUTOMATION_PANE, AUTOMATION_TARGET_APP, AUTOMATION_VERIFY, AUTOMATION_SEND_HINT,
} from '../lib/automation-permission';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const SETUP_DEPS = path.join(REPO_ROOT, 'packages/dashboard/src/components/SetupDeps.tsx');
const SETUP_PAGE = path.join(REPO_ROOT, 'packages/dashboard/src/pages/Setup.tsx');
const SURFACES = [SETUP_DEPS, SETUP_PAGE];
const read = (p: string): string => fs.readFileSync(p, 'utf-8');

/**
 * Comments blanked, length and line structure kept (G4). t113 needed this and found out the
 * blunt way: the rewritten Automation probe EXPLAINS the old `osascript -e "return 1"` in the
 * comment above it, so a clause asserting that string is absent failed on the explanation while
 * the code was correct. A source-matching clause that reads prose is testing the prose.
 */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

describe('the words name the right target', () => {
  it('⚠ names the APPLICATION being driven, which the old hint never did', () => {
    // The old copy stopped at the asking process ("node") and never said the word
    // Messages, so a user who found the row still did not know what to switch on.
    expect(AUTOMATION_TARGET_APP).toBe('Messages');
    for (const words of [automationInstructions('/x/node'), automationWhy(), AUTOMATION_SEND_HINT]) {
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
    expect(s, 'must tell the user to trigger a real send').toMatch(/send a test imessage/i);
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

  it('the "why" names the spawned helper, not Terminal and not the dashboard', () => {
    const why = automationWhy();
    expect(why).toMatch(/not from Terminal/i);
    expect(why).toMatch(/dashboard/i);
  });

  it('⚠ the verify line REFUSES to claim a check that is not happening', () => {
    // THE DELIBERATE DIFFERENCE FROM THE FDA CLAUSE, and the reason is measured in the
    // route below: that probe attempts the read the permission protects, so its copy is
    // allowed to promise proof. This one cannot, so it must not.
    expect(AUTOMATION_VERIFY).toMatch(/cannot check this one/i);
    expect(AUTOMATION_VERIFY, 'it has to name the test that IS real').toMatch(/send/i);
    expect(AUTOMATION_VERIFY, 'it must not borrow the FDA line\'s confidence')
      .not.toMatch(/\bproof\b/i);
  });
});

describe('ONE source — neither surface writes its own copy', () => {
  it('⚠ both surfaces import the shared copy', () => {
    for (const p of SURFACES) {
      expect(read(p), `${path.basename(p)} must use the shared copy`)
        .toMatch(/from '\.\.\/lib\/automation-permission'/);
    }
  });

  it('⚠ SetupDeps APPLIES it, and feeds it the path the server reports', () => {
    // APPLICATION, not presence (G4): importing the function and then hand-writing the
    // sentence anyway would satisfy a weaker clause. The hint must BE the function's
    // output, and it must be called with `serverExecPath` — a call with no argument
    // renders the "unknown path" wording forever on a box that knows it.
    expect(read(SETUP_DEPS)).toMatch(/hint:\s*`\$\{automationInstructions\(permissions\.serverExecPath\)\}/);
  });

  it('⚠ neither surface still sends the user hunting for "node" in the Automation pane', () => {
    // The census that would have caught this in the first place. Scoped to Automation on
    // purpose: both files legitimately spell OTHER panes, and the Accessibility hint's
    // `cliclick` path is correct and is not this item's subject.
    for (const p of SURFACES) {
      const offenders = read(p).split('\n')
        .filter((l) => /Automation/i.test(l) && /\bnode\b/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      expect(offenders, `${path.basename(p)} still points at a bare "node" entry`).toEqual([]);
    }
  });

  it('⚠ neither surface hand-writes the Automation pane path of its own', () => {
    for (const p of SURFACES) {
      const hand = read(p).split('\n')
        .filter((l) => /Automation/i.test(l) && /Privacy\s*(&amp;|&|>)\s*Security/i.test(l)
          && !/^\s*(\/\/|\*)/.test(l));
      expect(hand, `${path.basename(p)} spells the Automation pane itself instead of importing it`)
        .toEqual([]);
    }
  });
});

describe('the premises are still true of the code that creates them', () => {
  it('⚠ the sender really does drive Messages from a helper the server SPAWNS', () => {
    // If the bridge ever sends iMessage some other way, the copy's claim about who macOS
    // holds responsible becomes wrong, and this is where that shows up.
    const bridge = read(path.join(REPO_ROOT, 'packages/server/src/services/imessage-bridge.ts'));
    expect(bridge, 'the AppleScript fallback should still tell Messages')
      .toMatch(/tell application "Messages"/);
    expect(bridge, 'and it should still run through osascript').toMatch(/execSync\(`osascript -e/);
    expect(bridge, 'the primary path is still the imsg CLI').toMatch(/execFileSync\('imsg'/);
  });

  it('⚠ the Automation route still only OPENS the pane, which is why the copy says "use it"', () => {
    // THE ASYMMETRY THE COPY IS BUILT ON. `full-disk-access` first attempts the protected
    // read so macOS registers the process and a row appears to toggle; `automation` does
    // no such thing. If someone adds a registering attempt for automation, the "nothing
    // to add" wording stops being true and this clause is the one that notices.
    const route = read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts'));
    const automationCase = route.slice(route.indexOf("case 'automation':", route.indexOf('permissions/request')));
    const body = automationCase.slice(0, automationCase.indexOf('break;'));
    expect(body, 'the automation case should still just open the pane')
      .toMatch(/open "x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Automation"/);
    expect(body, 'if this case starts triggering a real request, the copy needs rewriting')
      .not.toMatch(/osascript|imsg|tell application/);
  });

  it('the Automation probe no longer CLAIMS anything, which is why the verify line is right', () => {
    // ── WHAT THIS CLAUSE USED TO ASSERT, AND WHY IT WAS WRITTEN THAT WAY ──
    //
    // It deliberately asserted the DEFECT: `expect(route).toMatch(/osascript -e "return 1"/)`.
    // t96 found that probe reports `granted` on a box where sending iMessage is blocked —
    // `osascript -e "return 1"` drives no application, so it needs no Automation grant — but
    // the probe lives in a server file that was outside t96's fence and t110's. The clause
    // pinned today's truth so that whoever fixed the server would be told by a red test that
    // this copy needed revisiting. That is the coupling, and it is why E1 was handed up as a
    // pair rather than as two items: fixing the server alone turned this suite red.
    //
    // t113 fixed it, and both halves move in the SAME COMMIT. The probe now returns `unknown`:
    // Automation is granted per (client, target) pair so no single boolean can express it, and
    // the only probe that would answer for Messages raises a TCC consent dialog, which a
    // polled status endpoint must not do.
    //
    // So this clause flips from "the defect is still here" to "the probe does not claim what
    // it cannot know", in both directions — the `.not.toMatch` half is what reds if someone
    // restores the old probe or invents a new one that answers `granted`.
    // STRIPPED FIRST: the rewritten probe explains the old one in the comment above it, so an
    // unstripped read would fail on the explanation while the code is correct (G4).
    const route = stripComments(read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts')));
    const probe = route.slice(route.indexOf("case 'automation':"));
    const body = probe.slice(0, probe.indexOf('default:'));
    expect(body, 'the probe answers `unknown`, which the response type already carries')
      .toMatch(/return 'unknown';/);
    expect(body, 'and it claims neither outcome it cannot establish')
      .not.toMatch(/return 'granted'|return 'denied'/);
    expect(body, 'the probe that proved nothing is gone')
      .not.toMatch(/osascript -e "return 1"/);
    expect(body, 'and nothing here drives an application, which is what would raise a TCC dialog')
      .not.toMatch(/tell application|execSync|execFileSync/);

    // AND THE COPY IS NOW CORRECT RATHER THAN MERELY CAUTIOUS. `AUTOMATION_VERIFY` says Dojo
    // cannot check this from here; under `unknown` that is the literal truth of the row, so it
    // keeps saying it — this is the assertion that reds if someone "upgrades" the copy to claim
    // parity with its FDA sibling while the probe still answers `unknown`.
    expect(AUTOMATION_VERIFY, 'the copy still refuses to claim a check')
      .toMatch(/cannot check this one for you from here/);
  });

  it('⚠ the server still reports the path this copy renders', () => {
    const route = read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts'));
    expect(route).toMatch(/serverExecPath:\s*process\.execPath/);
  });
});
