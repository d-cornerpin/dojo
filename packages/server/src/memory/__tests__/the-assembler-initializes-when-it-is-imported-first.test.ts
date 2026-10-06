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
import { spawnSync } from 'node:child_process';
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
