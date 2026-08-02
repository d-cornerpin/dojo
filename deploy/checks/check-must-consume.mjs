#!/usr/bin/env node
// ════════════════════════════════════════
// Must-consume gate (PHASE-4 T1).
//
// Runs `deploy/checks/eslint-rules/must-consume-outcome.cjs` over
// `packages/server/src` and refuses when any `Outcome` is discarded — a boundary
// reported applied/no_change/refused/failed/unknown and the caller carried on
// without looking.
//
// ── WHY ITS OWN RUNNER RATHER THAN eslint.config.js ──
// The repo's eslint config is deliberately WARN-ONLY with `lint-baseline.json` as
// the ratchet, because that tree has hundreds of pre-existing findings for its five
// rules and an unshippable gate gets bypassed and then deleted. This rule is the
// opposite case: its population is meant to be ZERO and stay zero, so it wants a
// gate that refuses rather than a count that may only fall. Two mechanisms for one
// rule would be the duplication this overhaul exists to remove, so it lives here,
// once, and `eslint.config.js` does not know about it.
//
// ── THE TIER IS THE FLIP ──
// T1's burn-down lands cluster by cluster, and a lint that ships RED is a whitelist
// waiting to happen. So this gate enters the manifest at `report` tier while the
// inventory is being burned down, and moves to `blocking` in a one-line, reviewable
// manifest edit at zero. The script itself always exits 1 on a violation; the
// manifest decides whether that stops a build.
//
// ── THREE CLAUSES, NOT ONE ──
//   1. INVENTORY   the rule over the real tree: every discarded Outcome, by file.
//   2. SELFTEST    a planted fault in a throwaway project: the rule must FLAG both
//                  discard shapes and must NOT flag the four consuming shapes or a
//                  non-Outcome call. A rule with no proof it bites is a comment.
//   3. CONFORMANCE the rule's `KINDS` list and `packages/shared/src/outcome.ts`'s
//                  `OUTCOME_KINDS` must agree. The rule matches by SHAPE, so the
//                  shape's vocabulary drifting apart from the checker's copy is the
//                  one way this gate could silently stop seeing anything.
//
// Usage:
//   node deploy/checks/check-must-consume.mjs            # all three clauses
//   node deploy/checks/check-must-consume.mjs --json     # inventory as JSON
//   node deploy/checks/check-must-consume.mjs --selftest # clause 2 alone
// ════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './eslint-rules/must-consume-outcome.cjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCOPE = 'packages/server/src';
const SHARED_OUTCOME = path.join(ROOT, 'packages/shared/src/outcome.ts');
const JSON_MODE = process.argv.includes('--json');
const SELFTEST_ONLY = process.argv.includes('--selftest');

function makeEslint({ cwd, files, ignores, project, tsconfigRootDir }) {
  return new ESLint({
    cwd,
    // The repo config is warn-only and scoped elsewhere; this gate brings its own.
    overrideConfigFile: true,
    // A one-line `eslint-disable` that turns a gate off is not a gate.
    allowInlineConfig: false,
    overrideConfig: [{
      files,
      ...(ignores ? { ignores } : {}),
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { project, tsconfigRootDir },
      },
      plugins: { dojo: { rules: { 'must-consume-outcome': rule } } },
      rules: { 'dojo/must-consume-outcome': 'error' },
    }],
  });
}

// ── Clause 3: the rule's vocabulary and the type's vocabulary are one list ──
function conformance() {
  const src = fs.readFileSync(SHARED_OUTCOME, 'utf8');
  const m = /export const OUTCOME_KINDS[^=]*=\s*\[([^\]]*)\]/m.exec(src);
  if (!m) {
    console.error('✗ conformance: could not find OUTCOME_KINDS in packages/shared/src/outcome.ts.');
    console.error('  The rule matches Outcomes by SHAPE; if the shape moved, this gate is blind.');
    return false;
  }
  const declared = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  const ruleSrc = fs.readFileSync(path.join(ROOT, 'deploy/checks/eslint-rules/must-consume-outcome.cjs'), 'utf8');
  const rm = /const KINDS = new Set\(\[([^\]]*)\]\)/m.exec(ruleSrc);
  const inRule = rm ? [...rm[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort() : [];
  if (declared.join(',') !== inRule.join(',')) {
    console.error('✗ conformance: OUTCOME_KINDS and the rule\'s KINDS disagree.');
    console.error(`    outcome.ts : ${declared.join(', ')}`);
    console.error(`    rule       : ${inRule.join(', ')}`);
    return false;
  }
  if (!JSON_MODE) console.log(`✓ conformance: five arms, one list — ${declared.join(' | ')}`);
  return true;
}

// ── Clause 2: the planted-fault proof ──
//
// A throwaway TypeScript project in the OS temp dir, deliberately importing
// nothing from this repo: the rule matches by shape, so the fixture declares its
// own Outcome-shaped type and the proof does not depend on the product tree
// compiling. Two shapes must be FLAGGED and five must not.
const FIXTURE = `
type Fixture =
  | { kind: 'applied'; value: number }
  | { kind: 'refused'; reason: string; detail: string };
declare function boundary(): Fixture;
declare function boundaryAsync(): Promise<Fixture>;
declare function plain(): number;
declare function sink(x: Fixture): void;

export async function shapes(): Promise<Fixture> {
  boundary();                               // FLAG 1: statement discard
  await boundaryAsync();                    // FLAG 2: awaited statement discard
  void boundary();                          // FLAG 3: void is not consumption
  const writeOnly = boundary();             // FLAG 4: write-only binding

  const read = boundary();                  // ok: branched on
  if (read.kind === 'refused') { sink(read); }
  const { kind } = boundary();              // ok: destructured
  if (kind === 'applied') { /* ok */ }
  sink(boundary());                         // ok: handed on
  plain();                                  // ok: not an Outcome at all
  return boundary();                        // ok: returned
}
`;

const EXPECTED_SELFTEST = 4;

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'must-consume-selftest-'));
  try {
    fs.writeFileSync(path.join(dir, 'fixture.ts'), FIXTURE);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
      include: ['*.ts'],
    }));
    const eslint = makeEslint({
      cwd: dir, files: ['**/*.ts'], project: ['./tsconfig.json'], tsconfigRootDir: dir,
    });
    const results = await eslint.lintFiles([path.join(dir, 'fixture.ts')]);
    const msgs = results.flatMap((r) => r.messages);
    const flagged = msgs.filter((m) => m.ruleId === 'dojo/must-consume-outcome');
    const other = msgs.filter((m) => m.ruleId !== 'dojo/must-consume-outcome');
    if (other.length) {
      console.error('✗ selftest: the fixture did not parse cleanly.');
      for (const m of other) console.error(`    ${m.line}:${m.column} ${m.message}`);
      return false;
    }
    if (flagged.length !== EXPECTED_SELFTEST) {
      console.error(`✗ selftest: expected ${EXPECTED_SELFTEST} planted discards to be flagged, got ${flagged.length}.`);
      for (const m of flagged) console.error(`    line ${m.line}: ${m.message}`);
      console.error('  Under-flagging = the rule stopped biting. Over-flagging = it bites consumption too.');
      return false;
    }
    const discards = flagged.filter((m) => m.messageId === 'discarded').length;
    const writeOnly = flagged.filter((m) => m.messageId === 'writeOnly').length;
    if (discards !== 3 || writeOnly !== 1) {
      console.error(`✗ selftest: shapes wrong — ${discards} statement discards (want 3), ${writeOnly} write-only (want 1).`);
      return false;
    }
    if (!JSON_MODE) {
      console.log(`✓ selftest: ${EXPECTED_SELFTEST} planted discards flagged (3 statement + 1 write-only), 6 consuming shapes untouched`);
    }
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Clause 1: the inventory over the real tree ──
async function inventory() {
  const eslint = makeEslint({
    cwd: ROOT,
    files: [`${SCOPE}/**/*.ts`],
    // Excluded for the same reason eslint.config.js excludes them: this rule is
    // type-aware, and `packages/server/tsconfig.json` — the project it types
    // against — excludes tests. The two exclusions must stay in sync.
    ignores: [`${SCOPE}/**/__tests__/**`, `${SCOPE}/**/*.test.ts`],
    project: ['./packages/server/tsconfig.json'],
    tsconfigRootDir: ROOT,
  });
  const results = await eslint.lintFiles([SCOPE]);
  // A config whose patterns stop matching lints nothing and reports a beautiful
  // zero. Same vacuity floor as check-lint-baseline.mjs, for the same reason.
  if (results.length === 0) {
    console.error(`✗ must-consume linted ZERO files under ${SCOPE}. A gate that reads nothing passes everything.`);
    process.exit(1);
  }
  const byFile = [];
  let total = 0;
  for (const r of results) {
    const hits = r.messages.filter((m) => m.ruleId === 'dojo/must-consume-outcome');
    const fatal = r.messages.filter((m) => m.fatal);
    if (fatal.length) {
      console.error(`✗ ${path.relative(ROOT, r.filePath)} did not parse: ${fatal[0].message}`);
      process.exit(1);
    }
    if (hits.length === 0) continue;
    total += hits.length;
    byFile.push({
      file: path.relative(ROOT, r.filePath),
      count: hits.length,
      sites: hits.map((m) => ({ line: m.line, messageId: m.messageId, message: m.message })),
    });
  }
  byFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  return { filesLinted: results.length, total, byFile };
}

const okConformance = conformance();
const okSelftest = await selftest();
if (SELFTEST_ONLY) process.exit(okConformance && okSelftest ? 0 : 1);

const inv = await inventory();

if (JSON_MODE) {
  console.log(JSON.stringify({ ...inv, conformance: okConformance, selftest: okSelftest }, null, 2));
} else {
  console.log(`  scope: ${SCOPE} (${inv.filesLinted} files linted, tests excluded by the tsconfig this rule types against)`);
  if (inv.total === 0) {
    console.log('✓ must-consume: 0 discarded Outcomes.');
  } else {
    console.log('');
    console.log(`✗ must-consume: ${inv.total} discarded Outcome(s) across ${inv.byFile.length} file(s):`);
    for (const f of inv.byFile) {
      console.log(`    ${f.count.toString().padStart(3)}  ${f.file}`);
      for (const s of f.sites) console.log(`         :${s.line}  ${s.message}`);
    }
  }
}

process.exit(okConformance && okSelftest && inv.total === 0 ? 0 : 1);
