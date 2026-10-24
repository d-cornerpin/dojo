// ════════════════════════════════════════════════════════════════════════════════════════
// G23 (v3.5) — THE COMMIT-IDENTITY GATE.
//
// A commit made on a box with no identity configured takes the machine's default: a real name and
// `user@Hostname.local`. Released history is public, so nothing since the last release tag may carry
// one. The gate lists every commit `PREV_TAG..HEAD` whose author or committer email is not the
// repo's neutral identity (its configured `user.email`, a GitHub noreply address) or ends in `.local`,
// and refuses, naming them. It also refuses a repo whose own configured identity is not neutral,
// because that is what its next commit (the release commit) would be made as.
//
// Driven the t229 way: the REAL gate script against throwaway repositories with one bad author.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const GATE = path.join(REPO_ROOT, 'deploy/checks/check-commit-identity.mjs');
/** Addresses are composed, so no literal in this file has the shape of someone's inbox. */
const addr = (user: string, host: string) => `${user}@${host}`;
const NEUTRAL = addr('4242+someone', 'users.noreply.github.com');
const HOST_LOCAL = addr('someone', 'host.local');
const OTHER_LOCAL = addr('x', 'Some-Mac.local');
const PRIVATE = addr('person', 'private-mail.test');

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
function commit(msg: string, who: { author?: string; committer?: string } = {}) {
  fs.writeFileSync(path.join(repo, 'f.txt'), `${msg}\n${Math.random()}`);
  git('add', '.');
  execFileSync('git', ['commit', '-q', '-m', msg], {
    cwd: repo, encoding: 'utf8',
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      ...(who.author ? { GIT_AUTHOR_EMAIL: who.author, GIT_AUTHOR_NAME: 'Machine Default' } : {}),
      ...(who.committer ? { GIT_COMMITTER_EMAIL: who.committer, GIT_COMMITTER_NAME: 'Machine Default' } : {}),
    },
  });
  return git('rev-parse', '--short', 'HEAD');
}
function gate(extra: string[] = []) {
  const r = spawnSync('node', [GATE, '--repo', repo, ...extra], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT ?? os.tmpdir(), 'g23id-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'someone');
  git('config', 'user.email', NEUTRAL);
  commit('before the last release');
  git('tag', 'v1.0.0');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('G23: the commit-identity gate', () => {
  it('commits since the last tag made under the neutral identity pass', () => {
    commit('a fix');
    const r = gate();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/v1\.0\.0/);
  });

  it('a commit authored as someone@host.local is refused, naming its hash', () => {
    const bad = commit('made on a box with no identity', { author: HOST_LOCAL });
    commit('a fine one');
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.out).toContain(bad);
    expect(r.out).toContain(HOST_LOCAL);
    expect(r.out).toContain('made on a box with no identity');
    expect(r.out).not.toMatch(/a fine one/);
  });

  it('a bad COMMITTER is refused as well as a bad author', () => {
    const bad = commit('rebased on another box', { committer: OTHER_LOCAL });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.out).toContain(bad);
  });

  it('a real-looking address that is not the neutral identity is refused too', () => {
    const bad = commit('a private address', { author: PRIVATE });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.out).toContain(bad);
  });

  it('another GitHub noreply address is not the repo\'s identity: refused (strict, as the plan says)', () => {
    const bad = commit('someone else\'s noreply', { author: addr('9999+other', 'users.noreply.github.com') });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.out).toContain(bad);
  });

  it('history before the last tag is not the gate\'s business', () => {
    // the bad commit sits BEFORE the tag: re-tag after it
    git('tag', '-d', 'v1.0.0');
    commit('old machine-default commit', { author: addr('old', 'host.local') });
    git('tag', 'v1.0.0');
    commit('new work');
    expect(gate().code).toBe(0);
  });

  it('both fixed: the bad commit gone, the gate passes', () => {
    commit('bad', { author: HOST_LOCAL });
    expect(gate().code).toBe(1);
    git('reset', '-q', '--hard', 'v1.0.0');
    commit('good again');
    expect(gate().code).toBe(0);
  });

  it('a repo whose own configured identity is not neutral is refused (its release commit would carry it)', () => {
    git('config', 'user.email', addr('me', 'Hostname.local'));
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.out).toContain(addr('me', 'Hostname.local'));
    expect(r.out).toMatch(/user\.email/);
  });

  it('no previous tag: nothing to compare, said plainly, not a silent pass', () => {
    git('tag', '-d', 'v1.0.0');
    const r = gate();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no previous release tag/i);
  });

  it('the gate is registered, blocking, in the manifest', async () => {
    const { GATES } = await import(/* @vite-ignore */ path.join(REPO_ROOT, 'deploy/checks/gate-manifest.mjs'));
    const g = GATES.find((x: { id: string }) => x.id === 'commit-identity');
    expect(g?.tier).toBe('blocking');
    expect(g?.script).toBe('deploy/checks/check-commit-identity.mjs');
  });
});
