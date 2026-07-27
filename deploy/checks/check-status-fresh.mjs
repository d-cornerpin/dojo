#!/usr/bin/env node
// ════════════════════════════════════════
// Resume-pointer backstop (Phase 0 T12d Step 3c). WARN-ONLY, by design.
//
// `../STATUS.md` is the resume pointer: roadmap non-negotiable #13 makes it
// outrank every other document for "where are we", and requires it rewritten at
// every task boundary and before every pause. A fresh session reads it FIRST
// and must never have to reconstruct state from checkboxes and git logs.
//
// The failure this catches is the cheap one: somebody committed code and did
// not touch the pointer at all. That leaves the next context inheriting a false
// picture of the tree — which is the precise failure mode this whole project
// exists to prevent.
//
// ════ WHAT A SCRIPT CAN AND CANNOT JUDGE ════
// It cannot read STATUS.md and decide whether the words are TRUE. It can only
// see whether anyone touched the file after the last commit landed. So this is
// a nag, never a gate: a stale pointer should be visible on every run without
// blocking a build, and a FRESH timestamp is no evidence of an ACCURATE file.
// Both halves of that are printed, every time, so the output cannot be read as
// a clean bill of health for the contents.
//
// Usage: node deploy/checks/check-status-fresh.mjs [path-to-STATUS.md]
// Always exits 0.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const STATUS = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, '..', 'STATUS.md');
const REL = path.relative(ROOT, STATUS);

console.log('Resume-pointer freshness — WARN ONLY (this check never fails a build)');
console.log('');

if (!fs.existsSync(STATUS)) {
  console.log(`  ! ${REL} does not exist.`);
  console.log('    The resume pointer is the one document a fresh session reads first (roadmap #13).');
  console.log('    Without it, the next context reconstructs state from checkboxes and git logs — the');
  console.log('    exact failure the rule was written to stop.');
  console.log('');
  console.log('  Warn-only: this check nags, it does not block.');
  process.exit(0);
}

const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const headIso = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: ROOT, encoding: 'utf8' }).trim();
const headSubject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: ROOT, encoding: 'utf8' }).trim();
const headAt = Date.parse(headIso);
const touchedAt = fs.statSync(STATUS).mtimeMs;

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const lagMin = Math.round((headAt - touchedAt) / 60_000);

console.log(`  ${REL}   last written  ${fmt(touchedAt)}`);
console.log(`  dojo HEAD ${headSha}       committed     ${fmt(headAt)}   ${headSubject}`);
console.log('');

if (touchedAt < headAt) {
  console.log(`  STATUS.md is STALE — it predates commit ${headSha}; a fresh context would resume from a false picture`);
  console.log(`  (written ${lagMin} minute(s) before the commit it is supposed to describe)`);
  console.log('');
  console.log('  Rewrite it now, from commands rather than memory: which task is in flight, the real');
  console.log('  tree and server state, the standing baseline, and any open owner question. A task');
  console.log('  whose STATUS refresh is missing is not accepted (roadmap #13, execution protocol).');
} else {
  console.log(`  STATUS.md was written after ${headSha} — the pointer has been touched since the last commit.`);
}

console.log('');
console.log('  What this proves and what it does not: it compares timestamps only. It CANNOT tell');
console.log('  whether the file is accurate — a freshly saved STATUS.md full of stale claims passes');
console.log('  this check exactly as a correct one does. Only a reader can judge the contents.');
process.exit(0);
