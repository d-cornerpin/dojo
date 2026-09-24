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
