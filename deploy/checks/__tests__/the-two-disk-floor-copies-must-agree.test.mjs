// The watchdog and the server each keep the flat disk floor by hand; the watchdog contract check prints a
// failure when the two copies disagree. Run through the real check on a scratch repository holding copies
// of the files it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const GATE = path.join(REPO, 'deploy/checks/check-watchdog-contract.mjs');
const FILES = ['packages/server/src/update-state.ts', 'watchdog/src/auto-rollback.ts', 'watchdog/src/disk-floor.ts',
  'packages/server/src/update/disk-preflight.ts', 'watchdog/package.json'];

function scratch(serverFloor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-floor-test-'));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  const server = path.join(root, 'packages/server/src/update/disk-preflight.ts');
  if (serverFloor) fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replace(/DISK_FLOOR_BYTES = [^;]+;/, `DISK_FLOOR_BYTES = ${serverFloor};`));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return { root, run: () => spawnSync('node', [GATE], { cwd: root, encoding: 'utf8' }) };
}

test('the server and watchdog disk floors agree as shipped', () => {
  const box = scratch(null);
  try {
    const r = box.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /disk floor/);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test('a server floor that differs from the watchdog floor is printed as a failure', () => {
  const box = scratch('2 * 1024 * 1024 * 1024');
  try {
    const r = box.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DISK_FLOOR_BYTES/);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});
