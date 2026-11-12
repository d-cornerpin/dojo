// Sends an already-approved report and decides nothing: it never calls `approveOnce` (the Post route does),
// and `markPosted` fires only from `approved`, so a duplicated request cannot mint a second issue.
// The signature search is a gate: a match is an offer (`duplicate-found`), never an action; a failed search
// returns `failed` rather than filing. The row changes only once GitHub accepts the report.

import { getReport, markPosted, type ReportRow } from './store.js';
import {
  GITHUB_ISSUE_BODY_MAX_CHARS, issueLabelsFor, renderIssueBody, renderIssueTitle, reportVersion,
} from './issue-body.js';
import { commentOnIssue, createIssue, findIssueBySignature, type IssueMatch } from '../github/issues.js';
import { reportRepo } from './repo.js';
import { createLogger } from '../logger.js';

const logger = createLogger('report-post');

export type PostChoice = { addToExisting: number } | { postSeparately: true };

export const DUPLICATE_ANSWER_HELP = 'The Post button sends either nothing, `{"addToExisting": '
  + '<issue number>}` or `{"postSeparately": true}` — the answers to “someone already reported '
  + 'this”.';

/** The owner's answer read off an HTTP body; `undefined` means not asked. Anything unrecognised is 'invalid'
 *  and REFUSED: a misread answer would put the owner's words on an issue they did not choose. */
export function parsePostChoice(body: unknown): PostChoice | undefined | 'invalid' {
  if (body === null || body === undefined) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) return 'invalid';
  const keys = Object.keys(body);
  if (keys.length === 0) return undefined;
  if (keys.length > 1) return 'invalid';
  const answer = body as { addToExisting?: unknown; postSeparately?: unknown };
  if (keys[0] === 'addToExisting') {
    const n = answer.addToExisting;
    return Number.isInteger(n) && (n as number) > 0 ? { addToExisting: n as number } : 'invalid';
  }
  if (keys[0] === 'postSeparately') {
    return answer.postSeparately === true ? { postSeparately: true } : 'invalid';
  }
  return 'invalid';
}

export type PostOutcome =
  // `labelsDropped` is null when the labels arrived, else a sentence (GitHub refused the labelled create,
  // or saved the issue without them). Null is not "measured and fine"; `github/issues.ts` logs the reason.
  | { kind: 'created'; issueUrl: string; issueNumber: number; labelsDropped: string | null }
  | { kind: 'commented'; issueUrl: string; issueNumber: number }
  | { kind: 'duplicate-found'; match: IssueMatch }
  | { kind: 'failed'; error: string };

const failed = (error: string): PostOutcome => ({ kind: 'failed', error });

const issueUrlFor = (repo: string, issueNumber: number): string =>
  `https://github.com/${repo}/issues/${issueNumber}`;

/** Record the delivery. A null means another door already delivered this row; it is logged, not swallowed,
 *  because the issue on GitHub is real. */
function record(row: ReportRow, url: string, issueNumber: number): void {
  if (markPosted(row.id, url, issueNumber) !== null) return;
  logger.error('report delivered twice: the row was already spent when the issue landed', {
    reportId: row.id, issueNumber, status: getReport(row.id)?.status ?? 'unknown',
  });
}

export async function postApprovedReport(id: string, choice?: PostChoice): Promise<PostOutcome> {
  const row = getReport(id);
  if (!row) return failed('No such report. It may have been cancelled, or this box may have been reset.');
  if (row.status !== 'approved') {
    return failed(`Only an approved report can be posted, and this one is ${row.status}. Nothing was sent.`);
  }
  const body = renderIssueBody(row);
  if (row.brief === null || body === '') return failed('This report has no text in it, so nothing was sent.');

  // Refuse an over-long brief before the network, naming the number and the fix, not a bare GitHub
  // 422. `renderIssueBody` bounds the attachment, so only the brief itself can overrun.
  if (body.length > GITHUB_ISSUE_BODY_MAX_CHARS) {
    return failed(
      `This report is too long to file: ${body.length} characters against GitHub's `
      + `${GITHUB_ISSUE_BODY_MAX_CHARS}-character limit for an issue body. Nothing was sent, and `
      + 'the report is untouched. Shorten the text on the card and post it again.',
    );
  }

  const repo = reportRepo();

  if (choice !== undefined && 'addToExisting' in choice) {
    const commented = await commentOnIssue(repo, choice.addToExisting, body);
    if (!commented.ok) return failed(commented.error);
    const url = issueUrlFor(repo, choice.addToExisting);
    record(row, url, choice.addToExisting);
    return { kind: 'commented', issueUrl: url, issueNumber: choice.addToExisting };
  }

  if (choice === undefined) {
    let match: IssueMatch | null;
    try {
      match = await findIssueBySignature(repo, row.signature);
    } catch (err) {
      // Must not fall through: a check that could not run stops here and never files a copy.
      return failed(err instanceof Error ? err.message : String(err));
    }
    if (match !== null) return { kind: 'duplicate-found', match };
  }

  const created = await createIssue(
    repo, renderIssueTitle(row.brief), body, issueLabelsFor(reportVersion(row) ?? ''),
  );
  if (!created.ok) return failed(created.error);
  // `record` runs before the label read-back (a 10-second HTTP call): a crash there would strand the
  // row `approved` with the issue already filed.
  record(row, created.url, created.number);
  const labelsDropped = created.labelsDropped ?? await measureLabelsAfterDelivery(created, row.id);
  if (labelsDropped !== null) {
    logger.warn('the report was filed without its labels', {
      reportId: row.id, issueNumber: created.number, detail: labelsDropped,
    });
  }
  return {
    kind: 'created', issueUrl: created.url, issueNumber: created.number, labelsDropped,
  };
}

/** The report has already landed and `record` spent the row, so no outcome here may become the owner's
 *  answer: an escape costs one warn line and a null sentence. */
async function measureLabelsAfterDelivery(
  created: { measureLabels: (() => Promise<string | null>) | null },
  reportId: string,
): Promise<string | null> {
  if (created.measureLabels === null) return null;
  try {
    return await created.measureLabels();
  } catch (err) {
    logger.warn('the label read-back threw after the report had already been filed', {
      reportId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
