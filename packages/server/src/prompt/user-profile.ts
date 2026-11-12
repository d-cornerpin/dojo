// USER.md has one source of truth: every read, write and default goes through this module.
// Storage stays the file ~/.dojo/prompts/USER.md (owners edit it by hand); the assembler reads it whole each time.

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../home.js';
import { createLogger } from '../logger.js';
import { getOwnerName, ownerNameIsSet } from '../config/platform.js';
import { DEFAULT_USER_MD } from './templates.js';

const logger = createLogger('user-profile');

export const UNSET_NAME_LINE = '- Name: not recorded yet';

export const USER_PROFILE_FILENAME = 'USER.md';

/** Resolved per call, not at load: `homeDir()` follows `DOJO_TEST_HOME_ROOT`, which a suite sets per run. */
export function userProfilePath(): string {
  return path.join(homeDir(), '.dojo', 'prompts', USER_PROFILE_FILENAME);
}

// `ownerNameIsSet()` reads the settings row, so a person genuinely named "User" still counts as set.
export function defaultUserProfile(): string {
  if (!ownerNameIsSet()) return DEFAULT_USER_MD;
  return DEFAULT_USER_MD.replace(UNSET_NAME_LINE, () => `- Name: ${getOwnerName()}`);
}

/** Throws if the file exists but is unreadable, so an editor Save cannot overwrite it with the default. */
export function readUserProfileForEditor(): string {
  const p = userProfilePath();
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  return readUserProfile();
}

/** The stored profile, else the default seeded to disk once; an edited copy is never overwritten. */
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

/** True when no person wrote the profile: absent, blank, or byte-equal to a default this module composes. */
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
  return stored === DEFAULT_USER_MD || stored === defaultUserProfile();
}

/** The one write door, shared by the dashboard edit route and the setup form. */
export function writeUserProfile(content: string, by: 'dashboard' | 'oobe' | 'engine'): void {
  const p = userProfilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  logger.info('owner profile written', { by, chars: content.length });
}

export interface OwnerProfileFields {
  readonly userName?: string;
  readonly userRole?: string;
  readonly userPreferences?: string;
}

/** The default with the setup form's fields substituted in; a blank field contributes nothing. */
export function composeUserProfile(fields: OwnerProfileFields): string {
  const name = (fields.userName ?? '').trim();
  const role = (fields.userRole ?? '').trim();
  const prefs = (fields.userPreferences ?? '').trim();

  let md = name
    ? DEFAULT_USER_MD.replace(UNSET_NAME_LINE, () => `- Name: ${name}`)
    : defaultUserProfile();

  if (role) {
    const anchor = name ? `- Name: ${name}` : null;
    const nameLine = anchor && md.includes(anchor) ? anchor
      : md.split('\n').find((l) => /^-\s*Name:/.test(l));
    if (nameLine) md = md.replace(nameLine, () => `${nameLine}\n- Role: ${role}`);
  }

  if (prefs) {
    // A section, so the default text (including its "nothing here is known" paragraph) stays.
    md = `${md.replace(/\n+$/, '')}\n\n## Preferences\n${prefs.replace(/\n+$/, '')}\n`;
  }

  return md;
}
