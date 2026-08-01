#!/usr/bin/env node
// ════════════════════════════════════════
// The two gate lists are ONE list, and both consumers still read it.
//
// ── WHY THIS EXISTS, and it is not hypothetical ──
// PHASE-1 T11 wrote `check-watchdog-sql.mjs` (renamed `check-sql-prepares.mjs` at the
// T8G merge, once its scope stopped being the watchdog) and wired it into `gates:block`
// but not into `deploy/release.sh` — so the one path that publishes to a user's box
// was the one path that did not run it. Nothing failed. It was found by T13 counting
// the tiers BY HAND: package.json had 9 blocking checks and release.sh's comments
// described 8. The only thing binding the two hand-maintained lists was a hand-typed
// `N/10` in a release.sh comment, and a hand-typed count is not a binding, it is a
// claim.
//
// `gate-manifest.mjs` is now the single declared list. This gate is what makes that
// true tomorrow as well as today. It refuses:
//
//   1. a `deploy/checks/check-*.mjs` file that the manifest does not name — the exact
//      T11 shape, caught on the day the file appears instead of two phases later;
//   2. a manifest entry pointing at a script that does not exist;
//   3. `package.json` not routing `gates:block` / `gates:report` through the runner —
//      i.e. a hand-typed `&&` chain coming back;
//   4. `release.sh` not reading the manifest for its blocking and report tiers;
//   5. a `deploy/checks/…` script invoked INLINE in release.sh that the manifest does
//      not declare as inline — including a pre-build gate invoked twice;
//   6. a declared release-only gate whose `step` line has vanished from release.sh —
//      the half of the problem that is NOT solved by sharing a list, because
//      release-only gates are by definition in only one of the two;
//   7. an empty or near-empty manifest (a list that empties itself passes everything).
//
// ── WHAT IT DOES NOT CATCH, said out loud ──
// That a gate is a GOOD gate, or that it is wired to bite. This is a plumbing check:
// it proves the lists agree and that nothing is missing from them. Each gate proves
// its own bite in its own file.
//
// Usage:
//   node deploy/checks/check-gate-manifest.mjs     # exit 0 clean, 1 on any violation
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATES } from './gate-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let failed = false;
const fail = (...lines) => { failed = true; for (const l of lines) console.error(l); };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const releaseSh = fs.readFileSync(path.join(ROOT, 'deploy/release.sh'), 'utf8');

// ════════ 0. the manifest is not empty ════════
// Floors, not ratchets: the count below which the only honest reading is "the list
// emptied itself". They do not rise as gates are added.
const FLOORS = { blocking: 8, report: 3, 'release-only': 6 };
const byTier = (t) => GATES.filter((g) => g.tier === t);
for (const [tier, floor] of Object.entries(FLOORS)) {
  const n = byTier(tier).length;
  if (n < floor) {
    fail(
      `✗ the manifest declares ${n} ${tier} gate(s); the floor is ${floor}.`,
      '  A gate list that empties itself would pass every build and every release.',
      '',
    );
  }
}

// ════════ 1. every checker file on disk is named by the manifest ════════
// This is the T11 rule. A new `deploy/checks/check-*.mjs` is either a gate someone
// forgot to wire, or it is not a gate and should not be named that.
const named = new Set(GATES.map((g) => g.script).filter(Boolean));
const onDisk = fs.readdirSync(HERE)
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .map((f) => `deploy/checks/${f}`)
  .sort();

const unnamed = onDisk.filter((f) => !named.has(f));
if (unnamed.length) {
  fail(`✗ ${unnamed.length} checker file(s) exist that no tier in gate-manifest.mjs names:`, '');
  for (const f of unnamed) fail(`    ${f}`);
  fail(
    '',
    '  This is EXACTLY how PHASE-1 T11\'s gate reached `npm run gates:block` and not the',
    '  release path, where it then did not run for two phases. Add it to gate-manifest.mjs',
    '  with a tier — `blocking`, `report`, or `release-only` with the reason it cannot run',
    '  in `npm run gates`. A checker nobody runs is not a gate, it is a file.',
    '',
  );
}

// ════════ 2. every named script exists ════════
const missing = [...named].filter((s) => !fs.existsSync(path.join(ROOT, s)));
if (missing.length) {
  fail(`✗ ${missing.length} manifest entr(ies) name a script that does not exist:`, '');
  for (const s of missing) fail(`    ${s}`);
  fail('  Re-point or remove the entry deliberately. A manifest that names a ghost runs one fewer gate than it claims.', '');
}

// ════════ 3. package.json routes through the runner ════════
const EXPECTED_SCRIPTS = {
  'gates:block': 'node deploy/checks/run-gates.mjs blocking',
  'gates:report': 'node deploy/checks/run-gates.mjs report',
};
for (const [name, expected] of Object.entries(EXPECTED_SCRIPTS)) {
  const actual = pkg.scripts?.[name];
  if (actual !== expected) {
    fail(
      `✗ package.json "${name}" is not the manifest runner.`,
      `    expected: ${expected}`,
      `    actual:   ${actual ?? '(missing)'}`,
      '  A hand-typed chain here is the second list this manifest exists to delete. If a gate',
      '  needs different treatment, say so in gate-manifest.mjs, not in package.json.',
      '',
    );
  }
}

// ════════ 4. release.sh reads the manifest ════════
const REQUIRED_EMITS = [
  { needle: '--emit blocking pre-build', what: 'the opening blocking-gate block' },
  { needle: '--emit report', what: 'the report tier' },
];
for (const r of REQUIRED_EMITS) {
  if (!releaseSh.includes(r.needle)) {
    fail(
      `✗ deploy/release.sh does not read the manifest for ${r.what} (no \`${r.needle}\`).`,
      '  If release.sh stops reading this list it silently becomes the second hand-maintained',
      '  list again, which is the whole defect. Restore the loop.',
      '',
    );
  }
}

// ════════ 5. inline `deploy/checks/…` invocations are declared ════════
// A gate invoked by name in release.sh is fine — some genuinely must be (they need
// $SMOKE_PORT, or a HEAD argument). It must be DECLARED inline, and a pre-build
// blocking gate must NOT be, or it runs twice and the loop count is a lie.
const inlineInvoked = new Set(
  [...releaseSh.matchAll(/\$SCRIPT_DIR\/checks\/(check-[A-Za-z0-9._-]+\.mjs)/g)].map((m) => `deploy/checks/${m[1]}`),
);
const declaredInline = new Set(
  GATES.filter((g) => g.script && (g.phase === 'post-smoke' || (g.tier === 'release-only' && g.script))).map((g) => g.script),
);
for (const s of inlineInvoked) {
  if (!declaredInline.has(s)) {
    const entry = GATES.find((g) => g.script === s);
    fail(
      `✗ deploy/release.sh invokes ${s} inline, but the manifest does not declare it inline.`,
      entry
        ? `  It is declared tier="${entry.tier}" phase="${entry.phase}". A pre-build blocking gate is run by the`
        : '  It is not in the manifest at all.',
      '  manifest loop; naming it again here runs it twice and makes the printed count untrue.',
      '',
    );
  }
}
for (const g of GATES) {
  if (g.script && (g.phase === 'post-smoke' || g.tier === 'release-only') && !inlineInvoked.has(g.script)) {
    fail(
      `✗ the manifest declares ${g.id} (${g.script}) as invoked inline by release.sh, but release.sh does not invoke it.`,
      `  ${g.why}`,
      '  Either release.sh dropped a gate, or the declaration is stale. Both are findings.',
      '',
    );
  }
}

// ════════ 6. every release-only gate is still IN release.sh ════════
// The half that sharing a list cannot solve: these appear in exactly one consumer, so
// only their `step` title binds them. Declared here, asserted present there.
for (const g of byTier('release-only')) {
  if (!releaseSh.includes(`step "${g.title}"`)) {
    fail(
      `✗ release-only gate "${g.id}" is declared in the manifest but release.sh has no \`step "${g.title}"\`.`,
      `  ${g.why}`,
      '  Either the gate was removed from the release path (a real loss, and this is the only',
      '  thing that would have noticed) or its step title was reworded. Re-sync the manifest.',
      '',
    );
  }
}

// ════════ 7. controls: this gate refuses what it is supposed to refuse ════════
// The plan's named control for Step 3: a checker file the manifest does not name must
// be refused. Run here on a SYNTHETIC file list so the control ships with the gate and
// runs on every invocation, rather than being a thing someone did once by hand.
{
  const controls = [
    {
      id: 'unnamed-checker-is-refused',
      why: 'a deploy/checks/check-*.mjs the manifest does not name must be a finding — the literal PHASE-1 T11 shape',
      ok: ['deploy/checks/check-bytes.mjs', 'deploy/checks/check-not-in-any-list.mjs']
        .filter((f) => !named.has(f)).length === 1,
    },
    {
      id: 'named-checker-is-accepted',
      why: 'the rule must not simply refuse everything',
      ok: onDisk.every((f) => typeof f === 'string') && onDisk.filter((f) => named.has(f)).length === onDisk.length - unnamed.length,
    },
    {
      id: 'every-tier-is-populated',
      why: 'all three tiers carry entries; a manifest with one tier is the old two-list problem with extra steps',
      ok: ['blocking', 'report', 'release-only'].every((t) => byTier(t).length > 0),
    },
    {
      id: 'blocking-gates-are-in-both-consumers',
      why: 'the whole point: every blocking gate reaches `npm run gates:block` AND `release.sh`',
      ok: byTier('blocking').every((g) => g.script && (g.phase === 'pre-build' || inlineInvoked.has(g.script))),
    },
  ];
  const bad = controls.filter((c) => !c.ok);
  if (bad.length) {
    fail(`✗ ${bad.length} control(s) FAILED — this gate's verdict is unreliable:`, '');
    for (const c of bad) fail(`  control "${c.id}": ${c.why}`, '');
  }
}

// ════════ verdict ════════

if (failed) {
  console.error('✗ gate manifest: refusing.');
  process.exit(1);
}

const counts = ['blocking', 'report', 'release-only'].map((t) => `${byTier(t).length} ${t}`).join(' · ');
console.log(`✓ gate manifest conformant — ${GATES.length} declared gates (${counts})`);
console.log(`  ${onDisk.length} checker file(s) in deploy/checks/, all named; package.json and release.sh both read the manifest`);
console.log(`  ${byTier('release-only').length} release-only gate(s) declared as such and all still present in release.sh`);
