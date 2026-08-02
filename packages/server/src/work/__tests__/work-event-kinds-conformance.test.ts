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
//   arm 1  DECLARED == CHECK      `work/event-kinds.ts` vs migration `152`'s `kind IN (…)`
//   arm 2  WRITERS  ⊆ DECLARED    every kind any writer can pass is on the list
//   arm 3  DECLARED \ WRITERS     exactly the declared-but-unwritten set, by name
//
// Arm 3 is the one that is easy to leave out and is the reason the other two cannot rot.
// `floor_ghosted` is declared here and has no writer yet — PHASE-4 T4's Step 2 writes its
// first row. That is a real state of affairs and it is recorded EXACTLY, so a SECOND
// orphaned kind (the shape a half-finished feature leaves behind) fails this test rather
// than joining a growing pile nobody counts. Non-negotiable #15's discipline applied to a
// list: a declared value with no writer is a QUESTION, and the answer is written down.
//
// The walk reads source with fs.readFileSync rather than grep, for the reason
// `single-writer-conformance.test.ts` records: two of this tree's largest files carry NUL
// bytes and grep skips them silently. Comments are blanked first — `store.ts`'s own docblock
// contains the words "transition + appendEvent" and a walk that counted prose as a call site
// would be measuring the documentation.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WORK_EVENT_KINDS, isWorkEventKind, type WorkEventKind } from '../event-kinds.js';

const SRC = path.join(__dirname, '..', '..');
const MIGRATION = path.join(SRC, 'db', 'migrations', '152_work_event_kinds_check.sql');

/** DECLARED-BUT-UNWRITTEN, by name and with its owner. Empties when T4 Step 2 lands the
 *  ghost path; until then this is the honest state, asserted rather than tolerated. */
const DECLARED_WITHOUT_WRITER: readonly WorkEventKind[] = ['floor_ghosted'];

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
const sourceFiles = (): string[] => walk(SRC).map(rel).sort();
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping length, so prose describing a call is never counted as one. */
export const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/** The SECOND argument of every `appendEvent` / `appendWorkEvent` CALL, as written. Matched
 *  on the call shape rather than on a list of known kinds — a walk that looked for the kinds
 *  it already knew could never find the one that was added. */
const CALL_RE = /\bappend(?:Work)?Event\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,/g;

interface KindExpr { file: string; expr: string }

/** Every kind expression at every call site, plus the ONE declaration the same shape
 *  matches (`function appendEvent(workId: string, kind: WorkEventKind, …)`), separated by
 *  the type annotation only a parameter list can carry. */
function kindExpressions(): { calls: KindExpr[]; declarations: KindExpr[] } {
  const calls: KindExpr[] = [];
  const declarations: KindExpr[] = [];
  for (const f of sourceFiles()) {
    const src = stripComments(read(f));
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(src))) {
      const expr = m[2];
      (expr.includes(':') ? declarations : calls).push({ file: f, expr });
    }
  }
  return { calls, declarations };
}

/** A kind constant's declaration, and the values it binds. REQUIRES the `satisfies` clause:
 *  a constant that is not bound to `WorkEventKind` is a SECOND declaration of the list, which
 *  is the shape this task deleted. Returns null when the identifier has no bound declaration
 *  anywhere — which the arm below reports as a failure naming the identifier. */
function boundConstantValues(identifier: string): string[] | null {
  const single = new RegExp(
    String.raw`\b${identifier}\s*=\s*'([a-z_]+)'\s*as const satisfies WorkEventKind\b`,
  );
  const object = new RegExp(
    String.raw`\b${identifier}\s*=\s*\{([\s\S]*?)\}\s*as const satisfies Record<string, WorkEventKind>`,
  );
  for (const f of sourceFiles()) {
    const src = stripComments(read(f));
    const s = single.exec(src);
    if (s) return [s[1]];
    const o = object.exec(src);
    if (o) return [...o[1].matchAll(/[A-Za-z]+\s*:\s*'([a-z_]+)'/g)].map((mm) => mm[1]);
  }
  return null;
}

/** THE ENUMERATED WRITER SET: every kind any writer can pass, by either route. */
function writtenKinds(): { kinds: Set<string>; unbound: string[] } {
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
      const src = sourceFiles().map(read).map(stripComments).join('\n');
      const pick = new RegExp(String.raw`\b${member}\s*:\s*'([a-z_]+)'`).exec(src);
      if (pick) kinds.add(pick[1]); else unbound.push(expr);
    } else {
      for (const v of values) kinds.add(v);
    }
  }
  return { kinds, unbound };
}

/** The CHECK's own list, read out of the migration file. */
function checkListedKinds(): string[] {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const m = /CHECK\s*\(\s*kind\s+IN\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
  if (!m) throw new Error('migration 152 does not contain a `CHECK (kind IN (…))`');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

// ── the three arms ─────────────────────────────────────────────────────────────────────

describe('ARM 1 — the DECLARED list and the CHECK are the same list', () => {
  it('migration 152 admits exactly WORK_EVENT_KINDS, in both directions', () => {
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

describe('ARM 2 — every kind a writer can pass is DECLARED', () => {
  it('no call site passes an undeclared kind, by either route', () => {
    const { kinds, unbound } = writtenKinds();
    expect(unbound).toEqual([]);
    expect(sorted([...kinds].filter((k) => !isWorkEventKind(k)))).toEqual([]);
  });

  it('the walk is not vacuous: it finds the real call sites and the real routes', () => {
    const { calls, declarations } = kindExpressions();
    // 29 call sites at dojo dc6da8b + the ONE declaration in store.ts. The counts are
    // reported rather than pinned — a new writer is legitimate; an UNDECLARED kind is not,
    // and that is arm 2's first clause. What is pinned is that the walk sees BOTH routes.
    expect(calls.length).toBeGreaterThanOrEqual(29);
    expect(declarations.map((d) => d.file)).toEqual(['work/store.ts']);
    const exprs = calls.map((c) => c.expr);
    expect(exprs).toContain("'transition'");            // the literal route
    expect(exprs).toContain('WORK_EVENT.activity');     // the bound-object route
    expect(exprs).toContain('AUDIT_KIND');              // the bound-single route
    expect(writtenKinds().kinds.size).toBe(24);
  });

  it('PLANTED FAULT: an undeclared literal at a call site is caught', () => {
    const src = stripComments("appendWorkEvent(workId, 'floor_teleported', 'engine', {});");
    CALL_RE.lastIndex = 0;
    const m = CALL_RE.exec(src);
    expect(m).not.toBeNull();
    const lit = /^'([a-z_]+)'$/.exec(m![2])!;
    expect(isWorkEventKind(lit[1])).toBe(false);
  });

  it('PLANTED FAULT: a kind constant with NO `satisfies` binding is caught', () => {
    // The shape a sixth constant object would have if somebody declared kinds beside the
    // list instead of onto it. `boundConstantValues` refuses to resolve it, and arm 2's
    // `unbound` list is asserted empty.
    expect(boundConstantValues('SOME_UNBOUND_KIND_CONST')).toBeNull();
    // ...while every constant the tree really uses DOES resolve, so the check above is not
    // passing merely because nothing ever resolves.
    expect(boundConstantValues('AUDIT_KIND')).toEqual(['audit']);
    expect(sorted(boundConstantValues('OCCURRENCE_EVENT')!))
      .toEqual(['occurrence_fired', 'occurrence_released', 'occurrence_settled']);
    expect(sorted(boundConstantValues('WORK_EVENT')!)).toEqual([
      'activity', 'revert_reset', 'user_verdict_cleared', 'user_verdict_requested',
      'validation_escalated',
    ]);
  });

  it('SELF-TEST: comment stripping does not hide a real call, or invent one', () => {
    // `store.ts`'s own docblock contains the words "transition + appendEvent". Two layers
    // keep it out of the count and BOTH are checked, because either alone would be luck:
    // the block comment is blanked whole...
    expect(stripComments("/** the pair\n *  ('transition + appendEvent'). No pair exists. */").trim()).toBe('');
    // ...and the prose does not match the call shape anyway (no `(` after the name).
    CALL_RE.lastIndex = 0;
    expect(CALL_RE.exec("('transition + appendEvent'). Re-derived: there is no pair.")).toBeNull();
    CALL_RE.lastIndex = 0;
    expect(CALL_RE.exec(stripComments("// appendWorkEvent(id, 'ghost_kind', a, {})"))).toBeNull();
    CALL_RE.lastIndex = 0;
    expect(CALL_RE.exec(stripComments("appendWorkEvent(id, 'opened', a, {})"))![2]).toBe("'opened'");
  });
});

describe('ARM 3 — the DECLARED list carries no unexplained value', () => {
  it('exactly the named kinds are declared without a writer', () => {
    const written = writtenKinds().kinds;
    const orphans = WORK_EVENT_KINDS.filter((k) => !written.has(k));
    // Exact equality in BOTH directions: a NEW declared-but-unwritten kind fails here, and
    // so does a stale exemption for a kind that has since grown a writer.
    expect(sorted(orphans)).toEqual(sorted(DECLARED_WITHOUT_WRITER));
  });

  it('`floor_ghosted` is the only one, and it is declared for a named consumer', () => {
    expect(DECLARED_WITHOUT_WRITER).toEqual(['floor_ghosted']);
    expect(isWorkEventKind('floor_ghosted')).toBe(true);
    // PHASE-4 T4 Step 2 is the owner. When it lands, this list empties and the arm above
    // starts failing until the exemption is removed — which is the point of pinning it.
    expect(writtenKinds().kinds.has('floor_ghosted')).toBe(false);
  });
});

describe('the list itself', () => {
  it('is sorted, unique, and 25 values — the CHECK is diffed against it by humans', () => {
    expect([...WORK_EVENT_KINDS]).toEqual(sorted(WORK_EVENT_KINDS));
    expect(new Set(WORK_EVENT_KINDS).size).toBe(WORK_EVENT_KINDS.length);
    expect(WORK_EVENT_KINDS.length).toBe(25);
  });

  it('`isWorkEventKind` answers for every member and refuses a near-miss', () => {
    for (const k of WORK_EVENT_KINDS) expect(isWorkEventKind(k)).toBe(true);
    for (const k of ['', 'Opened', 'transitions', 'floor_ghost', 'observation']) {
      expect(isWorkEventKind(k)).toBe(false);
    }
  });
});
