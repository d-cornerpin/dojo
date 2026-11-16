#!/usr/bin/env node
// Runs one tier of the gate manifest (`npm run gates:block`, `npm run gates:report`).
//   blocking  the first failure stops the run and exits 1.
//   report    every check runs and prints; always exits 0.
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

const gates = GATES.filter((g) => g.tier === tier);

// A runner that finds nothing to run would report a clean sweep, so an emptied list fails.
const FLOOR = { blocking: 9, report: 2 };
if (gates.length < FLOOR[tier]) {
  console.error(`✗ gate manifest declares only ${gates.length} ${tier} gate(s); floor is ${FLOOR[tier]}.`);
  console.error('  A gate list that empties itself would pass every build. Fix gate-manifest.mjs.');
  process.exit(1);
}

for (const g of gates) {
  if (tier === 'report') console.log(`── ${g.id} ──`);
  const r = spawnSync('node', [path.join(ROOT, g.script)], { stdio: 'inherit' });
  if (r.status === 0) continue;
  if (tier === 'report') { console.log(`(exit ${r.status}, report tier, not blocking)`); continue; }
  console.error('');
  console.error(`✗ ${g.title}`);
  console.error(`  ${g.fail}`);
  console.error(`  Re-run alone:  node ${g.script}`);
  process.exit(1);
}

console.log('');
console.log(
  tier === 'blocking'
    ? `✓ ${gates.length}/${gates.length} blocking gates green (from deploy/checks/gate-manifest.mjs)`
    : `✓ ${gates.length} report check(s) recorded (never blocking)`,
);
