// ════════════════════════════════════════════════════════════════════════════════════════
// THE ENGINE'S SOURCE, DERIVED ONCE — PHASE-6 GUARD-AUDIT (2026-08-04)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS FILE EXISTS. PHASE-6 cuts `agent/v2/loop.ts` into step packages under
// `agent/v2/steps/<name>/`, one tranche at a time. A guard that reads the DRIVER BY PATH
// stops seeing its subject the moment that subject moves — and the dangerous half is that
// it does not go red. It goes QUIET:
//
//   · a negative clause (`expect(offenders).toEqual([])`, `expect(src).not.toMatch(...)`)
//     passes over a corpus that no longer contains the thing it forbids;
//   · an `indexOf`-based ORDER clause compares two `-1`s, or a `-1` against a real
//     position, and reports agreement it never checked.
//
// CUT 2 (T9b) found the first live instance — `two-key-conformance`'s KEY-1 walk stopped
// seeing the engine's own privileged `status='complete'` writer and nothing failed. The
// GUARD-AUDIT that followed enumerated every guard in both repos that scans product source
// and found the class was not one file: SIX guards had each hand-rolled their own copy of
// "the driver plus the step packages", and twelve more still read the driver alone.
//
// SIX COPIES IS FIVE TOO MANY: each one is a place the corpus can drift, and a corpus that
// drifts silently is the same defect one level up. This module is the single derivation.
//
// ════ WHAT "THE ENGINE" MEANS HERE ════
// The driver (`agent/v2/loop.ts`) PLUS every non-test `.ts` under `agent/v2/steps/`. That
// is the set a tranche moves code WITHIN, so a clause written against it keeps holding
// across all nine cuts BY CONSTRUCTION rather than being repaired nine times.
//
// It deliberately does NOT include the rest of `agent/v2/` (`counterparty.ts`,
// `state.ts`, `receipt.ts`, …). Those are the engine's collaborators, not the turn body,
// and no tranche moves code into them. A guard that wants one of those reads it by name —
// naming a file that is not moving is correct, and this module is not a reason to widen a
// corpus past its subject.
//
// ════ THE ORDER TRAP, AND WHY `engineFileContaining` EXISTS ════
// CUT 2 hit this and recorded it: once the corpus is a JOIN of files, comparing two
// `indexOf` positions measures the order the FILES WERE CONCATENATED IN, not the order the
// engine executes. Any clause asserting that A appears before B must first establish that A
// and B are in the SAME FILE — `engineFileContaining` is how, and a clause that splits
// across a tranche boundary then fails LOUDLY instead of quietly measuring nothing.
//
// ════ NON-VACUITY IS THIS MODULE'S OWN JOB ════
// Every accessor below refuses an empty or impossible corpus by throwing. A guard that
// derives its corpus from here cannot pass because the derivation broke — which is the
// failure mode the audit exists to remove, and it would be absurd to re-introduce it in the
// module built to remove it.
// ════════════════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `packages/server/src` — this file lives at `agent/v2/__tests__/`. */
export const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The driver, relative to `SERVER_SRC`. */
export const ENGINE_DRIVER_REL = 'agent/v2/loop.ts';

/** The step packages' root, relative to `SERVER_SRC`. */
export const ENGINE_STEPS_REL = 'agent/v2/steps';

export interface EngineSource {
  /** Path relative to `packages/server/src`, POSIX-separated. */
  rel: string;
  text: string;
}

function isProductionTs(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts');
}

/**
 * Every step-package source file, relative to `SERVER_SRC`, sorted.
 *
 * Recursive on purpose: RULING P6-R1 made a step a DIRECTORY (an entry point plus
 * sub-modules), so a non-recursive read would see `index.ts` and miss the rest — which is
 * the same quiet defect in a smaller costume.
 */
export function stepPackageFiles(): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    const abs = path.join(SERVER_SRC, relDir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') walk(`${relDir}/${e.name}`);
        continue;
      }
      if (isProductionTs(e.name)) out.push(`${relDir}/${e.name}`);
    }
  };
  walk(ENGINE_STEPS_REL);
  return out.sort();
}

/**
 * The engine's sources: the driver first, then every step file.
 *
 * Throws if the driver is missing — a guard must never silently scan a corpus with no
 * driver in it.
 */
export function engineSources(): EngineSource[] {
  const driverAbs = path.join(SERVER_SRC, ENGINE_DRIVER_REL);
  if (!fs.existsSync(driverAbs)) {
    throw new Error(
      `engine-sources: the driver is not at ${ENGINE_DRIVER_REL}. If it MOVED, this module is ` +
      'the one place to re-point — every guard derives its engine corpus from here. Refusing ' +
      'to return a corpus without it, because a scan over the step packages alone would pass ' +
      'quietly on everything the driver still owns.',
    );
  }
  const out: EngineSource[] = [{ rel: ENGINE_DRIVER_REL, text: fs.readFileSync(driverAbs, 'utf8') }];
  for (const rel of stepPackageFiles()) {
    out.push({ rel, text: fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8') });
  }
  return out;
}

/** Relative paths of the engine's sources — the driver plus the step files. */
export function engineFiles(): string[] {
  return engineSources().map((s) => s.rel);
}

/**
 * The engine's source as ONE string, files joined by a newline.
 *
 * Use for presence, absence and count clauses. **Do not use for ORDER clauses** — see the
 * header's order trap and use `engineFileContaining` instead.
 */
export function engineText(): string {
  return engineSources().map((s) => s.text).join('\n');
}

/**
 * The ONE engine file containing `needle`, or `null` if no file does.
 *
 * Throws when more than one file contains it: a clause that asks "where does this live"
 * cannot be answered honestly with two answers, and silently taking the first is how an
 * order clause starts measuring the wrong pair.
 */
export function engineFileContaining(needle: string): EngineSource | null {
  const hits = engineSources().filter((s) => s.text.includes(needle));
  if (hits.length > 1) {
    throw new Error(
      `engine-sources: ${JSON.stringify(needle)} appears in ${hits.length} engine files ` +
      `(${hits.map((h) => h.rel).join(', ')}). A clause that locates a single site must say ` +
      'which one it means.',
    );
  }
  return hits[0] ?? null;
}

/**
 * Assert that two needles live in the SAME engine file, and return that file.
 *
 * This is the order trap's guard rail, made compulsory by making it the only convenient way
 * to get two positions. When a tranche splits the pair, this throws with both homes named —
 * loudly, which is the entire point.
 */
export function engineFileWithBoth(a: string, b: string): EngineSource {
  const fa = engineFileContaining(a);
  const fb = engineFileContaining(b);
  if (!fa) throw new Error(`engine-sources: ${JSON.stringify(a)} is in no engine file — the site was renamed or removed.`);
  if (!fb) throw new Error(`engine-sources: ${JSON.stringify(b)} is in no engine file — the site was renamed or removed.`);
  if (fa.rel !== fb.rel) {
    throw new Error(
      `engine-sources: ${JSON.stringify(a)} is in ${fa.rel} but ${JSON.stringify(b)} is in ${fb.rel}. ` +
      'An order between them cannot be read off a concatenated corpus — it would measure the ' +
      'order the FILES were joined in. Re-state the clause against whatever now sequences them.',
    );
  }
  return fa;
}
