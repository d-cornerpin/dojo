#!/usr/bin/env node
// The gate manifest: the one list of release checks that run as a plain node script.
// `npm run gates` runs it through run-gates.mjs; deploy/release.sh reads it with `--emit`.
//
//   tier   blocking  a failure refuses the build and the release.
//          report    runs and prints into the release record; never refuses.
//   phase  pre-build   reads source; runs in release.sh's opening block.
//          post-smoke  asks the packaged build release.sh has just smoke-booted.
//   releaseArgs  shell source release.sh appends to the call.
//
// release.sh also runs steps that are its own shell and so are not listed here:
// typecheck, embedded version, smoke boot, cache-prefix determinism, the unit
// suites and the checker tests in deploy/checks/__tests__.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATES = [
  {
    id: 'byte-hygiene',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-bytes.mjs',
    title: 'Byte-hygiene gate (no bytes that blind grep or deceive review)',
    fail: 'Byte-hygiene gate: tracked source carries NUL/control/bidi/zero-width bytes. NOT publishing.',
    why: 'NUL and C0 control bytes make a file BINARY to plain grep, which then reports no match and looks clean — that is how the dev-instrument ship gate spent months blind to the two largest files in this tree. Bidi/zero-width characters are the render-time version of the same trick. Early in the chain on purpose: every gate after it greps something.',
  },
  {
    id: 'no-personal-names',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-no-personal-names.mjs',
    releaseArgs: ['--require-hash-list'],
    title: 'Names/PII gate (no person or agent name in anything that ships)',
    fail: 'Names/PII gate: a shipped surface carries a person\'s or an agent\'s name. NOT publishing.',
    why: 'The owner\'s rule of 2026-09-26 — "in no code, comments, or documentation that goes live should we be including any agents names, peoples names, identifiable information of any kind" — and the v3.2.0 audit measured the shipped tree breaking it in 109 places across 51 files, one of them the owner\'s own credential inventory as string literals in a live data structure. Comments SHIP: `tsconfig.base.json` sets no `removeComments`, so a worker\'s measurement note naming the box\'s agents reaches every user\'s disk, and the repository is PUBLIC. The one-time scrub is batches A-C; this is what stops the inflow, because notes naming agents are a steady-state habit rather than a one-off mess. TWO HALVES, and neither may embed a name in this repo: the ROSTER half reads `agents.name` from the local database AT CHECK TIME (nothing written down, whole-word and case-sensitive so a vendor voice id is not a name, role names subtracted by reading `config/platform.ts`\'s own defaults) and SKIPS LOUDLY with no database rather than passing silently; the PATTERN half holds SHAPES only — a home-path username, an email address, a quoted GitHub handle — each with a fixture row proving what it catches AND what it ignores, and the gate refuses if its own fixture table fails. Early, pre-build, beside byte-hygiene: it is a text scan over tracked files and needs no build.',
  },
  {
    id: 'migration-freeze',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-migration-freeze.mjs',
    title: 'Migration freeze (a migration a release shipped never changes, and a new one sorts after them)',
    fail: 'Migration freeze: a migration a release shipped changed. A box that applied it keeps the old bytes and warns at every boot. NOT publishing.',
    why: 'Migrations are raw-copied into the package and `_migrations.checksum` records the bytes a box applied, so an edit to a migration a release shipped never reaches a box that applied it: the change belongs in a new numbered file. The gate compares each version a release tag holds against the tree with the runner\'s own checksum; a file in no release tag may still change.',
  },
  {
    id: 'orphan-structures',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-orphans.mjs',
    title: 'Orphan-structure gate (no undeclared work-shaped table; every spine structure read, waived or owed)',
    fail: 'Orphan-structure gate: an undeclared work-shaped table, a manifest entry that stopped describing the schema, or a spine structure with no production reader and no dated disposition. NOT publishing.',
    why: 'Two rules, one checker. The spine READER rule was log-only through Phases 0 and 1 and BLOCKS from the PHASE-1 exit (2026-07-28, T13). The flip changed the checker\'s DEFAULT rather than adding an env var to the invocation, and that was the point: this invocation passes no environment, so an env-var-only flip would have left the release path measuring nothing. The WORK-SHAPED TABLE rule blocks from day one: any table carrying an agent link and a state column must be declared in spine-manifest.json, which is the machine check for the plan\'s own falsifier. Reads SOURCE and the migration chain, never the live ~/.dojo database.',
  },
  {
    id: 'module-wiring',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-wiring.mjs',
    title: 'Module wiring walk (no unreached production file without a dated allowlist line)',
    fail: 'Wiring walk: a production file no entry point reaches with no allowlist entry, a stale allowlist entry, a missing entry point, or an unresolved relative import. NOT publishing.',
    why: 'The orphan gate works a column at a time and cannot see a WHOLE MODULE that no longer hangs off any entry point. This walk does: it starts at the four real entry points and reports the production files it never reaches. It refuses a NEW unreached file, a stale allowlist entry, a missing entry point, and an unresolved relative import (a hole in the walk means the lists cannot be trusted). It never asks anyone to delete anything: the fix is to wire the file or write down why it survives.',
  },
  {
    id: 'watchdog-contract',
    tier: 'report',
    phase: 'pre-build',
    script: 'deploy/checks/check-watchdog-contract.mjs',
    title: 'Watchdog/platform contract gate (hand-synced copies must not drift)',
    fail: 'Watchdog contract gate: the hand-synced update-state copies disagree, a new undeclared copy appeared, or watchdog/src imported platform code. NOT publishing.',
    why: 'The watchdog must keep working while the platform will not boot, so it cannot import platform code — which means the update-state contract (boot-attempt limit, wall clock, rollback cap, phase names, marker shape) is HAND-COPIED into both packages with a comment as the only thing binding them. If the copies drift, nothing fails and nothing warns; the divergence surfaces during a failed self-update, i.e. on a user\'s box, mid-incident, deciding whether to roll back. This gate is the binding.',
  },
  {
    id: 'sql-prepares',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-sql-prepares.mjs',
    title: 'SQL-prepares gate (every statement in the tree prepares against the migrated schema)',
    fail: 'SQL-prepares gate: a statement does not prepare against the schema the migration chain produces. NOT publishing.',
    why: 'ADDED AT THE PHASE-1 EXIT AND THE GAP IS THE POINT: T11 built this check and wired it into `npm run gates:block`, but not into the release stack — so the one path that publishes to a user\'s box was the one path that did not run it. That gap is the reason this manifest exists. T10 found both halves of watchdog supervision silently dead for a day because `watchdog/` sits outside every `packages/` scan; PHASE-3 T8G took the gate whole-tree (1,800 statements) after fixing five defects in the guard itself. Repo contained: the live ~/.dojo database is never consulted.',
  },
  {
    id: 'commit-identity',
    tier: 'blocking',
    phase: 'pre-build',
    script: 'deploy/checks/check-commit-identity.mjs',
    title: 'Commit-identity gate (no machine-default author or committer since the last release)',
    fail: 'Commit-identity gate: a commit since the last release tag carries a machine-default or non-neutral identity (or this repo\'s configured identity is not a noreply address). NOT publishing.',
    why: 'A commit made on a box with no identity configured takes the machine default, a real name and user@Hostname.local, and a release publishes that history for ever. The owner set the neutral identity repo-locally on 2026-10-19; nothing checked it. This lists every commit PREV_TAG..HEAD whose author or committer email is on a .local host or differs from the repo\'s configured noreply identity, and refuses a repo whose own configured identity is not neutral (the release commit would carry it).',
  },
  {
    id: 'upgrade-bypass',
    tier: 'blocking',
    phase: 'post-smoke',
    script: 'deploy/checks/check-upgrade-bypass.mjs',
    releaseArgs: ['"$SMOKE_PORT"', '--require-live'],
    title: 'Upgrade-header auth-bypass gate (asked of the packaged artifact, live)',
    fail: 'Upgrade-header auth-bypass gate: the packaged build let an untokened request through, or no server answered. NOT publishing.',
    why: 'Blocking in BOTH consumers, but it cannot run in the opening block: it asks the PACKAGED ARTIFACT just smoke-booted, not the working tree, because the compiled thing being shipped is what a user runs. `--require-live` turns the offline SKIP (correct for `npm run gates`) into a failure, because a release that could not ask the question must not answer it. release.sh therefore invokes it inline after the smoke boot; that is recorded here so the difference is declared rather than discovered.',
  },
  {
    id: 'shipped-souls',
    tier: 'blocking',
    phase: 'post-smoke',
    script: 'deploy/checks/check-shipped-souls.mjs',
    releaseArgs: ['"$SMOKE_PLATFORM"', '--require-artifact'],
    title: 'Shipped-souls gate (the built artifact carries templates/*-SOUL.md AND src/tools/docs/*.md where the code looks)',
    fail: 'Shipped-souls gate: the packaged build is missing a soul template or a TOOL MANUAL, or ships one the compiled assembler / doc reader cannot resolve. NOT publishing. (Which one it is: read the gate\'s own output — it names the file and the directory it looked in.)',
    why: 'UX-REPAIR T55, and the gap it closes was found by hand twice. W24 and W25 measured the PM and the Trainer running the in-code STUB (961 B and 3,023 B) while 13,593 B and 8,074 B of shipped doctrine reached no model on any box; the repair made the assembler resolve `templates/*-SOUL.md` out of the payload. That repair rests entirely on `build-package.sh:69-71` copying those files to where the COMPILED module looks — and W35 (HU-1) proved it only by replaying an install by hand, saying out loud that no gate checks it. Drop those two lines and every PM and Trainer silently reverts to the stub with nothing failing. Post-smoke because it asks the unzipped PACKAGED ARTIFACT, not the script text: it recomputes `platformTemplateSearchPaths`\'s own relative hop from the artifact\'s `packages/server/dist/prompt/` and demands each soul be there, byte-identical to the repo template when the artifact is of this tree. Offline it SKIPS loudly, exactly like the upgrade-bypass gate; the release passes --require-artifact so a skip cannot stand in for an answer.',
  },
  {
    id: 'shipped-tool-docs',
    tier: 'blocking',
    phase: 'post-smoke',
    script: 'deploy/checks/check-shipped-tool-docs.mjs',
    releaseArgs: ['"$SMOKE_HOME"', '"$SMOKE_PORT"', '--require-boot'],
    title: 'Shipped tool-docs gate (the boot wrote every manual the registry owed)',
    fail: 'Shipped tool-docs gate: the packaged build booted and did not write every tool manual its own registry declares, or could not say whether it had. Agents on that build would read the PREVIOUS version\'s instructions, which look exactly like current ones. NOT publishing.',
    why: 'The installed-box audit, 2026-09-26: the doc generator wrote each `~/.dojo/tools/<tool>.md` inside its own try/catch, logged `warn` on failure and counted only successes. An unwritable docs directory does not make `mkdirSync(…, {recursive:true})` throw — the directory already exists — so a box produced N warn lines, `count: 0`, an INFO line reading "Tool docs generated", and served the previous version\'s manuals for ever. The failure is silent by construction: a stale manual reads exactly like a current one. The runtime half shipped (`tools/doc-freshness.ts` compares written against the registry, speaks at ERROR, and reaches `/api/health` as `data.toolDocs` and the Vitals card through `@dojo/shared`\'s `toolDocsShortfall`); this is the question nobody asked at the one moment it is cheap — does the thing we are about to publish actually do it. Post-smoke because it asks the ARTIFACT: the release already unzips the package, installs it and boots it against a scratch HOME, so this reads that boot. DOUBLE ENTRY on purpose: the boot\'s own arithmetic from `/api/health`, AND an independent count of the `*.md` files in the sandbox HOME, with the directory the runtime NAMES asserted to be that sandbox — a runtime reporting a complete set over an empty directory fails the second, a pre-seeded directory fails the first, and a gate that counted the developer\'s own ~/.dojo/tools would otherwise pass for ever while measuring nothing. `expected` must clear a vacuity FLOOR (not a ratchet) because `missing === 0` is satisfiable by `expected === 0`; 443 manuals measured on a live box 2026-10-05. Offline it SKIPS LOUDLY like the upgrade-bypass and shipped-souls gates, and the release passes --require-boot so a skip cannot stand in for an answer.',
  },
];

// CLI: `--emit <tier> <phase>` prints one record per line for release.sh.
// Columns: id, script, releaseArgs (space-joined, may be empty), title, fail.
// The separator is US (\x1f) because bash collapses adjacent tabs, which would shift
// the columns after an empty one. Not JSON: release.sh is bash 3.2 with no jq guarantee.
// The entry guard compares real paths because import.meta.url percent-encodes spaces
// and process.argv[1] does not.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();
if (invokedDirectly) {
  const [flag, tier, phase] = process.argv.slice(2);
  if (flag !== '--emit' || !tier || !phase) {
    console.error('usage: node deploy/checks/gate-manifest.mjs --emit <blocking|report> <pre-build|post-smoke>');
    process.exit(2);
  }
  for (const g of GATES.filter((g) => g.tier === tier && g.phase === phase)) {
    process.stdout.write([g.id, g.script, (g.releaseArgs ?? []).join(' '), g.title, g.fail].join('\x1f') + '\n');
  }
}
