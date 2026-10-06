// ════════════════════════════════════════════════════════════════════════════════════════
// USER.md HAS ONE SOURCE OF TRUTH.
// (OWNER RULING #11, 2026-10-05, verbatim: "USER.md gets ONE source of truth, editable from
//  the dashboard AND the OOBE, never hard-coded; file vs DB is the implementer's call.")
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT THERE WAS INSTEAD, measured at main `c46b44e3` ────────────────────────────────
// Three texts answered "what is the owner's profile?", and two of them disagreed with the
// third on purpose:
//   1. `DEFAULT_USER_MD` (`prompt/templates.ts`) — the honest unset profile: it states that
//      nothing is known, names nobody, and asserts no preference the owner never gave.
//   2. `gateway/routes/config.ts`'s OOBE identity route — composed its OWN `# User Profile`
//      text with `- Name: ${userName}` defaulting to the literal `'User'` and, when the form
//      left preferences blank, the invented lines "Prefers concise, direct communication" /
//      "Values autonomous action for routine tasks". `__tests__/the-profile-admits-it-is-
//      empty.test.ts` refuses that wording in `DEFAULT_USER_MD` in as many words ("an invented
//      preference is a standing instruction the owner never gave") — and the OOBE wrote it
//      anyway, on the one path every new box takes.
//   3. The dashboard's `PUT /identity/:file` door — correct, but a THIRD piece of code
//      computing the same path with its own `fs` call, so nothing could enforce agreement.
// The file on disk is read on every assembly, so whichever text happened to write it last
// became the owner's profile. That is the defect: not the wording of any one of them, but
// that there were three.
//
// ── THE SHAPE: one module, three doors, no second opinion ──────────────────────────────
// Everything that resolves, reads, or writes USER.md goes through this module:
//   `defaultUserProfile()`  the shipped default, owner name substituted where setup recorded
//                           one — the ONLY place a default is composed.
//   `readUserProfile()`     the box's edited copy if it has one, else seed the default to disk
//                           and return it. `prompt/assembler.ts`'s `renderUserProfile()` slot
//                           is a thin wrapper over this, so an edit is live on the next
//                           assembly with no cache to invalidate.
//   `writeUserProfile()`    the ONE write door. The dashboard edit route and the OOBE form
//                           both call it; neither composes profile text of its own.
//
// ── FILE, NOT DB — the implementer's call the ruling left open ─────────────────────────
// `~/.dojo/prompts/USER.md` stays the storage. Reasons, in order of weight:
//   * The owner edits this file BY HAND — the default's own closing line tells them to
//     ("Settings, or `~/.dojo/prompts/USER.md`"). Moving the bytes into a config row would
//     make that sentence false and take away a door that already works on every box.
//   * It is already the file the assembler reads, so nothing migrates, and a box upgrading
//     into this change keeps the profile it has.
//   * There is no query against this value — it is read whole, once per assembly. A DB row
//     would buy indexing and transactions that nothing here wants.
// The cost is that two writers to one path need the discipline this module provides, which is
// exactly what it provides.
//
// ── THE DEFAULT NEVER OVERWRITES AN EDITED COPY ────────────────────────────────────────
// `readUserProfile()` seeds only when the file is ABSENT. That is load-bearing in both
// directions and clause-pinned both ways in `__tests__/one-user-md.test.ts`: a stored copy is
// returned unchanged however stale the default has become, and an absent file is seeded rather
// than returning emptiness to the model.
// ════════════════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../home.js';
import { createLogger } from '../logger.js';
import { getOwnerName, ownerNameIsSet } from '../config/platform.js';
import { DEFAULT_USER_MD } from './templates.js';

const logger = createLogger('user-profile');

/** The unset default's name line — the one line `defaultUserProfile` substitutes. */
export const UNSET_NAME_LINE = '- Name: not recorded yet';

/** The profile's filename, said once so no caller spells it. */
export const USER_PROFILE_FILENAME = 'USER.md';

/**
 * Resolved per call, NOT captured at module load. `homeDir()` answers `DOJO_TEST_HOME_ROOT`,
 * which a suite sets per run; a module-level `const` would freeze the first home a process
 * ever saw and quietly write every later test's profile into it.
 */
export function userProfilePath(): string {
  return path.join(homeDir(), '.dojo', 'prompts', USER_PROFILE_FILENAME);
}

/**
 * The shipped default, with the owner's real name where setup recorded one.
 *
 * `ownerNameIsSet()` asks the ROW, not the string, so a user genuinely called "User" is a
 * person rather than a missing setting — and an UNRECORDED name stays "not recorded yet"
 * instead of becoming the `'User'` placeholder the OOBE route used to bake in.
 */
export function defaultUserProfile(): string {
  if (!ownerNameIsSet()) return DEFAULT_USER_MD;
  return DEFAULT_USER_MD.replace(UNSET_NAME_LINE, `- Name: ${getOwnerName()}`);
}

/** Does this box have an edited profile on disk? */
export function userProfileExists(): boolean {
  try {
    return fs.existsSync(userProfilePath());
  } catch {
    return false;
  }
}

/**
 * The box's profile: its edited copy, or the default seeded to disk on first read.
 *
 * The seeding write is best-effort — a read-only home degrades to the in-memory default
 * rather than failing an assembly.
 */
export function readUserProfile(): string {
  const p = userProfilePath();

  if (fs.existsSync(p)) {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch (err) {
      logger.warn('failed to read the owner profile, using the shipped default', {
        error: err instanceof Error ? err.message : String(err),
      });
      return defaultUserProfile();
    }
  }

  const seed = defaultUserProfile();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, seed, 'utf-8');
    logger.info('seeded the owner profile from the shipped default');
  } catch {
    // Non-fatal: the assembly runs on the in-memory default.
  }
  return seed;
}

/**
 * Is the profile on disk still ENGINE-SEEDED — i.e. has no human written in it?
 *
 * This is the predicate the OOBE needs, and it exists because the obvious one is wrong. The
 * route used to ask "is the file absent, or under 20 characters?" before writing, to avoid
 * clobbering a profile the owner typed in the setup flow's earlier "Your Profile" step. But
 * `readUserProfile()` SEEDS the default on the first assembly, and an assembly can happen
 * before setup finishes — at which point the file exists, is ~600 characters of default text,
 * and the length guard silently refuses to record the name the owner just typed.
 *
 * So the question is not "is there a file" but "did a person write it". Engine-seeded content
 * is byte-equal to a default this module composed; anything else is the owner's, however
 * short, and is never overwritten.
 */
export function userProfileIsEngineSeeded(): boolean {
  const p = userProfilePath();
  let stored: string;
  try {
    if (!fs.existsSync(p)) return true;
    stored = fs.readFileSync(p, 'utf-8');
  } catch {
    return true;
  }
  if (stored.trim().length === 0) return true;
  // Both variants: the unset default, and the same text with a recorded name substituted in.
  return stored === DEFAULT_USER_MD || stored === defaultUserProfile();
}

/**
 * THE one write door. The dashboard edit route and the OOBE form both arrive here, which is
 * what makes "one source of truth" enforceable rather than aspirational.
 */
export function writeUserProfile(content: string, by: 'dashboard' | 'oobe' | 'engine'): void {
  const p = userProfilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  logger.info('owner profile written', { by, chars: content.length });
}

/** The fields the OOBE's identity form actually collects about the PERSON. */
export interface OwnerProfileFields {
  readonly userName?: string;
  readonly userRole?: string;
  readonly userPreferences?: string;
}

/**
 * The OOBE's profile: THE SHIPPED DEFAULT, with the form's fields substituted into it — and
 * nothing else. (t111-A1, closing t107's hand-up 1.)
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────────────────
 * `gateway/routes/config.ts`'s identity route composed its own `# User Profile` text:
 *
 *     - Name: ${userName}                        // `userName` defaulted to the literal 'User'
 *     ${userRole ? `- Role: ${userRole}` : ''}
 *     # Preferences
 *     ${userPreferences || '- Prefers concise, direct communication\n
 *                           - Values autonomous action for routine tasks'}
 *
 * Three defects in nine lines, and the third is the one that bit every box:
 *   1. An unrecorded name became the literal `User`, the exact placeholder
 *      `DEFAULT_USER_MD` was fixed to stop shipping.
 *   2. It was a FOURTH text answering a question `DEFAULT_USER_MD` already answers, so the
 *      honesty paragraph ("nothing here is known… you must not invent or assume any of them")
 *      was absent from the profile every real box ends up with.
 *   3. The `||` fallback wrote two INVENTED preferences whenever the form left the field
 *      blank — and `packages/dashboard/src/pages/Setup.tsx:1015`, the route's ONLY caller,
 *      sends `userPreferences: ''` and `userRole: ''` unconditionally. So the fallback was not
 *      an edge case: it was the behaviour. Every box that completed setup told its agent the
 *      owner "prefers concise, direct communication" and "values autonomous action for routine
 *      tasks" — standing instructions nobody ever gave, and the precise wording
 *      `prompt/__tests__/the-profile-admits-it-is-empty.test.ts` refuses.
 *
 * Now a blank field CONTRIBUTES NOTHING. An absent name leaves "not recorded yet" standing,
 * which is true; an absent preference writes no preference line at all.
 */
export function composeUserProfile(fields: OwnerProfileFields): string {
  const name = (fields.userName ?? '').trim();
  const role = (fields.userRole ?? '').trim();
  const prefs = (fields.userPreferences ?? '').trim();

  // Start from the default. When the form gave no name, `defaultUserProfile()` still fills in
  // one the SETTINGS row recorded; when neither knows, "not recorded yet" stays.
  let md = name
    ? DEFAULT_USER_MD.replace(UNSET_NAME_LINE, `- Name: ${name}`)
    : defaultUserProfile();

  if (role) {
    // Inside `## Identity`, directly under the name — the only other identity fact collected.
    const anchor = name ? `- Name: ${name}` : null;
    const nameLine = anchor && md.includes(anchor) ? anchor
      : md.split('\n').find((l) => /^-\s*Name:/.test(l));
    if (nameLine) md = md.replace(nameLine, `${nameLine}\n- Role: ${role}`);
  }

  if (prefs) {
    // A section, not a rewrite: the honesty paragraph stays, because a recorded preference
    // does not make the rest of the profile known.
    md = `${md.replace(/\n+$/, '')}\n\n## Preferences\n${prefs.replace(/\n+$/, '')}\n`;
  }

  return md;
}
