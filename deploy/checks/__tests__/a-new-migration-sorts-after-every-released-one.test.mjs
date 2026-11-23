// A migration file new since the last release tag must sort after every file that tag holds, so a fresh
// install and an updated box apply the steps in the same order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const GATE = fileURLToPath(new URL('../check-migration-freeze.mjs', import.meta.url));
const DIR = 'packages/server/src/db/migrations';

function tagged(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-order-test-'));
  let clock = 1_700_000_000;
  const git = (...args) => { const at = `${clock++} +0000`; execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }); };
  const write = (name) => fs.writeFileSync(path.join(root, DIR, name), `-- ${name}\n`);
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const f of files) write(f);
  git('add', '-A'); git('commit', '-q', '-m', 'release'); git('tag', 'v1.0.0');
  return { root, git, write, run: () => spawnSync('node', [GATE], { cwd: root, encoding: 'utf8' }), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a new file that sorts before a tagged file fails', () => {
  const box = tagged(['001_a.sql', '900_late.sql']);
  try {
    box.write('500_new.sql');
    const r = box.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /500_new\.sql .*sorts before 900_late\.sql/);
  } finally { box.clean(); }
});

test('a new file after every tagged file passes', () => {
  const box = tagged(['001_a.sql', '900_late.sql']);
  try {
    box.write('901_next.sql');
    const r = box.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { box.clean(); }
});

test('a merged-in stable tag nearer than the newest test build does not hide a released file', () => {
  const box = tagged(['001_a.sql']);
  const commit = (msg) => { box.git('add', '-A'); box.git('commit', '-q', '-m', msg); };
  try {
    box.git('checkout', '-q', '-b', 'preflight');
    box.write('900_late.sql'); commit('900');
    box.git('tag', 'v1.1.0-preflight.1');
    box.git('checkout', '-q', '-b', 'stable', 'v1.0.0');
    fs.writeFileSync(path.join(box.root, 'NOTES'), 'one\n'); commit('stable one');
    fs.writeFileSync(path.join(box.root, 'NOTES'), 'two\n'); commit('stable two');
    box.git('tag', 'v1.0.1');
    box.git('checkout', '-q', 'preflight');
    box.git('merge', '-q', '--no-edit', 'stable');
    box.write('219_new.sql');
    const r = box.run();
    assert.match(r.stdout, /since v1\.0\.1\b/);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /219_new\.sql .*sorts before 900_late\.sql/);
  } finally { box.clean(); }
});
