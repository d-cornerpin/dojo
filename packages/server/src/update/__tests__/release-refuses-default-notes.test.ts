// ════════════════════════════════════════════════════════════════════════════════════════
// G23 (v3.5) — THE RELEASE SCRIPT REFUSES WITHOUT PLAIN NOTES.
//
// THE DEFECT. With `--notes-file` absent, `release.sh` fell back to `git log --pretty='- %s'`: the
// commit subjects, in developer words, published as the release notes a user reads in Settings.
// `deploy/RELEASE.md` says never to do that, and nothing stopped it.
//
// THE RULE. A Stable or Preflight release without `--notes-file` (or with an empty one) is refused
// before anything is touched: "Refused: a release needs plain release notes (--notes-file). The rule
// is in deploy/RELEASE.md. NOT publishing." A `--dry-run` says the same as a WOULD FAIL line and still
// proves the other gates. The fallback block is gone.
//
// HOW IT IS DRIVEN. The REAL script, with a `gh` that fails authentication placed first on PATH: the
// refusal comes before the first `gh` call, and a run that passes the notes check stops at the stub's
// "gh is not authenticated", so nothing is built, committed, tagged, pushed or published, and the
// stub's call log proves what was (not) reached.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const RELEASE_SH = path.join(REPO_ROOT, 'deploy/release.sh');

const REFUSAL = 'Refused: a release needs plain release notes (--notes-file). The rule is in deploy/RELEASE.md. NOT publishing.';

let sandbox: string;
let ghLog: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT ?? os.tmpdir(), 'g23-'));
  ghLog = path.join(sandbox, 'gh-calls');
  fs.mkdirSync(path.join(sandbox, 'bin'));
  fs.writeFileSync(path.join(sandbox, 'bin', 'gh'), `#!/bin/sh\necho "$@" >> "${ghLog}"\nexit 1\n`, { mode: 0o755 });
});
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function release(args: string[], cwd = REPO_ROOT) {
  const r = spawnSync('bash', [RELEASE_SH, ...args], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${path.join(sandbox, 'bin')}:${process.env.PATH ?? ''}` },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const ghCalled = () => fs.existsSync(ghLog);
const notes = (text: string) => { const f = path.join(sandbox, 'notes.md'); fs.writeFileSync(f, text); return f; };

describe('G23: a release without plain notes is refused before anything is touched', () => {
  it('Stable without --notes-file: refused with the rule, and gh is never called', () => {
    const r = release(['9.9.9']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(REFUSAL);
    expect(ghCalled(), 'the refusal came after a gh call').toBe(false);
  });

  it('Preflight without --notes-file: refused the same way', () => {
    const r = release(['--preflight']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(REFUSAL);
    expect(ghCalled()).toBe(false);
  });

  it('an empty notes file is no notes', () => {
    const r = release(['9.9.9', '--notes-file', notes('  \n\n')]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(REFUSAL);
    expect(ghCalled()).toBe(false);
  });

  it('a notes file that does not exist is refused, naming the path', () => {
    const r = release(['9.9.9', '--notes-file', path.join(sandbox, 'missing.md')]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Notes file not found: .*missing\.md/);
    expect(ghCalled()).toBe(false);
  });

  it('--dry-run reports the same refusal as a would-fail line, and still goes on to the other checks', () => {
    const r = release(['9.9.9', '--dry-run']);
    expect(r.out).toMatch(/WOULD FAIL.*Refused: a release needs plain release notes \(--notes-file\)/);
    expect(ghCalled(), 'a dry run stopped at the notes line and proved nothing else').toBe(true);
    expect(r.code).not.toBe(0);
  });

  it('a RELATIVE --notes-file is made absolute before the script changes directory, so it is still found after', () => {
    notes('Fixed: something plain.\n');
    // Run from the sandbox: `notes.md` is valid there, and release.sh then `cd`s to the repo root.
    const r = release(['9.9.9', '--notes-file', 'notes.md'], sandbox);
    expect(r.out).not.toMatch(/Notes file not found|Refused: a release needs plain release notes/);
    expect(r.out).toContain(`release notes: ${path.join(fs.realpathSync(sandbox), 'notes.md')}`);
  });

  it('with real notes the notes check passes (the run goes on to the first gh call, which the stub fails)', () => {
    const r = release(['9.9.9', '--notes-file', notes('Fixed: chat follows the newest message.\n')]);
    expect(r.out).not.toContain('Refused: a release needs plain release notes');
    expect(r.out).toMatch(/gh is not authenticated/);
    expect(ghCalled()).toBe(true);
  });
});

describe('G23: the old mechanisms are gone (a census, not a sentence)', () => {
  const src = fs.readFileSync(RELEASE_SH, 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('no commit-subject notes and no bare --generate-notes remain', () => {
    expect(src).not.toMatch(/--pretty=/);
    expect(src).not.toMatch(/--generate-notes/);
    expect(src).not.toMatch(/Changes since/);
  });

  it('the release commit names no model: its trailer is the identity the repo config carries', () => {
    expect(src).not.toMatch(/Claude|anthropic/i);
    expect(src).toMatch(/Co-Authored-By: \$\{?RELEASE_IDENTITY/);
    expect(src).toMatch(/git config user\.email/);
  });
});
