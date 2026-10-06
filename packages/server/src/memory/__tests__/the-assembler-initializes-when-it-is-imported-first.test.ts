// ════════════════════════════════════════════════════════════════════════════════════════
// THE ASSEMBLER INITIALIZES WHEN NOTHING ELSE HAS BEEN IMPORTED YET (t117).
//
// ── THE DEFECT ──
// `work/ask-settlement.ts` read `START_ACK_ORIGIN_INTENT` at MODULE SCOPE, to build a SQL
// fragment (`NOT_A_START_ACK`) as a top-level `const`. The constant was declared near the END
// of `memory/message-store.ts`, and message-store reaches ask-settlement again through its own
// dependencies:
//
//   memory/message-store → work/store → work/obligation-memory → vault/store
//     → memory/embeddings → agent/abortable-call → agent/live-work → gateway/ws
//     → agent/v2/outbound → agent/v2/deliveries → work/ask-settlement → memory/message-store
//
// So whenever message-store was the module the process entered FIRST, ESM evaluated
// ask-settlement's top level while message-store was still mid-initialization — before its
// `export const START_ACK_ORIGIN_INTENT` line had run — and the module-scope read hit the
// temporal dead zone:
//
//   Cannot access 'START_ACK_ORIGIN_INTENT' before initialization
//
// THE BOOTED SERVER NEVER SAW IT. `index.ts` happens to pull a module that finishes
// message-store before anything reaches ask-settlement's top level, so the cycle resolved by
// luck of import order. Measured on the v3.3.0 cut: 31 of the 466 modules reachable from
// `memory/assembler.ts` threw when imported first in a fresh process — the assembler itself,
// message-store itself, and 29 others.
//
// It was the release-time cacheable-prefix determinism gate
// (`deploy/check-prefix-determinism.mjs`) that paid for it. That gate imports the PACKAGED
// assembler directly, with no server boot ahead of it, so it got the throw instead of a
// prefix — and refused the release reporting that it "could not import the dist assembler".
//
// ── THE FIX THIS FILE HOLDS ──
// The `origin_intent` vocabulary moved to `memory/origin-intents.ts`, a LEAF module with no
// imports of its own. A leaf cannot be mid-initialization when anyone reads it, so the
// module-scope read is safe no matter which module the process enters first.
//
// ── WHY THESE ARMS SPAWN CHILD PROCESSES ──
// A temporal dead zone is a property of the FIRST evaluation of a module graph. By the time a
// vitest file body runs, the worker's module registry already holds message-store (every other
// test in the suite imported it), so the cycle is already resolved and an in-process import
// proves nothing — which is exactly why a suite of this size was blind to the defect for the
// life of the constant. Each arm therefore runs the repo's own `tsx` on a fresh child and
// reads its verdict off stdout.
//
// MUTANT: move `START_ACK_ORIGIN_INTENT` back into `memory/message-store.ts` (restoring the
// cycle) and arms 1-3 go red together. No import reordering can make them pass.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/server/src/memory/__tests__` → the repo root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SERVER_SRC = path.resolve(HERE, '..', '..');

/** Source with comments removed — the arms below assert about CODE, and these files discuss
 *  the very declarations they must not contain. */
const codeOf = (...seg: string[]): string =>
  fs.readFileSync(path.join(SERVER_SRC, ...seg), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/**
 * Import ONE module, first, in a fresh ESM process, and report whether its graph initialized.
 * Returns the child's verdict: `'OK'`, or `THROW|<message>`.
 */
function importsCleanlyAlone(relFromServerSrc: string): string {
  const target = path.join(SERVER_SRC, relFromServerSrc);
  expect(fs.existsSync(target), `${relFromServerSrc} exists`).toBe(true);
  expect(fs.existsSync(TSX), `the repo's own tsx is present at ${TSX}`).toBe(true);
  const r = spawnSync(TSX, ['-e', `
    import(${JSON.stringify(target)})
      .then(() => console.log('OK'))
      .catch((e) => console.log('THROW|' + (e && e.message ? String(e.message).split('\\n')[0] : String(e))));
  `], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 180_000 });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const verdict = lines.reverse().find((l) => l === 'OK' || l.startsWith('THROW|'));
  if (!verdict) {
    throw new Error(`the child printed no verdict for ${relFromServerSrc}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return verdict;
}

// ── THE GRAPH, AND A POOLED PROBE OVER IT (the census arm below) ────────────────────────────
/** Resolve a `./x.js` specifier written in TypeScript back to the `.ts` file it means. */
function resolveTs(p: string): string | null {
  for (const c of [p, p.replace(/\.js$/, '.ts'), p.replace(/\.js$/, '/index.ts'), `${p}.ts`, `${p}/index.ts`]) {
    if (c.endsWith('.ts') && fs.existsSync(c)) return c;
  }
  return null;
}

const importCache = new Map<string, string[]>();
/** The relative VALUE imports of one module. `import type` is skipped: it is erased at compile
 *  time, so it cannot evaluate anything and cannot take part in a dead zone. */
function relativeValueImports(file: string): string[] {
  const hit = importCache.get(file);
  if (hit) return hit;
  const src = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const re of [
    /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^;'"]*?from\s*['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g,
  ]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  const resolved = [...new Set(out.map((r) => resolveTs(path.resolve(path.dirname(file), r))).filter(
    (x): x is string => x !== null))];
  importCache.set(file, resolved);
  return resolved;
}

/** Every module reachable from `memory/assembler.ts` by relative value imports, itself included. */
function assemblerGraph(): string[] {
  const seen = new Set<string>();
  const stack = [path.join(SERVER_SRC, 'memory', 'assembler.ts')];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of relativeValueImports(cur)) stack.push(n);
  }
  return [...seen].sort();
}

/** Probe many modules, each FIRST in its own fresh process, a few at a time. Returns the ones
 *  that threw, keyed by their path relative to `src/`, with the first line of the throw. */
async function censusOfFirstImportThrows(modules: string[], concurrency = 12): Promise<Map<string, string>> {
  const throwers = new Map<string, string>();
  const queue = [...modules];
  const child = (target: string) => new Promise<void>((resolve) => {
    const proc = spawn(TSX, ['-e', `import(${JSON.stringify(target)})`
      + `.then(() => console.log('OK'))`
      + `.catch((e) => console.log('THROW|' + String((e && e.message) || e).split(String.fromCharCode(10))[0]))`],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    const hardStop = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.on('close', () => {
      clearTimeout(hardStop);
      const rel = path.relative(SERVER_SRC, target);
      const verdict = out.trim().split('\n').reverse().find((l) => l === 'OK' || l.startsWith('THROW|'));
      // No verdict at all is NOT silently a pass: the child died without answering.
      if (!verdict) throwers.set(rel, 'no verdict — the child died without answering');
      else if (verdict.startsWith('THROW|')) throwers.set(rel, verdict.slice('THROW|'.length));
      resolve();
    });
  });
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) await child(queue.shift()!);
  }));
  return throwers;
}

describe('a module in the assembler graph can be the first thing a process imports', () => {
  // ARM 1 — the gate's own entry point. This is the import that refused the v3.3.0 release.
  it('memory/assembler.ts initializes when imported first in a fresh process', () => {
    expect(importsCleanlyAlone('memory/assembler.ts')).toBe('OK');
  }, 200_000);

  // ARM 2 — the other side of the cycle. message-store is the module whose mid-init state the
  // module-scope read used to observe, so it must be safe as an entry point too.
  it('memory/message-store.ts initializes when imported first in a fresh process', () => {
    expect(importsCleanlyAlone('memory/message-store.ts')).toBe('OK');
  }, 200_000);

  // ARM 3 — the settlement authority, which owns the module-scope read itself. This arm is the
  // CONTROL: it passed even with the defect in place, because entering ask-settlement first
  // finishes message-store before ask-settlement's own top level runs. That is precisely the
  // luck of import order the booted server was living on, and why arms 1 and 2 exist.
  it('work/ask-settlement.ts initializes when imported first in a fresh process', () => {
    expect(importsCleanlyAlone('work/ask-settlement.ts')).toBe('OK');
  }, 200_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE SAME DEFECT, ONE FILE OVER — AND WHY IT IS HELD HERE RATHER THAN IN ITS OWN FILE.
//
// The sweep that found the constant above imported each of the 466 modules reachable from
// `memory/assembler.ts` first, alone, in a fresh process. 33 threw. Fixing the origin-intent
// read took 31 of them green and UNMASKED the 33rd: `scheduler/runner.ts` could never be a
// first import either, because `tracker/pm-agent.ts` derives `VALIDATION_COVERAGE_BOUND_MS`
// from `runner`'s `VALIDATION_ESCALATION_MIN` at module scope while `runner` reaches `pm-agent`
// back through its own graph. Identical shape, identical fix: the clock moved to the leaf
// `scheduler/validation-clock.ts`.
//
// It is held in THIS file because it is the same defect and the same proof: a cycle that
// resolves by luck of import order. The arms below are the ones that were masked.
//
// MUTANT: move `VALIDATION_ESCALATION_MIN` back into `scheduler/runner.ts` and both arms red.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the owner-escalation clock is readable from module scope too', () => {
  it('scheduler/runner.ts initializes when imported first in a fresh process', () => {
    expect(importsCleanlyAlone('scheduler/runner.ts')).toBe('OK');
  }, 200_000);

  it('tracker/pm-agent.ts initializes when imported first in a fresh process', () => {
    expect(importsCleanlyAlone('tracker/pm-agent.ts')).toBe('OK');
  }, 200_000);

  it('scheduler/validation-clock.ts is a leaf — it imports nothing', () => {
    const stripped = codeOf('scheduler', 'validation-clock.ts');
    expect([...stripped.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([]);
    expect(stripped).not.toMatch(/^\s*import\s*['"]/m);
  });

  // Again the DECLARATION, not the import path — see the note on the origin-intent arm below.
  it('runner.ts re-exports the clock and declares no second one', () => {
    const src = codeOf('scheduler', 'runner.ts');
    expect(src, 'VALIDATION_ESCALATION_MIN is not declared in runner.ts')
      .not.toMatch(/(export\s+)?(const|let|var)\s+VALIDATION_ESCALATION_MIN\s*=/);
  });
});

describe('the origin-intent vocabulary stays readable from module scope', () => {
  // The STRUCTURAL half: a leaf cannot be mid-initialization when someone reads it. If the
  // vocabulary ever acquires an import of its own, it stops being a leaf and the TDZ can
  // return under some other first-import order that no arm above happens to name.
  it('memory/origin-intents.ts is a leaf — it imports nothing', () => {
    const stripped = codeOf('memory', 'origin-intents.ts');
    const specifiers = [...stripped.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers, 'origin-intents.ts imports nothing').toEqual([]);
    expect(stripped, 'and runs no side effect at import time').not.toMatch(/^\s*import\s*['"]/m);
  });

  // WHERE THE CONSTANT IS DECLARED is the load-bearing fact, and the only one. Measured while
  // building this file: pointing ask-settlement's import back at `message-store` does NOT bring
  // the dead zone back, because an ESM re-export binds the importer to the LEAF's binding —
  // the arms above stay green. What does bring it back is a `const` in `message-store` itself.
  // So this arm guards the declaration rather than the import path, and `message-store` is
  // free to go on re-exporting the vocabulary for the readers that have always read it there.
  it('message-store.ts re-exports the vocabulary and declares none of it', () => {
    const src = codeOf('memory', 'message-store.ts');
    for (const name of ['START_ACK_ORIGIN_INTENT', 'AGENT_BUS_INTENT']) {
      expect(src, `${name} is not declared in message-store.ts`)
        .not.toMatch(new RegExp(`(export\\s+)?(const|let|var)\\s+${name}\\s*=`));
    }
    // and the value itself is not re-spelled here either
    expect(src, 'message-store.ts does not re-spell the value').not.toContain("'engine_start_ack'");
  });
});


// ════════════════════════════════════════════════════════════════════════════════════════
// THE CENSUS — THE SET OF MODULES THAT CANNOT BE A FIRST IMPORT IS EXACTLY SIX, AND NAMED.
//
// ── WHY A CENSUS AND NOT ANOTHER PER-MODULE ARM ──
// The two fixes above each took a whole FAMILY of entry points green (31 and 1 of the 33 that
// threw when the defect was found). What remains is a third family — the provider tool-definition
// arrays — and the review of this lane established the fact that makes an unwatched latent
// defect unacceptable here:
//
//   **the six ARE inside the gate's runtime import closure.** They are not unreachable.
//   `memory/assembler.ts -> prompt/assembler.ts -> agent/tools/definitions.ts -> google/tools-read.ts`
//   is all value imports, as is the longer chain to `agent/tools/index.ts`, whose module-scope
//   read is the one that throws. The prefix gate passes only on EVALUATION ORDER: entering
//   through the assembler, `agent/tools/definitions.ts` fully initializes the provider module
//   before `agent/tools/index.ts` runs its read.
//
// That is the same species of luck the rest of this file exists to remove, sitting one import
// away from a release gate. It is not fixed here because it genuinely is not one commit away —
// these are large arrays MUTATED at module scope in several passes inside their own files and
// then aggregated, so the module-scope assembly has to become a function, which is its own lane.
//
// So it is MEASURED instead of left unwatched. This arm walks the assembler's whole graph,
// imports every module first in a fresh process, and asserts the throwing set is EXACTLY the six
// below. It bites in both directions, which is the point:
//
//   • a SEVENTH thrower — a new module-scope read into a cycle anywhere in the graph — reds here,
//     immediately, instead of waiting for some future consumer to import it first;
//   • and the day the v3.3.1 lane fixes these six, this arm goes red too and DEMANDS its own
//     update. A latent defect cannot be quietly inherited or quietly fixed.
//
// MUTANT: give any module in the graph a module-scope read of a binding from a module that
// imports it back, and the census reds naming that module as an unexpected thrower.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The known-bad set, at the time of t117. Each entry is the module and the identifier whose
 * temporal dead zone it hits — the identifier is held too, so that the SAME file acquiring a
 * DIFFERENT module-scope defect is still a red rather than a silent pass.
 *
 * All six resolve through `agent/tools/index.ts`, whose module-scope read of the provider
 * definition arrays is the actual offender. OWNED BY: the v3.3.1 provider tool-definition lane.
 */
const KNOWN_FIRST_IMPORT_THROWERS: ReadonlyArray<readonly [string, string]> = [
  ['agent/tools/provider/google.ts', 'googleReadToolDefinitions'],
  ['agent/tools/provider/microsoft.ts', 'microsoftReadToolDefinitions'],
  ['google/tools-read.ts', 'googleReadToolDefinitions'],
  ['google/tools-write.ts', 'googleWriteToolDefinitions'],
  ['microsoft/tools-read.ts', 'microsoftReadToolDefinitions'],
  ['microsoft/tools-write.ts', 'microsoftWriteToolDefinitions'],
];

describe('the census of modules that cannot be a first import', () => {
  it('is EXACTLY the six known provider tool-definition modules', async () => {
    const graph = assemblerGraph();

    // A broken enumerator must not make this arm vacuously true: the graph is large and
    // certainly contains the modules the arms above name individually.
    expect(graph.length, 'the assembler graph is enumerated').toBeGreaterThan(400);
    for (const must of ['memory/assembler.ts', 'memory/message-store.ts', 'work/ask-settlement.ts',
      'scheduler/runner.ts', 'tracker/pm-agent.ts', 'agent/tools/index.ts']) {
      expect(graph.map((g) => path.relative(SERVER_SRC, g)), `graph contains ${must}`).toContain(must);
    }
    // And the six it is about are genuinely IN the gate's closure — the review's load-bearing
    // correction. If a refactor ever takes them out, this arm must be re-argued, not relaxed.
    for (const [mod] of KNOWN_FIRST_IMPORT_THROWERS) {
      expect(graph.map((g) => path.relative(SERVER_SRC, g)), `graph contains ${mod}`).toContain(mod);
    }

    const throwers = await censusOfFirstImportThrows(graph);

    const expectedMods = KNOWN_FIRST_IMPORT_THROWERS.map(([m]) => m).sort();
    const actualMods = [...throwers.keys()].sort();

    // Report the difference in both directions, by name, so a failure is actionable.
    const unexpected = actualMods.filter((m) => !expectedMods.includes(m));
    const repaired = expectedMods.filter((m) => !actualMods.includes(m));
    expect(unexpected.map((m) => `${m} :: ${throwers.get(m)}`),
      'NEW module-scope dead zone(s) — a cycle that works today only by luck of import order')
      .toEqual([]);
    expect(repaired,
      'these no longer throw: the provider lane landed, so update KNOWN_FIRST_IMPORT_THROWERS')
      .toEqual([]);
    expect(actualMods, 'the census is exactly the known set').toEqual(expectedMods);

    // Same file, different defect, is still a red.
    for (const [mod, identifier] of KNOWN_FIRST_IMPORT_THROWERS) {
      expect(throwers.get(mod), `${mod} throws on ${identifier}`)
        .toBe(`Cannot access '${identifier}' before initialization`);
    }
  }, 900_000);
});
