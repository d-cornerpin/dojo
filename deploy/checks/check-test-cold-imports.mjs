#!/usr/bin/env node
// ════════════════════════════════════════
// Cold-import gate for server tests (t277).
//
// ── THE DEFECT CLASS (met four times: t265, t270, t277, and a fourth file in the same run) ──
// A test clause did `await import('../some-module.js')` - usually after `vi.resetModules()` -
// so the clause paid the module's WHOLE static import graph inside its own per-test timeout.
// The product call under test takes milliseconds; the import is what costs, and it costs
// 10x more when the machine runs several suites at once (a tool-surface graph measured 1.3 s
// idle and 13.6 s loaded, per clause, until it failed the 30 s budget). The failure is
// "Test timed out", it passes alone every time, and it is blamed on load. It is not load; it
// is a graph loaded in the wrong place.
//
// ── THE RULE ──
// A test file may not dynamically import (`import()` or `vi.importActual`) a HEAVY source module (static import graph of at
// least HEAVY_GRAPH_MODULES modules) from inside any function: not a clause, not a hook
// (`beforeAll` shares the 30 s `hookTimeout`, so it is the same exposure once per file),
// not a helper a clause calls. A static import at the top of the file (or a top-level
// `await import`) loads at COLLECTION, which has no per-test budget. Where a test truly needs a
// fresh module registry per clause, either keep the graph small by stubbing the heavy modules
// the clauses never reach (`vi.mock`), or list the site in the baseline below WITH a reason.
//
// ── WHAT "HEAVY" MEANS, AND WHY IT IS MEASURED BY GRAPH, NOT BY STOPWATCH ──
// A stopwatch gate would be a coin-flip on a loaded box. The static graph is deterministic and
// is what the stopwatch measures: modules reachable through value `import`/`export ... from`
// edges inside packages/server/src (type-only edges are erased and ignored). The census
// (`--census`) prints each site with its graph size beside the slowest clause measured for it.
//
// ── THE BASELINE ──
// deploy/checks/test-cold-imports-baseline.json lists the sites that remain on purpose
// (a fresh registry IS the subject). It may only SHRINK: a site missing from the tree but
// still listed fails the gate too, so the list cannot rot into a whitelist.
//
// Usage:
//   node deploy/checks/check-test-cold-imports.mjs            # the gate
//   node deploy/checks/check-test-cold-imports.mjs --census   # every site, heavy first
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'packages/server/src');
const BASELINE = path.join(ROOT, 'deploy/checks/test-cold-imports-baseline.json');

/** Measured: below this a cold import costs well under a second even on a loaded box
 *  (a 3-module leaf loads in milliseconds); the t277 casualties were 400-1300 modules. */
export const HEAVY_GRAPH_MODULES = 200;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base + '.ts',
    path.join(base, 'index.ts'),
    base,
  ];
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

const edgeCache = new Map();
/** Value (non-type) static edges of one source file, resolved to files inside the tree. */
function edgesOf(file) {
  if (edgeCache.has(file)) return edgeCache.get(file);
  const edges = [];
  edgeCache.set(file, edges);
  if (!/\.tsx?$/.test(file)) return edges;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  for (const st of sf.statements) {
    let spec = null;
    if (ts.isImportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      if (c && c.isTypeOnly) continue;
      // `import { type A, type B } from` is erased entirely.
      if (c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings)
        && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)) continue;
      spec = st.moduleSpecifier.text;
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      spec = st.moduleSpecifier.text;
    }
    if (spec) {
      const r = resolveModule(file, spec);
      if (r) edges.push(r);
    }
  }
  return edges;
}

const sizeCache = new Map();
/** Number of modules reachable from `file` (itself included) through value edges. */
export function graphSize(file) {
  if (sizeCache.has(file)) return sizeCache.get(file);
  const seen = new Set([file]);
  const stack = [file];
  while (stack.length) {
    for (const n of edgesOf(stack.pop())) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  sizeCache.set(file, seen.size);
  return seen.size;
}

/**
 * Every way a test loads a module lazily from inside ANY function:
 *   - `import('./x')`                    (a string-literal relative specifier: sized by its graph)
 *   - `vi.importActual('./x')`           (the same load, spelled through vitest; NOT counted when it
 *                                         sits inside a `vi.mock` / `vi.doMock` factory, which runs
 *                                         when the mocked module is first imported - at collection
 *                                         for a static import - and is how mocks wrap the real module)
 *   - `import(x)` with a NON-literal x   (cannot be sized, so it is reported as a finding of its own)
 */
function sitesIn(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites = [];
  const unsized = [];
  const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
  const isMockFactoryCall = (n) => ts.isCallExpression(n) && /^vi\.(mock|doMock)$/.test(n.expression.getText(sf));
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  (function visit(n, depth, inFactory) {
    if (depth > 0 && ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isActual = !isImport && /^vi\.(importActual|importMock)$/.test(n.expression.getText(sf));
      if ((isImport || isActual) && n.arguments.length > 0) {
        const arg = n.arguments[0];
        if (ts.isStringLiteralLike(arg)) {
          if (arg.text.startsWith('.') && !(isActual && inFactory)) {
            const target = resolveModule(file, arg.text);
            if (target) sites.push({ line: lineOf(n), spec: arg.text, target, size: graphSize(target), via: isActual ? 'vi.importActual' : 'import' });
          }
        } else if (isImport) {
          unsized.push({ line: lineOf(n), code: n.getText(sf).slice(0, 60) });
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, depth + (isFn(n) ? 1 : 0), inFactory || isMockFactoryCall(n)));
  })(sf, 0, false);
  return { sites, unsized, resets: /vi\.resetModules\(/.test(text) };
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

export function scan() {
  const out = [];
  const unsized = [];
  for (const f of walk(SRC).filter((p) => /\.test\.tsx?$/.test(p))) {
    const r = sitesIn(f);
    for (const s of r.sites) out.push({ file: rel(f), line: s.line, spec: s.spec, target: rel(s.target), size: s.size, resets: r.resets, via: s.via });
    for (const u of r.unsized) unsized.push({ file: rel(f), ...u });
  }
  return { sites: out, unsized };
}

function main() {
  const { sites: all, unsized } = scan();
  if (process.argv.includes('--census')) {
    for (const s of [...all].sort((a, b) => b.size - a.size)) {
      console.log(`${String(s.size).padStart(5)} modules  ${s.resets ? 'RESET ' : '      '}${s.file}:${s.line}  ${s.spec}${s.via === 'vi.importActual' ? '  [vi.importActual]' : ''}`);
    }
    for (const u of unsized) console.log(`  ?? modules        ${u.file}:${u.line}  ${u.code}  [non-literal specifier]`);
    console.log(`\n${all.length} in-function relative dynamic imports; ${all.filter((s) => s.size >= HEAVY_GRAPH_MODULES).length} heavy (>= ${HEAVY_GRAPH_MODULES} modules)`);
    return;
  }

  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { sites: {} };
  const allowed = baseline.sites ?? {};
  const allowedUnsized = baseline.unsized ?? {};
  const heavy = all.filter((s) => s.size >= HEAVY_GRAPH_MODULES);
  const perFile = {};
  for (const s of heavy) perFile[s.file] = (perFile[s.file] ?? 0) + 1;

  let bad = 0;
  for (const [file, n] of Object.entries(perFile)) {
    const entry = allowed[file];
    const ok = entry ? entry.count : 0;
    if (n > ok) {
      bad++;
      console.error(`${file}: ${n} heavy dynamic import(s) inside a function, ${ok} allowed:`);
      for (const s of heavy.filter((x) => x.file === file)) {
        console.error(`    line ${s.line}  ${s.via === 'vi.importActual' ? 'vi.importActual' : 'import'}('${s.spec}')  -> ${s.size} modules`);
      }
    }
  }
  for (const [file, entry] of Object.entries(allowed)) {
    const n = perFile[file] ?? 0;
    if (n < entry.count) {
      bad++;
      console.error(`${file}: baseline allows ${entry.count} but the tree has ${n} - lower the baseline (it may only shrink)`);
    }
    if (!entry.why || entry.why.length < 20) {
      bad++;
      console.error(`${file}: baseline entry needs a real reason ("why")`);
    }
  }

  // A specifier the scan cannot read (`import(x)`) cannot be sized, so it is a finding of its own: it
  // must be written as a literal, moved to collection, or listed with a reason - never a silent pass.
  const unsizedPerFile = {};
  for (const u of unsized) unsizedPerFile[u.file] = (unsizedPerFile[u.file] ?? 0) + 1;
  for (const [file, n] of Object.entries(unsizedPerFile)) {
    const ok = allowedUnsized[file]?.count ?? 0;
    if (n > ok) {
      bad++;
      console.error(`${file}: ${n} dynamic import(s) with a non-literal specifier inside a function, ${ok} allowed (cannot be sized):`);
      for (const u of unsized.filter((x) => x.file === file)) console.error(`    line ${u.line}  ${u.code}`);
    }
  }
  for (const [file, entry] of Object.entries(allowedUnsized)) {
    const n = unsizedPerFile[file] ?? 0;
    if (n < entry.count) { bad++; console.error(`${file}: unsized baseline allows ${entry.count} but the tree has ${n} - lower it`); }
    if (!entry.why || entry.why.length < 20) { bad++; console.error(`${file}: unsized baseline entry needs a real reason ("why")`); }
  }

  if (bad) {
    console.error(`
✗ test cold-import gate: ${bad} problem(s).
  A heavy module imported from inside a clause/hook/helper is loaded inside that test's own
  timeout, and a loaded machine turns it into "Test timed out" (lanes t265, t270, t277).
  Fix: import it STATICALLY at the top of the test file (collection has no per-test budget);
  where a fresh registry per clause is the point, stub the heavy modules the clauses never reach
  with vi.mock, or list the site in deploy/checks/test-cold-imports-baseline.json with a reason.`);
    process.exit(1);
  }
  const baselined = Object.values(allowed).reduce((a, e) => a + e.count, 0) + Object.values(allowedUnsized).reduce((a, e) => a + e.count, 0);
  console.log(`✓ test cold-import gate: no heavy dynamic import inside a test function (${all.length} light site(s) ignored, ${unsized.length} non-literal import(s) all baselined, ${baselined} site(s) baselined with a reason).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
