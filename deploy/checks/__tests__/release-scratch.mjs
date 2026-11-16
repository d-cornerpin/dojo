// A scratch repository with no remote that holds the real release script, on the branch it requires, with
// `gh` and `npm` stood in for: `gh` answers from the releases given and fails anything else, `npm` fails, so
// nothing is built, pushed or published. Not a test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const DEPLOY = fileURLToPath(new URL('../../', import.meta.url));

export function releaseScratch({ branch, stable, released }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-release-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(root, 'repo', 'deploy'), { recursive: true });
  fs.mkdirSync(bin);
  const repo = path.join(root, 'repo');
  for (const f of ['release.sh', 'version-rank.mjs']) fs.copyFileSync(path.join(DEPLOY, f), path.join(repo, 'deploy', f));
  fs.writeFileSync(path.join(repo, 'package.json'), '{ "version": "3.5.0-preflight.3" }\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'Plain notes.\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'scratch');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
echo "gh $*" >> "${path.join(root, 'gh.log')}"
case "$*" in
  "auth status") exit 0 ;;
  "api repos/"*"/releases/latest"*) echo "v${stable}" ;;
  "release list"*) printf '%s\\tPre-release\\t%s\\t2026-11-01\\n' ${released.map((t) => `${t} ${t}`).join(' ')} ;;
  "release view"*) exit 1 ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm stood in for" >&2\nexit 1\n', { mode: 0o755 });
  const run = (args, env = {}) => spawnSync('bash', [path.join(repo, 'deploy', 'release.sh'), ...args, '--notes-file', path.join(root, 'notes.md')],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  const ghCalls = () => (fs.existsSync(path.join(root, 'gh.log')) ? fs.readFileSync(path.join(root, 'gh.log'), 'utf8') : '');
  return { root, repo, run, ghCalls, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
