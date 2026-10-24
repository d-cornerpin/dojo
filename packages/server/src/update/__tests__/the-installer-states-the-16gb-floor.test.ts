// v3.5 A2, REVIEW FOCUS 3 — A BOX WITH LESS THAN 16 GB IS TOLD THE FLOOR PLAINLY BEFORE ANYTHING IS
// INSTALLED. Only the PREFLIGHT block of the real `deploy/install.sh` is run (the text between its
// "Preflight checks" and "Install Homebrew" headings, cut out of the file as shipped), with `uname`,
// `sysctl` and `sw_vers` shimmed on PATH and "N" on stdin. The rest of the script never runs here: a
// first draft ran the whole file and, on a box above the old floor, it went on past the preflight.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/install.sh');
const GIB = 1024 ** 3;
let shimRoot = '';

beforeAll(() => {
  shimRoot = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'install-floor-'));
});
afterAll(() => { fs.rmSync(shimRoot, { recursive: true, force: true }); });

function runPreflight(ramBytes: number): { status: number | null; out: string } {
  const bin = fs.mkdtempSync(path.join(shimRoot, 'bin-'));
  const shim = (name: string, body: string): void => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };
  shim('uname', 'echo Darwin');
  shim('sysctl', `echo ${ramBytes}`);
  shim('sw_vers', 'echo 15.0');
  const script = fs.readFileSync(INSTALL_SH, 'utf-8');
  const from = script.indexOf('# ── Preflight checks ──');
  const to = script.indexOf('# ── Install Homebrew ──');
  if (from < 0 || to <= from) throw new Error('install.sh no longer has its preflight block where this test cuts it');
  const r = spawnSync('/bin/bash', ['-c', `${script.slice(from, to)}\necho PREFLIGHT_PASSED`], {
    input: 'N',
    env: { PATH: `${bin}:/bin:/usr/bin`, HOME: shimRoot },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the installer states the 16 GB floor', () => {
  it('an 8 GB box is told why 16 GB is the floor, asked, and stops on N before installing anything', () => {
    const { status, out } = runPreflight(8 * GIB);
    expect(out).toContain('This Mac has 8GB of memory. The Dojo needs 16GB');
    expect(out).toContain('two small local models of its own');
    expect(out).not.toContain('PREFLIGHT_PASSED');
    expect(status).toBe(1);
  });

  it('a 12 GB box is under the floor too', () => {
    const { out } = runPreflight(12 * GIB);
    expect(out).toContain('This Mac has 12GB of memory. The Dojo needs 16GB');
  });

  it('a 16 GB box passes the preflight without a warning', () => {
    const { out } = runPreflight(16 * GIB);
    expect(out).not.toContain('The Dojo needs 16GB');
    expect(out).toContain('PREFLIGHT_PASSED');
  });
});
