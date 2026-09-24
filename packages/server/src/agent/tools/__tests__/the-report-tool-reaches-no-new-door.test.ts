// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT TOOL REACHES NO NEW DOOR (DOJO-REPORT T3, fix round 1 — finding I2).
//
// ── WHY THIS FILE EXISTS, STATED AS THE FAILURE IT REPLACES ──
// The shipped no-post guard was two clauses over `cat/report.ts`'s own TEXT: a five-name
// blacklist (`/github/`, `api.github.com`, `approveOnce`, `markPosted`, `postApprovedReport`)
// and a scan of that one file's own import specifiers. Review measured what that actually
// bought and the answer was nothing: the reviewer added a posting module under a name the
// blacklist does not know, imported it into `cat/report.ts`, CALLED it from the `submit` arm,
// and the tool performed a real outbound POST to the GitHub issues endpoint on every submit —
// with `the-report-tool-cannot-post.test.ts` at 10/10 green and the whole T3 set at 115/115.
//
// The module graph offers no isolation on its own. The transitive import closure from the
// handler is 528 modules; 37 of them call `fetch(`; `gateway/routes/update.ts` is ONE HOP away
// and holds four `fetch('https://api.github.com/repos/…')` calls; and `report/store.ts` — also
// one hop — EXPORTS the two one-shot approval doors. A blacklist of five spellings in front of
// that is name discipline wearing structure's clothes.
//
// ── WHAT A REAL GUARD HAS TO BE ──
// A census over the ACTUAL graph, in the ALLOWLIST direction, so the failure mode is "you
// added something and must say so" rather than "you avoided the five words we thought of".
// Three prongs, each answering a different question:
//
//   A. WHO MAY CONSUME AN APPROVAL? The importers of `report/store.ts`'s consent-critical
//      exports must equal a named list, repo-wide. Today that list is the store's own test.
//      **T7 adds exactly one more: the gateway route behind the owner's Post button.** That
//      is the point of this prong — when T7 lands, the diff that grants posting rights is a
//      one-line edit to a list called ALLOWED_CONSENT_CALLERS, in a file called this, and a
//      reviewer sees it. A poster that forgets to ask is a build failure.
//
//   B. DOES ANYTHING BEHIND THE TOOL CONSUME ONE? No module in the handler's import closure
//      may import those exports. Prong A says who is allowed; this says the tool is not
//      among them, and stays not among them however the graph is rewired.
//
//   C. HAS A NEW WAY OUT APPEARED BEHIND THE TOOL? The fetch-bearing modules in the closure
//      are pinned as a sorted manifest. A new outbound module reachable from the tool — the
//      exact shape of the reviewer's demonstration — is not in the manifest and fails here.
//      Plus the tightest clause of the three: the handler's and the gather's OWN one-hop
//      import lists are pinned exactly, so adding ANY import to either is a reviewed act.
//
// ── WHAT THIS FILE HONESTLY DOES NOT CLAIM ──
// It is a static import census, not a capability system. It cannot see a computed specifier,
// nor a door reached through a value passed in at runtime, and prong C cannot notice that an
// ALREADY-reachable fetch-bearing module gained a new call site — which is why prong C is
// paired with the exact one-hop pins rather than trusted alone. What it guarantees is that
// the graph behind this tool cannot change SHAPE without a human editing one of the four
// lists below. What it no longer does is mistake one SPELLING for the whole language: fix
// round 2 pins all six import forms and all seven binding forms as fixtures, because round 1
// read one of each and reported green while a module held the doors.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..', '..');
const HANDLER = path.join(SRC, 'agent', 'tools', 'cat', 'report.ts');
const STORE_REL = 'report/store.ts';

/** The doors that consume an owner's one approval. Named here so the census has a subject. */
const CONSENT_EXPORTS = ['approveOnce', 'markPosted', 'markExported'];

/**
 * PRONG A's LIST. Every file in `packages/server/src` that imports a consent export.
 * An addition here is a grant of posting rights and must be read as one.
 */
const ALLOWED_CONSENT_CALLERS: readonly string[] = [
  // The store's own lifecycle test — it drives the doors to prove they are one-shot.
  'report/__tests__/a-report-is-approved-once-and-only-once.test.ts',
  // T7 APPENDS ITS GATEWAY ROUTE HERE, and nowhere else, and that edit is the review.
];

/** PRONG C's exact one-hop pins. Adding an import to either file fails this file. */
const HANDLER_IMPORTS: readonly string[] = [
  '../../../gateway/routes/update.js', '../../../gateway/ws.js', '../../../report/bundle.js',
  '../../../report/gather.js', '../../../report/signature.js', '../../../report/store.js',
  '../../../report/telemetry-build.js', '../../../report/window.js', '../handler.js',
];
const GATHER_IMPORTS: readonly string[] = [
  '../credentials/secret-values.js', '../gateway/routes/update.js', '../logger.js',
  '../memory/message-store.js', './arg-shape.js', './collect.js', './signature.js',
  './telemetry-build.js', './window.js',
];

/**
 * PRONG C's MANIFEST — every module in the handler's closure that calls `fetch(`.
 *
 * This is a RECORD OF WHAT IS, not a permission list: the engine's graph is broad and most of
 * these are reachable only because the tool registry pulls in the whole toolbox. The guard is
 * the DELTA. A name appearing here that was not here before means a new outbound door became
 * reachable from a tool whose entire purpose is that it cannot send — read the diff and say
 * why before editing this list.
 */
const FETCH_BEARING_IN_CLOSURE: readonly string[] = [
  'agent/model.ts', 'agent/runtime.ts', 'agent/site-snapshot.ts', 'agent/tools/definitions.ts',
  'agent/tools/types.ts', 'agent/web-tools.ts', 'gateway/routes/config.ts',
  'gateway/routes/setup-deps.ts', 'gateway/routes/system.ts', 'gateway/routes/techniques.ts',
  'gateway/routes/update.ts', 'gateway/routes/upload.ts', 'google/auth.ts', 'google/client.ts',
  'google/tools-slides.ts', 'memory/embeddings.ts', 'microsoft/auth.ts', 'microsoft/client.ts',
  'microsoft/tools-office.ts', 'microsoft/tools-read.ts', 'microsoft/tools-write.ts',
  'receipts/store.ts', 'services/audio-generation.ts', 'services/capabilities.ts',
  'services/image-generation.ts', 'services/litellm-pricing-sync.ts',
  'services/num-ctx-calculator.ts', 'services/ollama.ts', 'services/transcription.ts',
  'services/video-generation.ts', 'tools/unified-read.ts', 'twilio/client.ts',
  'twilio/sms-inbound.ts', 'update/artifact-integrity.ts', 'voice/model-manager.ts',
  'voice/smart-turn.ts', 'voice/stt-service.ts',
];

// ── the walk ────────────────────────────────────────────────────────────────────────────
// Comment lines are dropped before a specifier is read. Four `await import('…')` mentions in
// the toolbox's header prose would otherwise be counted as real edges and reported as holes,
// and a walk that reports holes it invented teaches readers to ignore its holes.
//
// ── N2 (fix round 2): THE BARE IMPORT ──
// The first cut read `from '…'`, `import('…')` and `require('…')`. A side-effect import —
// `import './x.js';` — has no `from` and no parenthesis, so it was invisible, and one exists
// in the tree today: the real closure is 528 modules, not the 526 this file measured. Neither
// missed module calls `fetch`, so prong C was complete BY LUCK, NOT BY LAW. The `\bimport\s*`
// alternation is the whole fix, and the clause below pins every spelling the repo uses.

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

const stripComments = (code: string): string =>
  code.split('\n').filter(l => !isComment(l)).join('\n');

/** Every module specifier in a piece of code, in any spelling that creates an EDGE. */
function specifiersIn(code: string): string[] {
  return [...stripComments(code).matchAll(SPEC)].map(m => m[1]);
}

function specifiersOf(file: string): string[] {
  return specifiersIn(fs.readFileSync(file, 'utf8'));
}

/**
 * ── N1 (fix round 2): EVERY SPELLING THAT BINDS A CONSENT DOOR ──
 *
 * The first cut read ONE form — `import { approveOnce } from '…'` — and review measured two
 * escapes straight through it, each 7/7 green while a module held the doors:
 *
 *   import * as reportStore from '…/store.js';   // then reportStore.approveOnce(id)
 *   export { approveOnce as consume } from '…/store.js';   // a re-export barrel
 *
 * These are not hypothetical spellings: the repo already uses them 33 times (18 namespace,
 * 15 re-export barrels), five of the namespace ones on door modules shaped exactly like
 * `report/store.ts`. A census that reads one of six spellings is the same defect as the
 * five-name blacklist this file was written to replace, one layer up.
 *
 * ⚠ A STAR BINDS EVERYTHING, SO A STAR IS A CONSENT BINDING — unconditionally, with no
 * attempt to check whether `ns.approveOnce` is ever written. That check would be defeated by
 * `ns['approve' + 'Once']`, and a census that can be defeated by string concatenation is
 * decoration. The house rule this creates is a good one and is stated so nobody files it as
 * a bug: IF YOU WANT THE REPORT STORE, NAME WHAT YOU WANT. A module needing only `getReport`
 * writes the braced form and passes.
 */
function consentBindingsIn(code: string): string[] {
  const clean = stripComments(code);
  const specs: string[] = [];
  const bindsAConsentName = (clause: string): boolean =>
    clause.split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim())
      .some(n => CONSENT_EXPORTS.includes(n));

  // `import { … } from '…'` and `export { … } from '…'` — the named forms, either direction.
  for (const m of clean.matchAll(/(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (bindsAConsentName(m[1])) specs.push(m[2]);
  }
  // `import * as ns from '…'`, `export * from '…'`, `export * as ns from '…'` — all bind all.
  for (const m of clean.matchAll(/(?:import|export)\s*\*(?:\s*as\s+[A-Za-z_$][\w$]*)?\s*from\s*['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  return specs;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;   // a package, not a module of ours
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
    `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function closureFrom(entry: string): { modules: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const stack = [path.resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      const resolved = resolveSpec(file, spec);
      if (resolved) stack.push(resolved);
      else if (spec.startsWith('.')) unresolved.push(`${path.relative(SRC, file)} -> ${spec}`);
    }
  }
  return { modules: [...seen].map(f => path.relative(SRC, f)).sort(), unresolved: [...new Set(unresolved)] };
}

function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allSourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Files that BIND a consent door from the report store, in any spelling. */
function consentImporters(): string[] {
  const hits: string[] = [];
  for (const file of allSourceFiles(SRC)) {
    for (const spec of consentBindingsIn(fs.readFileSync(file, 'utf8'))) {
      const target = resolveSpec(file, spec);
      if (target && path.relative(SRC, target) === STORE_REL) hits.push(path.relative(SRC, file));
    }
  }
  return [...new Set(hits)].sort();
}

const CLOSURE = closureFrom(HANDLER);

// ⚠ THE READERS ARE TESTED BEFORE ANYTHING THEY READ IS TRUSTED (fix round 2, N1 + N2).
// Everything below this file's two regexes rests on them seeing what is actually written in
// the repo. Round 1 shipped a census that read ONE import spelling out of six and reported
// green while a module held the approval doors — the same defect as the five-name blacklist
// this file replaced, moved one layer up. So the spellings are pinned as fixtures, here,
// where a missing form is a failing clause rather than a silent hole in a 528-module walk.

describe('the specifier reader sees every import spelling that creates an edge', () => {
  const FORMS: readonly [string, string][] = [
    ['named', `import { a } from './x.js';`],
    ['default', `import d from './x.js';`],
    ['namespace', `import * as n from './x.js';`],
    // N2: no `from`, no parenthesis — invisible to the round-1 reader, and one exists today.
    ['bare side-effect', `import './x.js';`],
    ['dynamic', `const m = await import('./x.js');`],
    ['require', `const m = require('./x.js');`],
    ['re-export named', `export { a } from './x.js';`],
    ['re-export star', `export * from './x.js';`],
    ['re-export star as', `export * as n from './x.js';`],
  ];

  for (const [label, code] of FORMS) {
    it(`sees a ${label} import`, () => {
      expect(specifiersIn(code), `the walk is blind to the ${label} form: ${code}`).toEqual(['./x.js']);
    });
  }

  it('still ignores a specifier that only appears in prose', () => {
    expect(specifiersIn(`// the old \`await import('../agent/tools.js')\` hack\nconst x = 1;`)).toEqual([]);
  });
});

describe('the consent reader sees every spelling that binds a door', () => {
  const BINDS: readonly [string, string][] = [
    ['braced named', `import { approveOnce } from './store.js';`],
    ['braced and renamed', `import { approveOnce as ok } from './store.js';`],
    ['braced among innocents', `import { getReport, markPosted, createReport } from './store.js';`],
    // The two escapes review measured straight through the round-1 census, both 7/7 green.
    ['namespace', `import * as reportStore from './store.js';`],
    ['re-export barrel', `export { approveOnce as consume } from './store.js';`],
    ['star re-export', `export * from './store.js';`],
    ['star re-export, named', `export * as store from './store.js';`],
  ];

  for (const [label, code] of BINDS) {
    it(`treats a ${label} import of the store as a consent binding`, () => {
      expect(consentBindingsIn(code), `a ${label} import walks past the census: ${code}`)
        .toContain('./store.js');
    });
  }

  it('lets an innocent named import through — the rule is "name what you want"', () => {
    expect(consentBindingsIn(`import { getReport, listOpenReports } from './store.js';`)).toEqual([]);
  });

  it('a star binds every export, so it is a binding whether or not a door is ever written', () => {
    // No `reportStore.approveOnce` anywhere in this fixture, and it still counts. Checking for
    // the member access would be defeated by `ns['approve' + 'Once']`.
    expect(consentBindingsIn(`import * as s from './store.js';\nreturn s.getReport(id);`))
      .toContain('./store.js');
  });
});

describe('the walk itself is sound', () => {
  it('reaches a real graph and leaves no unresolved relative specifier', () => {
    expect(CLOSURE.modules.length).toBeGreaterThan(100);
    expect(CLOSURE.modules).toContain('agent/tools/cat/report.ts');
    expect(CLOSURE.modules).toContain('report/gather.ts');
    // A hole in the walk is a module never visited, so everything under it is unmeasured.
    // A census with holes reporting green is a false green.
    expect(CLOSURE.unresolved, `unresolved relative import(s): ${CLOSURE.unresolved.join(', ')}`).toEqual([]);
  });
});

describe('A — only a named list may consume the owner\'s one approval', () => {
  it('the importers of the consent doors are exactly the allowlist', () => {
    expect(
      consentImporters(),
      'A file imported approveOnce/markPosted/markExported without being named in '
      + 'ALLOWED_CONSENT_CALLERS. Those three doors CONSUME the owner\'s single approval (D4). '
      + 'If this is the T7 posting route, add it to that list — the edit is the review.',
    ).toEqual([...ALLOWED_CONSENT_CALLERS].sort());
  });

  it('the doors it names are the doors the store actually exports', () => {
    const store = fs.readFileSync(path.join(SRC, STORE_REL), 'utf8');
    for (const name of CONSENT_EXPORTS) {
      expect(store, `report/store.ts no longer exports ${name} — this census is guarding a ghost`)
        .toContain(`export function ${name}(`);
    }
  });
});

describe('B — nothing behind the report tool can consume one', () => {
  it('no module in the handler\'s import closure imports a consent door', () => {
    const inClosure = consentImporters().filter(f => CLOSURE.modules.includes(f));
    expect(
      inClosure,
      `these modules are reachable from the dojo_report handler AND import a consent door: `
      + `${inClosure.join(', ')}. The tool must not be able to reach the approval it exists to ask for.`,
    ).toEqual([]);
  });
});

describe('C — no new way out has appeared behind the report tool', () => {
  it('the handler imports exactly its declared list — one hop, pinned', () => {
    expect(
      [...new Set(specifiersOf(HANDLER))].sort(),
      'cat/report.ts gained or lost an import. Every module it can reach directly is pinned '
      + 'because a blacklist of five names is what this file exists to replace.',
    ).toEqual([...HANDLER_IMPORTS].sort());
  });

  it('the gather imports exactly its declared list — one hop, pinned', () => {
    expect([...new Set(specifiersOf(path.join(SRC, 'report', 'gather.ts')))].sort())
      .toEqual([...GATHER_IMPORTS].sort());
  });

  it('the fetch-bearing modules in the closure are exactly the recorded manifest', () => {
    const fetchy = CLOSURE.modules
      .filter(m => /\bfetch\s*\(/.test(fs.readFileSync(path.join(SRC, m), 'utf8')));
    const added = fetchy.filter(m => !FETCH_BEARING_IN_CLOSURE.includes(m));
    const gone = FETCH_BEARING_IN_CLOSURE.filter(m => !fetchy.includes(m));
    expect(
      added,
      `NEW outbound module(s) reachable from the dojo_report handler: ${added.join(', ')}. `
      + 'A tool whose whole claim is that it cannot send just grew a new way out. Read the diff '
      + 'and say why before adding a name to FETCH_BEARING_IN_CLOSURE.',
    ).toEqual([]);
    expect(gone, `manifest names a module no longer in the closure (stale): ${gone.join(', ')}`).toEqual([]);
  });
});
