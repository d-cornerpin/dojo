// ════════════════════════════════════════════════════════════════════════════════════════
// THE GUARD-CORPUS CENSUS — PHASE-6 GUARD-AUDIT (2026-08-04)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT THIS POLICES, IN ONE SENTENCE: a guard whose corpus does not follow its subject goes
// QUIET, not red — and this walk makes a NEW one impossible to ship unaudited.
//
// ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────────────────
// PHASE-6 drains `agent/v2/loop.ts` into step packages under `agent/v2/steps/<name>/`, nine
// tranches, one at a time. A guard that reads the driver BY PATH keeps passing after its
// subject leaves — because the thing it forbids is no longer in front of it. CUT 2 (T9b)
// caught the first live instance by accident of adjacency: `two-key-conformance`'s KEY-1
// walk stopped seeing the engine's own privileged `status='complete'` writer and NOTHING
// FAILED. Proven quiet rather than merely stale: the identical planted violation passed
// 14/14 against the old corpus and failed against the widened one.
//
// The audit that followed enumerated every source-scanning guard in both repos. The class
// was never one file: SIX guards had each hand-rolled their own "driver plus the step
// packages" walk, and a dozen more still read the driver alone — including a TOMBSTONE
// (`serve-boundary-conformance`, "the engine has no privileged same-turn close any more")
// whose entire subject is an ABSENCE, asserted over a corpus that was about to stop
// containing the place the thing would live.
//
// ── WHY A STANDALONE WALKER, AND NOT AN EXISTING HOST ───────────────────────────────────
// The brief asks for a one-line reason and here it is: **every existing conformance walk in
// this tree EXCLUDES `__tests__` from its corpus** (`single-writer-conformance`,
// `publish-path-guards`, `one-estimator-conformance`, `facade-contract`, `check-wiring`,
// `check-sql-prepares` — all of them skip it, correctly, because they police production),
// and none of them walks `deploy/checks/` at all. The guards are the one corpus no existing
// host looks at, which is exactly why they could rot unobserved.
//
// ── ⚠ AND THE ENUMERATION COMMAND THE PLAN HANDS OUT IS BLIND ───────────────────────────
// `PHASE-6.md`'s STANDING ADDITION tells every remaining cut to enumerate with
//     git grep -ln "loop.ts" -- 'packages/server/src/**/__tests__/**'
// That pathspec DOES NOT MATCH `packages/server/src/__tests__/` — the top-level test
// directory. Measured 2026-08-04: the command returns 31 files and misses two that name the
// driver, `__tests__/marker-ownership.test.ts` and `__tests__/outcome.test.ts`. The second
// reads the driver alone and its subject (the spin brake) rides the `execute` tranche out.
// This census therefore WALKS DIRECTORIES rather than trusting that glob, and the gap is
// handed up so the plan's own instruction can be corrected.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, '..');
const REPO = path.resolve(SERVER_SRC, '..', '..', '..');

/** Comments first: a matcher that reads commented-out code reports guards that do not exist. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/**
 * THE GUARD CORPUS: every test file under `packages/server/src/**\/__tests__/`, plus every
 * check script under `deploy/checks/`. A WALK, never a glob — see the header.
 */
function guardFiles(): string[] {
  const out: string[] = [];
  const walkTests = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walkTests(abs); continue; }
      if (/\.(ts|tsx|mts)$/.test(e.name) && abs.split(path.sep).includes('__tests__')) {
        out.push(path.relative(REPO, abs));
      }
    }
  };
  walkTests(SERVER_SRC);

  const checks = path.join(REPO, 'deploy', 'checks');
  const walkChecks = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walkChecks(abs); continue; }
      if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(path.relative(REPO, abs));
    }
  };
  walkChecks(checks);
  return out.sort();
}

const READS_SOURCE = /\b(readFileSync|readdirSync|globSync)\s*\(/;
/**
 * The driver named by path — ANY spelling.
 *
 * ⚠ THIS MATCHER WAS ENUMERATED TWICE AND WRONG BOTH TIMES, which is the whole argument for
 * planted faults. Draft 1 knew `'agent/v2/loop.ts'` and `'../loop.ts'` and missed the bare
 * SEGMENT form (`path.resolve(HERE, '..', '..', '..', 'loop.ts')`) that
 * `steps/teardown/__tests__/contract.test.ts` uses — caught by this file's own
 * stale-declaration clause. Draft 2 added that and still missed `'../v2/loop.ts'` — caught
 * by planting a new undeclared guard and watching the census pass.
 *
 * So it no longer enumerates spellings. It matches the FILENAME anywhere in code, which
 * cannot be routed around by a different relative prefix. `agent/v2/classifiers/loop.ts` is
 * a genuinely different file and is the one exclusion.
 */
const NAMES_DRIVER = /(?<!classifiers\/)\bloop\.ts\b/;
const NAMES_STEPS = /agent\/v2\/steps|['"`]\.\.\/steps['"`]/;
const MENTIONS_V2 = /agent\/v2/;
const USES_SHARED = /engine-sources/;

interface Guard {
  rel: string;
  readsSource: boolean;
  namesDriver: boolean;
  namesSteps: boolean;
  mentionsV2: boolean;
  usesShared: boolean;
}

function census(): Guard[] {
  return guardFiles().map((rel) => {
    const code = stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    return {
      rel,
      readsSource: READS_SOURCE.test(code),
      namesDriver: NAMES_DRIVER.test(code),
      namesSteps: NAMES_STEPS.test(code),
      mentionsV2: MENTIONS_V2.test(code),
      usesShared: USES_SHARED.test(code),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE DECLARATIONS — every entry carries a VERDICT and a REASON, and a stale reason FAILS
// (the T0A census pattern). Three verdicts, and only three:
//
//   'step-aware'      — the corpus follows moved code by construction (it derives from the
//                       shared engine module, or walks a root that contains the step
//                       packages). Nothing to do at a cut.
//   'cannot-go-quiet' — the subject provably never moves, OR the guard refuses loudly when
//                       its subject is missing. The reason must name WHICH, because a reason
//                       that stops being true has to fail rather than reassure.
//
// A guard that is neither is a guard that must be FIXED, not declared — which is why there
// is no third list to hide in.
// ════════════════════════════════════════════════════════════════════════════════════════

interface Declaration { rel: string; verdict: 'step-aware' | 'cannot-go-quiet'; why: string }

/**
 * Guards that name the DRIVER by path WITHOUT deriving their corpus from the shared engine
 * module. Each must say why that is safe. Anything not here fails.
 */
const DRIVER_BY_PATH: Declaration[] = [
  {
    rel: 'packages/server/src/__tests__/marker-ownership.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'Its corpus is a recursive walk of all three packages, so it already follows moved '
      + 'code. The driver is named only inside the NOT_FOLDED exemption list, and that list '
      + 'already re-tests its own subject (`read(n.file).includes(n.what)`), so when '
      + '`DECLINE_OPENER_RE` rides a tranche out the entry fails loudly and names itself. An '
      + 'exemption must name the file it exempts — widening it would blunt the list, not sharpen it. '
      + '(That prediction came true at CUT 8: the entry went RED, named itself, and was re-pointed '
      + 'at `steps/post-call-classify/no-reply.ts` with its reason unchanged.)',
  },
  {
    rel: 'packages/server/src/agent/v2/steps/post-call-classify/__tests__/contract.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'Same shape as the `execute` contract above, and for the same one question: that the '
      + "`advance` into `postCallClassify` sits AHEAD of the call site, which is a fact about the "
      + "DRIVER's own statement order that a step package cannot answer about itself. Both "
      + '`indexOf`s are asserted `> -1` before they are compared, so a driver that stopped calling '
      + 'this step fails here rather than passing on two -1s. Widening the corpus to the engine '
      + 'would be wrong on purpose: it would let the call site move into a step and still pass.',
  },
  {
    rel: 'packages/server/src/agent/v2/steps/teardown/__tests__/contract.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'Its SUBJECT IS THE DRIVER FILE ITSELF — it parses `runV2TurnBody` with the TypeScript '
      + 'compiler to prove the teardown arm is called from the main `finally` and the recovery '
      + 'arm from the main `catch`. That question is only answerable against the driver, and it '
      + '`throw`s ("runV2TurnBody not found in loop.ts") rather than passing when the shape is '
      + 'not where it expects. It cannot go quiet; it can only stop the build.',
  },
  {
    rel: 'packages/server/src/agent/v2/steps/execute/__tests__/contract.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'It reads the driver for exactly ONE question — that the `advance` into `execute` sits '
      + 'AHEAD of the call site, which is what makes `validate()` run on the transition and what '
      + 'lets the step be forbidden from writing `phase` at all. That is a question about the '
      + "DRIVER's own statement order and a step package cannot answer it. Both `indexOf`s are "
      + 'asserted `> -1` before they are compared, so a driver that stopped calling this step '
      + 'fails here rather than passing on two -1s. Widening the corpus to the engine would be '
      + 'wrong on purpose: it would let the call site move into a step and still pass.',
  },
  {
    rel: 'packages/server/src/agent/v2/steps/finalize/__tests__/contract.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'Same kind as the teardown contract above, and for the same reason: its SUBJECT IS THE '
      + "DRIVER'S OWN STRUCTURE. It parses `runV2TurnBody` to prove the finalize step is the LAST "
      + 'statement of the turn\'s main `try` — which is what makes "every `break` path reaches the '
      + 'stamping" true by the language rather than by habit — and it counts the two mid-call '
      + '`return`s that genuinely bypass it. Both questions are only answerable against the driver, '
      + 'and it `throw`s ("runV2TurnBody not found") rather than passing when the shape moves.',
  },
  {
    rel: 'packages/server/src/agent/v2/steps/assemble/__tests__/contract.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'Same kind as the teardown and finalize contracts above, and NARROWER than either: it '
      + "reads the driver for exactly one question — that the driver's `advance` into the "
      + '`assemble` phase sits AHEAD of the call to the step, which is what makes `validate()` '
      + 'run on the transition by construction. Both `indexOf`s are asserted `> -1` before they '
      + 'are compared, so an absent site FAILS rather than comparing -1 against a position — the '
      + 'exact way `prefix-lane-conformance` went quiet before this audit. Widening it to the '
      + "engine would be wrong on purpose: the question is about the DRIVER's statement order, "
      + 'and a step package cannot answer it.',
  },
  {
    rel: 'packages/server/src/credentials/__tests__/credential-hydration.test.ts',
    verdict: 'step-aware',
    why: 'DECLARED IN BOTH LISTS ON PURPOSE, because it names both halves of the engine: its '
      + 'expectation is a closed set of ENGINE paths and it walks the WHOLE of '
      + '`packages/server/src` rather than importing the shared derivation. The full reason — '
      + 'including why `engineText()` would be the WRONG corpus here — is on its entry in '
      + 'STEPS_BY_PATH below.',
  },
  {
    rel: 'packages/server/src/memory/__tests__/single-writer-conformance.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'The driver appears only as a PRODUCER_ALLOWLIST entry. Its stale check was '
      + '`existsSync` alone until this audit — half a check, and the half that mattered. It now '
      + 'also re-tests that each entry STILL PRODUCES, using the same predicate as the offender '
      + 'scan, so when ingest stamping rides a tranche out the exemption fails and names itself '
      + 'instead of silently outliving its reason.',
  },
  {
    rel: 'packages/server/src/work/__tests__/work-reaper.test.ts',
    verdict: 'cannot-go-quiet',
    why: 'One clause deliberately keeps the driver as its corpus: `STALE_TASK_WINDOW_MINUTES` is '
      + 'declared at loop.ts:560, MODULE LEVEL — above `runV2TurnBody` (1013-9362) — so no '
      + 'tranche moves it, and naming the one file that holds it is the NARROWER and therefore '
      + 'stronger corpus. Its in-function sibling `CLOSE_OUT_IDLE_MINUTES` (loop.ts:2296) was '
      + 'widened to the engine in the same task.',
  },
  {
    rel: 'packages/server/src/tracker/__tests__/two-key-conformance.test.ts',
    verdict: 'step-aware',
    why: 'The driver is named inside the three KEY allowlists, whose whole purpose is to say '
      + 'WHICH file is permitted a privileged write; the corpus itself is the shared engine '
      + 'derivation plus the subsystem walks. This is the guard CUT 2 found going quiet, and it '
      + 'is the reference repair.',
  },
];

/**
 * Guards that reach into `agent/v2/steps` by path without using the shared module. The point
 * of this list is that it should stay EMPTY apart from the module itself: a seventh
 * hand-rolled copy of the engine walk is how the corpus starts drifting again.
 */
const STEPS_BY_PATH: Declaration[] = [
  {
    rel: 'packages/server/src/credentials/__tests__/credential-hydration.test.ts',
    verdict: 'step-aware',
    why: 'It names BOTH halves of the engine by path, and it does NOT import the shared '
      + 'derivation, deliberately: its corpus is a recursive walk of the WHOLE of '
      + '`packages/server/src`, because the requirement is "there is exactly ONE caller of '
      + '`hydrateCredentialsInMessages` ANYWHERE", and `engineText()` would narrow that to the '
      + "engine and stop seeing a second call site in the assembler — the exact regression this "
      + 'guard exists to catch. The engine paths appear only in the EXPECTATION, as a closed set '
      + "`['agent/v2/loop.ts', 'agent/v2/steps/']`. PHASE-6 CUT 5 is when that mattered: the call "
      + 'site moved into `steps/call-llm/model-call.ts`, the clause failed LOUDLY with both paths '
      + 'printed, and the set was WIDENED while the COUNT was not — a second call site anywhere '
      + 'still fails it, proven by planting one.',
  },
  {
    rel: 'packages/server/src/agent/v2/__tests__/engine-sources.ts',
    verdict: 'step-aware',
    why: 'THE derivation itself — the one place `agent/v2/steps` is walked. Every other guard '
      + 'imports from here rather than growing its own copy.',
  },
  {
    rel: 'packages/server/src/__tests__/marker-ownership.test.ts',
    verdict: 'step-aware',
    why: 'It grows no walk of its own — its corpus is already a recursive walk of all three '
      + 'packages, which is why it follows moved code by construction. A step path appears in '
      + 'exactly ONE place: the NOT_FOLDED exemption entry naming the file that holds '
      + '`DECLINE_OPENER_RE`, which moved into `steps/post-call-classify/no-reply.ts` at CUT 8. '
      + 'An exemption must name the file it exempts, and the list re-tests its own subject '
      + '(`read(n.file).includes(n.what)`), so a stale entry fails loudly and names itself — '
      + 'which is exactly how CUT 8 found it.',
  },
];

// ════════════════════════════════════════════════════════════════════════════════════════

describe('the guard-corpus census (PHASE-6 GUARD-AUDIT)', () => {
  const guards = census();

  it('the walk is not vacuous — it finds the guard corpus it claims to police', () => {
    expect(guards.length, 'the guard walk found (almost) nothing — it has rotted').toBeGreaterThan(150);
    expect(
      guards.filter((g) => g.readsSource).length,
      'no guard appears to read source at all — the detector has rotted, and every clause below would pass vacuously',
    ).toBeGreaterThan(50);
    // Positive controls on BOTH corpora, so a walk that silently lost one half is caught.
    const rels = guards.map((g) => g.rel);
    expect(rels, 'the deploy/checks half of the corpus is missing').toContain('deploy/checks/check-wiring.mjs');
    expect(rels, 'the top-level src/__tests__ directory is missing — the pathspec blind spot is back')
      .toContain('packages/server/src/__tests__/outcome.test.ts');
    expect(rels, 'the nested __tests__ half of the corpus is missing')
      .toContain('packages/server/src/tracker/__tests__/two-key-conformance.test.ts');
  });

  it('every guard that READS source and names the DRIVER by path uses the shared corpus or is declared', () => {
    // Scoped to guards that actually READ source, because a CORPUS is the thing that can go
    // quiet. `tools/__tests__/work-verbs.test.ts` names the driver six times in `where:`
    // documentation strings and reads nothing at all — those pointers do go stale when a
    // tranche moves the verb consumers, but they are prose in a data field, not a corpus,
    // and policing them here would blur what this census means. Handed up instead.
    const declared = new Set(DRIVER_BY_PATH.map((d) => d.rel));
    const undeclared = guards
      .filter((g) => g.readsSource && g.namesDriver && !g.usesShared)
      .map((g) => g.rel)
      .filter((rel) => !declared.has(rel));
    expect(
      undeclared,
      'these guards read `agent/v2/loop.ts` by path with no shared corpus and no declaration. '
      + 'PHASE-6 is draining that file, so such a guard stops seeing its subject at some cut — '
      + 'and a NEGATIVE clause stops seeing it SILENTLY. Either derive the corpus from '
      + '`agent/v2/__tests__/engine-sources.ts`, or add a DRIVER_BY_PATH entry saying why this '
      + 'one cannot go quiet.',
    ).toEqual([]);
  });

  it('no guard grows a SECOND hand-rolled walk of the step packages', () => {
    const declared = new Set(STEPS_BY_PATH.map((d) => d.rel));
    const undeclared = guards
      .filter((g) => g.namesSteps && !g.usesShared)
      .map((g) => g.rel)
      .filter((rel) => !declared.has(rel));
    expect(
      undeclared,
      'these guards reach into `agent/v2/steps` by path without the shared derivation. Six '
      + 'copies of that walk existed before this audit and they are why the corpus could drift; '
      + 'import `engine-sources.ts` instead.',
    ).toEqual([]);
  });

  it('no declaration is STALE — every declared guard still exists and still names the driver', () => {
    const stale: string[] = [];
    for (const d of [...DRIVER_BY_PATH, ...STEPS_BY_PATH]) {
      const g = guards.find((x) => x.rel === d.rel);
      if (!g) { stale.push(`${d.rel} — declared, but no such guard in the tree`); continue; }
      const isDriverList = DRIVER_BY_PATH.some((x) => x.rel === d.rel);
      if (isDriverList && !g.namesDriver) {
        stale.push(`${d.rel} — declared as naming the driver by path, but it no longer does`);
      }
      if (!isDriverList && !g.namesSteps) {
        stale.push(`${d.rel} — declared as walking the step packages, but it no longer does`);
      }
    }
    expect(
      stale,
      'a declaration that no longer describes the tree is a list of lies — the same anti-rot '
      + 'rule the spine manifest and the wiring allowlist carry. Delete the entry, or fix the guard.',
    ).toEqual([]);
  });

  it('every declaration carries a real reason, not a placeholder', () => {
    const thin = [...DRIVER_BY_PATH, ...STEPS_BY_PATH]
      .filter((d) => d.why.trim().length < 80)
      .map((d) => d.rel);
    expect(thin, 'a one-word reason is how an exemption becomes permanent without argument').toEqual([]);
  });
});
