#!/usr/bin/env node
// ════════════════════════════════════════
// Runs one TIER of the gate manifest. This is what `npm run gates:block` and
// `npm run gates:report` are.
//
// Before this existed, package.json held a hand-typed `&&` chain of ten `node
// deploy/checks/…` invocations and release.sh held its own hand-written copy of the
// same list. Adding a gate to one and not the other was a silent, invisible mistake —
// and it happened (PHASE-1 T11; see gate-manifest.mjs's header). The list is now
// declared once, in gate-manifest.mjs, and both consumers read it.
//
//   blocking  every gate runs; the FIRST failure stops the run and exits 1.
//   report    every instrument runs; output is passed through; ALWAYS exits 0,
//             because a report tier that can fail a build is a blocking tier wearing
//             the wrong name (non-negotiable #7).
//
// Usage:
//   node deploy/checks/run-gates.mjs blocking
//   node deploy/checks/run-gates.mjs report
// ════════════════════════════════════════
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GATES } from './gate-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tier = process.argv[2];
if (tier !== 'blocking' && tier !== 'report') {
  console.error('usage: node deploy/checks/run-gates.mjs <blocking|report>');
  process.exit(2);
}

const gates = GATES.filter((g) => g.tier === tier && g.script);

// Vacuity guard, same rule as every other gate in this directory: a runner that finds
// nothing to run reports a clean sweep, which is the failure shape these gates exist to
// prevent. The floors are "the manifest emptied itself", not a ratchet.
const FLOOR = { blocking: 8, report: 3 };
if (gates.length < FLOOR[tier]) {
  console.error(`✗ gate manifest declares only ${gates.length} runnable ${tier} gate(s); floor is ${FLOOR[tier]}.`);
  console.error('  A gate list that empties itself would pass every build. Fix gate-manifest.mjs.');
  process.exit(1);
}

let ran = 0;
for (const g of gates) {
  if (tier === 'report') console.log(`── ${g.id} ──`);
  const r = spawnSync('node', [path.join(ROOT, g.script), ...(g.args ?? [])], { stdio: 'inherit' });
  ran++;
  if (tier === 'blocking' && r.status !== 0) {
    console.error('');
    console.error(`✗ ${g.title}`);
    console.error(`  ${g.fail ?? 'gate failed'}`);
    console.error(`  Re-run alone:  node ${g.script}`);
    process.exit(1);
  }
  if (tier === 'report' && r.status !== 0) console.log(`(exit ${r.status} — report tier, not blocking)`);
}

console.log('');
console.log(
  tier === 'blocking'
    ? `✓ ${ran}/${ran} blocking gates green (from deploy/checks/gate-manifest.mjs)`
    : `✓ ${ran} report instrument(s) recorded (never blocking)`,
);
