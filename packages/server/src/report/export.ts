// Unconnected-box export: the same sanitized brief as the issue body (one renderer, `issue-body.ts`) is
// written to a local file plus a prefilled new-issue link; the raw bundle is deliberately never read here.
// The cap binds the link, never the text: over it the link drops the attachment, then a pointer body that names nothing local,
// while `reportText` and the file stay whole (a silently truncated body would cut off the owner's words).

import { getReport } from './store.js';
import { writeReportFile } from './bundle.js';
import { issueLabelsFor, renderIssueBody, renderIssueTitle, reportVersion } from './issue-body.js';
import { reportRepo } from './repo.js';

/** Max ENCODED body length for a prefilled link: encoded is what the browser carries; it must fit ~8 KB. */
export const PREFILL_MAX_BODY_CHARS = 6000;

export interface ExportResult {
  filePath: string;
  newIssueUrl: string;
  bodyWasTrimmed: boolean;
  reportText: string;
}

function pointerBody(signature: string): string {
  return [
    'This report is too long to prefill into a link.',
    '',
    'Paste the full report here, replacing this text. The Copy report button in the Dojo copies it.',
    '',
    `Signature: ${signature}`,
  ].join('\n');
}

export function exportReport(id: string): ExportResult | null {
  const row = getReport(id);
  if (!row || !row.brief) return null;

  const markdown = renderIssueBody(row);
  const filePath = writeReportFile(id, 'report.md', markdown);

  const words = encodeURIComponent(markdown).length <= PREFILL_MAX_BODY_CHARS ? markdown : renderIssueBody(row, 0);
  const bodyWasTrimmed = encodeURIComponent(words).length > PREFILL_MAX_BODY_CHARS;
  const body = bodyWasTrimmed ? pointerBody(row.signature) : words;

  // `encodeURIComponent`, not `URLSearchParams` (it turns a space into `+` and a literal `+` into a space).
  // Labels come from `issueLabelsFor` as in `post.ts`; the comma between them stays unencoded.
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
    reportText: markdown,
  };
}
