// C14 (R33): the list of hashed real first names is NOT in the tracked tree. The names gate reads an
// untracked local file (or $DOJO_REAL_NAME_HASHES); with none, every other rule still runs and the
// gate says the hash list was not loaded. A name on a line carrying an `xx_word:` key is still checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const GATE = fileURLToPath(new URL('../check-no-personal-names.mjs', import.meta.url));
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: path.dirname(GATE) }).trim();

test('no file by that name is tracked', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  assert.equal(tracked.filter((f) => /known-real-name-hashes/.test(f)).length, 0);
});

test('with no list the gate still runs and says the hash list was not loaded', () => {
  const env = { ...process.env, DOJO_REAL_NAME_HASHES: path.join(os.tmpdir(), 'dojo-absent-hashes.json') };
  const r = spawnSync('node', [GATE], { cwd: ROOT, encoding: 'utf8', env });
  const out = `${r.stdout}${r.stderr}`;
  if (!fs.existsSync(path.join(ROOT, '.superpowers', 'known-real-name-hashes.json'))) assert.match(out, /hash list was not loaded/);
});

test('the digest of a coined word given by env is loaded and a vendor-shaped key does not hide it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-hash-'));
  try {
    const f = path.join(dir, 'h.json');
    fs.writeFileSync(f, JSON.stringify({ sha256: [crypto.createHash('sha256').update('zergblatt').digest('hex')] }));
    const r = spawnSync('node', [GATE, '--self-test'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DOJO_REAL_NAME_HASHES: f } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /✗/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
