// THE TWO GATES READ FILE NAMES WITHOUT GIT QUOTING. `check-bytes.mjs` and `check-no-personal-names.mjs`
// used to ask git for a list of paths the way a human reads one — one per line, with a non-ASCII
// letter escaped as `"caf\303\251.ts"` (with the quotes). They then asked fs about that escaped
// text, got false, and skipped the file without a word, so a NUL byte or a planted name hiding
// behind an accented letter name slipped through. Read the list the NUL-delimited way git's own
// -z flag hands it, with no quoting at all.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const BYTES = path.join(ROOT, 'deploy/checks/check-bytes.mjs');
const NAMES = path.join(ROOT, 'deploy/checks/check-no-personal-names.mjs');
const repos: string[] = [];

afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });

// A hermetic, repo-local git: HOME points at the scratch repo and the global/system config is cut
// off, so git's default quoting stays on (the bug condition) and nothing reads the real box.
function envFor(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'gate-quoting-'));
  repos.push(dir);
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, env: envFor(dir) });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'user.name', 't']);
  return dir;
}

function runBytes(dir: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync('node', [BYTES, ...args], {
    cwd: dir,
    env: envFor(dir),
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the two gates read file names without git quoting', () => {
  it('byte hygiene flags a NUL byte hidden behind an accented file name', () => {
    const dir = scratchRepo();
    // a NUL byte between two ASCII letters — the shape this gate exists to catch
    fs.writeFileSync(path.join(dir, 'café.ts'), Buffer.from([0x61, 0x00, 0x62]));
    fs.writeFileSync(path.join(dir, 'plain.ts'), 'ok');
    spawnSync('git', ['add', '.'], { cwd: dir, env: envFor(dir) });
    const { status, out } = runBytes(dir, []);
    expect(status).toBe(1);
    expect(out).toContain('café.ts');
  });

  it('the same NUL byte is caught when run with --staged', () => {
    const dir = scratchRepo();
    fs.writeFileSync(path.join(dir, 'café.ts'), Buffer.from([0x61, 0x00, 0x62]));
    fs.writeFileSync(path.join(dir, 'plain.ts'), 'ok');
    spawnSync('git', ['add', '.'], { cwd: dir, env: envFor(dir) });
    const { status, out } = runBytes(dir, ['--staged']);
    expect(status).toBe(1);
    expect(out).toContain('café.ts');
  });

  it('a clean accented file is read and still passes', () => {
    const dir = scratchRepo();
    fs.writeFileSync(path.join(dir, 'café.ts'), 'ok');
    spawnSync('git', ['add', '.'], { cwd: dir, env: envFor(dir) });
    const { status, out } = runBytes(dir, []);
    expect(status).toBe(0);
    expect(out).toContain('byte hygiene clean');
  });

  it('a repo with no tracked source file is told nothing was checked, not clean', () => {
    const dir = scratchRepo();
    const { status, out } = runBytes(dir, []);
    expect(status).toBe(1);
    expect(out).toContain('nothing was checked');
  });

  it('the names gate reads its file list NUL-delimited, not by quoted lines', () => {
    const text = fs.readFileSync(NAMES, 'utf-8');
    expect(text).not.toContain('execSync("git ls-files"');
    expect(text).toContain("'ls-files', '-z'");
  });
});
