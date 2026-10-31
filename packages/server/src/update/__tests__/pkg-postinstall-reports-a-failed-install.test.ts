// THE PKG POSTINSTALL REPORTS A FAILED INSTALL. The launcher `deploy/pkg-scripts/postinstall`
// writes ignored install.sh's exit status: it always printed the green "Installation complete",
// waited 5 seconds and closed the Terminal window — a person whose install failed was told it
// worked, and the reason scrolled away with the closed window.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/pkg-scripts/postinstall');
const scratches: string[] = [];

afterAll(() => { for (const s of scratches) fs.rmSync(s, { recursive: true, force: true }); });

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A scratch folder whose name contains a space (the install folder must survive that in the
// generated launcher). A `bin` folder with stubs for sudo/open/osascript/sleep/clear goes first
// on PATH; each stub appends its name and arguments to $DOJO_STUB_LOG and exits 0 — the sudo stub
// does not run the rest of its command line. The fake install.sh exits with the given status.
function scratchSetup(installStatus: number): { extra: Record<string, string>; launcher: string; log: string } {
  const scratch = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'pkg postinstall '));
  scratches.push(scratch);
  const installTemp = path.join(scratch, 'dojo install');
  fs.mkdirSync(installTemp);
  fs.writeFileSync(path.join(installTemp, 'install.sh'), `#!/bin/bash\nexit ${installStatus}\n`);
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(scratch, 'calls.log');
  for (const name of ['sudo', 'open', 'osascript', 'sleep', 'clear']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nprintf "%s %s\\n" "${name}" "$*" >> "$DOJO_STUB_LOG"\nexit 0\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const launcher = path.join(scratch, 'dojo run install.sh');
  const extra = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: scratch,
    USER: 'tester',
    DOJO_PKG_INSTALL_TEMP: installTemp,
    DOJO_PKG_LAUNCHER: launcher,
    DOJO_STUB_LOG: log,
  };
  return { extra, launcher, log };
}

// The hand-built env is applied to process.env for the run and restored after it: the iMessage
// test net (vitest.test-nets.cjs) gives any env handed to spawnSync its own stand-in directory
// first, which would swallow the launcher's `osascript`; a child that inherits process.env keeps
// the stub bin first — the escape the net itself documents.
function underExtra<T>(extra: Record<string, string>, fn: () => T): T {
  const keys = Object.keys(extra);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) process.env[k] = extra[k];
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function runScript(file: string): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [file], { encoding: 'utf-8', timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function callsOf(log: string, name: string): string[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf-8').split('\n').filter((line) => line.startsWith(`${name} `));
}

// The success path backgrounds the osascript close and exits straight away, so the stub can land
// in the log a moment after the launcher returns; wait for `wanted` calls (or a short deadline).
function callsWaiting(log: string, name: string, wanted: number): string[] {
  const deadline = Date.now() + 2000;
  for (;;) {
    const calls = callsOf(log, name);
    if (calls.length >= wanted || Date.now() >= deadline) return calls;
    waitMs(10);
  }
}

// The failure path must neither wait nor close the window at all; give a backgrounded stub a
// moment to land, then report any call of those names that appeared.
function lateCalls(log: string, names: string[]): string[] {
  const deadline = Date.now() + 300;
  for (;;) {
    const found = names.flatMap((n) => callsOf(log, n));
    if (found.length > 0 || Date.now() >= deadline) return found;
    waitMs(10);
  }
}

describe('pkg postinstall reports a failed install', () => {
  it('a failing install.sh: the launcher exits 1, never says "Installation complete", and leaves the window open', () => {
    const { extra, launcher, log } = scratchSetup(1);
    expect(underExtra(extra, () => runScript(SCRIPT)).status).toBe(0);
    expect(fs.existsSync(launcher)).toBe(true);
    const run = underExtra(extra, () => runScript(launcher));
    expect(run.status).toBe(1);
    expect(run.out).not.toContain('Installation complete');
    expect(run.out).toContain('did not finish');
    expect(lateCalls(log, ['sleep', 'osascript'])).toEqual([]);
  });

  it('a passing install.sh keeps the old behaviour: "Installation complete", then the wait and the close', () => {
    const { extra, launcher, log } = scratchSetup(0);
    expect(underExtra(extra, () => runScript(SCRIPT)).status).toBe(0);
    const run = underExtra(extra, () => runScript(launcher));
    expect(run.status).toBe(0);
    expect(run.out).toContain('Installation complete');
    expect(callsWaiting(log, 'sleep', 1)).toHaveLength(1);
    expect(callsWaiting(log, 'osascript', 1)).toHaveLength(1);
  });

  it('postinstall itself exits 0, pass or fail, and its open call names the launcher path', () => {
    for (const installStatus of [0, 1]) {
      const { extra, launcher, log } = scratchSetup(installStatus);
      expect(underExtra(extra, () => runScript(SCRIPT)).status).toBe(0);
      const logged = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
      expect(logged).toContain('open');
      expect(logged).toContain(launcher);
    }
  });
});
