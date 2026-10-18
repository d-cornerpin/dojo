#!/usr/bin/env node
// node deploy/checks/rename-fixture-name.mjs <old> <new> [--dry-run] [--root <dir>]
//
// The one command that repairs a stand-in COLLISION (v3.4, G6; the names gate prints it with a spare coined word filled in). It renames the
// REGISTERED stand-in <old> to <new> across the tracked text files, whole-word and case-aware (Old -> New, OLD -> NEW, old -> new; an identifier that
// merely contains the word, `oldCount` or `old_count`, is left alone), moves the registry (<new> becomes a stand-in and leaves the spare pool, <old>
// is retired), and re-runs the names gate. It is not a general find-and-replace: <old> must be registered, <new> must not be.
//
// Refusals, each by name: <old> is not a registered stand-in; <new> is itself registered; <new> is on this box's roster or already used in the tree
// (it would only move the collision); <new> is not a coined-looking word.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { REGISTRY_FILE, CODED_WORD, loadRegistry, readLiveRoster, trackedTextFiles, usesOf, wordRe } from './fixture-names.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? null); };
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root');
const [oldName, newName] = positional;
const dry = argv.includes('--dry-run');
const die = (msg) => { console.error(`✗ rename-fixture-name: ${msg}`); process.exit(1); };
if (!oldName || !newName) die('usage: node deploy/checks/rename-fixture-name.mjs <old> <new> [--dry-run] [--root <dir>]');

const root = path.resolve(flag('--root') ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const registryPath = path.join(root, 'deploy/checks/fixture-names.json');
const registry = loadRegistry(fs.existsSync(registryPath) ? registryPath : REGISTRY_FILE);
const lc = (s) => s.toLowerCase();

if (!registry.standIns.some((w) => lc(w) === lc(oldName))) die(`"${oldName}" is not a registered stand-in (deploy/checks/fixture-names.json lists: ${registry.standIns.join(', ')}). This is not a general find-and-replace.`);
if (registry.standIns.some((w) => lc(w) === lc(newName))) die(`"${newName}" is itself a registered stand-in; pick a spare coined word (${registry.spare.join(', ')}).`);
if (!CODED_WORD.test(newName)) die(`"${newName}" does not look like a coined word (one capitalised alphabetic token of 4 to 15 letters).`);
const roster = readLiveRoster() ?? [];
if (roster.some((n) => lc(n) === lc(newName))) die(`"${newName}" is on this box's roster: renaming to it would only move the collision. Pick a spare coined word.`);

const files = trackedTextFiles(root);
// the registry's own spare pool lists <new> by design; it is the one place the word may already be
const clash = usesOf(newName, files.filter((f) => f.rel !== 'deploy/checks/fixture-names.json'));
if (clash.uses > 0) die(`"${newName}" already appears ${clash.uses} time(s) in the tree (${clash.files.slice(0, 3).map((f) => f.rel).join(', ')}): renaming onto it would merge two names.`);

const caseOf = (match, repl) => (match === match.toUpperCase() ? repl.toUpperCase() : match === match.toLowerCase() ? repl.toLowerCase() : repl);
const re = wordRe(oldName, 'gi');
const plan = [];
for (const f of files) {
  const n = (f.text.match(re) ?? []).length;
  if (n > 0) plan.push({ ...f, n });
}
const total = plan.reduce((a, f) => a + f.n, 0);
console.log(`${dry ? 'DRY RUN: ' : ''}${oldName} -> ${newName}: ${total} use(s) in ${plan.length} file(s)`);
for (const f of plan) console.log(`  ${String(f.n).padStart(4)}  ${f.rel}`);
if (dry) { console.log('(nothing was changed)'); process.exit(0); }

for (const f of plan) fs.writeFileSync(f.abs, f.text.replace(re, (m) => caseOf(m, newName)));
// the registry follows (it is one of the tracked files above, so it already says <new> where it said <old>; make the spare pool consistent)
const after = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
after.standIns = [...new Set(after.standIns.map((w) => (lc(w) === lc(newName) ? newName : w)))];
after.spare = (after.spare ?? []).filter((w) => lc(w) !== lc(newName));
fs.writeFileSync(registryPath, `${JSON.stringify(after, null, 2)}\n`);
console.log(`renamed. Re-running the names gate...`);
const gate = spawnSync(process.execPath, [path.join(root, 'deploy/checks/check-no-personal-names.mjs')], { cwd: root, encoding: 'utf8', env: process.env });
const tail = `${gate.stdout}${gate.stderr}`.trim().split('\n').slice(-6).join('\n');
console.log(`gate exit ${gate.status}\n${tail}`);
process.exit(gate.status ?? 1);
