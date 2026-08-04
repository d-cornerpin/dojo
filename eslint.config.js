// ════════════════════════════════════════
// The repo's first-ever eslint config (Phase 0 T3).
//
// WARN-ONLY, ON PURPOSE. This codebase has hundreds of pre-existing findings
// for these five rules. Turning any of them into an error today would make the
// tree unshippable, and an unshippable gate gets bypassed, then deleted. So the
// severity is `warn` and the ENFORCEMENT lives elsewhere: lint-baseline.json
// pins today's per-rule counts and deploy/checks/check-lint-baseline.mjs fails
// the build if any of them rises. The findings can only go down. That ratchet
// is the mechanism — not the severity.
//
// Scope is packages/server/src only. Step 1 of the plan says "server package
// first"; widening the scope later is a deliberate, reviewable edit that shows
// up as new baseline entries, exactly like a ratchet ceiling raise.
//
// Test files are excluded because packages/server/tsconfig.json excludes them,
// and the type-aware rules below need every linted file to belong to that
// project. The two exclusions must stay in sync.
//
// EVERY invocation that feeds a number passes `--no-inline-config`. A
// decrease-only baseline that a `// eslint-disable-next-line no-empty` comment
// can lower is not a ratchet, it is a suggestion; with the flag, a finding can
// only leave the count by being FIXED. (The flag lives in the npm scripts and in
// check-lint-baseline.mjs rather than in `linterOptions.noInlineConfig` here,
// because the config-level switch makes ESLint emit a fresh warning for every
// directive it ignored — 52 of them — which is the noise we are removing.)
//
// Run:  npm run lint          (human-readable)
//       npm run gates         (the ratchet — this is what refuses)
// ════════════════════════════════════════
import tseslint from 'typescript-eslint';
import { EFFECT_IMPORT_EXCLUDED_FILES } from './deploy/checks/effect-import-exclusions.mjs';

// Node builtins that reach the filesystem or spawn processes. ENFORCED as of
// PHASE-5 T8 Step 4: everything an agent can reach performs its fs/proc work
// through `agent/effects/*`, behind the per-call capability the executor's gate
// loop mints. The exceptions are a NAMED LIST with a reason each, imported
// above, and `check-lint-baseline.mjs` censuses that list on every gate run.
const RESTRICTED_EFFECT_MODULES = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
];

export default [
  {
    // Never lint build output, deps, or the packaged deploy tree.
    ignores: ['**/node_modules/**', '**/dist/**', 'deploy/dist/**'],
  },
  {
    files: ['packages/server/src/**/*.ts'],
    ignores: ['packages/server/src/**/__tests__/**', 'packages/server/src/**/*.test.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware linting: no-floating-promises cannot work without it.
        // A misconfigured project here reports ZERO findings silently, which is
        // why the baseline check treats a 0 for that rule as a config bug.
        project: ['./packages/server/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    linterOptions: {
      // The tree already carries 52 `eslint-disable` comments (written before
      // this config existed; every one of them names a rule this config does not
      // enable). Reporting each as "unused" would put 52 findings about a MISSING
      // config into a baseline that is supposed to describe the CODE.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // A promise nobody awaits is a turn that ends before its work does — the
      // exact shape of "it said it sent the message and nothing arrived".
      '@typescript-eslint/no-floating-promises': 'warn',

      // fs/proc reached directly instead of through the effect facade.
      //
      // ⚠ ENFORCED — PHASE-5 T8 Step 4. This was advisory for the whole of
      // Phase 5 for a stated reason: the brokers AUTHORIZE a declared effect and
      // did not PERFORM the I/O, so an authorized handler still had to call `fs`
      // itself and the rule counted that call's import. RULING P5-R12 recorded
      // the measurement instead of gaming the number, and T8 built the missing
      // half — `agent/effects/*` performs the work behind a per-call capability
      // the gate loop mints from the tool's own declared effects.
      //
      // So the requirement the rule stands for is now expressible: *nothing an
      // agent can reach touches fs/proc except through the facade*. It is an
      // ERROR here, and the exceptions are the NAMED list in
      // `deploy/checks/effect-import-exclusions.mjs` — every entry with its class
      // and its reason, and every honest-label entry with its stated residual.
      //
      // NEVER A DIRECTORY HEURISTIC, and that is measured rather than stylistic:
      // 33 of the 37 platform-internal files are reachable in the import graph
      // from `agent/tools/**`, because `logger.ts` and `db/connection.ts` are
      // reachable from everything. A computed set excludes nearly the whole tree
      // or nothing at all. The question is what the CALL acts on, not what the
      // module graph permits — so it is written down, and censused.
      'no-restricted-imports': [
        'error',
        {
          paths: RESTRICTED_EFFECT_MODULES.map((name) => ({
            name,
            message:
              'Direct fs/proc access from a module an agent can reach. Perform the work through `agent/effects/fs.ts` ' +
              'or `agent/effects/proc.ts`, which do it only on a resource the per-call capability names — the tool ' +
              'declares the effect, the gate loop resolves it, the facade carries it. If this really is platform ' +
              'machinery no agent can influence, add it to deploy/checks/effect-import-exclusions.mjs WITH ITS ' +
              'REASON; that edit is meant to be seen and reviewed.',
          })),
        },
      ],

      // A `let` that is never reassigned reads as "this changes" and it does not.
      'prefer-const': 'warn',

      // `x === "a" || "b"`, `!x && y === undefined` — expressions with a constant
      // result. Always a bug, never a style opinion.
      'no-constant-binary-expression': 'warn',

      // Empty blocks, catch blocks included (allowEmptyCatch stays false): a
      // swallowed error is how a failure becomes a silence.
      'no-empty': 'warn',
    },
  },
  {
    // ── THE NAMED EXCEPTIONS (PHASE-5 T8 Step 4) ──
    //
    // These files keep the import ON PURPOSE, each for a reason written beside
    // it in `deploy/checks/effect-import-exclusions.mjs`. The severity drops to
    // `warn` rather than `off` deliberately: `lint-baseline.json` keeps counting
    // them, so the pin still may only FALL and a class that stops shrinking is
    // visible. Turning them off would delete the measurement along with the
    // refusal, and the direction is the thing that has protected this surface
    // for five phases.
    files: EFFECT_IMPORT_EXCLUDED_FILES.map((f) => `packages/server/src/${f}`),
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          paths: RESTRICTED_EFFECT_MODULES.map((name) => ({
            name,
            message:
              'Named exception, counted but not refused — see deploy/checks/effect-import-exclusions.mjs for this ' +
              "file's class, its reason, and (for an honest label) the residual it carries.",
          })),
        },
      ],
    },
  },
];
