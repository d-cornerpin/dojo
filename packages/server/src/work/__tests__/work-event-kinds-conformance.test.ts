// PHASE-4 T4-SCHEMA — THE THREE-WAY CONFORMANCE WALK for `work_events.kind`.
//
// THE DISEASE THIS FILE EXISTS TO KILL. Until this task there were three statements of
// "which kinds exist" and no mechanism that could notice they disagreed:
//
//   the DECLARED list  — migration `135:75`'s trailing comment, "12-value enum per 19 s1c"
//   the WRITTEN list   — 24 kinds, reachable from 29 call sites, `kind` typed `string`
//   the STORED list    — whatever had been written; 16 distinct values over 4,953 rows
//
// Twelve, twenty-four, sixteen. The comment was a transcription of a DESIGN DOCUMENT's
// enum (research `19-rebuild-map-lifts.md:33`) and nothing ever made it true of either the
// schema or the code. So the fix is not "one more value": it is that the three lists become
// ONE list with two derived copies, and that a change to any one of them without the others
// fails the build.
//
//   arm 1  DECLARED == CHECK      `work/event-kinds.ts` vs the LIVE CHECK-bearing migration
//                                 (`152` created it; `159` is the current carrier — the file
//                                 is derived, never named, see `liveCheckMigration` below)
//   arm 2  WRITERS  ⊆ DECLARED    every kind any writer can pass is on the list
//   arm 3  DECLARED \ WRITERS     exactly the declared-but-unwritten set, by name
//
// Arm 3 is the one that is easy to leave out and is the reason the other two cannot rot.
// It carried ONE exemption when T4-SCHEMA declared the list: `floor_ghosted`, declared for a
// named consumer and unwritten until PHASE-4 T4's Step 2 landed the ghost path.
//
// ⚠ THAT EXEMPTION IS GONE, DELETED BY THE COMMIT THAT WROTE THE FIRST ROW (PHASE-4 T4,
// 2026-08-02) — which is exactly what T4-SCHEMA's hand-forward said would happen, and the
// reason it was pinned by NAME rather than tolerated as "some kinds have no writer yet". The
// list is EMPTY now, and it staying empty is the standing property: a declared value with no
// writer is a QUESTION (non-negotiable #15 applied to a list), and the arm fails in BOTH
// directions — a new orphan, or a stale exemption for a kind that has since grown a writer.
//
// The walk reads source with fs.readFileSync rather than grep, for the reason
// `single-writer-conformance.test.ts` records: two of this tree's largest files carry NUL
// bytes and grep skips them silently. Comments are blanked first — `store.ts`'s own docblock
// contains the words "transition + appendEvent" and a walk that counted prose as a call site
// would be measuring the documentation.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WORK_EVENT_KINDS, type WorkEventKind } from '../event-kinds.js';

const SRC = path.join(__dirname, '..', '..');

/**
 * The migration that carries the LIVE `CHECK (kind IN (…))` — DERIVED, not named.
 *
 * This was pinned to `152_work_event_kinds_check.sql`, the file that first created the CHECK.
 * UX-REPAIR ROUND 6 T25 added `owed_interrupt` at `159`, which rebuilds the table with a new
 * CHECK — and a gate pinned to the FIRST statement of a rule reads a superseded one for ever
 * after, which is the same "declared list and real list drift apart" disease this whole file
 * exists to refuse. The chain applies in filename order, so the LAST file carrying the CHECK
 * is the one the database actually ends up with, and that is the one diffed here.
 */
function liveCheckMigration(): string {
  const dir = path.join(SRC, 'db', 'migrations');
  const carriers = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => /CHECK\s*\(\s*kind\s+IN\s*\(/i.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort();
  if (carriers.length === 0) throw new Error('no migration carries a `CHECK (kind IN (…))`');
  return path.join(dir, carriers[carriers.length - 1]);
}

const MIGRATION = liveCheckMigration();

/** DECLARED-BUT-UNWRITTEN, by name. EMPTY since PHASE-4 T4 landed `floor_ghosted`'s writer
 *  (`agent/v2/floor-ghost.ts`). It is kept as a list rather than deleted because the arm's
 *  value is the EXACT equality: an empty list is the assertion that every declared kind has a
 *  real writer, and the next person who declares one without a consumer meets this test. */
// v3.5 (orchestrator ruling, fix round 1): `continued` and `stalled` were declared in migration 200b
// so the release rebuilds work_events ONCE; Task D1 landed their writer (`work/job-momentum.ts`) and
// deleted them here, exactly as `floor_ghosted`'s writer did.
// The one path to done (901) left these with no writer: old rows still carry them, and 2f drops them.
const DECLARED_WITHOUT_WRITER: readonly WorkEventKind[] = [
  'claim_rejected', 'claim_upheld', 'override_request', 'override_resolved',
  'user_verdict_cleared', 'user_verdict_requested', 'validation_requested',
  'person_told', 'poke', 'poke_remediation',
];

// ── the source walk ────────────────────────────────────────────────────────────────────

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

// ── THE TREE IS READ ONCE, IN A HOOK — NOT ONCE PER CASE ───────────────────────────────
//
// MEASURED, on an IDLE box, before this cache existed: four of the twelve cases took
// 2441ms, 2381ms, 2201ms and 2157ms — each of them already about half of vitest's 5000ms
// per-case budget. Under a full-suite run (20 workers saturating the cores) that margin is
// gone, and the file failed 1-2 cases per run, a DIFFERENT case each time, while passing
// 12/12 when run alone. That is the signature of a case budget spent on shared setup, not
// of a flaky assertion.
//
// WHERE THE TIME WENT: nothing here is cached and the helpers call each other. Every case
// re-walked all of `packages/server/src` (~540 files), and `writtenKinds()` then called
// `boundConstantValues()` PER CALL SITE — each one re-reading the whole tree until it
// matched — plus a full `sourceFiles().map(read)` join for every member-access expression.
// One case therefore did thousands of readFileSync calls to answer a question about files
// that cannot change while the run is in progress.
//
// THE FIX IS A CACHE, NOT A TIMEOUT. Every helper below is a pure function of a tree that
// is immutable for the lifetime of the process, so each is memoised, and `beforeAll` pays
// the whole bill once, off the per-case budget. No assertion, no walk and no planted fault
// changed: the cases still ask exactly what they asked, they just stop re-deriving the
// answer twelve times. (A bare `testTimeout` bump was the alternative and is refused — it
// would have left 2.4s of avoidable IO in every case and only moved the cliff.)
let fileListCache: string[] | null = null;
const sourceFiles = (): string[] => (fileListCache ??= walk(SRC).map(rel).sort());

const readCache = new Map<string, string>();
const read = (r: string): string => {
  let hit = readCache.get(r);
  if (hit === undefined) readCache.set(r, hit = fs.readFileSync(path.join(SRC, r), 'utf8'));
  return hit;
};

/** Blank comments, keeping length, so prose describing a call is never counted as one.
 *  Stays a PURE function of its argument — the SELF-TEST case feeds it synthetic strings. */
export const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/** …and the memoised form, for the tree walk only. */
const strippedCache = new Map<string, string>();
const stripped = (r: string): string => {
  let hit = strippedCache.get(r);
  if (hit === undefined) strippedCache.set(r, hit = stripComments(read(r)));
  return hit;
};

/** Every source file, comments blanked, as ONE blob — built at most once. */
let joinedCache: string | null = null;
const strippedJoined = (): string => (joinedCache ??= sourceFiles().map(stripped).join('\n'));

/** The SECOND argument of every `appendEvent` / `appendWorkEvent` CALL, as written. Matched
 *  on the call shape rather than on a list of known kinds — a walk that looked for the kinds
 *  it already knew could never find the one that was added. */
const CALL_RE = /\bappend(?:Work)?Event\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,/g;

interface KindExpr { file: string; expr: string }

/** Every kind expression at every call site, plus the ONE declaration the same shape
 *  matches (`function appendEvent(workId: string, kind: WorkEventKind, …)`), separated by
 *  the type annotation only a parameter list can carry. */
let kindExpressionsCache: { calls: KindExpr[]; declarations: KindExpr[] } | null = null;
function kindExpressions(): { calls: KindExpr[]; declarations: KindExpr[] } {
  if (kindExpressionsCache) return kindExpressionsCache;
  const calls: KindExpr[] = [];
  const declarations: KindExpr[] = [];
  for (const f of sourceFiles()) {
    const src = stripped(f);
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(src))) {
      const expr = m[2];
      (expr.includes(':') ? declarations : calls).push({ file: f, expr });
    }
  }
  return (kindExpressionsCache = { calls, declarations });
}

/** A kind constant's declaration, and the values it binds. REQUIRES the `satisfies` clause:
 *  a constant that is not bound to `WorkEventKind` is a SECOND declaration of the list, which
 *  is the shape this task deleted. Returns null when the identifier has no bound declaration
 *  anywhere — which the arm below reports as a failure naming the identifier. */
const boundConstantCache = new Map<string, string[] | null>();
function boundConstantValues(identifier: string): string[] | null {
  const cached = boundConstantCache.get(identifier);
  if (cached !== undefined) return cached;
  const single = new RegExp(
    String.raw`\b${identifier}\s*=\s*'([a-z_]+)'\s*as const satisfies WorkEventKind\b`,
  );
  const object = new RegExp(
    String.raw`\b${identifier}\s*=\s*\{([\s\S]*?)\}\s*as const satisfies Record<string, WorkEventKind>`,
  );
  const remember = (v: string[] | null): string[] | null => {
    boundConstantCache.set(identifier, v);
    return v;
  };
  for (const f of sourceFiles()) {
    const src = stripped(f);
    const s = single.exec(src);
    if (s) return remember([s[1]]);
    const o = object.exec(src);
    if (o) return remember([...o[1].matchAll(/[A-Za-z]+\s*:\s*'([a-z_]+)'/g)].map((mm) => mm[1]));
  }
  return remember(null);
}

/** THE ENUMERATED WRITER SET: every kind any writer can pass, by either route. */
let writtenKindsCache: { kinds: Set<string>; unbound: string[] } | null = null;
function writtenKinds(): { kinds: Set<string>; unbound: string[] } {
  if (writtenKindsCache) return writtenKindsCache;
  const kinds = new Set<string>();
  const unbound: string[] = [];
  for (const { expr } of kindExpressions().calls) {
    const lit = /^'([a-z_]+)'$/.exec(expr);
    if (lit) { kinds.add(lit[1]); continue; }
    const root = expr.split('.')[0].trim();
    const values = boundConstantValues(root);
    if (values === null) { unbound.push(expr); continue; }
    if (expr.includes('.')) {
      // A member access takes only its own value, so an unused member of a bound object
      // does not count as written. `OCCURRENCE_EVENT.released` is one kind, not three.
      const member = expr.split('.')[1].trim();
      const pick = new RegExp(String.raw`\b${member}\s*:\s*'([a-z_]+)'`).exec(strippedJoined());
      if (pick) kinds.add(pick[1]); else unbound.push(expr);
    } else {
      for (const v of values) kinds.add(v);
    }
  }
  return (writtenKindsCache = { kinds, unbound });
}

/** The CHECK's own list, read out of the migration file. */
function checkListedKinds(): string[] {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const m = /CHECK\s*\(\s*kind\s+IN\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
  if (!m) throw new Error(`${path.basename(MIGRATION)} does not contain a \`CHECK (kind IN (…))\``);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

// Pay for the walk HERE, where it is charged to the hook and not to whichever case happened
// to ask first. After this every helper above is a map lookup.
beforeAll(() => {
  kindExpressions();
  writtenKinds();
  strippedJoined();
});

// ── the three arms ─────────────────────────────────────────────────────────────────────

describe('ARM 1 — the DECLARED list and the CHECK are the same list', () => {
  it('the live CHECK admits exactly WORK_EVENT_KINDS, in both directions', () => {
    expect(sorted(checkListedKinds())).toEqual(sorted(WORK_EVENT_KINDS));
  });

  it('the CHECK lists each kind once — a duplicate would hide a missing one from a count', () => {
    const listed = checkListedKinds();
    expect(listed.length).toBe(new Set(listed).size);
    expect(listed.length).toBe(WORK_EVENT_KINDS.length);
  });

  it('PLANTED FAULT: a CHECK that drops a kind, or carries an extra one, is caught', () => {
    const parse = (sql: string): string[] => {
      const m = /CHECK\s*\(\s*kind\s+IN\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
      return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
    };
    expect(sorted(parse("CHECK (kind IN ('opened','transition'))")))
      .not.toEqual(sorted(WORK_EVENT_KINDS));
    expect(sorted(parse(`CHECK (kind IN (${WORK_EVENT_KINDS.map((k) => `'${k}'`).join(',')},'sneaked_in'))`)))
      .not.toEqual(sorted(WORK_EVENT_KINDS));
    // ...and the parser really does read the real file's list, so the two above are not
    // passing because the parser returns nothing.
    expect(sorted(parse(fs.readFileSync(MIGRATION, 'utf8')))).toEqual(sorted(WORK_EVENT_KINDS));
  });
});

describe('ARM 3 — the DECLARED list carries no unexplained value', () => {

  it('`floor_ghosted` HAS a writer now, and the exemption that named it is deleted', () => {
    // T4-SCHEMA's hand-forward, discharged: the commit that writes the first `floor_ghosted`
    // row deletes the exemption, or this test goes red. Both halves are asserted here so the
    // discharge is a fact rather than a claim in a report.
    expect(DECLARED_WITHOUT_WRITER).not.toContain('floor_ghosted');
  });
});

describe('the list itself', () => {
  it('is sorted, unique, and 34 values — the CHECK is diffed against it by humans', () => {
    expect([...WORK_EVENT_KINDS]).toEqual(sorted(WORK_EVENT_KINDS));
    expect(new Set(WORK_EVENT_KINDS).size).toBe(WORK_EVENT_KINDS.length);
    expect(WORK_EVENT_KINDS.length).toBe(34);
  });
});
