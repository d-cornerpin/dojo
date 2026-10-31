// install.sh ignored the result of the watchdog's dependency install (`npm ci || npm install`) and
// of its copy, then printed "installed!". A watchdog that cannot start is the thing that performs
// the automatic rollback, so this must stop with a plain message and a non-zero exit instead.
// Only the "# Copy watchdog" .. "# ── Generate secrets ──" text of the real deploy/install.sh runs, in a
// scratch HOME with stub `npm`/`rsync` (nothing is installed, no network, no launchd).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/install.sh');
let scratch = '';

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'install-wd-'));
  fs.mkdirSync(path.join(scratch, 'pkg', 'watchdog', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'pkg', 'watchdog', 'package.json'), '{}');
  fs.writeFileSync(path.join(scratch, 'pkg', 'watchdog', 'dist', 'index.js'), '//');
  fs.mkdirSync(path.join(scratch, 'pkg', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'pkg', 'scripts', 'a.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(scratch, 'pkg', 'uninstall.sh'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(scratch, 'bin'));
  // Never the real launchctl: by default nothing is loaded.
  fs.writeFileSync(path.join(scratch, 'bin', 'launchctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function stub(name: string, body: string): void {
  fs.writeFileSync(path.join(scratch, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function run(): { status: number | null; out: string } {
  const script = fs.readFileSync(INSTALL_SH, 'utf-8');
  const from = script.indexOf('# Copy watchdog');
  const to = script.indexOf('# ── Generate secrets ──');
  if (from < 0 || to <= from) throw new Error('install.sh no longer has the watchdog block where this test cuts it');
  const cut = `DOJO_DIR="$HOME/.dojo"\nSCRIPT_DIR="${scratch}/pkg"\nmkdir -p "$DOJO_DIR"\n${script.slice(from, to)}\necho BLOCK_PASSED`;
  const r = spawnSync('/bin/bash', ['-c', cut], {
    env: { PATH: `${path.join(scratch, 'bin')}:/usr/bin:/bin`, HOME: scratch }, encoding: 'utf-8', timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('install.sh and the watchdog', () => {
  it('control: copy and dependency install succeed, the script goes on', () => {
    stub('npm', 'exit 0');
    const { status, out } = run();
    expect(status).toBe(0);
    expect(out).toContain('BLOCK_PASSED');
  });

  it('stops with a plain message and a non-zero exit when the watchdog dependencies cannot be installed', () => {
    stub('npm', 'exit 1');
    const { status, out } = run();
    expect(status).not.toBe(0);
    expect(out).toContain('watchdog');
    expect(out).toContain('was not started');
    expect(out).not.toContain('BLOCK_PASSED');
  });

  it('stops when the watchdog copy fails', () => {
    stub('npm', 'exit 0');
    stub('rsync', 'exit 23');
    const { status, out } = run();
    expect(status).not.toBe(0);
    expect(out).toContain('watchdog');
    expect(out).not.toContain('BLOCK_PASSED');
  });

  // Review FIX 6: "Dojo was not started" must be true. On a reinstall the earlier services are still
  // loaded and the new platform is already switched in, so the message says what state the box is in.
  it('on a reinstall (Dojo already loaded) the failure says what is still running, not "was not started"', () => {
    stub('npm', 'exit 1');
    stub('launchctl', 'if [ "$1" = list ]; then echo "123 0 com.dojo.platform"; echo "124 0 com.dojo.watchdog"; fi; exit 0');
    const { status, out } = run();
    expect(status).not.toBe(0);
    expect(out).not.toContain('was not started');
    expect(out).toContain('new platform is installed');
    expect(out).toContain('still running');
    expect(out).not.toContain('it had before');
    expect(out).toContain('partly updated');
  });

  it('on a first install (nothing loaded) it still says Dojo was not started', () => {
    stub('npm', 'exit 1');
    stub('launchctl', 'exit 0');
    const { status, out } = run();
    expect(status).not.toBe(0);
    expect(out).toContain('was not started');
  });

  it('a failed watchdog copy on a reinstall also says what state the box is in', () => {
    stub('npm', 'exit 0');
    stub('rsync', 'exit 23');
    stub('launchctl', 'if [ "$1" = list ]; then echo "123 0 com.dojo.platform"; fi; exit 0');
    const { out } = run();
    expect(out).not.toContain('was not started');
    expect(out).toContain('new platform is installed');
  });
});
