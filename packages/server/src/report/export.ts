// ════════════════════════════════════════════════════════════════════════════════════════
// D2's OTHER HALF — AN UNCONNECTED BOX STILL GETS ITS REPORT OUT (DOJO-REPORT T6).
//
// Owner ruling D2: *"Connected GitHub → the agent posts the issue as the user. Not connected →
// the SAME brief as a local file plus a prefilled new-issue link for paste-and-post."* The
// load-bearing word is **same**: this is not a lesser path, it is the identical sanitized brief
// delivered by hand instead of by token.
//
// ── ONE RENDERER, NOT TWO — AND IT NOW LIVES IN `issue-body.ts` (T7) ──
// T6 built the renderer here and handed T7 the choice: delegate to it, or replace it and
// re-point this module. T7 took the second, which is what the plan's T7 instructs ("import
// `renderIssueBody`/`renderIssueTitle` instead of its own copy"). The file this module writes
// is now BYTE-IDENTICAL to the issue body the poster sends — same renderer, same call, no
// wrapper — and the clause that holds it compares the POSTED bytes against this file's bytes
// for the same row. A second renderer would be a second brief, and the owner only approved one.
//
// The TITLE rides the same way: the prefilled link carries `renderIssueTitle`, so a report
// pasted by hand arrives with the title, the label and the body the platform would have sent.
//
// ── WHAT IS DELIBERATELY ABSENT ──
// THE BUNDLE. D1: *"the raw bundle NEVER leaves the box in v1 by any automatic path."* This
// module's code names neither `readBundle` nor `bundlePath` — the first because the export has
// no business reading raw evidence, the second because `bundle_path` is a RECORDED STRING and
// not a resolvable path (contract C6). Two clauses in
// `__tests__/an-unconnected-box-still-gets-its-report-out.test.ts` hold that: one reads this
// file's code, the other seeds the bundle with a marker and searches the output.
//
// ALSO ABSENT: any approval door. `markExported` CONSUMES the owner's one approval (contract
// C3) and the single place that may spend it is the route behind the Post button. This module
// writes a file and builds a URL; it decides nothing.
//
// ── THE CAP BINDS THE LINK, NEVER THE FILE ──
// A prefilled `issues/new` URL is a GET, and a SILENTLY truncated body is the owner's own words
// cut off on a public page. So over the cap the link carries a short body naming the file and
// the signature, and the result says `bodyWasTrimmed` so the card can say "the full text is in
// the file — open it and paste". The file on disk is always whole.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getReport } from './store.js';
import { writeReportFile } from './bundle.js';
import { issueLabelsFor, renderIssueBody, renderIssueTitle, reportVersion } from './issue-body.js';
import { reportRepo } from './repo.js';

/**
 * How much ENCODED body a prefilled link may carry — encoded because that is what the browser
 * actually carries: an em dash is 1 character raw and 9 once encoded, so counting the raw string
 * would pass a URL six times over any real limit. Six thousand leaves headroom under the ~8 KB
 * every mainstream browser and proxy tolerates, with the title, the labels and the origin all
 * riding in the same URL.
 */
export const PREFILL_MAX_BODY_CHARS = 6000;

export interface ExportResult {
  /** The file on this box. `markExported` records this string in `export_path`. */
  filePath: string;
  /** A prefilled `issues/new` link the owner can open and post themselves. */
  newIssueUrl: string;
  /** True when the LINK carries a pointer instead of the brief. The file is whole either way. */
  bodyWasTrimmed: boolean;
}

/** The short body a link falls back to. Names where the real text is, and what to search for. */
function pointerBody(filePath: string, signature: string): string {
  return [
    'This report is too long to prefill into a link.',
    '',
    `The full text is in this file on the reporter's Mac:`,
    '',
    `    ${filePath}`,
    '',
    'Open it and paste it here.',
    '',
    `Signature: ${signature}`,
  ].join('\n');
}

/**
 * Write the brief to this box and build the paste-and-post link.
 *
 * Returns `null` when there is nothing to export — an unknown id, or a report with no brief.
 * Both are "there is nothing to paste", not failures to retry, and the caller renders them as
 * such rather than writing a stray file to prove it tried.
 */
export function exportReport(id: string): ExportResult | null {
  const row = getReport(id);
  if (!row || !row.brief) return null;

  const markdown = renderIssueBody(row);
  const filePath = writeReportFile(id, 'report.md', markdown);

  const encodedFull = encodeURIComponent(markdown);
  const bodyWasTrimmed = encodedFull.length > PREFILL_MAX_BODY_CHARS;
  const body = bodyWasTrimmed ? pointerBody(filePath, row.signature) : markdown;

  // Built with `encodeURIComponent`, NOT `URLSearchParams`: the latter writes form encoding, so
  // a space becomes `+` and a brief containing a literal `+` becomes a brief containing a space
  // on the public page. Percent-encoding round-trips both.
  // ── ONE LABEL SET, BOTH DOORS (final review, FR-6) ──
  // This used to be the literal `labels=dojo-report` while `post.ts` sent `issueLabelsFor(...)`,
  // so a hand-pasted report arrived without the version label a posted one carries and dropped
  // out of every version-filtered triage view. Same function, same row, same answer. The comma
  // is left UNENCODED between labels because that separator is GitHub's, not a value: each
  // label is encoded on its own.
  const labels = issueLabelsFor(reportVersion(row) ?? '').map(encodeURIComponent).join(',');
  const query = [
    `labels=${labels}`,
    `title=${encodeURIComponent(renderIssueTitle(row.brief))}`,
    `body=${encodeURIComponent(body)}`,
  ].join('&');
  return {
    filePath,
    newIssueUrl: `https://github.com/${reportRepo()}/issues/new?${query}`,
    bodyWasTrimmed,
  };
}
