// ════════════════════════════════════════════════════════════════════════════
// REGISTERED STAND-IN FIXTURE NAMES (v3.4, G6): the registry and what the names gate and the rename codemod both ask of it.
//
// The names gate (`check-no-personal-names.mjs`) keeps real names out of tests and shipped files; the tests use COINED stand-ins instead.
// A coined word is collision-resistant, not collision-proof: an owner may one day name an agent after one, and the gate then sees the
// roster name in dozens of files with nowhere to point. This module is the fix, the small option the owner chose:
//
//   · `fixture-names.json` REGISTERS the stand-ins (and a pool of spare coined words);
//   · `checkStandIns` turns a roster / owner-name hit on a REGISTERED stand-in into a COLLISION (not a leak) and names the one command
//     that repairs it, before the gate scans the tree and before its own fixture table trips on it;
//   · `rename-fixture-name.mjs <old> <new>` renames it whole-word and case-aware across the tracked tree and re-runs the gate.
//
// The registry holds coined words only, and it is a scanned file like any other (it lives under deploy/checks/).
// ════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_FILE = path.join(HERE, 'fixture-names.json');
export const CODED_WORD = /^[A-Z][a-z]{3,14}$/;

export function loadRegistry(file = REGISTRY_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const standIns = Array.isArray(raw.standIns) ? raw.standIns : [];
  const spare = Array.isArray(raw.spare) ? raw.spare : [];
  const bad = [...standIns, ...spare].filter((w) => typeof w !== 'string' || !CODED_WORD.test(w));
  if (bad.length > 0) throw new Error(`fixture-names.json: ${bad.length} entr${bad.length === 1 ? 'y is' : 'ies are'} not a coined word (one capitalised alphabetic token of 4 to 15 letters): ${bad.slice(0, 3).join(', ')}`);
  if (new Set([...standIns, ...spare].map((w) => w.toLowerCase())).size !== standIns.length + spare.length) throw new Error('fixture-names.json: a word is listed twice');
  return { ...raw, standIns, spare };
}

/** Whole-word, case-insensitive, and an identifier that merely CONTAINS the word (`zergoCount`, `zergo_count`) is not a use. */
export const wordRe = (word, flags = 'gi') => new RegExp(`(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, flags);

/** The live roster of agent names on this box, or null when there is no database (the gate then falls back to its committed roster). */
export function readLiveRoster() {
  const db = path.join(process.env.DOJO_HOME ?? os.homedir(), '.dojo/data/dojo.db');
  if (!fs.existsSync(db)) return null;
  try {
    return execFileSync('sqlite3', ['-readonly', db, 'SELECT name FROM agents'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
}

/** Tracked text files under `root` (git ls-files), skipping anything binary or huge. */
export function trackedTextFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const files = [];
  for (const rel of out) {
    const abs = path.join(root, rel);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue;
    files.push({ rel, abs, text: buf.toString('utf8') });
  }
  return files;
}

/** Files (and total uses) of `word` across the tracked text files. */
export function usesOf(word, files) {
  const re = wordRe(word, 'gi');
  const hit = [];
  let uses = 0;
  for (const f of files) { const n = (f.text.match(re) ?? []).length; if (n > 0) { hit.push({ rel: f.rel, n }); uses += n; } }
  return { files: hit, uses };
}

/** A spare coined word that is not on the roster, not an owner name and not already registered. */
export function suggestSpare(registry, avoid = []) {
  const taken = new Set([...avoid, ...registry.standIns].map((w) => String(w).toLowerCase()));
  return registry.spare.find((w) => !taken.has(w.toLowerCase())) ?? null;
}

/**
 * The gate's question: does any registered stand-in sit on this box's roster or in the owner's name? `rosterNames` is the LIVE roster
 * (pass [] when the gate fell back to its committed fixture roster). Returns `{ registered, collisions: [{ name, files, uses, command }] }`.
 */
export function checkStandIns({ root, rosterNames = [], ownerNames = [], registry = loadRegistry(), files = null }) {
  const real = new Set([...rosterNames, ...ownerNames].map((n) => String(n).toLowerCase()));
  const hits = registry.standIns.filter((w) => real.has(w.toLowerCase()));
  const tree = hits.length > 0 ? (files ?? trackedTextFiles(root)) : [];
  const collisions = hits.map((name) => {
    const u = usesOf(name, tree);
    const spare = suggestSpare(registry, [...rosterNames, ...ownerNames]);
    return { name, files: u.files, uses: u.uses, command: spare ? `node deploy/checks/rename-fixture-name.mjs ${name} ${spare}` : null };
  });
  return { registered: registry.standIns.length, collisions };
}

/** What the gate prints for a collision, then exits non-zero on. */
export function describeCollision(c) {
  return [
    `✗ names gate: COLLISION, not a leak. This box's roster (or the owner's name) holds "${c.name}", which the repository uses as a REGISTERED fixture stand-in `
      + `in ${c.files.length} file(s) (${c.uses} use(s)). Nothing real was written down; a coined word met a real name.`,
    c.command
      ? `  Repair it with ONE command (it renames the stand-in whole-word and case-aware across the tracked tree, then re-runs this gate):\n    ${c.command}`
      : '  No spare coined word is left in deploy/checks/fixture-names.json: add one there, then run node deploy/checks/rename-fixture-name.mjs <old> <new>.',
  ].join('\n');
}
