// SOURCE SWEEP s12 F1 — `deploy/verify-release.sh` must check the integrity manifest it
// publishes beside the zip. `deploy/release.sh` uploads THREE assets (the zip, the installer
// and dojo-platform.zip.sha256) but the guard rail only checked two, so a release whose
// manifest was missing or mismatched still "passed" and every box then silently refused (or
// silently accepted unverified) the update. This test runs the whole `deploy/verify-release.sh`
// with `gh` and `curl` shimmed on PATH and the version passed as an argument so the script never
// calls node. The curl shim serves the range-GET one-byte probe as HTTP 206 and writes the zip
// bytes (`zipbytes`) or the manifest digest (`$STUB_DIGEST`) to the requested `-o` file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const VERIFY_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/verify-release.sh');
let shimRoot = '';

beforeAll(() => {
  shimRoot = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'verify-release-'));
});
afterAll(() => { fs.rmSync(shimRoot, { recursive: true, force: true }); });

const ALL3 = 'dojo-platform.zip:uploaded\nAgent-DOJO-Installer.pkg:uploaded\ndojo-platform.zip.sha256:uploaded\n';
const TWO = 'dojo-platform.zip:uploaded\nAgent-DOJO-Installer.pkg:uploaded\n';
const GOOD = createHash('sha256').update('zipbytes').digest('hex');

function runVerify(assets: string, digest: string): { status: number | null; out: string } {
  const scratch = fs.mkdtempSync(path.join(shimRoot, 'scratch-'));
  const bin = fs.mkdtempSync(path.join(shimRoot, 'bin-'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
case "$*" in
  *"--json assets"*) printf '%s' "$STUB_ASSETS" ;;
  *"--json body"*) echo "Plain notes for users." ;;
  "api repos/"*"/releases/latest"*) echo "v\${STUB_VERSION}" ;;
  *"release view"*) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
out=""; url=""; prev=""; range=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$a" = "-r" ] && range=1
  prev="$a"; url="$a"
done
if [ "$range" = 1 ]; then printf '206'; exit 0; fi
case "$url" in
  *.zip.sha256) printf '%s  dojo-platform.zip\n' "$STUB_DIGEST" > "$out" ;;
  *.zip) printf 'zipbytes' > "$out" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
  const r = spawnSync('/bin/bash', [VERIFY_SH, '9.9.9'], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, STUB_VERSION: '9.9.9', STUB_ASSETS: assets, STUB_DIGEST: digest },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('verify-release checks the integrity manifest', () => {
  it('A: all three assets uploaded and a matching manifest passes', () => {
    const { status, out } = runVerify(ALL3, GOOD);
    expect(out).toContain('asset present: dojo-platform.zip.sha256');
    expect(out).toContain('integrity manifest matches the zip');
    expect(status).toBe(0);
  });

  it('B: a release missing the manifest asset fails', () => {
    const { status, out } = runVerify(TWO, GOOD);
    expect(status).toBe(1);
    expect(out).toContain('missing or not-uploaded asset: dojo-platform.zip.sha256');
  });

  it('C: a release whose manifest does not match the zip fails', () => {
    const { status, out } = runVerify(ALL3, 'a'.repeat(64));
    expect(status).toBe(1);
    expect(out).toContain('integrity manifest does not match the zip');
  });

  it('D: an upper-case digest still matches', () => {
    const { status } = runVerify(ALL3, GOOD.toUpperCase());
    expect(status).toBe(0);
  });

  it('E: the repair text names the manifest', () => {
    const { out } = runVerify(ALL3, 'a'.repeat(64));
    expect(out).toContain('deploy/dist/dojo-platform.zip.sha256');
  });
});
