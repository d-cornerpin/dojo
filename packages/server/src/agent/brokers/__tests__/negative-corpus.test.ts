// ════════════════════════════════════════════════════════════════════════════
// THE NEGATIVE CORPUS (PHASE-5 T2 Step 1) — every bypass class, proven REFUSED
// AT THE BROKER rather than assumed.
//
// WHY THIS FILE EXISTS, in one sentence: T2 deletes a 15-branch guard run that
// stands between every agent and the filesystem, the shell and the network, and
// the phase's binding posture is *less code, NEVER less capability* — so every
// requirement those branches encode lands here as a test BEFORE the branch that
// carries it today dies.
//
// ── RULING P5-R5 SCOPES WHAT MAY BE IN HERE (orchestrator, 2026-08-02) ──
// Enforcement PARITY. Every case below targets a resource that is ALREADY
// denied today, or an action that is ALREADY refused today; what the corpus adds
// is the proof that the denial cannot be walked around by spelling the resource
// differently (`../`, a symlink, a case fold, a homoglyph, a `>>` redirect, a
// `$(…)` substitution). Reaching `~/.dojo/secrets.yaml` through a symlink was
// never a capability, so refusing it is guard STRENGTHENING and not narrowing.
// **No case in this file invents a refusal class the tree does not already
// have.** A declared effect that nothing gates today gets no gate here.
//
// ── RULING P5-R1 (orchestrator, 2026-08-02) ──
// The PM overseer wall (`pmMayCall`, `tools.ts:4480` at this HEAD) survives T2
// untouched — it sits ABOVE the ladder, outside the deleted range — but until
// now it was held by nothing except a line number. Its requirement lands here as
// its own fixture (§7 below), so a careless delete fails a test instead of
// silently handing the PM the worker verbs.
//
// ── TEST HYGIENE (binding) ──
// Nothing in this file touches the owner's real `~/.ssh`, `~/.dojo` or anything
// else outside a throwaway temp dir. `os.homedir()` is redirected to a fixture
// home built by this file, and every "secret" inside it is a dummy string
// written here.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Fixture world, built before the homedir spy and before any import of the
// code under test (vitest hoists `vi.mock`, not these consts). ──
// `realpathSync` on purpose: macOS's `os.tmpdir()` is `/var/folders/…`, and
// `/var` is itself a symlink to `/private/var`. A HOME directory behind a
// symlink is not the shape any real box has, and leaving the fixture in that
// shape would have the test measuring the tmpdir's own indirection rather than
// the guard. (The observation is recorded as a hand-up in the T2 report: the
// deny table anchors on `os.homedir()` unresolved, exactly as its two pre-merge
// twins did, so a genuinely symlinked home would miss the home-anchored rules
// on the RESOLVED candidate. Parity with the legacy lists, named rather than
// silently inherited.)
const fixtureHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-corpus-home-')));
const projects = path.join(fixtureHome, 'Projects');
const dojoDir = path.join(fixtureHome, '.dojo');
const sshDir = path.join(fixtureHome, '.ssh');

fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(dojoDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(dojoDir, 'logs'), { recursive: true });
fs.mkdirSync(sshDir, { recursive: true });

const SECRETS = path.join(dojoDir, 'secrets.yaml');
fs.writeFileSync(SECRETS, 'dummy: not-a-real-key\n');
fs.writeFileSync(path.join(dojoDir, 'logs', 'healer.log'), 'dummy healer log\n');
fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'DUMMY PRIVATE KEY\n');
fs.writeFileSync(path.join(sshDir, 'id_ed25519.pub'), 'DUMMY PUBLIC KEY\n');
fs.writeFileSync(path.join(projects, 'notes.txt'), 'an ordinary file an agent may legitimately read\n');

// ── The bypass fixtures on disk ──
// (1) a symlink inside the ALLOWED tree pointing at the denied file
const SYMLINK_TO_SECRETS = path.join(projects, 'looks-innocent.yaml');
try { fs.symlinkSync(SECRETS, SYMLINK_TO_SECRETS); } catch { /* already there */ }
// (2) a BROKEN symlink inside the allowed tree pointing at a not-yet-existing
//     file under the denied dir. A WRITE through it CREATES the target, so a
//     resolver that stops at "does not exist" is defeated by a link that is not
//     even valid yet — the class `realResolveDeepest` was built for.
const BROKEN_LINK_TARGET = path.join(dojoDir, 'data', 'dojo.db');
const BROKEN_LINK = path.join(projects, 'pending.db');
try { fs.symlinkSync(BROKEN_LINK_TARGET, BROKEN_LINK); } catch { /* already there */ }
// (3) the `-wal` / `-shm` siblings of the platform database. The DB itself is
//     globally write-denied by `~/.dojo/data/*.db`; its journal siblings hold
//     the same bytes mid-transaction and match the same glob's DIRECTORY but not
//     its extension, so they are named explicitly.
const WAL_SIBLING = path.join(dojoDir, 'data', 'dojo.db-wal');
const SHM_SIBLING = path.join(dojoDir, 'data', 'dojo.db-shm');

// The DB is only reached for the squad-workspace fallback and the audit log;
// the agent row returned here carries a WILDCARD manifest on purpose, so any
// refusal in this file can only have come from a GLOBAL deny or from the
// resolver — never from an incidental allowlist miss.
const wildcardManifest = JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
  exec_allow: ['*'], exec_deny: [], network_domains: '*',
  max_processes: 10, can_spawn_agents: true, can_assign_permissions: true,
  system_control: ['*'],
});
const scopedManifest = JSON.stringify({
  file_read: ['~/Projects/**', '/tmp/**'], file_write: ['~/Projects/**', '/tmp/**'],
  file_delete: 'none', exec_allow: ['ls', 'cat', 'echo'], exec_deny: ['rm -rf /'],
  network_domains: ['example.com'], max_processes: 3, can_spawn_agents: false,
  can_assign_permissions: false, system_control: [],
});

const agentRows: Record<string, { id: string; permissions: string; spawn_depth: number; created_by: string; group_id: null }> = {
  'agent-wildcard': { id: 'agent-wildcard', permissions: wildcardManifest, spawn_depth: 1, created_by: 'agent-parent', group_id: null },
  'agent-scoped': { id: 'agent-scoped', permissions: scopedManifest, spawn_depth: 1, created_by: 'agent-parent', group_id: null },
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

// `isPrimaryAgent` reads the config table; pin it so the corpus is about the
// broker and not about platform config.
vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return { ...actual, isPrimaryAgent: (id: string) => id === 'agent-primary', isTrainerAgent: () => false, isHealerAgent: (id: string) => id === 'agent-healer' };
});

import { setFsCaseInsensitive, isSensitivePath } from '../../path-guards.js';
import {
  resolvePathArg, resolveCommandArg, resolveUrlArg,
} from '../resolve.js';
import { authorize } from '../index.js';
import { grantForManifest } from '../grants.js';
import { isDeniedResource, DENY_RULES, deniedTiers } from '../deny.js';
import { pmMayCall } from '../../../tracker/pm-agent.js';

// The fixture home lives on whatever the runner's tmpdir is; probe it for real
// rather than assuming, exactly as boot does.
const probeUpper = path.join(fixtureHome, 'FSCASE-A.tmp');
const probeLower = path.join(fixtureHome, 'fscase-a.tmp');
fs.writeFileSync(probeUpper, 'probe');
const REAL_FS_FOLDS = fs.existsSync(probeLower);
fs.unlinkSync(probeUpper);

const wildcard = () => grantForManifest('agent-wildcard', JSON.parse(wildcardManifest));
const scoped = () => grantForManifest('agent-scoped', JSON.parse(scopedManifest));

/** Resolve or blow up loudly — a corpus case that cannot even resolve its own
 *  fixture is a broken test, not a passing guard. */
function mustResolvePath(raw: string) {
  const r = resolvePathArg(raw);
  if (!r.ok) throw new Error(`fixture failed to resolve: ${raw} (${r.code}: ${r.reason})`);
  return r.value;
}
function mustResolveCommand(raw: string) {
  const r = resolveCommandArg(raw);
  if (!r.ok) throw new Error(`fixture failed to resolve: ${raw} (${r.code})`);
  return r.value;
}
function mustResolveUrl(raw: string) {
  const r = resolveUrlArg(raw);
  if (!r.ok) throw new Error(`fixture failed to resolve: ${raw} (${r.code})`);
  return r.value;
}

let homedirSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fixtureHome);
  setFsCaseInsensitive(REAL_FS_FOLDS);
});
afterAll(() => {
  homedirSpy.mockRestore();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§1 — the resolver is the only mint, and it rejects what the ladder skipped', () => {
  it('rejects a non-string path instead of skipping the gate', () => {
    // The ladder read `args.path as string | undefined` and then `if (filePath)`.
    // A non-string that is TRUTHY (an array, an object) walked straight past the
    // cast into `path.resolve`, which throws — so today this class is a CRASH,
    // never a bypass. The resolver turns it into a refusal, which is strictly
    // better and narrows nothing: the call could never have succeeded.
    for (const bad of [42, true, ['/etc/passwd'], { toString: () => '/etc/passwd' }, Symbol('x')]) {
      const r = resolvePathArg(bad as unknown);
      expect(r.ok, `expected refusal for ${String(typeof bad)}`).toBe(false);
      if (!r.ok) expect(r.code).toBe('not_a_string');
    }
  });

  it('reports an ABSENT argument distinctly from a bad one (ladder parity)', () => {
    // `if (filePath)` skipped the gate when the arg was missing and let the
    // handler produce its own friendlier error. Parity: absence is `not_present`,
    // which the dispatcher treats as "this gate does not apply", NOT as a deny.
    for (const missing of [undefined, null, '']) {
      const r = resolvePathArg(missing as unknown);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('not_present');
    }
  });

  it('a ResolvedPath carries BOTH the lexical and the symlink-resolved target', () => {
    const rp = mustResolvePath(SYMLINK_TO_SECRETS);
    expect(rp.lexical).toBe(SYMLINK_TO_SECRETS);
    expect(rp.real).toBe(fs.realpathSync(SECRETS));
    expect(rp.realResolved).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§2 — path escapes: `..` cannot walk out of an allowed tree', () => {
  it('refuses a `../` traversal from the allowlist into the denied store', async () => {
    const rp = mustResolvePath('~/Projects/../.dojo/secrets.yaml');
    const v = await authorize(scoped(), { kind: 'fs_read', resource: rp });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason.toLowerCase()).toMatch(/deny|not allowed|restricted/);
  });

  it('refuses the same traversal for a WILDCARD manifest — the global deny wins', async () => {
    const rp = mustResolvePath('~/Projects/../.dojo/secrets.yaml');
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: rp });
    expect(v.allowed).toBe(false);
  });

  it('still ALLOWS the ordinary file the traversal was pretending to be', async () => {
    const v = await authorize(scoped(), { kind: 'fs_read', resource: mustResolvePath('~/Projects/notes.txt') });
    expect(v.allowed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§3 — symlinks, including BROKEN ones (realpath must follow)', () => {
  it('refuses a read through a symlink planted inside the allowed tree', async () => {
    const rp = mustResolvePath(SYMLINK_TO_SECRETS);
    const v = await authorize(scoped(), { kind: 'fs_read', resource: rp });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.basis).toBe('bypass-hardening');
  });

  it('refuses a WRITE through a BROKEN symlink whose target does not exist yet', async () => {
    // The write would CREATE `~/.dojo/data/dojo.db`. `fs.existsSync` follows
    // links, so a broken link reads as "nothing here" and a naive walk resolves
    // the LINK's own path — which lives in an allowed dir.
    expect(fs.existsSync(BROKEN_LINK_TARGET)).toBe(false);
    expect(fs.lstatSync(BROKEN_LINK).isSymbolicLink()).toBe(true);
    const rp = mustResolvePath(BROKEN_LINK);
    // The tmpdir is itself a symlink on macOS (`/var` → `/private/var`), so the
    // resolved target is compared against the REAL fixture directory rather than
    // the string this file built — comparing to the built string would be
    // asserting that resolution did NOT happen.
    expect(rp.real).toBe(path.join(fs.realpathSync(path.join(dojoDir, 'data')), 'dojo.db'));
    const v = await authorize(scoped(), { kind: 'fs_write', resource: rp });
    expect(v.allowed).toBe(false);
  });

  it('a symlink to an ORDINARY file is still allowed (the guard is not a blanket)', async () => {
    const link = path.join(projects, 'notes-link.txt');
    try { fs.symlinkSync(path.join(projects, 'notes.txt'), link); } catch { /* exists */ }
    const v = await authorize(scoped(), { kind: 'fs_read', resource: mustResolvePath(link) });
    expect(v.allowed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§4 — the `-wal` / `-shm` siblings and the case-fold variants', () => {
  it('refuses a write to the database WAL sibling', async () => {
    const v = await authorize(wildcard(), { kind: 'fs_write', resource: mustResolvePath(WAL_SIBLING) });
    expect(v.allowed).toBe(false);
  });

  it('refuses a write to the database SHM sibling', async () => {
    const v = await authorize(wildcard(), { kind: 'fs_write', resource: mustResolvePath(SHM_SIBLING) });
    expect(v.allowed).toBe(false);
  });

  it('refuses the CASE-FOLDED spelling of the secret store on a folding filesystem', async () => {
    setFsCaseInsensitive(true);
    try {
      const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath('~/.dojo/Secrets.YAML') });
      expect(v.allowed).toBe(false);
    } finally { setFsCaseInsensitive(REAL_FS_FOLDS); }
  });

  it('does NOT fold on a case-sensitive filesystem — the probe decides, not the platform', () => {
    // The mirror-image requirement: on a case-SENSITIVE volume `Secrets.YAML` is
    // a different file and blocking it would be a false refusal. This is the
    // clause that stops "just always lowercase" being the fix.
    setFsCaseInsensitive(false);
    try {
      expect(isSensitivePath(path.join(dojoDir, 'Secrets.YAML'))).toBe(false);
    } finally { setFsCaseInsensitive(REAL_FS_FOLDS); }
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§5 — homoglyph paths: a lookalike must not be MISTAKEN for the real one', () => {
  // The honest requirement, and it is the opposite of the obvious one. A
  // Cyrillic `е` in `sеcrets.yaml` is a DIFFERENT FILE on every filesystem; it
  // holds no secret and blocking it would be an invented refusal (P5-R5).
  // What matters is that the deny list keys on the RESOLVED bytes, so a
  // homoglyph can never be normalised INTO an allow, and — the real hazard —
  // that a homoglyph in the ALLOWLIST cannot be matched by the real path.
  const CYRILLIC_E = 'е';
  const HOMOGLYPH = path.join(dojoDir, `s${CYRILLIC_E}crets.yaml`);

  it('a homoglyph lookalike is not the denied file, and is not silently treated as it', async () => {
    expect(HOMOGLYPH).not.toBe(SECRETS);
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(HOMOGLYPH) });
    // No global deny names it; a wildcard manifest may read it. The point is
    // that the verdict is reached by comparing BYTES, never by a lookalike fold.
    expect(v.allowed).toBe(true);
  });

  it('the REAL path is still denied when a homoglyph twin sits beside it', async () => {
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(SECRETS) });
    expect(v.allowed).toBe(false);
  });

  it('NFC/NFD normalisation cannot turn a denied path into an allowed one', async () => {
    // macOS hands back NFD from readdir while a model types NFC. Both spellings
    // of the same denied name must land on the same verdict.
    const nfd = SECRETS.normalize('NFD');
    const nfc = SECRETS.normalize('NFC');
    for (const spelling of [nfd, nfc]) {
      const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(spelling) });
      expect(v.allowed, `spelling ${JSON.stringify(spelling)} must be refused`).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§6 — the proc broker: substitution, backticks and redirection append', () => {
  it('refuses a shell-redirection APPEND that reaches the denied file', async () => {
    // The v2.3.19 finding verbatim: `echo '...' >> ~/.dojo/secrets.yaml` went
    // through cleanly because file_write denies do not see a shell redirect.
    const cmd = mustResolveCommand("echo 'x: y' >> ~/.dojo/secrets.yaml");
    const v = await authorize(wildcard(), { kind: 'shell', resource: cmd });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/secrets\.yaml/);
  });

  it('refuses command SUBSTITUTION that names the denied file', async () => {
    const v = await authorize(wildcard(), { kind: 'shell', resource: mustResolveCommand('echo $(cat ~/.dojo/secrets.yaml)') });
    expect(v.allowed).toBe(false);
  });

  it('refuses BACKTICK substitution that names the denied file', async () => {
    const v = await authorize(wildcard(), { kind: 'shell', resource: mustResolveCommand('echo `cat ~/.dojo/secrets.yaml`') });
    expect(v.allowed).toBe(false);
  });

  it('refuses the $HOME and bare-basename spellings too (the substring rule)', async () => {
    for (const cmd of [
      'cat $HOME/.dojo/secrets.yaml',
      'cat secrets.yaml',
      `cat ${SECRETS}`,
    ]) {
      const v = await authorize(wildcard(), { kind: 'shell', resource: mustResolveCommand(cmd) });
      expect(v.allowed, `expected refusal for: ${cmd}`).toBe(false);
    }
  });

  it('refuses a plain read of an SSH private key (the tokenized scan)', async () => {
    for (const cmd of ['cat ~/.ssh/id_ed25519', 'grep -r AAAA ~/.ssh/id_ed25519', 'cp ~/.ssh/id_ed25519 /tmp/x']) {
      const v = await authorize(wildcard(), { kind: 'shell', resource: mustResolveCommand(cmd) });
      expect(v.allowed, `expected refusal for: ${cmd}`).toBe(false);
    }
  });

  it('RECORDS the tokenized scan\'s known limit instead of pretending it is closed', async () => {
    // `for f in ~/.ssh/id_ed25519; do cat $f; done` is ALLOWED for an agent with
    // exec '*', and it was allowed before T2 as well: the scan looks at the
    // tokens FOLLOWING a reading command, and the token following `cat` here is
    // `$f`, not the path. The scan's own comment has always said so — *"a
    // sufficiently motivated bypass will get through; the point is keeping
    // accidental `cat ~/.dojo/secrets.yaml` out of the conversation"*.
    //
    // RULING P5-R5 is why this is asserted as an ALLOW rather than quietly
    // fixed: closing it would be a NEW refusal class for an agent that holds
    // exec '*', which is an owner decision, not a worker's. The clause exists so
    // the limit is a measured fact with a name, and so a future task that DOES
    // close it fails here and has to say it meant to.
    const v = await authorize(wildcard(), {
      kind: 'shell',
      resource: mustResolveCommand('for f in ~/.ssh/id_ed25519; do cat $f; done'),
    });
    expect(v.allowed).toBe(true);
    // …and the file that actually matters is closed on the substring rule no
    // matter how it is spelled, construct or no construct.
    const secrets = await authorize(wildcard(), {
      kind: 'shell',
      resource: mustResolveCommand('for f in ~/.dojo/secrets.yaml; do cat $f; done'),
    });
    expect(secrets.allowed).toBe(false);
  });

  it('refuses the global-deny commands regardless of manifest', async () => {
    for (const cmd of ['rm -rf /', 'rm -rf ~', 'sudo rm x', 'chmod 777 /etc']) {
      const v = await authorize(wildcard(), { kind: 'shell', resource: mustResolveCommand(cmd) });
      expect(v.allowed, `expected refusal for: ${cmd}`).toBe(false);
    }
  });

  it('still ALLOWS the ordinary shell work an agent does all day', async () => {
    for (const cmd of ['ls -la ~/Projects', 'echo hello', 'cat ~/Projects/notes.txt']) {
      const v = await authorize(wildcard(), { kind: 'shell', resource: mustResolveCommand(cmd) });
      expect(v.allowed, `expected ALLOW for: ${cmd}`).toBe(true);
    }
  });

  it('refuses a command outside a SCOPED agent\'s allowlist, naming the inner command', async () => {
    const v = await authorize(scoped(), { kind: 'shell', resource: mustResolveCommand('curl https://example.com') });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/curl/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§7 — RULING P5-R1: the PM overseer wall, held by a test at last', () => {
  // The wall lives at `tools.ts` ABOVE the ladder and T2 does not move it. What
  // it lacked was a test: nothing failed if somebody deleted it. These clauses
  // are that test, expressed against the same single-source allow-list the
  // executor calls (`pmMayCall`, tracker/pm-agent.ts), so a change to either
  // side fails here.
  it('REFUSES a worker verb a PM must never call', () => {
    for (const [name, args] of [
      ['exec', { command: 'ls' }],
      ['spawn_agent', { name: 'w', system_prompt: 'x' }],
      ['file_write', { path: '/tmp/x', content: 'y' }],
      ['imessage_send', { to: '+1', text: 'hi' }],
      ['web_fetch', { url: 'https://example.com' }],
    ] as const) {
      expect(pmMayCall(name, args as Record<string, unknown>), `PM must not be able to call ${name}`).toBe(false);
    }
  });

  it('REFUSES a work_update STATUS flip — the operation, not the name, is the key', () => {
    // PHASE-2 T8V: the three PM-only tools became three ACTIONS on one verb, so
    // a name-keyed wall would have let a status flip through under a name that
    // is otherwise allowed. This is the clause that pins the operation keying.
    expect(pmMayCall('work_update', { action: 'status', status: 'in_progress' })).toBe(false);
  });

  it('ALLOWS the overseer verbs — the wall contains the PM, it does not disarm it', () => {
    expect(pmMayCall('work_validate', { action: 'validate' })).toBe(true);
    expect(pmMayCall('work_update', { action: 'reassign' })).toBe(true);
    expect(pmMayCall('work_update', { action: 'get' })).toBe(true);
    expect(pmMayCall('send_to_agent', { to: 'x', message: 'y' })).toBe(true);
    expect(pmMayCall('file_read', { path: '/tmp/x' })).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§8 — the net broker: private/internal address classes, THROUGH the broker', () => {
  it('refuses loopback, link-local, metadata and ULA targets', async () => {
    for (const raw of [
      'http://127.0.0.1/admin',
      'http://localhost:3001/api/dev/outbound',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://2130706433/', // the numeric spelling of 127.0.0.1
    ]) {
      const v = await authorize(wildcard(), { kind: 'net', resource: mustResolveUrl(raw) });
      expect(v.allowed, `expected refusal for ${raw}`).toBe(false);
    }
  });

  it('refuses a non-http scheme at the broker', async () => {
    for (const raw of ['file:///etc/passwd', 'gopher://example.com/']) {
      const r = resolveUrlArg(raw);
      if (r.ok) {
        const v = await authorize(wildcard(), { kind: 'net', resource: r.value });
        expect(v.allowed, `expected refusal for ${raw}`).toBe(false);
      } else {
        expect(r.code).toBe('invalid_url');
      }
    }
  });

  it('refuses a domain outside a SCOPED agent\'s network_domains', async () => {
    const v = await authorize(scoped(), { kind: 'net', resource: mustResolveUrl('https://not-granted.test/') });
    expect(v.allowed).toBe(false);
  });

  it('ALLOWS a granted domain (and its subdomain) for a scoped agent', async () => {
    for (const raw of ['https://example.com/x', 'https://api.example.com/y']) {
      const v = await authorize(scoped(), { kind: 'net', resource: mustResolveUrl(raw) });
      expect(v.allowed, `expected ALLOW for ${raw}`).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§9 — sensitive-share: a path that may be READ may still not be PUBLISHED', () => {
  it('refuses publishing an SSH private key even to a wildcard agent', async () => {
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(path.join(sshDir, 'id_ed25519')), surface: 'share' });
    expect(v.allowed).toBe(false);
  });

  it('still publishes the public key beside it (the `.pub` carve-out survives)', async () => {
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(path.join(sshDir, 'id_ed25519.pub')), surface: 'share' });
    expect(v.allowed).toBe(true);
  });

  it('refuses publishing a `.env` file', async () => {
    const envFile = path.join(projects, '.env');
    fs.writeFileSync(envFile, 'API_KEY=dummy\n');
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(envFile), surface: 'share' });
    expect(v.allowed).toBe(false);
  });

  it('publishes an ordinary project file', async () => {
    const v = await authorize(wildcard(), { kind: 'fs_read', resource: mustResolvePath(path.join(projects, 'notes.txt')), surface: 'share' });
    expect(v.allowed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§10 — ONE deny list: the merge is a SUPERSET of both twins, proven', () => {
  // The two twins at this HEAD are `isSensitivePath` (path-guards.ts) and
  // `GLOBAL_FILE_READ_DENY` (permissions.ts). They are non-overlapping in
  // content and overlapping in PURPOSE, which is how a path ends up protected
  // on one door and open on the next. The merge is a data merge: ONE table,
  // each row declaring which tiers it denies, so the per-tier answers are
  // byte-for-byte what they were (P5-R5: no new refusals) while there is only
  // one place left to add the next secret file.

  /** The literal pre-merge lists, frozen here as the reference implementation
   *  the merge is measured against. If somebody edits the merged table and
   *  drops a row, this fails naming it. */
  const LEGACY_GLOBAL_FILE_READ_DENY = [
    '~/.dojo/logs/healer.log',
    '~/.dojo/logs/healer-report.log',
    '~/.dojo/logs/healer-archives/**',
    '~/.dojo/secrets.yaml',
  ];
  const LEGACY_SENSITIVE_BASENAMES = [
    'secrets.yaml', 'secrets.yml', 'secrets.json',
    '.env', '.env.local', '.env.production', '.env.development',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
    'authorized_keys', 'known_hosts', '.npmrc', '.pypirc', '.netrc', 'credentials',
  ];

  it('every legacy GLOBAL_FILE_READ_DENY pattern is still denied on the read tier', () => {
    for (const pattern of LEGACY_GLOBAL_FILE_READ_DENY) {
      const probe = pattern.replace('/**', '/anything.log').replace('~', fixtureHome);
      expect(deniedTiers(probe), `${pattern} lost its read deny`).toContain('global_read');
    }
  });

  it('every legacy SENSITIVE basename is still on the sensitive tier', () => {
    for (const base of LEGACY_SENSITIVE_BASENAMES) {
      const probe = path.join(projects, base);
      expect(deniedTiers(probe), `${base} lost its sensitive-tier deny`).toContain('sensitive');
    }
  });

  it('the ~/.ssh containment rule and its .pub carve-out both survive the merge', () => {
    expect(deniedTiers(path.join(sshDir, 'anything_at_all'))).toContain('sensitive');
    expect(deniedTiers(path.join(sshDir, 'anything_at_all.pub'))).not.toContain('sensitive');
  });

  it('the cloud-credential locations survive the merge', () => {
    expect(deniedTiers(path.join(fixtureHome, '.aws', 'credentials'))).toContain('sensitive');
    expect(deniedTiers(path.join(fixtureHome, '.config', 'gcloud', 'x.json'))).toContain('sensitive');
    expect(deniedTiers(path.join(fixtureHome, '.kube', 'config'))).toContain('sensitive');
  });

  it('`~/.dojo/secrets.yaml` stays denied — on EVERY tier the two twins covered', () => {
    const tiers = deniedTiers(SECRETS);
    expect(tiers).toContain('sensitive');
    expect(tiers).toContain('global_read');
    expect(tiers).toContain('global_write');
    expect(isDeniedResource(SECRETS, 'fs_read')).toBe(true);
    expect(isDeniedResource(SECRETS, 'fs_write')).toBe(true);
  });

  it('the merged table is ONE table and every row names the tiers it denies', () => {
    expect(DENY_RULES.length).toBeGreaterThan(0);
    for (const rule of DENY_RULES) {
      expect(rule.id, 'every rule is identifiable in a refusal message').toBeTruthy();
      expect(rule.tiers.length, `${rule.id} denies nothing`).toBeGreaterThan(0);
      expect(rule.reason, `${rule.id} has no stated requirement`).toBeTruthy();
    }
    // No two rows may carry the same id — a duplicate id is how a merge quietly
    // drops one of the twins.
    const ids = DENY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('an ordinary file is denied on NO tier (the merge did not widen)', () => {
    expect(deniedTiers(path.join(projects, 'notes.txt'))).toEqual([]);
  });
});
