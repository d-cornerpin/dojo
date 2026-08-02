// ════════════════════════════════════════════════════════════════════════════
// THE CANARY CORPUS FOR THE REBUILT EXEC (PHASE-5 T3 Step 1) — argv-no-shell at
// one door, an explicitly-granted `shell` class at the other, both proven.
//
// WHAT THIS FILE IS FOR, in one sentence: T3 replaces the string-to-shell exec
// entry point (`executeExec`, which handed the model's line to `/bin/zsh`) with
// two doors, and the phase's binding posture is *less code, NEVER less
// capability* — so every canary lands here BEFORE the entry point that carries
// them today dies, and the ALLOW half of the corpus is as load-bearing as the
// refusals.
//
// ── THE TWO DOORS, AND WHY THERE ARE TWO ──
//   `exec({argv})`     execFile, NO shell. `argv[0]` is a program name, every
//                      other element is a literal argument, and the shell's
//                      metacharacters are inert text rather than syntax.
//   `shell({script})`  `/bin/zsh -c <script>` — pipes, loops, redirects,
//                      substitution — behind its OWN grant class, with the FULL
//                      script text audited.
//
// ── OWNER RULING 2026-07-28 (EXEC-LOOP) IS THE REASON THE SECOND DOOR EXISTS ──
// *"why wouldn't we allow an agent to do commands if they have shell access?"*
// Whatever an agent can run at the shell today it can still run after this task.
// §E is that promise as a test: the constructs the owner asked about run through
// `shell` with byte-identical authority to today's exec, and §D proves the
// derivation that gets today's agents there without anybody editing a manifest.
//
// ── WHY `sh -c` IS REFUSED AT THE ARGV DOOR AND `sh script.sh` IS NOT ──
// `exec({argv:['sh','-c','<anything>']})` is a shell script wearing argv's
// clothes; allowing it would make the whole no-shell rebuild theatre. It is
// ROUTED, not removed: the refusal names `shell`, where the same text runs with
// its full body audited. Same capability, one door, one audit record.
//
// ⚠ `sh count.sh` IS STILL ALLOWED, and the clause that says so is as
// load-bearing as any refusal here. The first draft refused any interpreter as
// argv[0]; the kit's own `coding-task` scenario — *"write a small script … run
// your script"* — is what showed that up as a capability loss. Running a FILE
// is not running inline text: the file reached disk through the fs broker.
//
// ── TEST HYGIENE (binding) ──
// Nothing here touches the owner's real `~/.ssh`, `~/.dojo` or anything outside
// a throwaway temp dir. `os.homedir()` is redirected to a fixture home built by
// this file and every "secret" in it is a dummy string written here.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-argv-home-')));
const projects = path.join(fixtureHome, 'Projects');
const dojoDir = path.join(fixtureHome, '.dojo');
const sshDir = path.join(fixtureHome, '.ssh');
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(dojoDir, 'data'), { recursive: true });
fs.mkdirSync(sshDir, { recursive: true });
const SECRETS = path.join(dojoDir, 'secrets.yaml');
fs.writeFileSync(SECRETS, 'dummy: not-a-real-key\n');
fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'DUMMY PRIVATE KEY\n');
fs.writeFileSync(path.join(projects, 'notes.txt'), 'an ordinary file an agent may legitimately read\n');

// ── The three manifests the corpus authorizes against ──
// WILDCARD is the primary/Healer shape (`exec_allow:['*']`). SCOPED is the
// shape a real worker carries (BehaviorBot's, trimmed). LOCKED has an EMPTY
// `exec_allow`, which is what deny-by-default has to be measured against.
const wildcardManifest = JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
  exec_allow: ['*'], exec_deny: [], network_domains: '*',
  max_processes: 10, can_spawn_agents: true, can_assign_permissions: true, system_control: ['*'],
});
const scopedManifest = JSON.stringify({
  file_read: [`${projects}/**`], file_write: [`${projects}/**`], file_delete: 'none',
  exec_allow: ['ls', 'cat', 'echo', 'git *', 'node'], exec_deny: ['git push *'],
  network_domains: ['example.com'],
  max_processes: 3, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});
const lockedManifest = JSON.stringify({
  file_read: [`${projects}/**`], file_write: 'none', file_delete: 'none',
  exec_allow: [], exec_deny: [], network_domains: 'none',
  max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});
// The T5-shaped manifest: exec, but shell explicitly WITHHELD. It is what proves
// the two doors are genuinely separate grants rather than one grant with two names.
const noShellManifest = JSON.stringify({
  file_read: [`${projects}/**`], file_write: 'none', file_delete: 'none',
  exec_allow: ['ls', 'git *'], exec_deny: [], shell_allow: [], network_domains: 'none',
  max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});

const agentRows: Record<string, { id: string; permissions: string; spawn_depth: number; created_by: string }> = {
  'agent-wildcard': { id: 'agent-wildcard', permissions: wildcardManifest, spawn_depth: 1, created_by: 'agent-parent' },
  'agent-scoped': { id: 'agent-scoped', permissions: scopedManifest, spawn_depth: 1, created_by: 'agent-parent' },
  'agent-locked': { id: 'agent-locked', permissions: lockedManifest, spawn_depth: 1, created_by: 'agent-parent' },
  'agent-noshell': { id: 'agent-noshell', permissions: noShellManifest, spawn_depth: 1, created_by: 'agent-parent' },
};

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (...params: unknown[]) => {
        if (/FROM agents/i.test(sql)) return agentRows[String(params[0])];
        return undefined;
      },
      all: () => [],
    }),
    exec: () => ({}),
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
  }),
}));

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return { ...actual, isPrimaryAgent: (id: string) => id === 'agent-primary', isTrainerAgent: () => false, isHealerAgent: (id: string) => id === 'agent-healer' };
});

import { resolveArgvArg, resolveCommandArg } from '../resolve.js';
import { authorizeArgv, authorizeShellScript } from '../proc.js';
import { grantForManifest } from '../grants.js';

const grantOf = (id: keyof typeof agentRows) => grantForManifest(id, JSON.parse(agentRows[id].permissions));
const wildcard = () => grantOf('agent-wildcard');
const scoped = () => grantOf('agent-scoped');
const locked = () => grantOf('agent-locked');
const noShell = () => grantOf('agent-noshell');

/** Resolve or blow up loudly — a corpus case that cannot resolve its own fixture
 *  is a broken test, not a passing guard. */
function mustArgv(raw: unknown) {
  const r = resolveArgvArg(raw);
  if (!r.ok) throw new Error(`fixture failed to resolve: ${JSON.stringify(raw)} (${r.code}: ${r.reason})`);
  return r.value;
}
function mustScript(raw: string) {
  const r = resolveCommandArg(raw);
  if (!r.ok) throw new Error(`fixture failed to resolve: ${raw} (${r.code})`);
  return r.value;
}

let homedirSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => { homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fixtureHome); });
afterAll(() => { homedirSpy.mockRestore(); fs.rmSync(fixtureHome, { recursive: true, force: true }); });

// ══════════════════════════════════════════════════════════════════════════
describe('§A — the argv resolver is the only mint, and it refuses every shape that is not argv', () => {
  it('refuses a STRING where an argv array belongs — the old shape cannot sneak through', () => {
    const r = resolveArgvArg('rm -rf /tmp/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_a_string');
  });

  it('refuses an EMPTY array — there is no program to authorize', () => {
    const r = resolveArgvArg([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_present');
  });

  it('refuses an array holding a non-string element', () => {
    for (const bad of [['ls', 5], ['ls', null], ['ls', { a: 1 }], ['ls', ['nested']]]) {
      const r = resolveArgvArg(bad);
      expect(r.ok, `expected refusal for ${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) expect(r.code).toBe('not_a_string');
    }
  });

  it('reports an ABSENT argv distinctly from a malformed one', () => {
    for (const absent of [undefined, null]) {
      const r = resolveArgvArg(absent);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('not_present');
    }
  });

  it('mints a resolved argv carrying the program, its basename and a display line', () => {
    const v = mustArgv(['/usr/bin/git', 'status', '--short']);
    expect(v.program).toBe('/usr/bin/git');
    expect(v.base).toBe('git');
    expect(v.display).toBe('/usr/bin/git status --short');
    expect(v.argv).toEqual(['/usr/bin/git', 'status', '--short']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§B — THE CANARY CORPUS at the argv door, every canary REFUSED', () => {
  it('refuses INLINE SHELL SCRIPT (`-c`) — the escape hatch is routed, not opened', () => {
    for (const sh of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', '/bin/sh', '/bin/zsh']) {
      const v = authorizeArgv(wildcard(), mustArgv([sh, '-c', 'echo hi']));
      expect(v.allowed, `expected refusal for inline script: ${sh} -c`).toBe(false);
      // The refusal must NAME the other door, or an agent reads it as "you cannot".
      if (!v.allowed) expect(v.reason + String(v.blockedMessage)).toMatch(/shell/);
    }
    // and through an `env` re-point, which happens AFTER the allowlist looked
    expect(authorizeArgv(wildcard(), mustArgv(['env', 'FOO=1', 'sh', '-c', 'echo hi'])).allowed).toBe(false);
  });

  it('⚠ but RUNNING A SCRIPT FILE still works — refusing it would delete a workflow', () => {
    // `write a script, then run it` is an ordinary thing an agent does all day
    // and is the kit's own `coding-task` scenario verbatim. The first draft of
    // the interpreter rule refused any interpreter as argv[0] and would have
    // broken it; that is the capability-loss class this phase must not create.
    for (const argv of [
      ['sh', `${projects}/count.sh`],
      ['bash', `${projects}/build.sh`],
      ['/bin/zsh', `${projects}/run.zsh`],
      ['node', `${projects}/count.js`],
    ]) {
      expect(authorizeArgv(wildcard(), mustArgv(argv)).allowed, `expected ALLOW: ${argv.join(' ')}`).toBe(true);
    }
  });

  it('refuses `eval` and `source` — shell builtins, with no program to run', () => {
    for (const p of ['eval', 'source', 'exec', 'command']) {
      expect(authorizeArgv(wildcard(), mustArgv([p, 'anything'])).allowed, p).toBe(false);
    }
  });

  it('refuses the GLOBAL exec denies spelled as argv, for a WILDCARD agent', () => {
    const canaries = [
      ['rm', '-rf', '/'],
      ['rm', '-rf', '~'],
      ['sudo', 'rm', '-rf', '/etc'],
      ['chmod', '777', '/'],
    ];
    for (const argv of canaries) {
      const v = authorizeArgv(wildcard(), mustArgv(argv));
      expect(v.allowed, `expected refusal for argv: ${argv.join(' ')}`).toBe(false);
    }
  });

  it('refuses the secret store named in ANY argv element and in every spelling', () => {
    const spellings = [
      ['cat', `${fixtureHome}/.dojo/secrets.yaml`],
      ['cat', '~/.dojo/secrets.yaml'],
      ['cat', '$HOME/.dojo/secrets.yaml'],
      ['grep', '-r', 'key', '~/.dojo/secrets.yaml'],
      ['cp', '~/.dojo/secrets.yaml', '/tmp/stolen'],
    ];
    for (const argv of spellings) {
      const v = authorizeArgv(wildcard(), mustArgv(argv));
      expect(v.allowed, `expected refusal for argv: ${argv.join(' ')}`).toBe(false);
    }
  });

  it('refuses reading an SSH private key through the tokenized scan', () => {
    const v = authorizeArgv(wildcard(), mustArgv(['cat', `${sshDir}/id_ed25519`]));
    expect(v.allowed).toBe(false);
  });

  it('DENY-BY-DEFAULT: an agent with an empty exec_allow runs nothing at all', () => {
    for (const argv of [['ls'], ['echo', 'hi'], ['git', 'status'], ['node', '-v']]) {
      const v = authorizeArgv(locked(), mustArgv(argv));
      expect(v.allowed, `expected refusal for locked agent: ${argv.join(' ')}`).toBe(false);
    }
  });

  it('refuses a program outside a SCOPED agent\'s allowlist, naming the program', () => {
    const v = authorizeArgv(scoped(), mustArgv(['curl', 'https://example.com']));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/curl/);
  });

  it('honours an exec_deny row against the reconstructed line', () => {
    const v = authorizeArgv(scoped(), mustArgv(['git', 'push', '--force', 'origin', 'main']));
    expect(v.allowed).toBe(false);
  });

  it('an absolute path to a denied program is still the denied program', () => {
    expect(authorizeArgv(scoped(), mustArgv(['/usr/bin/curl', 'https://x'])).allowed).toBe(false);
    expect(authorizeArgv(wildcard(), mustArgv(['/bin/rm', '-rf', '/'])).allowed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§C — the ALLOW half: what an agent does all day still works', () => {
  it('an allowlisted `git status` RUNS', () => {
    expect(authorizeArgv(scoped(), mustArgv(['git', 'status'])).allowed).toBe(true);
    expect(authorizeArgv(wildcard(), mustArgv(['git', 'status'])).allowed).toBe(true);
  });

  it('the ordinary programs a worker uses are allowed', () => {
    for (const argv of [['ls', '-la', projects], ['echo', 'hello'], ['cat', `${projects}/notes.txt`], ['node', '-v']]) {
      const v = authorizeArgv(scoped(), mustArgv(argv));
      expect(v.allowed, `expected ALLOW for: ${argv.join(' ')}`).toBe(true);
    }
  });

  it('a shell METACHARACTER inside an ARGUMENT is literal text, not syntax, and is allowed', () => {
    // `grep 'a|b' file` is an ordinary regex. Refusing it because the byte `|`
    // appears would be exactly the narrowing this phase forbids: with no shell
    // there is nothing for that byte to mean.
    for (const argv of [
      ['echo', 'a|b'],
      ['echo', '$(whoami)'],
      ['echo', '`id`'],
      ['echo', 'a && b'],
      ['echo', 'a > b'],
      ['echo', '*'],
      ['echo', '$HOME'],
    ]) {
      const v = authorizeArgv(wildcard(), mustArgv(argv));
      expect(v.allowed, `expected ALLOW (inert literal) for: ${JSON.stringify(argv)}`).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§D — the shell class is a SEPARATE grant, and today\'s agents already hold it', () => {
  it('an agent whose manifest never mentions shell inherits its exec reach — NO capability is lost', () => {
    // The migration promise in one clause: `shell_allow` absent ⇒ the shell door
    // answers from `exec_allow`, so every agent alive today runs tomorrow exactly
    // what it runs now. Nobody has to edit a manifest for that to be true.
    expect(authorizeShellScript(scoped(), mustScript('ls -la | grep notes')).allowed).toBe(true);
    expect(authorizeShellScript(wildcard(), mustScript('for i in 1 2 3; do echo $i; done')).allowed).toBe(true);
  });

  it('a manifest that WITHHOLDS shell explicitly refuses the shell door while exec still works', () => {
    expect(authorizeArgv(noShell(), mustArgv(['git', 'status'])).allowed).toBe(true);
    expect(authorizeShellScript(noShell(), mustScript('ls | wc -l')).allowed).toBe(false);
  });

  it('the shell door is deny-by-default for an agent with no exec grant either', () => {
    expect(authorizeShellScript(locked(), mustScript('ls')).allowed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§E — EXEC-LOOP PRESERVED: the owner\'s own construct still runs, at the shell door', () => {
  it('the exact line the owner asked about is ALLOWED for a shell-granted agent', () => {
    // Owner ruling 2026-07-28, verbatim subject: this line was refused with
    // "Command 'for' is not allowed" and the owner overruled it.
    const line = 'for i in $(seq -w 1 20); do echo "=== note-$i.md ==="; cat "$HOME/Projects/notes.txt"; done';
    expect(authorizeShellScript(wildcard(), mustScript(line)).allowed).toBe(true);
  });

  it('pipes, redirects, substitution, chains and conditionals all still run', () => {
    for (const script of [
      'ls -la | grep notes | wc -l',
      'echo hello > /tmp/exec-argv-corpus-out.txt',
      'echo "$(date)" && echo done',
      'if [ -f ~/Projects/notes.txt ]; then cat ~/Projects/notes.txt; fi',
      'while read -r l; do echo "$l"; done < /dev/null',
      'ls; echo second',
    ]) {
      expect(authorizeShellScript(wildcard(), mustScript(script)).allowed, `expected ALLOW: ${script}`).toBe(true);
    }
  });

  it('grammar widens and AUTHORITY DOES NOT — an inner command outside the allowlist is refused', () => {
    const v = authorizeShellScript(scoped(), mustScript('for f in a b; do curl https://x/$f; done'));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/curl/);
  });

  it('the canary corpus still bites at the shell door', () => {
    for (const script of [
      'echo x >> ~/.dojo/secrets.yaml',
      'cat $(echo ~/.dojo/secrets.yaml)',
      'cat `echo ~/.dojo/secrets.yaml`',
      'rm -rf /',
      'sudo rm -rf /etc',
      `cat ${sshDir}/id_ed25519`,
    ]) {
      expect(authorizeShellScript(wildcard(), mustScript(script)).allowed, `expected refusal: ${script}`).toBe(false);
    }
  });
});
