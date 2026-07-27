// ════════════════════════════════════════
// "Is this box past its first run?" — the SECURITY answer (PHASE-0 T9)
// ════════════════════════════════════════
//
// NOT the same question as `isSetupCompleted()` in ./platform.ts, and
// deliberately not named the same. That one asks "did OOBE finish, so may I
// spawn the resident agents / do boot work?" and must answer NO when unsure —
// spawning agents on a half-set-up box is the harm. This one asks "must the
// OOBE doors be shut?" and must answer YES when unsure — leaving them open is
// the harm. Same fact, opposite fail-safe directions, so they stay two
// functions with two names. (Collapsing them is a Sweep E/F question, and it
// would have to pick one failure direction.)
//
// Two readers depend on this answer and they must never disagree:
//   • the auth middleware, which opens the `/api/setup/` doors ONLY during a
//     genuine out-of-box experience (they install software and import whole
//     databases; leaving them open forever is the hole T9 closes), and
//   • GET /api/setup/status, which tells the dashboard whether to show the
//     wizard or the login form.
// If those two ever split, the dashboard offers a wizard whose routes 401.
//
// TWO facts make a box "set up", and either one is enough:
//   1. the `setup_completed` config row, written once by markSetupCompleted();
//   2. a dashboard password hash existing at all.
// (2) is the fail-closed rule (roadmap non-negotiable #15: never infer absence
// of a thing from absence of its record). Every install that predates the flag
// has no row and a real owner; reading `row?.value === 'true'` alone coerces
// those boxes to "first run" and throws their setup doors open. The backfill
// migration 125 stamps the row where the DATABASE can see the box is
// configured, but the password hash lives in ~/.dojo/secrets.yaml, which no SQL
// migration can read — so the gate carries the check too, and does not depend
// on the migration having run.
//
// CACHED, and the cache is load-bearing, not an optimisation:
// during OOBE the password is created at the login screen (POST
// /api/auth/login first-run branch) BEFORE the wizard runs, and an import
// restores a `setup_completed='true'` row mid-wizard. An uncached read would
// therefore flip to "completed" in the middle of the out-of-box experience and
// slam the doors on the user still walking through them. The value is resolved
// once per process and only markFirstRunComplete() moves it. Do not "simplify"
// this to a live read.

import { getDb } from '../db/connection.js';
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

    // Absent row + a real password = a set-up box whose flag predates the flag.
    if (!completed) completed = getDashboardPasswordHash() !== null;
  } catch {
    // Cannot read the evidence → assume the box IS set up, so the doors stay
    // shut. Not cached: a transient failure must not lock the box out of its
    // own first run forever.
    return true;
  }

  cached = completed;
  return completed;
}

/**
 * Called once, by POST /api/setup/complete, when the owner finishes first run.
 * Writes the durable flag AND busts the cache — one function so the two can
 * never drift apart.
 */
export function markFirstRunComplete(): void {
  getDb()
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES ('setup_completed', 'true', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now')`,
    )
    .run();
  cached = true;
}
