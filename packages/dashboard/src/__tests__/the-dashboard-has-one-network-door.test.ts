// ════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD HAS ONE NETWORK DOOR, AND THIS IS THE CENSUS THAT KEEPS IT ONE.
//
// ── WHAT THIS IS FOR (BACKLOG line 31) ──
// Sixteen files under `src/` called the global `fetch` themselves. The cost was
// not style: a component whose network call is a bare `fetch` has NO SEAM, so a
// test that mounts it either reaches a live `:3001` — passing for a reason that
// is not the code — or trips the tripwire in `vitest.setup.ts`. That is why
// `every-major-page-mounts.test.tsx` had to replace the tripwire with a
// 503-answering stub for the whole suite, and why the credential-chip clause
// needed a `vi.stubGlobal` of its own to render a link.
//
// Both of those concessions are gone now, which is the behavioural half of the
// proof. This file is the SOURCE half, and the reason it exists is that the
// behavioural half cannot see a new offender in a component no page mounts.
//
// ── IT PARSES, IT DOES NOT MATCH TEXT. THE FIRST VERSION LEXED BY HAND AND WAS
//    BLIND IN 16 OF 121 FILES. ──
// That version stripped comments and string literals with a hand-written
// quote-tracking state machine. It had no notion of two shapes that are
// everywhere in a React package:
//
//   · an apostrophe in JSX TEXT — `It's used for lightweight tasks`
//     (`SetupDeps.tsx`), `aren't affected` (`Agents.tsx`);
//   · a REGEX LITERAL containing a quote — `/filename="?([^";]+)"?/`
//     (`TechniqueCard.tsx`), `/tell\s+application\s+"([^"]{1,40})"/i`
//     (`lib/tool-display.ts`).
//
// Either one opened a "string" that ran to the next quote character in the file,
// and from there the lexer was OUT OF PHASE: it kept string contents and blanked
// CODE — including any `fetch(` call — until another unbalanced quote flipped it
// back. Review measured the blind region at 67% of `TechniqueCard.tsx`, 35% of
// `SetupDeps.tsx`, 20% of `Agents.tsx`. A planted `fetch("/api/x")` was invisible
// in 16 files, among them `Setup.tsx`, `SetupDeps.tsx`, `Agents.tsx`, `Memory.tsx`
// and `TechniqueCard.tsx` — precisely the files most likely to grow a network
// call. The clause that was meant to make "one door" a PROPERTY was making it a
// snapshot.
//
// So the lexing is gone. `typescript` is already a dependency of this package, so
// each file is PARSED and the census counts `CallExpression` nodes whose callee is
// the identifier `fetch`. Comments, strings, template literals, JSX text and
// regex literals are then the compiler's problem, which is the only place that
// problem has ever been solved correctly. `fetch<T>(…)` is the same node, so the
// generic form needs no special case.
//
// ── AND IT PROVES ITS OWN COVERAGE, WHICH IS THE LESSON ──
// The hand lexer was mutation-tested — with ONE mutant, in ONE file, which
// happened to have no phase break. That is how a blind census passes a mutation
// test. So the last clause below plants a `fetch(` at the end of EVERY file this
// census guards, in memory, and requires that the detector sees all of them. A
// census that cannot see a planted call in a file it claims to guard is not a
// census, and now it says so about itself.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import ts from 'typescript';

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/**
 * The door itself — the ONE file allowed to call `fetch`.
 *
 * It is `lib/door.ts` and not `lib/api.ts`: the transport POLICY was pulled out
 * of that 2,400-line endpoint CATALOGUE into its own leaf file, which is the
 * direction `api.ts`'s size ratchet exists to push. `api.ts` re-exports all four
 * wrappers, so callers still import from `lib/api` and `vi.mock('../lib/api')`
 * is still the one seam that mocks the network.
 */
const DOOR = path.join('lib', 'door.ts');

/** The catalogue that re-exports the door, keeping `lib/api` the single seam. */
const CATALOGUE = path.join('lib', 'api.ts');

/**
 * The tripwire's own clause asserts that calling `fetch` THROWS. It has to call
 * the function to do that, and it is the assertion, not a network call.
 */
const ASSERTS_THE_TRIPWIRE = path.join('__tests__', 'the-dom-environment-provides-what-the-dashboard-uses.test.ts');

/** Every tracked source file under `src/`. */
function sourceFiles(dir: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...sourceFiles(full)); continue; }
    if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * ⚠ SCRIPT KIND BY EXTENSION, not `TSX` for everything. In a `.ts` file `<T>x` is
 * a type assertion and in a `.tsx` file it opens a JSX element; parsing a `.ts`
 * file as TSX mis-reads the former. Getting this wrong would be the same class of
 * bug as the hand lexer — a parser quietly in the wrong mode — so the sweep at the
 * bottom of this file is what proves the choice, for every file, rather than this
 * comment.
 */
const parse = (rel: string, src: string): ts.SourceFile =>
  ts.createSourceFile(
    rel, src, ts.ScriptTarget.Latest, true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** Walk every node, callback first. */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Calls of the GLOBAL `fetch`, as nodes.
 *
 * Both spellings that actually reach the network are counted: the bare
 * `fetch(…)`, and `globalThis`/`window`/`self`.`fetch(…)` — the second is not
 * pedantry, it is the obvious way around a clause that only knows the first.
 * A method named `fetch` on anything else (`client.fetch(x)`) is a different
 * function and is not counted, and neither is `refetch(…)`, which is a distinct
 * identifier as far as the parser is concerned. The first census of this defect
 * reported 19 files because a regex could not tell those apart; four of them were
 * `void refetch()`.
 */
function fetchCalls(rel: string, src: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(parse(rel, src), (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'fetch') { out.push(node); return; }
    if (
      ts.isPropertyAccessExpression(callee)
      && callee.name.text === 'fetch'
      && ts.isIdentifier(callee.expression)
      && ['globalThis', 'window', 'self'].includes(callee.expression.text)
    ) out.push(node);
  });
  return out;
}

/** Does any call in this file invoke `name` — bare, or as `api.name`? */
function callsFunction(rel: string, src: string, name: string): boolean {
  let found = false;
  walk(parse(rel, src), (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === name) { found = true; return; }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === name) found = true;
  });
  return found;
}

/** Names this file exports as `export const <name> =`. */
function exportedConsts(rel: string, src: string): Set<string> {
  const names = new Set<string>();
  walk(parse(rel, src), (node) => {
    if (!ts.isVariableStatement(node)) return;
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
    }
  });
  return names;
}

/** Names this file re-exports FROM `from` (`export { a, b } from './from'`). */
function reExportsFrom(rel: string, src: string, from: string): Set<string> {
  const names = new Set<string>();
  walk(parse(rel, src), (node) => {
    if (!ts.isExportDeclaration(node) || !node.moduleSpecifier) return;
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== from) return;
    const clause = node.exportClause;
    if (clause && ts.isNamedExports(clause)) {
      for (const el of clause.elements) names.add(el.name.text);
    }
  });
  return names;
}

const WRAPPERS = ['request', 'requestRaw', 'requestForm', 'fetchUrl'] as const;

const FILES = sourceFiles();
const RAW = new Map<string, string>(
  FILES.map((f) => [path.relative(SRC, f), fs.readFileSync(f, 'utf8')]),
);
const isTest = (rel: string): boolean => /\.test\.tsx?$/.test(rel) || rel.startsWith(`__tests__${path.sep}`);

describe('the dashboard calls fetch in exactly one place', () => {
  it('the census actually scanned this package', () => {
    // A scan that matched nothing would satisfy every clause below for the worst
    // possible reason.
    expect(FILES.length, 'the source walk found almost nothing — is SRC right?').toBeGreaterThan(100);
    expect(RAW.has(DOOR), 'lib/door.ts was not scanned').toBe(true);
    expect(RAW.has(CATALOGUE), 'lib/api.ts was not scanned').toBe(true);
  });

  it('⚠ no file outside lib/door.ts calls the global fetch', () => {
    const offenders: string[] = [];
    for (const [rel, src] of RAW) {
      if (rel === DOOR || rel === ASSERTS_THE_TRIPWIRE) continue;
      if (fetchCalls(rel, src).length > 0) offenders.push(rel);
    }
    // The message is the fix, because whoever reds this will be the person who
    // just added the call.
    expect(
      offenders.sort(),
      'these call the global `fetch` directly, which leaves them with no door a test can mock — '
      + 'use `request` / `requestRaw` / `requestForm` / `fetchUrl` from `lib/api` instead',
    ).toEqual([]);
  });

  it('⚠ the door has exactly ONE fetch call, and it is inside `throughTheDoor`', () => {
    const src = RAW.get(DOOR)!;
    const calls = fetchCalls(DOOR, src);
    // One, not "at least one": the point of the door is that there is a single
    // place where auth headers, the CSRF token, the 401 bounce and the
    // never-throw contract are applied. A second call site is a second policy.
    expect(calls.length, 'lib/door.ts should call fetch once — in `throughTheDoor`').toBe(1);

    // And it is in the function that carries the contract, not merely somewhere in
    // the file. A `fetch` in some other helper here would be one call site by
    // count and a second door by behaviour.
    let span: { start: number; end: number } | null = null;
    walk(parse(DOOR, src), (node) => {
      if (!ts.isVariableDeclaration(node)) return;
      if (ts.isIdentifier(node.name) && node.name.text === 'throughTheDoor') {
        span = { start: node.getStart(), end: node.getEnd() };
      }
    });
    expect(span, 'lib/door.ts no longer defines `throughTheDoor`').not.toBeNull();
    const only = calls[0];
    expect(only.getStart() > span!.start && only.getEnd() < span!.end,
      'the single fetch call is no longer inside `throughTheDoor`').toBe(true);
  });

  it('⚠ lib/api.ts re-exports the door, so `lib/api` stays the one seam', () => {
    // A door with one call site but a SPLIT SEAM would pass every clause above:
    // callers importing `lib/door` directly would need their own `vi.mock`, and
    // mocking `lib/api` would stop mocking the network.
    const reExported = reExportsFrom(CATALOGUE, RAW.get(CATALOGUE)!, './door');
    for (const wrapper of WRAPPERS) {
      expect(reExported, `lib/api.ts does not re-export ${wrapper} from './door'`).toContain(wrapper);
    }
  });

  it('⚠ all four wrappers are exported by the door, and every one is USED', () => {
    const exported = exportedConsts(DOOR, RAW.get(DOOR)!);
    const callers = [...RAW].filter(([rel]) => rel !== DOOR);
    for (const wrapper of WRAPPERS) {
      expect(exported, `lib/door.ts does not export ${wrapper}`).toContain(wrapper);
      // APPLICATION, not presence (G4): a wrapper nobody calls is a wrapper whose
      // behaviour nothing exercises. Counted from the AST, so the generic call
      // form `requestForm<{ techniqueId: string }>(…)` counts — an earlier
      // `\(`-only matcher measured ZERO callers for `requestForm` while one
      // existed six lines away in `pages/Techniques.tsx`.
      const applied = callers.filter(([rel, src]) => callsFunction(rel, src, wrapper));
      expect(applied.length, `nothing calls ${wrapper}`).toBeGreaterThan(0);
    }
  });
});

describe('the census proves its own coverage', () => {
  it('⚠ a fetch planted in EVERY guarded file is detected in EVERY guarded file', () => {
    // THE CLAUSE THE HAND-LEXED VERSION DID NOT HAVE, and the reason it shipped
    // blind. Mutation-testing a census with one mutant in one hand-picked file
    // proves that file. This plants the defect everywhere — in memory; no file on
    // disk is touched — and requires the detector to see all of it.
    //
    // At the END of the file on purpose: that is the worst case for anything that
    // can fall out of phase part-way through, which is exactly what happened.
    const PLANT = '\nconst __census_probe = fetch("/api/__census_probe__");\n';
    const hidden: string[] = [];
    let swept = 0;

    for (const [rel, src] of RAW) {
      // Tests may legitimately name `fetch`; the door is allowed to call it.
      if (rel === DOOR || isTest(rel)) continue;
      swept += 1;
      const before = fetchCalls(rel, src).length;
      const after = fetchCalls(rel, src + PLANT).length;
      if (after !== before + 1) hidden.push(rel);
    }

    expect(swept, 'the sweep guarded almost nothing').toBeGreaterThan(90);
    expect(
      hidden.sort(),
      'the census is BLIND in these files: a direct `fetch(` planted in them is not seen, so the '
      + 'offenders clause above cannot be trusted for them. This is how the first version of this '
      + 'file shipped — a hand-written lexer that fell out of phase on an apostrophe in JSX text or '
      + 'a quote inside a regex literal.',
    ).toEqual([]);
  });

  it('⚠ and it detects the generic and property-access spellings too', () => {
    // The three shapes a text matcher gets wrong in the other direction: a call
    // with a type argument, and the two ways to reach the global explicitly.
    for (const shape of [
      'const a = fetch<Thing>("/x");',
      'const b = globalThis.fetch("/x");',
      'const c = window.fetch("/x");',
    ]) {
      expect(fetchCalls('probe.ts', shape).length, shape).toBe(1);
    }
    // …and the shapes that must NOT count, because they are other functions.
    for (const shape of [
      'void refetch();',
      'prefetch(x);',
      'client.fetch(x);',
      'this.fetch(x);',
      'const s = "fetch(";',
      '// fetch(1)',
      'const r = /fetch\\(/;',
    ]) {
      expect(fetchCalls('probe.ts', shape).length, shape).toBe(0);
    }
  });
});
