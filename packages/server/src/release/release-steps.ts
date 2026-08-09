// ════════════════════════════════════════════════════════════════════════════════════════
// PER-RELEASE BOOT STEPS — one declared facility, SWEEP CORE-2 item 3.
//
// ── WHY THIS EXISTS, AND WHAT IT PROMOTES ───────────────────────────────────────────────
// The owner's ask of 2026-08-06 names the shape: *"a declared per-release migration step (the
// gap between the previous and current version decides which steps run), idempotent."* The
// pattern already existed — built by hand, once. `scheduler/anchor-compensation.ts` is exactly
// this: a one-shot boot pass keyed to which boot first carries a fix, examining every candidate
// row and reporting with a denominator. This module is that pattern promoted, so the second one
// does not have to be hand-rolled too.
//
// The tree already did this for the PERIODIC axis and said why: `work/work-reaper.ts` opens
// with *"'when does an obligation age out' was answered in eleven places ... Nothing could list
// the deadlines, nothing could say which clock drove which sweep."* Re-derived for THIS axis at
// HEAD (#14): there are five one-shot boot passes in the tree and **not one of them compares a
// version** — every one keys on a config flag stamped on first sight:
//
//   anchor-compensation.ts:279   config `anchor_compensation_scan` + `anchor_door_fix_first_boot_at`
//   techniques/audit-migration   config `technique_dep_audit_dispatched_at`
//   google/reauth-notice.ts      config `google_broker_reauth_notified`
//   vault/archive.ts             none — state-shaped idempotence
//   services/vision-model.ts     none — config-shaped idempotence
//
// A config flag answers "has this ever run", which is the right question for a step that pays
// for ONE fix and is then finished for ever. It cannot answer the owner's question, which is
// "this box jumped from 3.1 to 3.4 — what does it owe?" That is a GAP, and a gap needs two
// versions.
//
// ── THE MARKER IS NEW, AND THAT IS DECLARED RATHER THAN SLIPPED IN ──────────────────────
// `config.platform_version` looks like the natural home and is NOT used: measured at HEAD, it
// has three READERS (`migration/manifest.ts` x2, `PostMigrationBanner.tsx`) and **no writer at
// all**, so every box answers `'1.0.0'` by default. Starting to write it would silently change
// what an export manifest claims about the box it came from — a side effect of a reconciliation
// pass, in a subsystem that has nothing to do with it. So this facility introduces its OWN key,
// says so, and leaves `platform_version` exactly as unwritten as it found it (#15: a residue to
// REPORT, never a change to make quietly).
//
// ── IDEMPOTENCE IS THE PRIMARY SAFETY, NOT THE MARKER ───────────────────────────────────
// Every step must be safe to run any number of times, and the marker is only an optimisation
// on top of that. It is the right way round: a marker can be lost (a restored backup, a reset
// box, a `config` row deleted), and a step whose safety depended on the marker would then do
// its work twice. A step whose safety does not depend on it simply runs again and finds
// nothing. `runReleaseSteps` records the version AFTER the pass, and a step that throws does
// not stop the others — the reaper's "non-fatal by design" discipline, for the same reason.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
// The tree's ONE version-ordering function, which already handles `X.Y.Z` and
// `X.Y.Z-preflight.N`. A second comparator here would be a second answer to "which release is
// newer", and this project has closed that class of duplication a dozen times.
import { compareVersions, getCurrentVersion } from '../gateway/routes/update.js';

const logger = createLogger('release-steps');

/** The version the last boot ran release steps at. NEW key — see the header. */
export const RELEASE_STEPS_VERSION_KEY = 'release_steps_last_version';

export interface ReleaseStepOutcome {
  /** How many candidate rows were LOOKED AT. Mandatory: a pass with no denominator is not evidence. */
  examined: number;
  /** How many were surfaced for a person to decide. */
  flagged: number;
  /** How many the step changed, which is only ever a structurally unambiguous case. */
  repaired: number;
}

export interface ReleaseStep {
  readonly id: string;
  /**
   * The release whose SHIPPING created the wreckage window this step reconciles — i.e. the
   * version at or after which a box may be carrying what this step looks for. A box that
   * crosses this version in one update owes this step.
   */
  readonly sinceVersion: string;
  /** What shipped, and what it left behind. A step that cannot say this does not belong here. */
  readonly pays: string;
  /** MUST be idempotent. Never throws to the caller — the runner catches, but do not rely on it. */
  readonly run: () => Promise<ReleaseStepOutcome> | ReleaseStepOutcome;
}

/** The declared set. A new one-shot pass joins this list rather than the boot file. */
export const RELEASE_STEPS: readonly ReleaseStep[] = [
  {
    id: 'version-gap-reconcile',
    // The tracker doors this reconciles are correct at HEAD; the window this pays for is every
    // release BEFORE the `close_project` repair, which is the whole of a lived-in box's history.
    // `0.0.0` is deliberate and not a shrug: it says "any box that has ever run any version".
    sinceVersion: '0.0.0',
    pays:
      "the owner's 2026-08-06 report — a prior build's broken close_project left his production "
      + 'dojo carrying 27 stale projects while the board reported 29 "Active" with zero '
      + 'in-progress work. The fix ships; the wreckage stays. Nothing in the tree reconciled '
      + 'tracker state across a version change.',
    run: async () => {
      const { runVersionGapReconcile } = await import('../tracker/version-gap-reconcile.js');
      const r = await runVersionGapReconcile();
      return { examined: r.projectsExamined + r.tasksExamined, flagged: r.findings.length, repaired: r.repaired };
    },
  },
];

/**
 * Which declared steps a box crossing `from` -> `to` owes.
 *
 * A step is owed when its release is at or below where the box has arrived, and ABOVE where it
 * last was. `from: null` — a box with no recorded history — owes every step at or below the
 * current version, because its wreckage could have come from any release it has ever run.
 *
 * Pure and exported so the rule is testable without a boot.
 */
export function stepsInGap<T extends { id: string; sinceVersion: string }>(
  steps: readonly T[], gap: { from: string | null; to: string },
): T[] {
  return steps.filter((s) => {
    if (compareVersions(s.sinceVersion, gap.to) > 0) return false;      // not shipped here yet
    if (gap.from === null) return true;                                  // no history: owe it all
    return compareVersions(gap.from, s.sinceVersion) < 0;                // inside the gap
  });
}

export interface ReleaseStepsReport {
  from: string | null;
  to: string;
  ran: Array<{ id: string } & ReleaseStepOutcome>;
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
}

function readLastVersion(): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?')
      .get(RELEASE_STEPS_VERSION_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch { return null; }
}

function recordVersion(version: string): void {
  try {
    getDb().prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(RELEASE_STEPS_VERSION_KEY, version);
  } catch (err) {
    // Recording is an optimisation, not a safety: every step is idempotent, so a box that fails
    // to record simply runs them again next boot and finds nothing.
    logger.warn('Could not record the release-steps version marker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Run every step this boot owes. Sequential and individually guarded, for the reaper's reason:
 * one step failing must not silence the others.
 */
export async function runReleaseSteps(opts?: { currentVersion?: string }): Promise<ReleaseStepsReport> {
  const to = opts?.currentVersion ?? getCurrentVersion();
  const from = readLastVersion();
  const owed = new Set(stepsInGap(RELEASE_STEPS, { from, to }).map((s) => s.id));
  const report: ReleaseStepsReport = { from, to, ran: [], skipped: [], failed: [] };

  for (const step of RELEASE_STEPS) {
    if (!owed.has(step.id)) { report.skipped.push(step.id); continue; }
    try {
      const outcome = await step.run();
      report.ran.push({ id: step.id, ...outcome });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.failed.push({ id: step.id, error });
      logger.warn('release step failed (non-fatal)', { step: step.id, error });
    }
  }

  if (report.ran.length > 0 || report.skipped.length === RELEASE_STEPS.length) recordVersion(to);
  logger.info('Release steps complete', {
    from, to, ran: report.ran, skipped: report.skipped, failed: report.failed,
  });
  return report;
}
