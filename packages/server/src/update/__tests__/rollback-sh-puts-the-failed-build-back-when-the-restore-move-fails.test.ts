// rollback.sh, step 3: if the move of the backup into ~/.dojo/platform fails, the build that was
// running is put back, both services are loaded again on whatever folder is in place, and the
// script exits 1 with a plain message. Before: no platform folder, both services stopped, and an
// unset-variable abort inside the error message when there had been no platform folder at all.
// The REAL script runs against a scratch HOME with stub `launchctl` and `mv` (no real launchd).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(path.resolve(HERE, '../../../../..'), 'deploy/scripts/rollback.sh');

let home: string;
let dojo: string;
let binDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'rb-mvfail-'));
  dojo = path.join(home, '.dojo');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(dojo, { recursive: true });
  binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'launchctl'),
    `#!/bin/sh\necho "$@" >> "${path.join(home, 'launchctl.log')}"\nexit 0\n`, { mode: 0o755 });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** mv that fails when a platform.backup-* folder is moved onto .../platform; otherwise the real mv. */
function installFailingMv(): void {
  fs.writeFileSync(path.join(binDir, 'mv'),
    '#!/bin/sh\n' +
    'for last; do :; done\n' +
    'src="$1"; case "$src" in -*) src="$2";; esac\n' +
    'case "$(basename "$src")" in platform.backup-*) case "$last" in */platform) exit 1;; esac;; esac\n' +
    'exec /bin/mv "$@"\n', { mode: 0o755 });
}

function makeBuild(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, 'packages', 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dojo-platform', version }));
}

function run(): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      env: { ...process.env, HOME: home, DOJO_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const launchLog = (): string[] =>
  fs.readFileSync(path.join(home, 'launchctl.log'), 'utf-8').trim().split('\n');

describe('rollback.sh when the move of the backup into place fails', () => {
  it('puts the running build back, reloads both services, exits 1', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    installFailingMv();
    const { code, out } = run();
    expect(code).toBe(1);
    const v = JSON.parse(fs.readFileSync(path.join(dojo, 'platform', 'package.json'), 'utf-8')).version;
    expect(v).toBe('3.1.18');
    expect(fs.existsSync(path.join(dojo, 'platform.backup-3.1.17'))).toBe(true);
    expect(fs.readdirSync(dojo).filter((f) => f.startsWith('platform.failed-'))).toEqual([]);
    const log = launchLog();
    expect(log.slice(-2)).toEqual([
      `load ${home}/Library/LaunchAgents/com.dojo.platform.plist`,
      `load ${home}/Library/LaunchAgents/com.dojo.watchdog.plist`,
    ]);
    expect(out).toContain('previous build was put back');
  });

  it('with no platform folder to begin with: exit 1 and no unset-variable abort', () => {
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    installFailingMv();
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).not.toContain('unbound variable');
    expect(launchLog().slice(-2).join('\n')).toContain('com.dojo.watchdog.plist');
  });

  it('control: a working mv rolls back to 3.1.17 and exits 0', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    const { code } = run();
    expect(code).toBe(0);
    const v = JSON.parse(fs.readFileSync(path.join(dojo, 'platform', 'package.json'), 'utf-8')).version;
    expect(v).toBe('3.1.17');
  });
});
