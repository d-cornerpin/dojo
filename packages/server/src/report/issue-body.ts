// One renderer for both doors (the poster in `post.ts`, the paste-by-hand export in `export.ts`), so they
// render the same bytes. Verbatim: nothing here escapes, wraps, trims or sanitizes the brief the owner read.
// The bundle is deliberately absent (no `bundlePath` or `readBundle`); the title is `renderIssueTitle`.
// `dojo-sig:` is the dedupe trailer `findIssueBySignature` matches on, so its shape must not drift.

import type { ReportBrief, ReportRow } from './store.js';
import { boundDocumentArrays } from './bounds.js';

/** The one bound on this path: GitHub's 65,536-char issue body, with no per-field caps. The brief is never
 *  trimmed (the owner approved it), so the attachment is bounded into the room left. A brief that alone
 *  does not fit is returned over-long and `post.ts` refuses before the network. */
export const GITHUB_ISSUE_BODY_MAX_CHARS = 65_536;

export const REPORT_ISSUE_LABELS = ['dojo-report'] as const;

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The version label is dropped when the version is not version-shaped (`<absent>`, `<unrecognised>`). */
export function issueLabelsFor(version: string): string[] {
  return VERSION_SHAPE.test(version)
    ? [...REPORT_ISSUE_LABELS, `v${version}`]
    : [...REPORT_ISSUE_LABELS];
}

/** The version the report is ABOUT (from the attachment at draft time), not the box's version at post
 *  time: a box that upgraded between draft and post must not label the report with the new version. */
export function reportVersion(row: ReportRow): string | null {
  const platform = (row.telemetry ?? {}).platform;
  if (typeof platform !== 'object' || platform === null) return null;
  const version = (platform as Record<string, unknown>).version;
  return typeof version === 'string' && VERSION_SHAPE.test(version) ? version : null;
}

/** The tag plus the brief's title folded onto one line (an issue title is single-line), 80 chars max. */
export function renderIssueTitle(brief: ReportBrief): string {
  const t = brief.title.replace(/\s+/g, ' ').trim();
  return `[dojo-report] ${t.length > 80 ? `${t.slice(0, 77)}...` : t}`;
}

const HEADINGS: ReadonlyArray<readonly [keyof ReportBrief, string]> = [
  ['whatHappened', 'What happened'],
  ['whatShouldHaveHappened', 'What should have happened'],
  ['whyItWentWrong', 'Why the agent thinks it went wrong'],
  ['fixIdeas', 'Fix ideas'],
];

/** The attachment JSON inside `room` chars: its arrays give way (target halves until it fits). */
function telemetryJsonWithin(telemetry: Record<string, unknown>, room: number): string {
  const full = JSON.stringify(telemetry, null, 2);
  if (full.length <= room) return full;
  const arrays = Object.keys(telemetry).filter((k) => Array.isArray(telemetry[k]));
  for (let target = Math.floor(room * 0.9); target > 0 && arrays.length > 0; target = Math.floor(target / 2)) {
    const per = Math.floor(target / arrays.length);
    const bounded = boundDocumentArrays(telemetry, Object.fromEntries(arrays.map((k) => [k, per])));
    const json = JSON.stringify({ publishedBounds: bounded.notes, ...bounded.doc }, null, 2);
    if (json.length <= room) return json;
  }
  return JSON.stringify({
    omitted: true,
    chars: full.length,
    note: 'the machine-built attachment did not fit GitHub\'s issue body; its whole copy is on '
      + 'the reporting machine under this report id',
  }, null, 2);
}

const ATTACHMENT_NOTE = [
  'Built by the platform from a fixed field whitelist. No conversation content, no',
  'file contents, no argument values — tool names, argument shapes and sizes,',
  'timings, token counts and settings only. Raw evidence stayed on the reporter\'s',
  'machine under this report id.',
];

/** The report as the world sees it ('' for a briefless row); `room` bounds the attachment, 0 leaves it off. */
export function renderIssueBody(row: ReportRow, room?: number): string {
  const brief = row.brief;
  if (!brief) return '';
  const version = reportVersion(row);
  const stamp = version === null ? 'Agent Dojo (version unknown)' : `Agent Dojo v${version}`;

  const parts = [
    `**Filed from ${stamp}** · lane: \`${row.lane}\` · report \`${row.id}\``,
    '',
    'Filed by a Dojo agent at its user\'s request, through the in-product report tool.',
    'The user read and approved this exact text before it was posted.',
    '',
  ];
  for (const [key, heading] of HEADINGS) parts.push(`## ${heading}`, '', brief[key], '');
  const tail = [
    '```',
    '',
    '</details>',
    '',
    '---',
    `dojo-sig: ${row.signature}`,
    `dojo-report-id: ${row.id}`,
    `dojo-version: ${version ?? 'unknown'}`,
    '',
  ];
  const head = [
    '## Technical attachment',
    '',
    ...ATTACHMENT_NOTE,
    '',
    '<details>',
    '<summary>telemetry</summary>',
    '',
    '```json',
  ];
  // The attachment room: the whole bound less every other character (a newline per joined element).
  const around = [...parts, ...head, ...tail].join('\n').length + 1;
  const json = telemetryJsonWithin((row.telemetry ?? {}) as Record<string, unknown>, room ?? GITHUB_ISSUE_BODY_MAX_CHARS - around);
  return [...parts, ...head, json, ...tail].join('\n');
}
