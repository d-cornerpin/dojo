// rollback.sh, step 3: if the move of the backup into ~/.dojo/platform fails, the build that was
// running is put back, both services are loaded again on whatever folder is in place, and the
// script exits 1 with a plain message. Before: no platform folder, both services stopped, and an
// unset-variable abort inside the error message when there had been no platform folder at all.
// The REAL script runs against a scratch HOME with stub `launchctl` and `mv` (no real launchd).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
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
    `#!/bin/sh\ncase "$1" in list) printf '1\\t0\\tcom.dojo.platform\\n-\\t0\\tcom.dojo.watchdog\\n'; exit 0;; esac\necho "$@" >> "${path.join(home, 'launchctl.log')}"\nexit 0\n`, { mode: 0o755 });
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

// Review FIXES 3, 4, 7 (rollback.sh): no nesting, no false "as it was", a launchctl failure is not
// "Rolled back", and a TERM/INT/HUP does not leave the services unloaded.
describe('rollback.sh edge cases found in review', () => {
  const pkgVersion = (d: string): string | null => {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf-8')).version; } catch { return null; }
  };

  it('a leftover platform.failed-<version>-<time> folder is never reused or nested into', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    makeBuild(path.join(dojo, 'platform.failed-3.1.18-20260101-000000'), '3.1.99-old-failure');
    fs.writeFileSync(path.join(binDir, 'date'), '#!/bin/sh\ncase "$1" in +%Y%m%d-%H%M%S) echo 20260101-000000;; *) exec /bin/date "$@";; esac\n', { mode: 0o755 });
    installFailingMv();
    const { code, out } = run();
    expect(code).toBe(1);
    expect(pkgVersion(path.join(dojo, 'platform'))).toBe('3.1.18');
    expect(pkgVersion(path.join(dojo, 'platform.failed-3.1.18-20260101-000000'))).toBe('3.1.99-old-failure');
    expect(fs.existsSync(path.join(dojo, 'platform', 'platform.failed-3.1.18-20260101-000000'))).toBe(false);
    expect(out).toContain('Dojo is as it was');
  });

  it('a partial platform folder left by the failed restore is moved aside before the running build goes back', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    fs.writeFileSync(path.join(binDir, 'mv'),
      '#!/bin/sh\nfor last; do :; done\nsrc="$1"\n' +
      'case "$(basename "$src")" in platform.backup-*) case "$last" in */platform) mkdir -p "$last"; echo half > "$last/partial.txt"; exit 1;; esac;; esac\n' +
      'exec /bin/mv "$@"\n', { mode: 0o755 });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(pkgVersion(path.join(dojo, 'platform'))).toBe('3.1.18');
    expect(fs.existsSync(path.join(dojo, 'platform', 'platform.failed-3.1.18'))).toBe(false);
    expect(fs.readdirSync(dojo).some((f) => f.startsWith('platform.partial-'))).toBe(true);
    expect(out).toContain('Dojo is as it was');
  });

  it('never says "as it was" when the build that came back has no package.json', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    // Both moves "work" but leave an empty folder: the running build is lost to the stub.
    fs.writeFileSync(path.join(binDir, 'mv'),
      '#!/bin/sh\nfor last; do :; done\ncase "$last" in */platform) mkdir -p "$last"; exit 0;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).not.toContain('Dojo is as it was');
    expect(out).not.toContain('Rolled back');
  });

  it('a restore that "succeeds" into a folder that is not the expected build is not reported as rolled back', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    fs.writeFileSync(path.join(binDir, 'mv'),
      '#!/bin/sh\nfor last; do :; done\nsrc="$1"\ncase "$(basename "$src")" in platform.backup-*) case "$last" in */platform) mkdir -p "$last"; exit 0;; esac;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).not.toContain('Rolled back');
  });

  it('a failed launchctl load is not reported as "Rolled back"', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    fs.writeFileSync(path.join(binDir, 'launchctl'),
      `#!/bin/sh\necho "$@" >> "${path.join(home, 'launchctl.log')}"\ncase "$1 $2" in "load "*watchdog*) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
    const { code, out } = run();
    expect(code).not.toBe(0);
    expect(out).not.toContain('Rolled back');
    expect(out).toContain('watchdog');
  });

  for (const sig of ['TERM', 'INT', 'HUP'] as const) {
    it(`SIG${sig} between stopping and starting reloads both services`, async () => {
      makeBuild(path.join(dojo, 'platform'), '3.1.18');
      makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
      // The first mv blocks long enough for the signal to arrive.
      fs.writeFileSync(path.join(binDir, 'mv'),
        `#!/bin/sh\ntouch "${path.join(home, 'mv.started')}"\nsleep 2\nexec /bin/mv "$@"\n`, { mode: 0o755 });
      const child = spawn('bash', [SCRIPT], {
        env: { ...process.env, HOME: home, DOJO_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        stdio: 'ignore', detached: true,
      });
      const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
      for (let i = 0; i < 250 && !fs.existsSync(path.join(home, 'mv.started')); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fs.existsSync(path.join(home, 'mv.started'))).toBe(true);
      process.kill(child.pid!, `SIG${sig}`);
      await closed;
      const log = launchLog();
      const loads = log.filter((l) => l.startsWith('load '));
      expect(loads.some((l) => l.includes('com.dojo.platform.plist'))).toBe(true);
      expect(loads.some((l) => l.includes('com.dojo.watchdog.plist'))).toBe(true);
      expect(fs.existsSync(path.join(dojo, 'rollback.lock'))).toBe(false);
    });
  }
});

// Re-check fixes 1, 2 and 5.
describe('rollback.sh re-check fixes', () => {
  it('SIGTERM during the first unload still reloads both services', async () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    fs.writeFileSync(path.join(binDir, 'launchctl'),
      `#!/bin/sh\necho "$@" >> "${path.join(home, 'launchctl.log')}"\nif [ "$1" = unload ] && [ ! -e "${path.join(home, 'u.started')}" ]; then touch "${path.join(home, 'u.started')}"; sleep 2; fi\nexit 0\n`, { mode: 0o755 });
    const child = spawn('bash', [SCRIPT], {
      env: { ...process.env, HOME: home, DOJO_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` }, stdio: 'ignore', detached: true,
    });
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
    for (let i = 0; i < 250 && !fs.existsSync(path.join(home, 'u.started')); i++) await new Promise((r) => setTimeout(r, 20));
    process.kill(child.pid!, 'SIGTERM');
    await closed;
    const loads = launchLog().filter((l) => l.startsWith('load '));
    expect(loads.some((l) => l.includes('com.dojo.platform.plist'))).toBe(true);
    expect(loads.some((l) => l.includes('com.dojo.watchdog.plist'))).toBe(true);
  });

  it('a whole backup whose package.json has no version line is restored, as before', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    fs.mkdirSync(path.join(dojo, 'platform.backup-3.1.17'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'platform.backup-3.1.17', 'package.json'), '{"name":"x"}');
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('Rolled back');
    expect(fs.readFileSync(path.join(dojo, 'platform', 'package.json'), 'utf-8')).toContain('"x"');
    expect(fs.readdirSync(dojo).some((f) => f.startsWith('platform.partial-'))).toBe(false);
  });

  it('a backup that moved but does not verify goes back to its own name, and the message about it is true', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    // The move works, then the stub damages the result (package.json gone).
    fs.writeFileSync(path.join(binDir, 'mv'),
      '#!/bin/sh\nfor last; do :; done\n/bin/mv "$@" || exit $?\ncase "$(basename "$1")" in platform.backup-*) case "$last" in */platform) rm -f "$last/package.json";; esac;; esac\nexit 0\n', { mode: 0o755 });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dojo, 'platform.backup-3.1.17'))).toBe(true);
    expect(fs.readdirSync(dojo).some((f) => f.startsWith('platform.partial-'))).toBe(false);
    expect(out).not.toContain('Rolled back');
  });

  it('when the previous build cannot be put back and platform/ is in the way, the manual command says to clear it first', () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    // Restore leaves a partial platform/, and every later move fails.
    fs.writeFileSync(path.join(binDir, 'mv'),
      '#!/bin/sh\nn=$(cat "' + path.join(home, 'mvn') + '" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "' + path.join(home, 'mvn') + '"\n' +
      'for last; do :; done\nif [ "$n" = 1 ]; then exec /bin/mv "$@"; fi\n' +
      'if [ "$n" = 2 ]; then mkdir -p "$last"; echo half > "$last/p"; exit 1; fi\nexit 1\n', { mode: 0o755 });
    const { out } = run();
    expect(out).toContain('in the way');
    expect(out).toContain('remove or rename');
  });
});

