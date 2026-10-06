// ════════════════════════════════════════════════════════════════════════════════════════
// AN UNSET PROFILE SAYS SO, AND INVENTS NOBODY (fresh-box audit, finding 2).
//
// ── WHAT SHIPPED, and there were THREE answers to one question ──
//   `templates/USER.md`            an invented first name and job title, as if real
//   `prompt/templates.ts`          `- Name: {{owner_name}}` — a token NOTHING substitutes
//   `config/platform.ts`           `getOwnerName()` defaulting to `'User'`
// A fresh box's agent could therefore believe its owner was a fictional person, or was literally
// named "{{owner_name}}", or was "User", depending on which prompt slot it read.
//
// ── TWO CORRECTIONS TO THE AUDIT, both measured here ──
//   1. The shipped `templates/USER.md` is NOT what seeds a fresh box. `renderUserProfile()` calls
//      `readPromptFile('USER.md', DEFAULT_USER_MD)`, which uses the IN-CODE default;
//      `readPlatformTemplate()` exists but has ZERO callers. So the fictional person never reached
//      a model through this path — it shipped as a file, which is its own problem and is why the
//      template is fixed too.
//   2. The real leak was the unsubstituted `{{owner_name}}`, which DID reach the model verbatim.
//
// So: one fallback (`OWNER_NAME_FALLBACK`), one wording, the real name seeded when setup recorded
// one, and no invented facts anywhere.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `vi.mock` factories are hoisted above module-level consts, so the home path has to be too.
const { HOME } = vi.hoisted(() => ({
  HOME: `${(process.env.DOJO_TEST_HOME_ROOT || require('node:os').tmpdir())}/dojo-profile-honest-${process.pid}`,
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

/** Owner identity, driven per clause. */
const owner = { name: 'User', set: false };
vi.mock('../../config/platform.js', () => ({
  getOwnerName: () => owner.name,
  ownerNameIsSet: () => owner.set,
  OWNER_NAME_FALLBACK: 'User',
  isPrimaryAgent: () => true,
  isPMAgent: () => false,
  isTrainerAgent: () => false,
  isHealerAgent: () => false,
  isImaginerAgent: () => false,
  getPrimaryAgentName: () => 'Primary',
  getPrimaryAgentId: () => 'primary-1',
  getPMAgentName: () => 'PM',
  getPMAgentId: () => 'pm-1',
  getTrainerAgentId: () => 't-1',
  getTrainerAgentName: () => 'Trainer',
  isTrainerEnabled: () => true,
  getHealerAgentId: () => 'h-1',
  getHealerAgentName: () => 'Healer',
  getImaginerAgentName: () => 'Imaginer',
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('no DB in this suite'); },
  closeDb: vi.fn(),
  getDbPath: () => '/dev/null',
}));

import { DEFAULT_USER_MD } from '../templates.js';
import { renderUserProfile } from '../assembler.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SHIPPED = path.join(REPO_ROOT, 'templates', 'USER.md');

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  owner.name = 'User'; owner.set = false;
});
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

describe('the default profile invents nothing', () => {
  it('⚠ carries no unsubstituted template token — that is what reached the model', () => {
    expect(DEFAULT_USER_MD).not.toMatch(/\{\{/);
    expect(DEFAULT_USER_MD).not.toMatch(/owner_name/);
  });

  it('⚠ states that it is unset, and tells the agent to learn and ask', () => {
    expect(DEFAULT_USER_MD).toMatch(/not recorded yet/);
    expect(DEFAULT_USER_MD).toMatch(/has not been filled in/i);
    expect(DEFAULT_USER_MD).toMatch(/not invent or assume/i);
    expect(DEFAULT_USER_MD).toMatch(/ask them/i);
  });

  it('⚠ asserts no preference the owner never expressed', () => {
    // The old default claimed the owner "prefers concise, actionable responses" and "values
    // correctness over speed". Invented preferences are standing instructions nobody gave.
    expect(DEFAULT_USER_MD).not.toMatch(/Prefers /i);
    expect(DEFAULT_USER_MD).not.toMatch(/Values correctness/i);
    expect(DEFAULT_USER_MD).not.toMatch(/Comfortable with technical details/i);
  });

  it('⚠ names no person and no role — a fictional owner is a fabricated record', () => {
    // Shape, not a blocklist of one name: a `- Name:`/`- Role:` line asserting a concrete value
    // is the defect, whatever the value is.
    const nameLines = DEFAULT_USER_MD.split('\n').filter(l => /^-\s*(Name|Role):/i.test(l));
    expect(nameLines).toEqual(['- Name: not recorded yet']);
  });
});

describe('the shipped template and the in-code default agree', () => {
  it('⚠ templates/USER.md is byte-identical to DEFAULT_USER_MD', () => {
    // Two files answering one question is how they came to disagree. The shipped copy exists
    // because `build-package.sh` copies `templates/*.md`; it must not be a second opinion.
    expect(fs.existsSync(SHIPPED)).toBe(true);
    expect(fs.readFileSync(SHIPPED, 'utf-8')).toBe(DEFAULT_USER_MD);
  });
});

describe('the real name is seeded where setup recorded one', () => {
  it('an UNSET owner gets the "not recorded yet" profile on disk', () => {
    const out = renderUserProfile('primary-1');
    expect(out).toMatch(/- Name: not recorded yet/);
    const seeded = fs.readFileSync(path.join(HOME, '.dojo', 'prompts', 'USER.md'), 'utf-8');
    expect(seeded).toMatch(/- Name: not recorded yet/);
    expect(seeded).not.toMatch(/\{\{/);
  });

  it('⚠ a SET owner gets their real name, and only that line changes', () => {
    owner.set = true; owner.name = 'Rivera';

    const out = renderUserProfile('primary-1');

    expect(out).toMatch(/- Name: Rivera/);
    expect(out).not.toMatch(/not recorded yet/);
    // The honesty paragraph stays: a recorded name does not mean the profile is complete.
    expect(out).toMatch(/not invent or assume/i);
  });

  it('⚠ a user genuinely called "User" is a person, not a missing setting', () => {
    // `ownerNameIsSet()` asks the ROW, so comparing against the fallback string cannot erase them.
    owner.set = true; owner.name = 'User';
    expect(renderUserProfile('primary-1')).toMatch(/- Name: User/);
  });

  it('NEGATIVE CONTROL — an existing USER.md on disk is never overwritten', () => {
    const p = path.join(HOME, '.dojo', 'prompts', 'USER.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# User Profile\n\n- Name: the owner already wrote this\n', 'utf-8');
    owner.set = true; owner.name = 'Rivera';

    expect(renderUserProfile('primary-1')).toMatch(/already wrote this/);
  });
});
