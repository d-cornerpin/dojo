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
});
