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

  it('the "why" names the spawned helper, not Terminal and not the dashboard', () => {
    const why = automationWhy();
    expect(why).toMatch(/not from Terminal/i);
    expect(why).toMatch(/dashboard/i);
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

  it('⚠ THE COUPLED PAIR — the probe really drives Messages, and the copy says so', () => {
    // ── THE HISTORY, BECAUSE IT IS WHY THIS CLAUSE EXISTS AT ALL ──
    //
    // t113's version asserted `return 'unknown';` in this route and `cannot check this one for
    // you from here` in the copy. Before that, t110's version asserted the DEFECT itself
    // (`/osascript -e "return 1"/`) so that whoever fixed the server would be told by a red
    // test that this copy needed revisiting. That coupling has now fired twice, exactly as
    // designed: t115 could not move the server without this file going red.
    //
    // THE OWNER RULED (2026-10-06): the check becomes the real probe and the TCC pop-up is
    // accepted. So this clause now holds the pair in its third position — the probe asks
    // Messages for real, and the copy claims the check. Both halves move in ONE commit, which
    // is the whole reason they are pinned against each other.
    //
    // STRIPPED FIRST (G4): the probe module and the route both EXPLAIN the old probes in
    // comments, so an unstripped read fails on the explanation while the code is correct.
    const route = stripComments(read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts')));
    const probeSrc = stripComments(read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/automation-probe.ts')));

    // THE ROUTE: the automation field is the awaited probe, in APPLICATION not just in import.
    expect(route, 'the status field must BE the probe call')
      .toMatch(/automation:\s*await automationPermissionStatus\(\)/);
    expect(route, 'the no-op probe t96 found must not come back')
      .not.toMatch(/osascript -e "return 1"/);
    // And the cheap no-side-effect switch must not answer for automation again — a restored
    // `case 'automation'` there would shadow the real probe silently.
    const sw = route.slice(route.indexOf('const checkPermission'), route.indexOf('serverExecPath'));
    expect(sw, 'nothing in the sync switch may answer for automation')
      .not.toMatch(/case 'automation'/);

    // THE PROBE: it drives Messages, and it can say all three things.
    expect(probeSrc, 'it has to actually tell Messages something')
      .toMatch(/tell application "Messages" to get name/);
    for (const answer of ["'granted'", "'denied'", "'unknown'"]) {
      expect(probeSrc, `the probe must be able to answer ${answer}`)
        .toMatch(new RegExp(`return ${answer}`));
    }
    // And the harmlessness the copy promises is a property of the script, which is pinned in
    // the server's own clause file; here we only hold that the copy is not promising something
    // the script has stopped being: no send verb anywhere in the probed expression.
    const script = probeSrc.slice(probeSrc.indexOf('MESSAGES_READ_ONLY_PROBE ='));
    expect(script.slice(0, script.indexOf('\n')), 'the script must stay a bare read')
      .toBe("MESSAGES_READ_ONLY_PROBE = 'tell application \"Messages\" to get name';");

    // THE COPY, the other direction. This is the half that reds if someone strengthens the
    // probe and leaves the words disclaiming a check, or weakens the probe and leaves the words
    // claiming one.
    expect(AUTOMATION_VERIFY, 'the copy may no longer disclaim a check that happens')
      .not.toMatch(/cannot check this one for you from here/);
    expect(AUTOMATION_VERIFY, 'and it claims exactly what the probe establishes')
      .toMatch(/checks this one for real/i);
  });

  it('⚠ the server still reports the path this copy renders', () => {
    const route = read(path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts'));
    expect(route).toMatch(/serverExecPath:\s*process\.execPath/);
  });
});
