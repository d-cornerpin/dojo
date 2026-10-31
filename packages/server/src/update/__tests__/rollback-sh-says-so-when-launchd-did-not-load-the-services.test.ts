// rollback.sh, step 4, and start.sh answer "is the service up?" the SAME way: launchd's own list
// (`launchctl list`), not the exit status of `launchctl load`. The REAL scripts run against a
// scratch HOME with a stub `launchctl` first on PATH; no real launchd is reached.
// Before: rollback.sh printed "The server is restarting." and exited 0 whatever launchd did.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const homes: string[] = [];
afterEach(() => { while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true }); });

/** `listed`: labels the stub's `list` prints. `loadStatus`: what `load` exits with. */
function scratch(listed: string[], loadStatus: number): string {
  const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'launchd-rule-'));
  homes.push(home);
  const dojo = path.join(home, '.dojo');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  for (const svc of ['platform', 'watchdog']) fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', `com.dojo.${svc}.plist`), '');
  for (const [dir, v] of [['platform', '3.1.18'], ['platform.backup-3.1.17', '3.1.17']]) {
    fs.mkdirSync(path.join(dojo, dir, 'packages', 'server', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dojo, dir, 'package.json'), JSON.stringify({ name: 'dojo-platform', version: v }));
    fs.writeFileSync(path.join(dojo, dir, 'packages', 'server', 'dist', 'index.js'), '// build\n');
  }
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const lines = listed.map((l) => `printf '123\\t0\\t${l}\\n'`).join('\n');
  fs.writeFileSync(path.join(bin, 'launchctl'),
    `#!/bin/sh\ncase "$1" in\n  list) ${lines || ':'} ;;\n  load) exit ${loadStatus} ;;\nesac\nexit 0\n`, { mode: 0o755 });
  return home;
}

function run(script: string, home: string): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [path.join(ROOT, 'deploy/scripts', script)], {
    env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, HOME: home, DOJO_HOME: home },
    encoding: 'utf-8', timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const BOTH = ['com.dojo.platform', 'com.dojo.watchdog'];

describe('rollback.sh judges the restart by launchctl list', () => {
  it('says the restart worked, and exits 0, when both labels are listed', () => {
    const r = run('rollback.sh', scratch(BOTH, 0));
    expect(r.status).toBe(0);
    expect(r.out).toContain('Rolled back to 3.1.17');
  });
  it('exits 1 and names what is missing when launchd lists neither', () => {
    const r = run('rollback.sh', scratch([], 0));
    expect(r.status).toBe(1);
    expect(r.out).toContain('launchd did not load the platform and the watchdog');
    expect(r.out).not.toContain('The server is restarting');
  });
  it('names only the watchdog when only the watchdog is missing', () => {
    const r = run('rollback.sh', scratch(['com.dojo.platform'], 0));
    expect(r.status).toBe(1);
    expect(r.out).toContain('did not load the watchdog');
  });
  it('trusts the list, not the exit status of load', () => {
    expect(run('rollback.sh', scratch(BOTH, 1)).status).toBe(0);
  });
});

describe('start.sh follows the same rule', () => {
  it('exits 0 when both are listed, even if load exited non-zero (already loaded)', () => {
    const r = run('start.sh', scratch(BOTH, 1));
    expect(r.status).toBe(0);
    expect(r.out).toContain('Services started');
  });
  it('exits 1 when launchd lists neither', () => {
    const r = run('start.sh', scratch([], 0));
    expect(r.status).toBe(1);
    expect(r.out).toContain('did not load the platform and the watchdog');
  });
});
