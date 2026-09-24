// ════════════════════════════════════════════════════════════════════════════════════════
// WHERE A REPORT GOES — ONE VALUE, DECLARED ONCE (DOJO-REPORT).
//
// ── WHY THIS IS ITS OWN MODULE, AND WHY IT EXISTS BEFORE THE POSTER DOES ──
// The plan pins this constant to T7, beside the issue-creating calls. It is built here, in T6,
// to its pinned name and signature, because T6's export fallback ALREADY needs it: D2's
// paste-and-post link is `https://github.com/<repo>/issues/new?…`, and it must name the same
// repository the poster will later post to. Two copies of a repository slug is precisely the
// drift the plan forbids between the two delivery paths — so T7 IMPORTS this, it does not
// declare its own.
//
// ── THE VALIDATION, AND WHY IT FALLS BACK RATHER THAN THROWS ──
// `DOJO_REPORT_REPO` is a dev-box escape hatch, read from the environment, and the thing it
// feeds is a URL. An unvalidated value here is a malformed link in front of an owner who is
// trying to report a problem — the worst possible moment to hand someone a broken page. So the
// override must be a literal `owner/name` pair of the characters GitHub actually allows, and
// anything else falls back to the default: a typo'd env var costs the dev box its override, and
// never costs an owner their report. It does not throw, because the failure would then surface
// at the end of a consent flow the owner has already completed.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The Dojo's own tracker — the same repository `gateway/routes/update.ts` reads releases from. */
export const DOJO_REPORT_REPO_DEFAULT = 'd-cornerpin/dojo';

/** GitHub's own owner/name alphabet. No slashes, no query, no path beyond the pair. */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The repository a report is filed against. Env override for the dev box, validated. */
export function reportRepo(): string {
  const override = (process.env.DOJO_REPORT_REPO ?? '').trim();
  return REPO_SLUG.test(override) ? override : DOJO_REPORT_REPO_DEFAULT;
}

/** GitHub treats `Owner/Name` and `owner/name` as one repository, so this must too. */
const sameRepo = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when nothing has redirected this box's reports somewhere else. */
export function reportRepoIsDefault(): boolean {
  return sameRepo(reportRepo(), DOJO_REPORT_REPO_DEFAULT);
}

// ── THE DEVELOPMENT BOX MAY NOT FILE ON THE REAL TRACKER ────────────────────────────────
//
// The owner's development machine runs this build constantly, with real reports in the
// database and a real GitHub connection. The whole feature's happy path ends in a PUBLIC
// issue on the Dojo's own tracker, so the difference between "T8's live proof" and "six
// fixture issues filed under the owner's name" is one environment variable. `DOJO_DEV_BOX=1`
// declares a box that must never file on the default repository; `DOJO_REPORT_REPO` is how
// such a box exercises the real path anyway, against a scratch repository of its own.
//
// ── WHY THE FLAG IS LATCHED RATHER THAN RE-READ ──
// A refusal that reads `process.env` at the moment of the call is a refusal any later write
// can lift — a test helper restoring a saved environment, a config loader, a `delete` in a
// `finally`. The flag is therefore read at module load AND re-read on every call, and the
// latch only ever CLOSES: once this process has seen the flag, nothing can clear it. That is
// the only shape whose safety does not depend on the order in which code happens to run.
let devBoxSeen = process.env.DOJO_DEV_BOX === '1';

function isDevBox(): boolean {
  if (process.env.DOJO_DEV_BOX === '1') devBoxSeen = true;
  return devBoxSeen;
}

export type RepoVerdict = { ok: true } | { ok: false; error: string };

/**
 * THE LAST GATE BEFORE THE WIRE. Every door that WRITES to GitHub asks this first, with the
 * repository it is about to write to — so the check cannot be separated from the send by any
 * amount of code, environment manipulation or time between them.
 *
 * It validates the slug as well as the box, because a caller that built a repository string
 * some other way must not be able to walk past the validation `reportRepo` performs.
 */
export function assertPostableRepo(repo: string): RepoVerdict {
  if (!REPO_SLUG.test(repo.trim())) {
    return { ok: false, error: `\`${repo}\` is not an owner/name repository, so nothing was sent.` };
  }
  if (isDevBox() && sameRepo(repo, DOJO_REPORT_REPO_DEFAULT)) {
    return { ok: false, error: 'This box is marked DOJO_DEV_BOX=1, so it will not file an issue '
      + `on ${DOJO_REPORT_REPO_DEFAULT}. Point DOJO_REPORT_REPO at a scratch repository to `
      + 'exercise the real path, or clear the flag on a box that is meant to report.' };
  }
  return { ok: true };
}
