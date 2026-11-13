// Per-release boot steps: a declared list of one-shot passes. A box owes a step when its last-run version
// predates the step's `sinceVersion` and the current version has reached it.
// Idempotence is the primary safety, the marker only an optimisation: a lost marker (restored backup) must
// not make a step do its work twice. The marker is its own key because `config.platform_version` is never written.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
// The tree's one version ordering (handles `X.Y.Z` and `X.Y.Z-preflight.N`).
import { compareVersions, getCurrentVersion, versionIsOrderable } from '../gateway/routes/update.js';

const logger = createLogger('release-steps');

export const RELEASE_STEPS_VERSION_KEY = 'release_steps_last_version';

export interface ReleaseStepOutcome {
  /** How many candidate rows were LOOKED AT. Mandatory: a pass with no denominator is not evidence. */
  examined: number;
  flagged: number;
  repaired: number;
}

export interface ReleaseStep {
  readonly id: string;
  /** The release at or after which a box may carry what this step looks for. */
  readonly sinceVersion: string;
  readonly pays: string;
  /** Must be idempotent. The runner catches a throw, but a step should not rely on that. */
  readonly run: () => Promise<ReleaseStepOutcome> | ReleaseStepOutcome;
}

/** The declared set. A new one-shot pass joins this list rather than the boot file. */
export const RELEASE_STEPS: readonly ReleaseStep[] = [
  {
    id: 'version-gap-reconcile',
    // `0.0.0` means any box that has ever run any version.
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
  {
    id: 'orphaned-ask-backlog',
    // Below every 3.5.0 prerelease (`-0` sorts lowest): any box last run on an older build owes it.
    sinceVersion: '3.5.0-0',
    pays:
      'since t93 (v3.3.0) every restart mid-turn stranded an owner or contact message `claimed`, and no build handed '
      + 'those back. The build that does would serve the whole backlog on its first boot. The PARKING happens in the '
      + "boot reconcile (index.ts 4b1, before any turn can run), keyed on this step being owed; this entry is that pass's "
      + 'marker and report, so it runs once per version boundary and a repeated boot finds nothing (proof-fix-f, review B2).',
    run: async () => {
      // Report only: a live turn's open row would read as dead. A throw leaves the step owed.
      const { completedInheritedBacklogPass } = await import('../work/inherited-backlog.js');
      const r = completedInheritedBacklogPass();
      if (r === null) throw new Error('the boot pass that parks inherited orphans did not complete on this boot; the step stays owed');
      return { examined: r.examined, flagged: r.parked, repaired: 0 };
    },
  },
  {
    id: 'built-in-tools',
    sinceVersion: '3.5.0-preflight.4',
    pays:
      'the Dreamer and PM keep the tool list they last held, so an upgraded box\'s built-in agents lacked tools their build lists. '
      + 'Adds every listed tool the owner neither denied nor removed in an audited edit.',
    run: async () => (await import('./built-in-tools.js')).deliverBuiltInTools(),
  },
];

/** Does this boot owe step `id`? An unorderable version answers owed, so not knowing holds work back. */
export function releaseStepOwed(id: string, currentVersion: string = getCurrentVersion()): boolean {
  const from = readLastVersion();
  if (!versionIsOrderable(currentVersion) || (from !== null && !versionIsOrderable(from))) return true;
  return stepsInGap(RELEASE_STEPS, { from, to: currentVersion }).some((s) => s.id === id);
}

/** Steps a box crossing `from` -> `to` owes; `from: null` (no history) owes all at or below `to`. */
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
    // Recording is an optimisation: every step is idempotent, so a failed record just reruns them.
    logger.warn('Could not record the release-steps version marker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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

  // A failed step stays owed: moving the marker past it would drop it for good.
  if (report.failed.length === 0 && (report.ran.length > 0 || report.skipped.length === RELEASE_STEPS.length)) recordVersion(to);
  logger.info('Release steps complete', {
    from, to, ran: report.ran, skipped: report.skipped, failed: report.failed,
  });
  return report;
}
