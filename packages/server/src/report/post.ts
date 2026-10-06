// ════════════════════════════════════════════════════════════════════════════════════════
// THE POSTER — IT SENDS, AND IT DECIDES NOTHING (DOJO-REPORT T7).
//
// ── IT NEVER APPROVES ANYTHING, AND THE NAME SAYS SO ──
// `postApprovedReport` takes an ALREADY-APPROVED row. It does not call `approveOnce`, it
// cannot reach it, and the only door that can is the route behind the owner's Post button
// (D4). What this module holds is the SECOND half of the one-shot: `markPosted` fires only
// from `approved`, so a duplicated request can never mint a second issue. That import is why
// this file is named on `ALLOWED_CONSENT_CALLERS` in
// `agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts`, and that one-line edit
// IS the review the census asks for.
//
// ── THE SEARCH IS A GATE, NOT A COURTESY ──
// Before anything is filed, the tracker is searched for the report's signature. A match is an
// OFFER, never an action: `duplicate-found` comes back, NOTHING is posted, and the card asks
// the owner whether to add to the existing thread or file separately. A platform that quietly
// commented on a stranger's issue would be publishing the owner's words somewhere they never
// agreed to — and a platform that filed a second copy because the check failed would turn one
// defect into nine threads. So a failed search RETURNS `failed`; it never falls through.
//
// ── WHAT HAPPENS TO THE ROW WHEN NOTHING IS DELIVERED ──
// Nothing. This module touches the row ONLY when GitHub has accepted the report — no cancel,
// no un-approve, no "mark it tried". The row is left exactly as it was found, in `approved`,
// and the ROUTE decides what that means for the owner (it hands the decision straight back, so
// a report can never strand in `approved` with nothing delivered — see `gateway/routes/
// reports.ts`). Keeping that policy out of here is deliberate: this module can be called
// twice, from anywhere, and still cannot lose a report.
//
// ── P3, AND WHY THERE IS NO RETRY HERE ──
// NO-DOOMED-DIALS P3: when a bound trips, fail honestly to the human and never silently
// re-dial. Every failure below ends the attempt and produces a sentence the card shows. The
// next attempt is a person pressing Post again, which is a fresh human act — not a retry.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getReport, markPosted, type ReportRow } from './store.js';
import {
  GITHUB_ISSUE_BODY_MAX_CHARS, issueLabelsFor, renderIssueBody, renderIssueTitle, reportVersion,
} from './issue-body.js';
import { commentOnIssue, createIssue, findIssueBySignature, type IssueMatch } from '../github/issues.js';
import { reportRepo } from './repo.js';
import { createLogger } from '../logger.js';

const logger = createLogger('report-post');

/** The owner's answer to "someone already reported this". Absent means they have not been asked. */
export type PostChoice = { addToExisting: number } | { postSeparately: true };

/** The only body the Post button ever sends, said in the sentence its door answers with. */
export const DUPLICATE_ANSWER_HELP = 'The Post button sends either nothing, `{"addToExisting": '
  + '<issue number>}` or `{"postSeparately": true}` — the answers to “someone already reported '
  + 'this”.';

/**
 * The owner's answer, read off an HTTP body. `undefined` is "they have not been asked" — the
 * ordinary Post press, which sends no body at all. Anything the door does not recognise comes
 * back as `'invalid'` and is REFUSED rather than ignored: a misread answer is the owner's words
 * landing on an issue they did not choose, which is the one mistake this question exists to
 * prevent. The check lives here, beside the type it produces, so the route cannot drift from it.
 */
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
  // `labelsDropped` is null when the labels arrived, and a SENTENCE when they did not — by
  // either of the two routes GitHub takes: it refuses the labelled create and accepts it bare
  // (T8), or it answers 201 and saves the issue without them, which is what it documents itself
  // as doing for an account without write access and what it did live on 2026-09-26 (T8 LIVE
  // D-B). Carried rather than swallowed because the delivery then differs from the one the owner
  // pressed Post for, in a way only a human with write access can act on. Null is never
  // "measured and fine": a read-back that could not be believed also answers null, and the
  // reason is logged in `github/issues.ts` rather than guessed at here.
  | { kind: 'created'; issueUrl: string; issueNumber: number; labelsDropped: string | null }
  | { kind: 'commented'; issueUrl: string; issueNumber: number }
  | { kind: 'duplicate-found'; match: IssueMatch }
  | { kind: 'failed'; error: string };

const failed = (error: string): PostOutcome => ({ kind: 'failed', error });

/** The canonical web address of an issue. The comment door is told a NUMBER, not a link. */
const issueUrlFor = (repo: string, issueNumber: number): string =>
  `https://github.com/${repo}/issues/${issueNumber}`;

/**
 * Record the delivery. A null here means another door delivered this row while the network
 * call was in flight — impossible through the route (the approval is minted before the send),
 * and logged rather than swallowed because the issue on GitHub is REAL: the owner must still
 * be given its address, and whoever reads the log needs to know the row points elsewhere.
 */
function record(row: ReportRow, url: string, issueNumber: number): void {
  if (markPosted(row.id, url, issueNumber) !== null) return;
  logger.error('report delivered twice: the row was already spent when the issue landed', {
    reportId: row.id, issueNumber, status: getReport(row.id)?.status ?? 'unknown',
  });
}

/**
 * Post an approved report, or say honestly why it did not go.
 *
 * `choice` is the owner's answer to a duplicate we already showed them. Absent, the search
 * runs and a match comes back as a question rather than an action.
 */
export async function postApprovedReport(id: string, choice?: PostChoice): Promise<PostOutcome> {
  const row = getReport(id);
  if (!row) return failed('No such report. It may have been cancelled, or this box may have been reset.');
  if (row.status !== 'approved') {
    return failed(`Only an approved report can be posted, and this one is ${row.status}. Nothing was sent.`);
  }
  const body = renderIssueBody(row);
  if (row.brief === null || body === '') return failed('This report has no text in it, so nothing was sent.');

  // ── THE ONE BOUND, CHECKED BEFORE THE NETWORK (OWNER RULING 2026-10-05 #13) ──
  // `renderIssueBody` spends the 65,536 characters on the brief first and bounds the
  // machine-built attachment into what is left, so the only way to be over here is a BRIEF
  // longer than the whole limit — reachable from the tool door, which caps no field. Refusing
  // here rather than letting GitHub answer 422: their refusal arrives as an opaque validation
  // error, and this one names the number, the overrun, and the thing the owner can actually do
  // about it. The dashboard edit door caps each field at 8,000, so an edited brief always fits.
  if (body.length > GITHUB_ISSUE_BODY_MAX_CHARS) {
    return failed(
      `This report is too long to file: ${body.length} characters against GitHub's `
      + `${GITHUB_ISSUE_BODY_MAX_CHARS}-character limit for an issue body. Nothing was sent, and `
      + 'the report is untouched. Shorten the text on the card and post it again.',
    );
  }

  const repo = reportRepo();

  // ── the owner chose an existing thread ──
  // No search: they were shown the match and answered. Searching again would be asking a
  // question that has been answered, and would let a second match change their answer.
  if (choice !== undefined && 'addToExisting' in choice) {
    const commented = await commentOnIssue(repo, choice.addToExisting, body);
    if (!commented.ok) return failed(commented.error);
    const url = issueUrlFor(repo, choice.addToExisting);
    record(row, url, choice.addToExisting);
    return { kind: 'commented', issueUrl: url, issueNumber: choice.addToExisting };
  }

  // ── the duplicate check ──
  if (choice === undefined) {
    let match: IssueMatch | null;
    try {
      match = await findIssueBySignature(repo, row.signature);
    } catch (err) {
      // THE BRANCH THAT MUST NOT FALL THROUGH. Every path out of here returns; none of them
      // continues to `createIssue`. A duplicate check that could not run is a reason to stop
      // and tell the owner, never a reason to file a second copy.
      return failed(err instanceof Error ? err.message : String(err));
    }
    if (match !== null) return { kind: 'duplicate-found', match };
  }

  const created = await createIssue(
    repo, renderIssueTitle(row.brief), body, issueLabelsFor(reportVersion(row) ?? ''),
  );
  if (!created.ok) return failed(created.error);
  // ── THE ROW IS MARKED BEFORE THE LABEL READ-BACK, AND THAT ORDER IS THE FIX (F5) ──
  // `record` is a local SQLite write; the read-back below is a 10-second authenticated HTTP call.
  // Measuring first put that round-trip between a live public issue and the row that records it,
  // on the happy path of every delivered report — and a crash in the window stranded the row as
  // `approved` with the issue already filed: refused forever by the one-shot approval, absent
  // from the open list, undecidable. `record` first; measure second.
  record(row, created.url, created.number);
  const labelsDropped = created.labelsDropped ?? await measureLabelsAfterDelivery(created, row.id);
  // THE LOG IS THE OTHER RECORD. The row has no column for it — a dropped label is a fact about
  // one delivery attempt, not about the report — so it is logged here beside the issue number
  // that proves the report actually landed, and handed to the route for the card.
  if (labelsDropped !== null) {
    logger.warn('the report was filed without its labels', {
      reportId: row.id, issueNumber: created.number, detail: labelsDropped,
    });
  }
  return {
    kind: 'created', issueUrl: created.url, issueNumber: created.number, labelsDropped,
  };
}

/**
 * THE LABEL MEASUREMENT, AND THE ONE TRY/CATCH THAT MAKES IT UNABLE TO TAKE THE DELIVERY BACK.
 *
 * The report HAS LANDED by the time this runs — the issue is public and `record` has already
 * spent the row. So every outcome here is a detail about one delivery attempt, and NO outcome
 * may become the owner's answer. `github/issues.ts` returns `null` for "not measured" on every
 * failure it anticipates; this catch is for the ones it does not, which is the whole point of
 * F6: the invariant used to rest on inspection of a single try/catch deep inside `createIssue`,
 * where an escape turned a live issue into a `failed` outcome AND wrote a connection failure to
 * the ledger. Now an escape costs one warn line and a `null` sentence, and the owner still gets
 * the address of their issue.
 */
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
