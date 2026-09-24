// ════════════════════════════════════════════════════════════════════════════════════════
// D2's OTHER HALF — AN UNCONNECTED BOX STILL GETS ITS REPORT OUT (DOJO-REPORT T6).
//
// Owner ruling D2: *"Connected GitHub → the agent posts the issue as the user. Not connected →
// the SAME brief as a local file plus a prefilled new-issue link for paste-and-post."* The
// load-bearing word is **same**: this is not a lesser path, it is the identical sanitized brief
// delivered by hand instead of by token.
//
// ── ONE RENDERER, NOT TWO ──
// `renderReportMarkdown` is the single place a report becomes text. The plan's rule is that the
// exported file and the posted issue body cannot drift, and the only way to hold that is for
// both to call one function. ⚠ T7 HAND-OFF: `renderIssueBody` must DELEGATE to this (or replace
// it and re-point this module). A second renderer is a second brief, and the owner only approved
// one of them.
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

import { getReport, type ReportBrief, type ReportRow } from './store.js';
import { writeReportFile } from './bundle.js';
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

const HEADINGS: ReadonlyArray<readonly [keyof ReportBrief, string]> = [
  ['whatHappened', 'What happened'],
  ['whatShouldHaveHappened', 'What should have happened'],
  ['whyItWentWrong', 'Why it went wrong'],
  ['fixIdeas', 'Fix ideas'],
];

/**
 * A report as markdown: the five brief fields VERBATIM, then the machine-built attachment.
 *
 * Verbatim is the whole contract. D4 says the user sees the exact text before anything posts, so
 * nothing here escapes, wraps, trims or re-flows what the owner read on the card — a renderer
 * that "helped" would publish something the owner never approved. The text sits between blank
 * lines rather than inside a fence for the same reason: a fence must escape a brief holding one.
 */
export function renderReportMarkdown(row: ReportRow): string {
  const brief = row.brief;
  if (!brief) return '';
  const parts = [`# ${brief.title}`, ''];
  for (const [key, heading] of HEADINGS) {
    parts.push(`## ${heading}`, '', brief[key], '');
  }
  parts.push(
    '## Technical attachment',
    '',
    'Built by the platform from a fixed field whitelist. No conversation content, no file',
    'contents, no names — and nothing the agent wrote reaches it.',
    '',
    '```json',
    JSON.stringify(row.telemetry ?? {}, null, 2),
    '```',
    '',
    `<!-- dojo-report ${row.signature} -->`,
    '',
  );
  return parts.join('\n');
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

  const markdown = renderReportMarkdown(row);
  const filePath = writeReportFile(id, 'report.md', markdown);

  const encodedFull = encodeURIComponent(markdown);
  const bodyWasTrimmed = encodedFull.length > PREFILL_MAX_BODY_CHARS;
  const body = bodyWasTrimmed ? pointerBody(filePath, row.signature) : markdown;

  // Built with `encodeURIComponent`, NOT `URLSearchParams`: the latter writes form encoding, so
  // a space becomes `+` and a brief containing a literal `+` becomes a brief containing a space
  // on the public page. Percent-encoding round-trips both.
  const query = [
    'labels=dojo-report',
    `title=${encodeURIComponent(row.brief.title)}`,
    `body=${encodeURIComponent(body)}`,
  ].join('&');
  return {
    filePath,
    newIssueUrl: `https://github.com/${reportRepo()}/issues/new?${query}`,
    bodyWasTrimmed,
  };
}
