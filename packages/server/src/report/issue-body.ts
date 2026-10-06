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
import { boundDocumentArrays } from './bounds.js';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE BOUND ON THIS PATH — OWNER RULING 2026-10-05 #13, verbatim: one bound, GitHub's
 * 65,536-character issue body, and NO per-field caps.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── IT WAS REACHABLE, AND BY THE MACHINE'S OWN HALF OF THE DOCUMENT ──
 * `window.ts`'s row caps are the only size discipline the PUBLISHED attachment ever had, and a
 * row cap is not a size bound (that file says so itself). Measured on a window seeded to every
 * cap exactly — 20 turns, 60 calls, 200 tool calls, 25 work rows, each tool call carrying 24
 * `arg_shape` entries — `JSON.stringify(telemetry, null, 2)` renders 601,404 characters: 9.2x
 * GitHub's limit, before a single word of the brief. `bounds.ts` bounds the COPY the agent reads
 * and says in so many words that nothing published is bounded here. So an ordinary busy window
 * produced a body GitHub answers 422 to, and the owner saw a failed post with no account of why.
 *
 * ── WHICH HALF GIVES WAY, AND WHY IT IS NEVER THE BRIEF ──
 * The attachment is MACHINE-BUILT and its whole copy stays on the box under the report id
 * (`attachDraft` stores it before anything renders). The brief is the text the owner read and
 * approved before pressing Post — trimming that would publish something they never approved,
 * which is this module's verbatim contract (D4) and not a size decision. So the bound spends the
 * room on the brief first and bounds the ATTACHMENT into what is left, through the same
 * `boundDocumentArrays` the draft echo uses, with the drop said out loud in the body.
 *
 * ── AND WHEN THE BRIEF ALONE WILL NOT FIT ──
 * Nothing here may trim it, so this function returns the over-long body and `report/post.ts`
 * REFUSES before the network, naming this number. That is reachable only from the tool door,
 * which caps no field; the dashboard edit door caps each at 8,000 (`EditReportSchema`), so
 * 4 x 8,000 + headings + trailers always fits — which is why the refusal can honestly tell the
 * owner that editing the text is the fix.
 */
export const GITHUB_ISSUE_BODY_MAX_CHARS = 65_536;

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

/**
 * The attachment JSON, inside `room` characters.
 *
 * The arrays are the part that scales with the window, so they are what gives way; the fixed
 * members (`report`, `platform`, `window`, `settings`) are small and constant. The target
 * HALVES until the rendered block fits, which terminates and needs no second size model —
 * `boundDocumentArrays` already knows how to spend a per-section budget honestly and to write
 * the note that says what it dropped. The last resort records the size and nothing else,
 * because a body GitHub refuses carries no evidence at all.
 */
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
  // The room the attachment may have: the whole bound, less every character that is not it.
  // `join('\n')` adds one newline per element after the first, and the attachment is one
  // element, so the arithmetic is the joined length of everything else plus its own separator.
  const around = [...parts, ...head, ...tail].join('\n').length + 1;
  const json = telemetryJsonWithin((row.telemetry ?? {}) as Record<string, unknown>,
    GITHUB_ISSUE_BODY_MAX_CHARS - around);
  return [...parts, ...head, json, ...tail].join('\n');
}
