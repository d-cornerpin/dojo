// The migration freeze holds a file to the bytes a release tag shipped, and lets a file that is in
// no release tag change freely, even when it was committed on the branch since the last tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const GATE = fileURLToPath(new URL('../check-migration-freeze.mjs', import.meta.url));
const DIR = 'packages/server/src/db/migrations';

function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-freeze-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const write = (name, sql) => fs.writeFileSync(path.join(root, DIR, name), sql);
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); };
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('001_released.sql', 'CREATE TABLE a (id INTEGER);\n');
  commit('one');
  git('tag', 'v1.0.0');
  write('002_unreleased.sql', 'CREATE TABLE b (id INTEGER);\n');
  commit('two');
  write('002_unreleased.sql', 'CREATE TABLE b (id INTEGER, note TEXT);\n');
  commit('two, redrafted');
  const run = () => spawnSync('node', [GATE], { cwd: root, encoding: 'utf8' });
  return { root, git, write, commit, run };
}

test('a migration in no release tag may be redrafted on the branch', () => {
  const repo = scratchRepo();
  try {
    const r = repo.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('a migration a release tag shipped may not change, committed or not', () => {
  const repo = scratchRepo();
  try {
    repo.write('001_released.sql', 'CREATE TABLE a (id INTEGER, extra TEXT);\n');
    const dirty = repo.run();
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    assert.match(dirty.stderr, /001_released\.sql differs .*released in v1\.0\.0/);
    repo.commit('edit a released migration');
    assert.equal(repo.run().status, 1);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('a migration a stable tag shipped stays frozen after it merges into a branch tagged later', () => {
  const repo = scratchRepo();
  try {
    repo.git('tag', 'v1.0.1-preflight.1');
    repo.git('checkout', '-q', '-b', 'stable', 'v1.0.0');
    repo.write('003_stable.sql', 'CREATE TABLE c (id INTEGER);\n');
    repo.commit('three');
    repo.git('tag', 'v1.0.1');
    fs.writeFileSync(path.join(repo.root, 'NOTES'), 'stable\n');
    repo.commit('after the stable tag');
    repo.git('checkout', '-q', '-');
    repo.git('merge', '-q', '--no-edit', 'stable');
    repo.write('003_stable.sql', 'CREATE TABLE c (id INTEGER, extra TEXT);\n');
    repo.commit('edit a migration the stable tag shipped');
    const r = repo.run();
    assert.match(r.stdout, /since v1\.0\.1-preflight\.1/);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /003_stable\.sql differs .*released in v1\.0\.1/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('bytes a stable tag shipped stay frozen even when they match no tag the branch describes', () => {
  const repo = scratchRepo();
  try {
    repo.git('tag', 'v1.0.1-preflight.1');
    repo.git('checkout', '-q', '-b', 'stable', 'v1.0.0');
    repo.write('001_released.sql', 'CREATE TABLE a (id INTEGER, fixed TEXT);\n');
    repo.commit('a stable fix to 001');
    repo.git('tag', 'v1.0.1');
    fs.writeFileSync(path.join(repo.root, 'NOTES'), 'stable\n');
    repo.commit('after the stable tag');
    repo.git('checkout', '-q', '-');
    repo.git('merge', '-q', '--no-edit', 'stable');
    repo.write('001_released.sql', 'CREATE TABLE a (id INTEGER);\n');
    repo.commit('put back the bytes the branch tag shipped');
    const r = repo.run();
    assert.match(r.stdout, /since v1\.0\.1-preflight\.1/);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /001_released\.sql differs .*released in v1\.0\.1\b/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});
