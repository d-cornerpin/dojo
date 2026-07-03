#!/usr/bin/env node
// C28 Part 3: release-time cacheable-prefix determinism gate.
//
// Self-contained (NO dev-instrument imports; it must survive the packaged-build
// ship-gate grep in release.sh). Runs inside the smoke-boot sandbox AFTER boot
// has succeeded (so migrations have run and a primary agent exists). It imports
// the PACKAGED dist assembler, assembles the stable cacheable prefix TWICE for a
// real agent, and fails the release if the prefix is not byte-identical, if the
// system-side volatile lane is non-empty, or if a cache-breaker smell is present.
//
// Usage: node check-prefix-determinism.mjs <path-to/packages/server/dist>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distDir = process.argv[2];
if (!distDir) { console.error('usage: check-prefix-determinism.mjs <server-dist-dir>'); process.exit(2); }
const imp = (rel) => import(pathToFileURL(path.join(distDir, rel)).href);

function fail(msg) { console.error(`  ✗ cache-prefix determinism gate: ${msg}`); process.exit(1); }

// Rendered volatile forms that must NEVER appear in the stable system prefix
// (they moved to the msg.turn-context tail in C28 Part 1). The stable prose
// placeholders (e.g. "[Reply destination: ...]") are deliberately not matched.
const SMELLS = [
  { name: 'relative time (N minutes/hours ago)', re: /\b(minutes?|hours?)\s+ago\b/ },
  // \u2014 below is the em-dash the rendered dashboard-chat tag actually contains.
  { name: 'rendered reply-destination tag', re: /\[Reply destination: (dashboard chat \u2014|iMessage to |email reply to |SMS to |phone call to |Teams DM to |voice )/ },
  { name: 'othersWaiting hint body', re: /waiting for you right now/ },
  { name: 'conversational-turn hint body', re: /this is a quick conversational request, not a multi-step project/ },
  { name: 'live iMessage bridge line', re: /(^|\n)iMessage bridge: (on|off)(\n|$)/ },
];

let getDb, assembleContext;
try {
  ({ getDb } = await imp('db/connection.js'));
  ({ assembleContext } = await imp('memory/assembler.js'));
} catch (err) {
  fail(`could not import the dist assembler: ${err instanceof Error ? err.message : String(err)}`);
}

// Pick a real agent seeded by the boot (prefer the primary); seed a minimal one
// only if the boot left none.
const db = getDb();
let agentId;
try {
  const row = db.prepare("SELECT id FROM agents WHERE status != 'terminated' ORDER BY (agent_type='primary') DESC, created_at ASC LIMIT 1").get();
  agentId = row?.id;
} catch { /* fall through to seed */ }
if (!agentId) {
  agentId = '__prefix_gate__';
  try {
    db.prepare("INSERT OR IGNORE INTO agents (id, name, status, permissions, created_at, updated_at) VALUES (?, 'PrefixGate', 'idle', '{}', datetime('now'), datetime('now'))").run(agentId);
  } catch (err) {
    fail(`no agent available and could not seed one: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let a, b;
try {
  a = await assembleContext(agentId, '__auto__', { latestUserSource: null });
  b = await assembleContext(agentId, '__auto__', { latestUserSource: null });
} catch (err) {
  fail(`assembleContext threw: ${err instanceof Error ? err.message : String(err)}`);
}

if (a.systemPrompt !== b.systemPrompt) fail('the system prefix is NOT byte-identical across two assembles (something volatile is in the cached prefix).');
if ((a.systemVolatile ?? '') !== '') fail(`systemVolatile is NOT empty (${a.systemVolatile.length} chars); volatile content leaked into the system-side lane.`);
for (const s of SMELLS) {
  const m = a.systemPrompt.match(s.re);
  if (m) fail(`cache-breaker smell in the system prefix: ${s.name}, matched "${m[0].slice(0, 40)}"`);
}

console.log(`  ✓ cache-prefix determinism gate: stable prefix byte-identical (${a.systemPrompt.length} chars), systemVolatile empty, smell-free`);
process.exit(0);
