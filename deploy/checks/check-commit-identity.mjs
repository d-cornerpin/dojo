#!/usr/bin/env node
// ════════════════════════════════════════
// Commit-identity gate (v3.5, G23). BLOCKING.
//
// A commit made on a box with no identity configured takes the machine's default: a real name and
// `user@Hostname.local`. Released history is public and permanent, so nothing since the last release
// tag may carry one. This lists every commit `PREV_TAG..HEAD` whose author or committer email is
//
//   - not the repo's neutral identity: its configured `user.email` (a GitHub noreply address), any
//     other GitHub noreply address (a merge made on the web, a co-author), or
//   - on a `.local` host (the machine default, always refused),
//
// and refuses, naming each commit. It also refuses a repo whose OWN configured identity is not a
// GitHub noreply address, because that is the identity its next commit (the release commit) is made
// as. With no previous tag there is nothing to compare, which it says rather than passing silently.
//
// Usage: node deploy/checks/check-commit-identity.mjs [--repo <dir>] [--since <ref>]
// ════════════════════════════════════════
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const REPO = path.resolve(flag('--repo') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return ''; } };

const NOREPLY = /@users\.noreply\.github\.com$/i;
const configuredRaw = tryGit('config', 'user.email');
const configured = configuredRaw.toLowerCase();
const isNeutral = (email) => {
  const e = email.trim().toLowerCase();
  if (e.endsWith('.local')) return false;
  return e === configured || NOREPLY.test(e) || e === 'noreply@github.com';
};

const problems = [];
console.log('Commit-identity gate (nothing since the last release tag may carry a machine-default identity)');

if (!NOREPLY.test(configured)) {
  problems.push(`  this repo's configured identity (git config user.email) is "${configuredRaw || '(unset)'}", not a GitHub noreply address.`
    + '\n  The release commit is made as that identity. Set it repo-locally, e.g. git config user.email <id>+<user>@users.noreply.github.com');
}

const since = flag('--since') ?? tryGit('describe', '--tags', '--abbrev=0');
if (!since) {
  console.log('  no previous release tag: no commit range to compare.');
} else {
  const rows = git('log', `${since}..HEAD`, '--format=%h%x1f%ae%x1f%ce%x1f%s').split('\n').filter(Boolean).map((l) => l.split('\x1f'));
  console.log(`  ${rows.length} commit(s) since ${since}`);
  for (const [hash, author, committer, subject] of rows) {
    const bad = [...new Set([author, committer].filter((e) => !isNeutral(e)))];
    if (bad.length) problems.push(`  ${hash}  ${bad.join(', ')}  ${subject}`);
  }
}

if (problems.length) {
  console.error('');
  console.error('✗ commit identity: these must be made under the neutral identity before a release:');
  for (const p of problems) console.error(p);
  console.error('  (Fix: set git config user.name/user.email repo-locally and reword/re-author the commits, then re-run.)');
  process.exit(1);
}
console.log('✓ every commit since the last release is under a neutral identity');
