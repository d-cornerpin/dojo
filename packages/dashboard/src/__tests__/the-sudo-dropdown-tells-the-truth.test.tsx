// ════════════════════════════════════════════════════════════════════════════════════════
// THE SUDO DROPDOWN TELLS THE TRUTH — owner ruling 2026-09-26, ships v3.2.2.
//
// The Settings dropdown is the ONLY place the owner meets this policy, so the copy is a product
// surface and it is clauses here rather than taste in JSX. The rule lives in `lib/sudo-policy.ts`
// precisely so these can be asked without mounting the page.
//
// ⚠ THE CLAUSE THAT MATTERS MOST IS §2's FLOOR NOTE. `free` does not mean "anything goes":
// `sudo rm -rf /` is refused under every value, because the server strips the wrapper and re-runs the
// whole permission pipeline on the inner command first. An owner who reads `free` as "no limits" meets
// a refusal later and files it as broken permissions — so the note has to be on screen under ALL
// THREE values, not buried in the `free` hint.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  SUDO_FLOOR_NOTE, SUDO_POLICY_DEFAULT, SUDO_POLICY_HINTS, SUDO_POLICY_KEY, SUDO_POLICY_LABELS,
  SUDO_POLICY_ORDER, readSudoPolicy, sudoPolicyWarning, type SudoPolicy,
} from '../lib/sudo-policy';

describe('§1 the values, the default, and what an unknown row means', () => {
  it('three values, in increasing authority, and that order is what renders', () => {
    expect(SUDO_POLICY_ORDER).toEqual(['blocked', 'gated', 'free']);
  });

  it('the shipped default is GATED, and it says so on the option', () => {
    expect(SUDO_POLICY_DEFAULT).toBe('gated');
    expect(SUDO_POLICY_LABELS.gated).toContain('default');
  });

  it('an unset or unknown stored value reads as the default — NEVER as free', () => {
    for (const stored of [null, undefined, '', 'FREE', 'free ', 'allow', 'true', 'off']) {
      expect(readSudoPolicy(stored), String(stored)).toBe('gated');
    }
    // and the three real values round-trip
    for (const p of SUDO_POLICY_ORDER) expect(readSudoPolicy(p)).toBe(p);
  });

  it('it reads and writes the same config row the server reads', () => {
    expect(SUDO_POLICY_KEY).toBe('sudo_policy');
  });

  it('THE RULING IS IN THE COPY: every hint names the MAIN AGENT', () => {
    // Owner ruling 2026-09-27: only the main agent ever gets sudo. A hint that said "sudo commands run"
    // would be read as box-wide, and the owner would expect a sub-agent to inherit the setting.
    for (const p of SUDO_POLICY_ORDER) {
      expect(SUDO_POLICY_HINTS[p].toLowerCase(), p).toContain('main agent');
    }
  });

  it('⚠ THE COPY SAYS ADMIN PRIVILEGES, NOT ONLY SUDO — owner ruling "one policy"', () => {
    // The setting governs sudo AND the macOS "with administrator privileges" prompt. Copy that said
    // only "sudo" would leave an owner thinking the osascript door is a separate switch, and there
    // isn't one — so every label, and the note, name the broader thing.
    for (const p of SUDO_POLICY_ORDER) {
      expect(SUDO_POLICY_LABELS[p].toLowerCase(), p).toContain('admin');
      expect(SUDO_POLICY_HINTS[p].toLowerCase(), p).toContain('admin');
    }
    expect(SUDO_FLOOR_NOTE).toContain('ONE POLICY, EVERY ADMIN DOOR');
    expect(SUDO_FLOOR_NOTE).toContain('administrator');
    expect(SUDO_FLOOR_NOTE.toLowerCase()).toContain('osascript');
  });

  it('the floor note leads with the ROLE BOUNDARY, the bigger surprise', () => {
    expect(SUDO_FLOOR_NOTE).toContain('MAIN AGENT ONLY');
    expect(SUDO_FLOOR_NOTE).toContain('refused admin rights outright');
    expect(SUDO_FLOOR_NOTE).toContain('role boundary');
    // and it is the FIRST sentence, not a footnote after the floor list
    expect(SUDO_FLOOR_NOTE.indexOf('MAIN AGENT ONLY')).toBeLessThan(SUDO_FLOOR_NOTE.indexOf('rm -rf /'));
  });

  it('every value has a label and a hint, and each hint says what it DOES', () => {
    for (const p of SUDO_POLICY_ORDER) {
      expect(SUDO_POLICY_LABELS[p]?.length ?? 0, p).toBeGreaterThan(10);
      expect(SUDO_POLICY_HINTS[p]?.length ?? 0, p).toBeGreaterThan(40);
    }
    expect(SUDO_POLICY_HINTS.blocked).toContain('refused');
    expect(SUDO_POLICY_HINTS.gated).toContain('approval');
    expect(SUDO_POLICY_HINTS.free).toContain('like any other command');
  });
});

describe('§2 the floor note is unconditional, because the floor is', () => {
  it('it names the commands that are refused whatever the setting', () => {
    expect(SUDO_FLOOR_NOTE).toContain('every setting');
    expect(SUDO_FLOOR_NOTE).toContain('rm -rf /');
    expect(SUDO_FLOOR_NOTE).toContain('credentials');
  });

  it('it states the mechanism, so the claim is checkable rather than reassuring', () => {
    expect(SUDO_FLOOR_NOTE).toContain('unwrapped');
    expect(SUDO_FLOOR_NOTE).toContain('re-runs');
  });

  it('it says the setting cannot widen an agent past its own permissions', () => {
    expect(SUDO_FLOOR_NOTE).toContain('own permissions');
  });

  it('IT IS NOT A HINT ON ONE OPTION — no single hint carries the floor', () => {
    // If the floor claim lived in the `free` hint, switching to `gated` would hide it.
    for (const p of SUDO_POLICY_ORDER) {
      expect(SUDO_POLICY_HINTS[p], p).not.toContain('rm -rf /');
    }
  });
});

describe('§3 the warning is about the PASSWORD, not about danger', () => {
  it('only `free` warns, and it warns about the thing that actually surprises people', () => {
    expect(sudoPolicyWarning('blocked')).toBeNull();
    expect(sudoPolicyWarning('gated')).toBeNull();
    const w = sudoPolicyWarning('free');
    expect(w).not.toBeNull();
    expect(w!).toContain('password');
    expect(w!).toContain('one command');
  });

  it('it does not scold — the owner chose this on his own machine', () => {
    const w = sudoPolicyWarning('free')!;
    for (const scold of ['dangerous', 'not recommended', 'at your own risk', 'warning:']) {
      expect(w.toLowerCase(), scold).not.toContain(scold);
    }
  });
});

describe('§4 the component renders what the rule decides, and nothing it invents', () => {
  it('Settings imports the rule rather than spelling the values inline', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(dir, '..', 'pages', 'Settings.tsx'), 'utf8');
    expect(src).toContain("from '../lib/sudo-policy'");
    expect(src).toContain('SUDO_POLICY_ORDER.map');
    expect(src).toContain('SUDO_FLOOR_NOTE');
    // the dropdown is reachable and labelled
    expect(src).toContain('aria-label="admin privileges policy"');
    // and no hand-typed policy word survives in the component
    const card = src.slice(src.indexOf('const SudoPolicyCard'), src.indexOf('const SecurityTab'));
    for (const word of ["'blocked'", "'gated'", "'free'"]) {
      expect(card, `the card must not spell ${word} itself`).not.toContain(word);
    }
  });
});
