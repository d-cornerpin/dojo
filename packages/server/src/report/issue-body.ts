// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE RENDERER — WHAT A REPORT LOOKS LIKE WHEN IT LEAVES THIS BOX (DOJO-REPORT T7).
//
// ── ONE RENDERER, BOTH DOORS ──
// A report leaves by exactly two doors: the poster (`report/post.ts` → a GitHub issue) and the
// export (`report/export.ts` → a file the owner pastes by hand, D2). They render the SAME
// BYTES, because this function is the only thing that can turn a report into text. T6 built the
// first version of it in `export.ts` and wrote the hand-off in that file's header; the plan's
// instruction here is the other half of it — `export.ts` now imports this, and a clause in
// `github/__tests__/a-matching-issue-gets-a-comment-not-a-duplicate.test.ts` compares the bytes
// POSTED to GitHub against the bytes of the file, for the same row. Two renderers would be two
// briefs, and the owner only ever approved one of them.
//
// ── VERBATIM IS THE WHOLE CONTRACT (D4) ──
// Nothing here escapes, wraps, trims, re-flows or sanitizes the brief. The owner read the exact
// text on the card before pressing Post; a renderer that "helped" would publish something they
// never approved. `<script>`, backticks, fences and trailing spaces all survive untouched, and
// a clause drives each of them. The brief's fields sit between blank lines rather than inside a
// fence for the same reason: a fence has to escape a brief that contains one.
//
// ── THE TRAILERS ARE THE DEDUPE, AND THEY ARE A CONVENTION, NOT DECORATION ──
// `dojo-sig:` is deliberately the same shape as the house's existing `behav-sig:` line in
// `DOJO-ISSUES-LOG.md`, so a triager reads one convention rather than two. It is also what
// `findIssueBySignature` matches on, which is why its shape is pinned by a regex in the suite:
// a trailer that drifts is a duplicate check that silently stops working and files a second
// issue for a defect somebody is already fixing.
//
// ── WHAT IS DELIBERATELY ABSENT ──
// THE BUNDLE, and the title. The bundle because D1 says the raw evidence never leaves the box
// by any automatic path — this module names neither `bundlePath` (a RECORDED STRING, not a
// resolvable path: contract C6) nor `readBundle`, and a census reads this file's own source to
// keep it that way. The title because an issue carries its title in its own field: `export.ts`
// puts `renderIssueTitle` into the prefilled link's `title=` parameter, so a report pasted by
// hand arrives with the same title, the same label and the same body as one the platform posts.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { ReportBrief, ReportRow } from './store.js';

/** The label every report carries, whatever version filed it. */
export const REPORT_ISSUE_LABELS = ['dojo-report'] as const;

/** Semver as this build writes it, prerelease included. Anything else is not a version. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * `['dojo-report', 'v3.1.28']`.
 *
 * The version label is DROPPED when the version is not version-shaped. The telemetry's
 * `platform.version` can legitimately read `<absent>` or `<unrecognised>` (T1's two sentinels,
 * which mean different things and are never collapsed), and a GitHub label called
 * `v<unrecognised>` is this platform quoting its own plumbing onto a public tracker.
 */
export function issueLabelsFor(version: string): string[] {
  return VERSION_SHAPE.test(version)
    ? [...REPORT_ISSUE_LABELS, `v${version}`]
    : [...REPORT_ISSUE_LABELS];
}

/**
 * The version the report is ABOUT, read from the attachment the platform built at draft time —
 * not `getCurrentVersion()`, which is the version the box is running at POST time. A box that
 * upgraded between drafting and posting must not file a report against the new version: the
 * signature is version-keyed (T2), so the issue would carry a version the digest does not
 * describe, and the dedupe would stop matching the boxes that are still hitting the defect.
 *
 * Null means "this row cannot say", which is only reachable through a hand-edited database.
 */
export function reportVersion(row: ReportRow): string | null {
  const platform = (row.telemetry ?? {}).platform;
  if (typeof platform !== 'object' || platform === null) return null;
  const version = (platform as Record<string, unknown>).version;
  return typeof version === 'string' && VERSION_SHAPE.test(version) ? version : null;
}

/**
 * The issue title, PINNED by the plan: the tag, then the brief's title folded onto one line and
 * capped at 80 characters INCLUDING the ellipsis.
 *
 * The fold is not cosmetic — a GitHub issue title is a single line, so a newline in the owner's
 * title would either be swallowed silently or truncate the title at the break.
 */
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

/** What the attachment is, and what it is not — in front of the JSON, for a human reader. */
const ATTACHMENT_NOTE = [
  'Built by the platform from a fixed field whitelist. No conversation content, no',
  'file contents, no argument values — tool names, argument shapes and sizes,',
  'timings, token counts and settings only. Raw evidence stayed on the reporter\'s',
  'machine under this report id.',
];

/**
 * The report as the world sees it. An empty string for a row with no brief — there is nothing
 * to publish, and both doors treat that as "nothing to send" rather than as a failure to retry.
 */
export function renderIssueBody(row: ReportRow): string {
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
  parts.push(
    '## Technical attachment',
    '',
    ...ATTACHMENT_NOTE,
    '',
    '<details>',
    '<summary>telemetry</summary>',
    '',
    '```json',
    JSON.stringify(row.telemetry ?? {}, null, 2),
    '```',
    '',
    '</details>',
    '',
    '---',
    `dojo-sig: ${row.signature}`,
    `dojo-report-id: ${row.id}`,
    `dojo-version: ${version ?? 'unknown'}`,
    '',
  );
  return parts.join('\n');
}
