// ════════════════════════════════════════════════════════════════════════════════════════
// NO BARE STRING DATE PARSE IN THE DASHBOARD — the census, UX-REPAIR T9 step 3.
//
// WHY A CENSUS AND NOT ANOTHER UNIT TEST. The owner reported one symptom ("next run time isn't
// matching") and the cause was a FAMILY: the server serves datetimes as Z-LESS UTC TEXT
// (`msToText`, `work/tracker-view.ts:189` — `strftime('%Y-%m-%d %H:%M:%S', col/1000,
// 'unixepoch')`), `new Date()` reads a zone-less string as LOCAL, and the dashboard had ~24
// string-fed `new Date(...)` sites of mixed correctness. Four of them had independently
// hand-rolled the same `+'Z'` repair, which is the signature of a rule nothing enforces. Fixing
// the kanban card fixes an instance; this file removes the class's ability to come back.
//
// The dashboard owns the sanctioned parser — `parseUtc` in `dashboard/src/lib/dates.ts`, whose
// header documents this exact trap. Nothing required its use. Now something does: a string-fed
// `new Date(...)` anywhere under `packages/dashboard/src` fails this test unless it is one of the
// two argued exemptions below.
//
// WHAT PASSES WITHOUT ARGUMENT, and why each is safe:
//   · `new Date()` — no argument, reads the clock. No parsing, no zone question.
//   · `new Date(<epoch ms>)` — a number is an unambiguous instant. Covers `Date.now()`-rooted
//     arithmetic, numeric literals, and the repo's `…Ms` naming convention for epoch columns
//     (`next_run_at_ms`, `startedAtMs`).
// Everything else is a string parse and must go through `parseUtc` or a formatter built on it.
//
// WHY THIS LIVES IN THE SERVER PACKAGE. `npm test` runs `vitest` in packages/server only — the
// dashboard package has no test runner, and wiring one means editing root/dashboard package.json,
// outside T9's fence. The precedent is `marker-ownership.test.ts:25`, whose ROOTS already include
// `dashboard/src`: cross-package source guards live here so that they RUN. A guard the suite does
// not run is a sentence in a report, not a guard.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DASHBOARD_SRC = join(__dirname, '..', '..', '..', 'dashboard', 'src');

/**
 * THE ARGUED ALLOWLIST. Keyed on file AND on the exact argument expression, so an allowlisted
 * FILE does not become a free pass — a new bare parse inside `dates.ts` still fails.
 *
 * Every entry states why parsing that value as UTC would be WRONG. "It happens to be ISO today"
 * is NOT a reason to be here: a value that is already Z-suffixed passes through `parseUtc`
 * unchanged, so those sites route through the helper like everything else.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; arg: string; why: string }> = [
  {
    file: 'lib/dates.ts',
    arg: 'dateStr',
    why: 'parseUtc itself: the branch for a string that ALREADY carries Z or a numeric offset. '
      + 'This is the authority the rest of the dashboard is required to call.',
  },
  {
    file: 'lib/dates.ts',
    arg: "dateStr + 'Z'",
    why: 'parseUtc itself: the branch that appends the missing UTC marker. This single line is '
      + 'the repair that four call sites used to hand-roll.',
  },
  {
    file: 'components/TaskScheduleForm.tsx',
    arg: 'e.target.value',
    why: "a <input type='datetime-local'> value is LOCAL wall-clock time by HTML spec "
      + '("YYYY-MM-DDTHH:MM", deliberately zone-less). It is what the PERSON typed in their own '
      + 'zone, not a server instant. Parsing it as UTC would be the bug; `new Date()` local '
      + 'parsing is correct here, and `.toISOString()` on the next line converts it for storage.',
  },
];

/** Source files to scan: everything the dashboard actually ships. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  arg: string;
  text: string;
}

/**
 * Extract the argument expression of every `new Date(` in `src` by scanning to its matching
 * close paren (so nested calls and arithmetic survive intact). String literals and template
 * literals are skipped over so a paren inside one cannot desynchronise the depth count.
 */
function findNewDateSites(file: string, src: string): Site[] {
  const sites: Site[] = [];
  const needle = 'new Date(';
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    // Skip matches inside a line comment — those are prose, not code (dates.ts's header
    // explains the trap by naming `new Date()`).
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const before = src.slice(lineStart, i);
    if (before.includes('//') || before.trimStart().startsWith('*')) continue;

    let depth = 1;
    let j = i + needle.length;
    let quote: string | null = null;
    for (; j < src.length && depth > 0; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const arg = src.slice(i + needle.length, j - 1).trim();
    sites.push({
      file,
      line: src.slice(0, i).split('\n').length,
      arg,
      text: src.slice(lineStart, src.indexOf('\n', i) === -1 ? undefined : src.indexOf('\n', i)).trim(),
    });
  }
  return sites;
}

/**
 * A numeric argument is an unambiguous instant and needs no parser. Deliberately narrow: an
 * unrecognised expression is treated as a string parse and must be justified, not waved through.
 */
function isNumericArg(arg: string): boolean {
  if (arg === '') return true;                      // new Date() — reads the clock
  if (/^[\d_]+$/.test(arg)) return true;            // numeric literal
  if (/^Date\.now\(\)/.test(arg)) return true;      // Date.now() and arithmetic rooted in it
  if (/^Number\(/.test(arg)) return true;           // explicit numeric coercion
  if (/Ms$/.test(arg)) return true;                 // repo convention: `…Ms` is epoch millis
  return false;
}

const FILES = walk(DASHBOARD_SRC);
const ALL_SITES = FILES.flatMap((f) =>
  findNewDateSites(relative(DASHBOARD_SRC, f).split(sep).join('/'), readFileSync(f, 'utf8')),
);

describe('T9 census — the dashboard never parses a server datetime by hand', () => {
  it('scans a non-trivial dashboard tree (the census is actually looking at something)', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(ALL_SITES.length).toBeGreaterThan(10);
  });

  it('has no string-fed `new Date(...)` outside the argued allowlist', () => {
    const offenders = ALL_SITES
      .filter((s) => !isNumericArg(s.arg))
      .filter((s) => !ALLOWLIST.some((a) => a.file === s.file && a.arg === s.arg));

    const detail = offenders
      .map((s) => `  ${s.file}:${s.line}  new Date(${s.arg})\n      ${s.text}`)
      .join('\n');

    expect(
      offenders,
      offenders.length === 0 ? '' :
        `${offenders.length} bare string date parse(s) in packages/dashboard/src.\n\n${detail}\n\n`
        + 'The server serves datetimes as Z-LESS UTC TEXT (msToText, work/tracker-view.ts:189); '
        + '`new Date()` reads a zone-less string as LOCAL time, which is how every kanban "Next:" '
        + 'line came out an offset wrong (UX-REPAIR T9).\n'
        + 'Route it through `parseUtc` — or a formatter built on it (`formatDate`, '
        + '`formatDateShort`, `formatTimeOnly`, `formatShortDateTime`, `formatTimeSince`, '
        + '`formatElapsed`, `formatRelative`) — in packages/dashboard/src/lib/dates.ts.\n'
        + 'A value that already carries Z passes through `parseUtc` unchanged, so "it is ISO '
        + 'today" is a reason to USE the helper, not to skip it.\n'
        + 'If the value is genuinely local wall-clock (a datetime-local input), add it to '
        + 'ALLOWLIST in this file with the argument that makes it local.',
    ).toEqual([]);
  });

  it('keeps every allowlist entry live — a stale exemption is deleted, not left lying around', () => {
    const unused = ALLOWLIST.filter(
      (a) => !ALL_SITES.some((s) => s.file === a.file && s.arg === a.arg),
    );
    expect(
      unused.map((a) => `${a.file}: new Date(${a.arg})`),
      'these allowlist entries no longer match any site — delete them',
    ).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    for (const a of ALLOWLIST) {
      expect(a.why.length, `${a.file} / ${a.arg}`).toBeGreaterThan(40);
    }
  });

  it('the sanctioned parser is where the allowlist says it is', () => {
    const dates = readFileSync(join(DASHBOARD_SRC, 'lib', 'dates.ts'), 'utf8');
    expect(dates).toContain('export function parseUtc');
    // The two exempted parses are parseUtc's own two branches and nothing else.
    const inDates = ALL_SITES.filter((s) => s.file === 'lib/dates.ts' && !isNumericArg(s.arg));
    expect(inDates.map((s) => s.arg).sort()).toEqual(["dateStr + 'Z'", 'dateStr'].sort());
  });
});

describe('T9 census — the tracker card reads its time through the shared helper', () => {
  it('TaskCard renders next-run and paused-until via lib/dates, not a local formatter', () => {
    const card = readFileSync(join(DASHBOARD_SRC, 'components', 'TaskCard.tsx'), 'utf8');
    expect(card).toMatch(/import \{[^}]*formatShortDateTime[^}]*\} from '\.\.\/lib\/dates'/);
    expect(card).toContain('formatShortDateTime(task.nextRunAt)');
    expect(card).toContain('formatShortDateTime(task.pausedUntil)');
    // The hand-rolled formatters that carried the defect are gone, not merely bypassed.
    expect(card).not.toContain('const formatNextRun');
    expect(card).not.toContain('const formatTimeSince');
  });

  it('the four hand-rolled `+Z` repairs are gone from their original sites', () => {
    const gone: Array<[string, RegExp]> = [
      ['components/ContactsPanel.tsx', /new Date\(iso \+ \(iso\.endsWith\('Z'\)/],
      ['components/ActiveJobsIndicator.tsx', /new Date\(startedAt\.replace\(' ', 'T'\) \+ 'Z'\)/],
      ['components/TaskCard.tsx', /dateStr\.includes\('Z'\) \|\| dateStr\.includes\('\+'\)/],
      ['components/TaskScheduleForm.tsx', /const utcStr = /],
    ];
    for (const [file, pattern] of gone) {
      const src = readFileSync(join(DASHBOARD_SRC, ...file.split('/')), 'utf8');
      expect(pattern.test(src), `${file} still hand-rolls the append-Z repair`).toBe(false);
    }
  });
});
