// Where a report goes, declared once: the export link and the poster must name one repository.

export const DOJO_REPORT_REPO_DEFAULT = 'd-cornerpin/dojo';

const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** Env override for the dev box; a non-`owner/name` value falls back to the default (never throws). */
export function reportRepo(): string {
  const override = (process.env.DOJO_REPORT_REPO ?? '').trim();
  return REPO_SLUG.test(override) ? override : DOJO_REPORT_REPO_DEFAULT;
}

const sameRepo = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function reportRepoIsDefault(): boolean {
  return sameRepo(reportRepo(), DOJO_REPORT_REPO_DEFAULT);
}

// `DOJO_DEV_BOX=1` marks a box that must never file on the default repository. The flag is latched (read
// at load and on every call, it only ever closes), so no later environment write can lift the refusal.
let devBoxSeen = process.env.DOJO_DEV_BOX === '1';

function isDevBox(): boolean {
  if (process.env.DOJO_DEV_BOX === '1') devBoxSeen = true;
  return devBoxSeen;
}

export type RepoVerdict = { ok: true } | { ok: false; error: string };

/** The last gate before the wire: every door that writes to GitHub asks it, with its target repository. */
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
