// 914: the roster reader must open a database that a stopped server left in WAL mode with no -wal file,
// must say so loudly when an existing file cannot be read, and the stand-in scan must not count the registry itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readLiveRoster, trackedTextFiles } from '../fixture-names.mjs';

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-914-'));
  const prev = process.env.DOJO_HOME;
  process.env.DOJO_HOME = home;
  fs.mkdirSync(path.join(home, '.dojo/data'), { recursive: true });
  try { return fn(path.join(home, '.dojo/data/dojo.db')); }
  finally { if (prev === undefined) delete process.env.DOJO_HOME; else process.env.DOJO_HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
}

test('a stopped WAL-mode database gives its roster', () => withHome((db) => {
  execFileSync('sqlite3', [db, 'PRAGMA journal_mode=wal; CREATE TABLE agents(name); INSERT INTO agents VALUES (\'Aaaa\'),(\'Bbbb\');'], { stdio: 'ignore' });
  fs.rmSync(`${db}-wal`, { force: true });
  fs.rmSync(`${db}-shm`, { force: true });
  assert.deepEqual(readLiveRoster(), ['Aaaa', 'Bbbb']);
}));

test('a file that is not a database throws, naming the gate', () => withHome((db) => {
  fs.writeFileSync(db, 'garbage bytes, not a database at all\n'.repeat(20));
  assert.throws(() => readLiveRoster(), /^Error: fixture-names gate: cannot read the Dojo database/);
}));

test('a missing file gives null', () => withHome(() => {
  assert.equal(readLiveRoster(), null);
}));

test('the stand-in scan skips the registry file itself', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-914-tree-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    fs.mkdirSync(path.join(root, 'deploy/checks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deploy/checks/fixture-names.json'), '{"standIns":["Zergo"]}');
    fs.writeFileSync(path.join(root, 'other.txt'), 'x');
    git('add', '-A');
    const rels = trackedTextFiles(root).map((f) => f.rel);
    assert.deepEqual(rels, ['other.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
