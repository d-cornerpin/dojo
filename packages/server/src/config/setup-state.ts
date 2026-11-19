// The one answer to "must the OOBE doors be shut?" for auth and GET /api/setup/status, YES when unsure;
// isSetupCompleted (./platform.ts) is the spawn question and fails the other way. Set up = the flag row
// or a password hash (secrets.yaml, unreadable to migrations). Cached per process: the hash is set at first
// login and an import restores the flag mid-wizard, so only markFirstRunComplete() may shut the doors.

import { getDb } from '../db/connection.js';
import { setConfigValue } from './config-value.js';
import { getDashboardPasswordHash } from './loader.js';

let cached: boolean | null = null;

export function isPastFirstRun(): boolean {
  if (cached !== null) return cached;

  let completed: boolean;
  try {
    const row = getDb()
      .prepare("SELECT value FROM config WHERE key = 'setup_completed'")
      .get() as { value: string } | undefined;
    completed = row?.value === 'true';

    if (!completed) completed = getDashboardPasswordHash() !== null;
  } catch {
    // Unreadable: the doors stay shut, uncached so a transient failure cannot lock out the first run.
    return true;
  }

  cached = completed;
  return completed;
}

export function markFirstRunComplete(): void {
  setConfigValue('setup_completed', 'true');
  cached = true;
}
