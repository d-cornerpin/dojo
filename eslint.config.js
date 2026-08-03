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

// Node builtins that reach the filesystem or spawn processes. ADVISORY until
// Phase 5, which rebuilds these behind fs/proc brokers — at that point the
// baseline should be near zero and this rule flips to `error`. Counting them
// now means Phase 5 starts from a measured surface instead of a guess.
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

      // fs/proc reached directly instead of through a broker (Phase 5).
      //
      // ⚠ WHAT THIS COUNT IS, AFTER PHASE-5 T7 READ ALL 95 SITES (RULING P5-R12).
      // The rule counts IMPORT STATEMENTS; the requirement is *nothing an agent
      // can reach touches fs/proc/net except through a broker*. Those are not the
      // same measurement, and the classification says why: of the 95 sites, 37
      // act on a resource the AGENT NAMES (a path, a command, a URL out of tool
      // arguments), 17 are reachable from a tool call but act on a PLATFORM
      // LITERAL the agent cannot influence (self-update, voice models, the
      // tunnel pidfile), and 41 are platform-internal with no tool path at all
      // (boot, migration, logging, the dashboard's own routes).
      //
      // The rule cannot be flipped to 'error' without either inventing a
      // threshold or routing platform machinery through agent-facing brokers,
      // which would make the number LIE about the surface it exists to measure.
      // It stays advisory, and the BASELINE keeps the direction enforced: the
      // count may only fall, and a raise is a reviewed by-hand edit that has to
      // say what it measured and refused. The flip needs an fs/proc facade that
      // performs the I/O behind the brokers, which no plan builds today —
      // recorded in lint-baseline.json's $classification entry with its command.
      'no-restricted-imports': [
        'warn',
        {
          paths: RESTRICTED_EFFECT_MODULES.map((name) => ({
            name,
            message:
              'Direct fs/proc access. The brokers AUTHORIZE a declared effect; they do not perform the I/O, so an ' +
              'import here is not by itself a hole — see eslint.config.js above this rule and lint-baseline.json ' +
              '$classification for what the 95 sites actually are. Advisory, and the baseline may only fall.',
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
];
