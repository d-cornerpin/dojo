// BUILD-PACKAGE.SH STOPS WHEN THE WATCHDOG DOES NOT BUILD. The real `deploy/build-package.sh` is
// run (spawned with /bin/bash inside a scratch project root, with stub `npm` and `npx` first on
// PATH — fake data only, the real build never runs) against a watchdog compile that fails. The
// failure used to be hidden by `2>/dev/null || true`, and the package then shipped the LAST
// successful build's watchdog, or none at all — a box whose automatic rollback could not run and
// nobody said so.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/build-package.sh');
const scratches: string[] = [];

afterAll(() => { for (const s of scratches) fs.rmSync(s, { recursive: true, force: true }); });

// A scratch project root: the real script copied into deploy/ (it finds its project root from its
// own location), a package.json and an empty watchdog/ — just enough for it to reach the build.
// `npxBody` is the body of the stub `npx`; the stub `npm` always succeeds.
function scratchProject(npxBody: string): string {
  const root = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'build-package-'));
  scratches.push(root);
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.copyFileSync(SCRIPT, path.join(root, 'deploy', 'build-package.sh'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.0.0-test"}');
  fs.mkdirSync(path.join(root, 'watchdog'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/bash\n${npxBody}\n`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  fs.chmodSync(path.join(bin, 'npx'), 0o755);
  return root;
}

function runScript(root: string): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [path.join(root, 'deploy', 'build-package.sh')], {
    cwd: root,
    env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, HOME: root },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('build-package.sh stops when the watchdog does not build', () => {
  it('a watchdog compile error stops the build and says the watchdog did not compile', () => {
    const root = scratchProject('if [[ "$1" == "tsc" ]]; then echo "tsc error" >&2; exit 1; fi\nexit 0');
    const { status, out } = runScript(root);
    expect(status).not.toBe(0);
    expect(out).toContain('watchdog did not compile');
    expect(out).not.toContain('Assembling package');
  });

  it('an npx that succeeds but leaves no watchdog/dist/index.js stops the build too', () => {
    const root = scratchProject('exit 0');
    const { status, out } = runScript(root);
    expect(status).not.toBe(0);
    expect(out).toContain('no dist/index.js');
    expect(out).not.toContain('Assembling package');
  });
});
