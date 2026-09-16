// ════════════════════════════════════════
// Creates the one throwaway home-root for this `vitest run`, and removes it after.
// Runs in the MAIN process, once, around the whole suite. The per-worker homes
// underneath it are carved out by `vitest.setup.ts`.
//
// DOJO_TEST_HOME_KEEP=1 leaves the tree behind — the only reason not to delete it is
// that someone wants to read it.
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function root(): string {
  const declared = process.env.DOJO_TEST_HOME_ROOT;
  if (declared && declared !== '') return declared;
  return path.join(os.tmpdir(), 'dojo-test-homes', `run-${process.pid}-${Date.now().toString(36)}`);
}

export function setup(): void {
  const dir = root();
  process.env.DOJO_TEST_HOME_ROOT = dir;
  fs.mkdirSync(dir, { recursive: true });
  // The main process itself gets a home under the same root, so anything the runner
  // loads (a reporter, a config-time import) cannot fall through to the real one.
  const own = path.join(dir, 'runner');
  fs.mkdirSync(path.join(own, '.dojo'), { recursive: true });
  process.env.DOJO_HOME = own;
}

export function teardown(): void {
  if (process.env.DOJO_TEST_HOME_KEEP === '1') {
    process.stdout.write(`\n[dojo] test homes kept at ${root()}\n`);
    return;
  }
  const dir = root();
  // Only ever remove a directory this run created, under the system temp dir or an
  // explicitly declared root. Never a path that merely looks like one.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp tree is a nuisance, never a reason to fail a green run.
  }
}
