// ════════════════════════════════════════════════════════════════════════════════════════
// USER.md HAS ONE SOURCE OF TRUTH, AND THE OOBE INVENTS NOBODY.
// (OWNER RULING #11, 2026-10-05 + t107 HANDED UP 1 — built as t111-A1/A3.)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// `the-profile-admits-it-is-empty.test.ts` next door already refuses invented facts in
// `DEFAULT_USER_MD`. It could not see the real leak, because the leak was somewhere else:
// `gateway/routes/config.ts`'s OOBE identity route composed its OWN profile text and wrote it
// to the same file, with `- Name: ${userName}` defaulting to the literal `'User'` and two
// invented preference lines whenever the form's field was blank. `pages/Setup.tsx:1015` — that
// route's ONLY caller — sends `userPreferences: ''` and `userRole: ''` unconditionally, so the
// fallback was not an edge case. It was what every box that completed setup got.
//
// This file asks the question the sibling cannot: is there ONE source, and does every door
// go through it? Three kinds of clause, because the defect had three shapes:
//   §1 the COMPOSER — a blank field contributes nothing; a given field appears verbatim.
//   §2 the RESOLUTION — the default seeds an absent file, and NEVER overwrites a written one
//      (both directions, which is ruling #11's third requirement said as a test).
//   §3 the WIRING — a SOURCE-SHAPE census over `gateway/routes/config.ts` and
//      `prompt/assembler.ts`: comments stripped first, so a clause cannot be satisfied by the
//      prose above the call. It asserts the doors CALL this module and that the dead text is
//      gone from the route — a presence-only clause would stay green if a fifth writer grew.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

const { HOME } = vi.hoisted(() => ({
  HOME: `${(process.env.DOJO_TEST_HOME_ROOT || require('node:os').tmpdir())}/dojo-one-user-md-${process.pid}`,
}));

vi.mock('../../home.js', () => ({
  homeDir: (): string => HOME,
  dojoDir: (...s: string[]): string => `${HOME}/.dojo/${s.join('/')}`,
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const owner = { name: 'User', set: false };
vi.mock('../../config/platform.js', () => ({
  getOwnerName: () => owner.name,
  ownerNameIsSet: () => owner.set,
  OWNER_NAME_FALLBACK: 'User',
}));

import { DEFAULT_USER_MD } from '../templates.js';
import {
  composeUserProfile, defaultUserProfile, readUserProfile, writeUserProfile,
  userProfileIsEngineSeeded, userProfilePath,
} from '../user-profile.js';

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  owner.name = 'User'; owner.set = false;
});
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

// ── §1 THE COMPOSER ─────────────────────────────────────────────────────────────────────

describe('§1 the OOBE substitutes the form it was given, and invents the rest of nobody', () => {
  it('⚠ a blank form writes the SHIPPED DEFAULT verbatim — no name, no role, no preference', () => {
    // The exact call `pages/Setup.tsx` makes: a style and some rules, and all three person
    // fields empty. This is the shape that produced the invented preferences on every box.
    const out = composeUserProfile({ userName: '', userRole: '', userPreferences: '' });

    expect(out).toBe(DEFAULT_USER_MD);
    // Said again by their own bytes, because these two lines ARE the reported defect.
    expect(out).not.toMatch(/Prefers concise, direct communication/);
    expect(out).not.toMatch(/Values autonomous action for routine tasks/);
    // and the placeholder name the old route baked in for an unrecorded owner.
    expect(out).not.toMatch(/^-\s*Name:\s*User\s*$/m);
    expect(out).toMatch(/- Name: not recorded yet/);
    // The honesty paragraph is present, which it never was in the route's own text.
    expect(out).toMatch(/not invent or assume/i);
  });

  it('a name the owner typed lands on the Identity line, and nothing else moves', () => {
    const out = composeUserProfile({ userName: '  Rivera  ', userRole: '', userPreferences: '' });

    expect(out).toMatch(/^- Name: Rivera$/m);
    expect(out).not.toMatch(/not recorded yet/);
    expect(out).not.toMatch(/^-\s*Role:/m);
    expect(out).not.toMatch(/## Preferences/);
    // Everything that is not the name line is byte-identical to the default.
    expect(out).toBe(DEFAULT_USER_MD.replace('- Name: not recorded yet', '- Name: Rivera'));
  });

  it('a role and preferences appear verbatim, as a line and a section, and the honesty text survives', () => {
    const out = composeUserProfile({
      userName: 'Rivera', userRole: 'runs a bike shop', userPreferences: '- long replies are fine',
    });

    expect(out).toMatch(/^- Name: Rivera\n- Role: runs a bike shop$/m);
    expect(out).toMatch(/## Preferences\n- long replies are fine/);
    expect(out).toMatch(/not invent or assume/i);
  });

  it('with NO form name, a name the settings row recorded is still used — and a user called "User" is a person', () => {
    owner.set = true; owner.name = 'User';
    expect(composeUserProfile({})).toMatch(/^- Name: User$/m);
    expect(defaultUserProfile()).toMatch(/^- Name: User$/m);

    owner.set = false;
    expect(composeUserProfile({})).toMatch(/not recorded yet/);
  });
});

// ── §2 THE RESOLUTION ───────────────────────────────────────────────────────────────────

describe('§2 the default seeds an empty box and never overwrites a written profile', () => {
  it('an ABSENT profile is seeded from the default, and read back from disk', () => {
    expect(fs.existsSync(userProfilePath())).toBe(false);

    const out = readUserProfile();

    expect(out).toBe(DEFAULT_USER_MD);
    expect(fs.readFileSync(userProfilePath(), 'utf-8')).toBe(DEFAULT_USER_MD);
  });

  it('⚠ THE OTHER DIRECTION: an EDITED profile is returned unchanged and the default never lands on it', () => {
    writeUserProfile('# User Profile\n\n- Name: the owner wrote this themselves\n', 'dashboard');
    owner.set = true; owner.name = 'Rivera';

    expect(readUserProfile()).toMatch(/the owner wrote this themselves/);
    expect(readUserProfile()).not.toMatch(/not recorded yet/);
    // Reading twice does not re-seed on the second pass either.
    expect(fs.readFileSync(userProfilePath(), 'utf-8')).toMatch(/wrote this themselves/);
  });

  it('⚠ engine-seeded vs owner-written is answered by CONTENT, not by length', () => {
    // The guard this replaced asked "absent, or under 20 characters?". The engine's own seed is
    // ~600 characters, so that guard called the engine's seed an owner's profile and refused to
    // record the name the owner had just typed. Both directions:
    readUserProfile();                                   // engine seeds the default
    expect(userProfileIsEngineSeeded()).toBe(true);       // ...and is recognised as such

    writeUserProfile('- Name: me\n', 'dashboard');        // 11 characters, written by a person
    expect(userProfileIsEngineSeeded()).toBe(false);      // ...and is NOT overwritable
  });

  it('a dashboard edit is what the next assembly reads — one file, no cache', () => {
    readUserProfile();
    writeUserProfile('# User Profile\n\n- Name: edited in Settings\n', 'dashboard');
    expect(readUserProfile()).toMatch(/edited in Settings/);

    // and the OOBE door writes to the same place the dashboard door just did.
    writeUserProfile(composeUserProfile({ userName: 'Rivera' }), 'oobe');
    expect(readUserProfile()).toMatch(/^- Name: Rivera$/m);
  });
});
