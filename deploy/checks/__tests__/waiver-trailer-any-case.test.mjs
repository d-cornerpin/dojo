// 9405: a gate-waiver commit trailer is counted whatever the spelling of its name — git reads trailer
// names case-insensitively, so a lowercase `gate-waiver:` line must spend the budget just like `Gate-Waiver:`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../check-waivers.mjs', import.meta.url));

// Make a throw-away repo whose arc holds exactly one commit carrying one trailer line spelled `spelling`,
// then read back the trailer count the counter prints for that arc.
function trailerCountFor(spelling) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-9405-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'Fixture Author');
    git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed commit');
    const base = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(root, 'waived.txt'), 'waived\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add a waiver', '-m', `${spelling}: some-gate — a reason`);
    const out = execFileSync('node', [SCRIPT, '--since', base], { cwd: root, encoding: 'utf8' });
    const m = /commit trailers\s+(\d+)/.exec(out);
    assert.ok(m, `counter printed no "commit trailers" line:\n${out}`);
    return Number(m[1]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a lowercase gate-waiver trailer is counted', () => {
  assert.equal(trailerCountFor('gate-waiver'), 1);
});

test('the capitalized Gate-Waiver trailer is counted', () => {
  assert.equal(trailerCountFor('Gate-Waiver'), 1);
});
