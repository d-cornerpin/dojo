#!/usr/bin/env node
// ════════════════════════════════════════
// THE GATE MANIFEST — one declared list, both consumers.
//
// ── WHY THIS EXISTS ──
// There were two hand-maintained lists of the same gates: `package.json`'s
// `gates:block` / `gates:report` scripts, and `deploy/release.sh`'s hand-written
// steps. The ONLY thing binding them was a hand-typed `N/10` in a release.sh comment.
//
// That is not a hypothetical: PHASE-1 T11 built `check-watchdog-sql.mjs` (renamed
// `check-sql-prepares.mjs` at the T8G merge — see that entry) and wired it
// into `npm run gates:block` but NOT into release.sh — so the one path that publishes
// to a user's box was the one path that did not run it. It was found by T13 counting
// the tiers BY HAND (package.json had 9 blocking checks, release.sh described 8), and
// release.sh:355-363 still says so in its own words. A gate that only runs on the
// developer's machine is a gate the release does not have.
//
// So the list lives here, once. `package.json` runs it through `run-gates.mjs`;
// `release.sh` reads it with `--emit` and runs each entry with its own `step`/`fail`.
// `check-gate-manifest.mjs` refuses when a `deploy/checks/check-*.mjs` file exists
// that this list does not name, when either consumer stops reading this list, or when
// a declared release-only gate has vanished from release.sh.
//
// ── THE THREE TIERS, AND WHY release.sh RUNS MORE THAN `npm run gates` ──
//   blocking      both consumers. Refuses the build and refuses the release.
//   report        both consumers. Measures and records; never blocks (non-negotiable
//                 #7 — no phase passes or fails on a line count).
//   release-only  release.sh ONLY, and DECLARED here rather than omitted, because
//                 "the lists differ" must be a readable fact instead of a discrepancy
//                 someone re-derives by counting. Each needs something `npm run gates`
//                 does not have: a packaged artifact, a live smoke server, a full
//                 build, or a recorded marker tied to HEAD.
//
// ── PHASE ──
// `pre-build` runs in release.sh's opening gate block. `post-smoke` needs the packaged
// build already smoke-booted, so release.sh invokes it inline at that point and this
// manifest records that it does. `n/a` is for release-only entries whose runner is
// release.sh's own shell (a `cd`, an env, a subshell) rather than a plain node call.
// ════════════════════════════════════════

export const GATES = [
  // ════════ blocking ════════
  {
    id: 'gate-manifest',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-gate-manifest.mjs',
    args: [],
    title: 'Gate-manifest conformance (one declared list, both consumers read it)',
    fail: 'Gate-manifest conformance: a checker no list names, a consumer that stopped reading the manifest, or a declared release-only gate missing from this file. NOT publishing.',
    why: 'First in the chain on purpose: every gate after it is named by the list this one checks. It is the replacement for the hand-typed `N/10` comment that used to be the only binding between package.json and release.sh.',
  },
  {
    id: 'byte-hygiene',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-bytes.mjs',
    args: [],
    title: 'Byte-hygiene gate (no bytes that blind grep or deceive review)',
    fail: 'Byte-hygiene gate: tracked source carries NUL/control/bidi/zero-width bytes. NOT publishing.',
    why: 'NUL and C0 control bytes make a file BINARY to plain grep, which then reports no match and looks clean — that is how the dev-instrument ship gate spent months blind to the two largest files in this tree. Bidi/zero-width characters are the render-time version of the same trick. Early in the chain on purpose: every gate after it greps something.',
  },
  {
    id: 'size-ratchets',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-ratchets.mjs',
    args: [],
    title: 'Size-ratchet gate (files may only shrink; new files may not balloon)',
    fail: 'Size-ratchet gate: a pinned file grew past its ratchet, a pinned file vanished without its manifest entry, or an unlisted new file exceeded the cap. NOT publishing.',
    why: 'The overhaul exists to shrink this codebase, and nothing shrinks by itself: the god files got that way one "just five more lines" at a time, over two years, with no gate that could see it. ratchets.json pins every large source file at its measured wc -l; a pinned file may shrink but never exceed its pin, and any unlisted source file above the new-file cap fails too. Reads SOURCE, not the packaged dist.',
  },
  {
    id: 'growth-detector',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-growth.mjs',
    args: [],
    title: 'Growth-detector gate (no file balloons past its recorded baseline)',
    fail: 'Growth-detector gate: a file grew >25% above its baseline, or an unlisted file crossed 60% of the new-file cap. NOT publishing.',
    why: 'The ratchet governs files it already knows about. This is the other half: a file more than 25% above its recorded baseline, or a NEW unlisted file that crosses 60% of the new-file cap, fails — so a god file is argued about while it is still cheap to argue about, not after it passes 400 lines.',
  },
  {
    id: 'lint-baseline',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-lint-baseline.mjs',
    args: [],
    title: 'Lint-baseline gate (per-rule finding counts are decrease-only)',
    fail: 'Lint-baseline gate: an eslint rule or unused-symbol diagnostic rose above its pinned count in lint-baseline.json. NOT publishing.',
    why: 'The eslint rules are all `warn` because the tree has hundreds of pre-existing findings and error-mode would be unshippable — so lint-baseline.json is the enforcement instead: every count is pinned PER RULE and may only fall. Slower than the others (type-aware eslint plus a full tsc pass) and still never skippable: a gate that only runs on the good days is a habit, not a gate.',
  },
  {
    id: 'orphan-structures',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-orphans.mjs',
    args: [],
    title: 'Orphan-structure gate (no undeclared work-shaped table; every spine structure read, waived or owed)',
    fail: 'Orphan-structure gate: an undeclared work-shaped table, a manifest entry that stopped describing the schema, or a spine structure with no production reader and no dated disposition. NOT publishing.',
    why: 'Two rules, one checker. The spine READER rule was log-only through Phases 0 and 1 and BLOCKS from the PHASE-1 exit (2026-07-28, T13). The flip changed the checker\'s DEFAULT rather than adding an env var to the invocation, and that was the point: this invocation passes no environment, so an env-var-only flip would have left the release path measuring nothing. The WORK-SHAPED TABLE rule blocks from day one: any table carrying an agent link and a state column must be declared in spine-manifest.json, which is the machine check for the plan\'s own falsifier. Reads SOURCE and the migration chain, never the live ~/.dojo database.',
  },
  {
    id: 'module-wiring',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-wiring.mjs',
    args: [],
    title: 'Module wiring walk (no unreached production file without a dated allowlist line)',
    fail: 'Wiring walk: a production file no entry point reaches with no allowlist entry, a stale allowlist entry, a missing entry point, or an unresolved relative import. NOT publishing.',
    why: 'The orphan gate works a column at a time and cannot see a WHOLE MODULE that no longer hangs off any entry point. This walk does: it starts at the four real entry points and reports the production files it never reaches. It refuses a NEW unreached file, a stale allowlist entry, a missing entry point, and an unresolved relative import (a hole in the walk means the lists cannot be trusted). It never asks anyone to delete anything: the fix is to wire the file or write down why it survives.',
  },
  {
    id: 'watchdog-contract',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-watchdog-contract.mjs',
    args: [],
    title: 'Watchdog/platform contract gate (hand-synced copies must not drift)',
    fail: 'Watchdog contract gate: the hand-synced update-state copies disagree, a new undeclared copy appeared, or watchdog/src imported platform code. NOT publishing.',
    why: 'The watchdog must keep working while the platform will not boot, so it cannot import platform code — which means the update-state contract (boot-attempt limit, wall clock, rollback cap, phase names, marker shape) is HAND-COPIED into both packages with a comment as the only thing binding them. If the copies drift, nothing fails and nothing warns; the divergence surfaces during a failed self-update, i.e. on a user\'s box, mid-incident, deciding whether to roll back. This gate is the binding.',
  },
  {
    id: 'sql-prepares',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-sql-prepares.mjs',
    args: [],
    title: 'SQL-prepares gate (every statement in the tree prepares against the migrated schema)',
    fail: 'SQL-prepares gate: a statement does not prepare against the schema the migration chain produces. NOT publishing.',
    why: 'ADDED AT THE PHASE-1 EXIT AND THE GAP IS THE POINT: T11 built this check and wired it into `npm run gates:block`, but not into the release stack — so the one path that publishes to a user\'s box was the one path that did not run it. That gap is the reason this manifest exists. T10 found both halves of watchdog supervision silently dead for a day because `watchdog/` sits outside every `packages/` scan; PHASE-3 T8G took the gate whole-tree (1,800 statements) after fixing five defects in the guard itself. Repo contained: the live ~/.dojo database is never consulted.',
  },
  {
    id: 'waiver-budget',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-waivers.mjs',
    args: [],
    title: 'Waiver-budget gate (counted Gate-Waiver trailers across the arc)',
    fail: 'Waiver-budget gate: more waivers across this arc than the budget allows. The gate being waived is the thing to fix. NOT publishing.',
    why: 'The pre-committed consequence for "gates get waived": every waiver is a counted commit trailer, and more than ~5 across an arc means the RULE is wrong. Over budget the finding is a mis-scoped gate to re-aim, never a habit to hide.',
  },
  {
    id: 'upgrade-bypass',
    tier: 'blocking',
    phase: 'post-smoke',
    script: 'deploy/checks/check-upgrade-bypass.mjs',
    args: [],
    releaseArgs: ['"$SMOKE_PORT"', '--require-live'],
    title: 'Upgrade-header auth-bypass gate (asked of the packaged artifact, live)',
    fail: 'Upgrade-header auth-bypass gate: the packaged build let an untokened request through, or no server answered. NOT publishing.',
    why: 'Blocking in BOTH consumers, but it cannot run in the opening block: it asks the PACKAGED ARTIFACT just smoke-booted, not the working tree, because the compiled thing being shipped is what a user runs. `--require-live` turns the offline SKIP (correct for `npm run gates`) into a failure, because a release that could not ask the question must not answer it. release.sh therefore invokes it inline after the smoke boot; that is recorded here so the difference is declared rather than discovered.',
  },

  // ════════ report ════════
  // Never blocks, always recorded. Non-negotiable #7: no phase passes or fails on a
  // line count, but a net-positive phase owes an accounting, and the accounting starts
  // with the numbers being IN the release record instead of on a terminal nobody kept.
  {
    id: 'iso-writes',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-iso-writes.mjs',
    args: [],
    title: 'ISO-write instrument (mixed timestamp formats)',
    why: 'Measures the remaining ISO-string time writes against the epoch-ms convention.',
  },
  {
    id: 'status-fresh',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-status-fresh.mjs',
    args: [],
    title: 'STATUS freshness instrument (the resume pointer must describe reality)',
    why: 'Roadmap #13: STATUS.md outranks every other document for "where are we". This measures whether it is stale.',
  },
  {
    id: 'capability-ledger',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-capability-ledger.mjs',
    args: [],
    title: 'Capability-ledger instrument (capability the tree lost)',
    why: 'The owner\'s standing rule is never less capability. This reports what the ledger says left.',
  },
  {
    id: 'deletion-ratio',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-deletion-ratio.mjs',
    args: [],
    title: 'Net-production instrument (added / deleted / net)',
    why: 'The blanket deletion-ratio GATE was retired by owner ruling 2026-07-26 (satisfiable by pure relocation, and it drives hallucinated deletions). The MEASUREMENT stays, and it is report tier forever.',
  },

  // ════════ release-only ════════
  // Declared, never omitted. Each needs something `npm run gates` does not have.
  {
    id: 'typecheck',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Typecheck',
    why: 'A full tsc across the workspace. Not in `npm run gates` because the dev loop already typechecks continuously; a release cannot assume that happened.',
  },
  {
    id: 'embedded-version',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Verifying embedded version inside $ZIP_NAME',
    why: 'Needs the built zip. Every past release failure was the same shape — a version bumped, tagged and released with assets that did not match or were never uploaded.',
  },
  {
    id: 'smoke-boot',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Smoke-booting the packaged build (catches non-resolvable imports before publish)',
    why: 'Needs the packaged build and a sandbox HOME. Catches what a source-tree check cannot: an import that resolves in dev and not in the shipped layout.',
  },
  {
    id: 'cache-prefix-determinism',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Cacheable-prefix determinism gate (C28)',
    why: 'Runs against the smoke sandbox (migrations already applied, a primary agent present) and asks the compiled build to assemble twice. Roadmap #10, the cache-prefix law: a cache-breaker in the system prefix fails no test today, it just silently multiplies token cost.',
  },
  {
    id: 'tool-list-conformance',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Tool-list conformance gate (hand lists vs. real tool surface)',
    why: 'A whole defect class: hand-maintained lists/maps of tool NAMES that freeze while the real tool surface moves. Needs the built module graph.',
  },
  {
    id: 'unit-suite',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Unit-suite gate (packages/server vitest, full run)',
    why: 'Owner ruling 2026-07-21: suites in no gate rot silently — 8 suites sat red for up to 8 weeks, one carrying a real production bug. Minutes long, so it is a release gate rather than a per-commit one, and it is never skippable.',
  },
  {
    id: 'prompt-gate-record',
    tier: 'release-only',
    phase: 'post-smoke',
    script: 'deploy/checks/check-prompt-gate-record.mjs',
    args: [],
    releaseArgs: ['--head', '"$(git rev-parse HEAD)"'],
    title: 'Prompt-gate record (cache prefix, prompt inventory, steer delivery, message prefix)',
    why: 'The four kit prompt checks read a LIVE server through the dev instruments, so they cannot run inside a release — a release build has no instruments by construction. The gate therefore reads a RECORDED marker and refuses if it is missing, stale, measured another tree, or carries a red blocking prompt gate. `--head` binds the record to this HEAD.',
  },
  {
    id: 'behavioral-suite',
    tier: 'release-only',
    phase: 'n/a',
    script: null,
    args: [],
    title: 'Behavioral suite gate (full-suite green marker, <24h AND same HEAD)',
    why: 'The behavioral suite lives in the sibling `dojo-test-kit` repo and takes far too long to run inline, so the release reads its green marker and refuses a stale one or one from another HEAD. Skippable ONLY by the owner\'s explicit --skip-behavioral-gate, and the skip is recorded in the release notes.',
  },
];

// ── CLI: `--emit <tier> [phase]` prints one record per line for release.sh ──
// Columns: id, script, releaseArgs (space-joined, may be EMPTY), title, fail.
//
// The separator is US (\x1f), not a tab, and that is not decoration. Bash treats tab
// as IFS *whitespace*, so `IFS=$'\t' read` COLLAPSES two adjacent tabs into one
// delimiter — an empty `releaseArgs` column therefore shifted every later field left
// by one and release.sh printed each gate's failure message as its step title. It
// still ran the right gates and still exited 0, so only rehearsing the actual shell
// caught it (non-negotiable #16). \x1f is not whitespace, so empty fields survive, and
// no title or prose can contain it.
//
// Deliberately not JSON: release.sh is bash 3.2 on macOS with no jq guarantee.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [flag, tier, phase] = process.argv.slice(2);
  if (flag !== '--emit' || !tier) {
    console.error('usage: node deploy/checks/gate-manifest.mjs --emit <blocking|report|release-only> [phase]');
    process.exit(2);
  }
  const rows = GATES.filter((g) => g.tier === tier && (phase === undefined || g.phase === phase));
  for (const g of rows) {
    process.stdout.write([
      g.id,
      g.script ?? '',
      (g.releaseArgs ?? []).join(' '),
      g.title,
      g.fail ?? '',
    ].join('\x1f') + '\n');
  }
}
