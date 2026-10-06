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
import path from 'node:path';
import ts from 'typescript';

const { HOME } = vi.hoisted(() => ({
  HOME: `${require('node:os').tmpdir()}/dojo-one-user-md-${process.pid}`,
}));

vi.mock('../../home.js', () => ({
  homeDir: (): string => HOME,
  dojoDir: (...s: string[]): string => `${HOME}/.dojo/${s.join('/')}`,
  isTestRun: (): boolean => true,
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

const SRC = path.resolve(__dirname, '../..');

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

// ── §3 THE WIRING (source shape, comments stripped) ─────────────────────────────────────

const STRIP_CACHE = new Map<string, string>();

/**
 * t99's comment stripper (`report/__tests__/only-the-audited-door-can-reach-the-wire.test.ts`),
 * carried here rather than a line-start regex: a clause that can be satisfied by the prose
 * above a call is testing the comment. AST trivia ranges, so `/* keep *\/` mid-line and a
 * `//` inside a string literal are both handled correctly.
 */
function stripComments(code: string, kind: ts.ScriptKind = ts.ScriptKind.TS): string {
  const cached = STRIP_CACHE.get(code);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(
    kind === ts.ScriptKind.TSX ? 'census.tsx' : 'census.ts',
    code, ts.ScriptTarget.Latest, false, kind,
  );
  const chars = code.split('');
  const blanked = new Set<string>();
  const blank = (range: ts.CommentRange): void => {
    const key = `${range.pos}:${range.end}`;
    if (blanked.has(key)) return;
    blanked.add(key);
    for (let i = range.pos; i < range.end && i < chars.length; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };
  const triviaAt = (pos: number): void => {
    ts.getLeadingCommentRanges(code, pos)?.forEach(blank);
    ts.getTrailingCommentRanges(code, pos)?.forEach(blank);
  };
  const visit = (node: ts.Node): void => {
    triviaAt(node.pos); triviaAt(node.end); ts.forEachChild(node, visit);
  };
  visit(source);
  triviaAt(source.endOfFileToken.pos);
  const out = chars.join('');
  STRIP_CACHE.set(code, out);
  return out;
}

const readStripped = (rel: string): string =>
  stripComments(fs.readFileSync(path.join(SRC, rel), 'utf-8'));

describe('§3 every door goes through the one module, and the rival text is gone', () => {
  it('⚠ the OOBE route COMPOSES nothing: no invented preference, no \'User\' default, no baked agent name', () => {
    const route = readStripped('gateway/routes/config.ts');

    // The dead text, by its own bytes. These are what t107 reported.
    expect(route).not.toMatch(/Prefers concise, direct communication/);
    expect(route).not.toMatch(/Values autonomous action for routine tasks/);
    expect(route).not.toMatch(/userName\s*=\s*'User'/);
    expect(route).not.toMatch(/You are \$\{agentName\}/);
    // and it no longer owns a `# User Profile` / `# Preferences` heading of its own.
    expect(route).not.toMatch(/# User Profile/);
    expect(route).not.toMatch(/# Preferences/);
  });

  it('⚠ the OOBE route APPLIES the module — the call shape and what it does with the result', () => {
    const route = readStripped('gateway/routes/config.ts');

    // Shape AND application: `composeUserProfile` feeds the write, guarded by the
    // engine-seeded predicate. A bare mention of the import would not satisfy this.
    expect(route).toMatch(/composeUserProfile\(\s*\{\s*userName,\s*userRole,\s*userPreferences\s*\}\s*\)/);
    expect(route).toMatch(/userProfileIsEngineSeeded\(\)/);
    expect(route).toMatch(/writeUserProfile\(\s*user,\s*'oobe'\s*\)/);
    // and the SOUL side seeds from the shipped default through the soul door — the composer
    // is APPLIED to the door's own fallback, so the two cannot disagree about the seed text.
    expect(route).toMatch(/soulFileForAgent\(\s*getPrimaryAgentId\(\)\s*\)/);
    expect(route).toMatch(/composePrimarySoul\(\s*\{\s*communicationStyle,\s*rules\s*\}\s*,\s*primarySoul\?\.fallback/);
    expect(route).toMatch(/writeSoulFile\(\s*primarySoul,\s*soul\s*\)/);
  });

  it('the dashboard read and edit doors are the same doors', () => {
    const route = readStripped('gateway/routes/config.ts');
    expect(route).toMatch(/readUserProfile\(\)/);
    expect(route).toMatch(/writeUserProfile\(\s*body\.content,\s*'dashboard'\s*\)/);
  });

  it('⚠ the assembler SLOT is a reader of the module and composes no seed of its own', () => {
    const asm = readStripped('prompt/assembler.ts');

    expect(asm).toMatch(/return readUserProfile\(\)/);
    // The seed-composing line it replaced, by its own shape — this is the "both directions"
    // half: re-introducing a second default here reds, not just deleting the call.
    expect(asm).not.toMatch(/readPromptFile\(\s*'USER\.md'/);
    expect(asm).not.toMatch(/DEFAULT_USER_MD/);
  });

  it('⚠ the census counts BOTH WAYS: this module is the ONLY writer of USER.md in the tree', () => {
    // A presence-only clause above stays green when a FIFTH writer is added somewhere else.
    // So: walk the server source and require that every site naming the profile file is either
    // the module itself, a test, or a door that routes through the module.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(e.name)) continue;
        const rel = path.relative(SRC, full);
        if (rel.includes('__tests__')) continue;
        if (rel === path.join('prompt', 'user-profile.ts')) continue;

        const code = stripComments(fs.readFileSync(full, 'utf-8'), e.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        // A WRITE to USER.md: the filename next to a write call in the same statement region.
        if (!/USER\.md/.test(code)) continue;
        const writes = /writeFileSync\([^)]*USER\.md|USER\.md[^;]*writeFileSync/.test(code);
        if (writes) offenders.push(rel);
      }
    };
    walk(SRC);

    // `prompt/agent-rename.ts` rewrites STORED SOUL files only and is not a profile writer;
    // if it ever becomes one it shows up here, which is the point.
    expect(offenders, `these modules write USER.md without going through prompt/user-profile.ts: ${offenders.join(', ')}`).toEqual([]);
  });
});
