// ════════════════════════════════════════════════════════════════════════════
// THE ONE HELPER DEFAULT, THE SUBSET RULE, AND THE REFUSALS.
//
// Owner ruling: helpers are "Limited by default"; the main agent grants more per
// job. A spawn naming no manifest gets DEFAULT_SUBAGENT_PERMISSIONS (plus its own
// artifact directory), never its parent's reach. Beside it, the two halves that
// keep a named manifest honest: child within parent, and a malformed manifest
// REFUSING rather than silently downgrading.
//
// EVERY REFUSAL HERE HAS A POSITIVE CONTROL BESIDE IT. A validator that refuses
// valid spawns is a capability loss.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { resolveChildScope, validateManifest, scopeExcesses, artifactPathFor } from '../scope.js';
import { PRIMARY_AGENT_PERMISSIONS } from '../manifest.js';
import { DEFAULT_SUBAGENT_PERMISSIONS } from '@dojo/shared';
import { grantForManifest } from '../brokers/grants.js';
import { authorizeShellScript, authorizeProc } from '../brokers/proc.js';
import { authorizeAppleScript } from '../brokers/applescript.js';
import { authorizeSystemControl } from '../brokers/index.js';
import { resolveCommandArg } from '../brokers/resolve.js';
import type { PermissionManifest } from '@dojo/shared';
import { gatesForCall } from '../tools/gates.js';

const CHILD = 'child-1';
const child = (): PermissionManifest => {
  const r = resolveChildScope(undefined, PRIMARY_AGENT_PERMISSIONS, CHILD);
  if (!r.ok) throw new Error(r.reason);
  return r.manifest;
};

const cmd = (text: string) => {
  const r = resolveCommandArg(text);
  if (!r.ok) throw new Error(`fixture did not resolve: ${text}`);
  return r.value;
};

describe('A: the one default, a helper of the main agent starts small', () => {
  it('holds no system control, AppleScript included', () => {
    const grant = grantForManifest(CHILD, child());
    for (const category of ['mouse', 'keyboard', 'screen', 'web_browse']) {
      expect(authorizeSystemControl(grant, category, 'x').allowed, category).toBe(false);
    }
    expect(authorizeAppleScript(grant, cmd('display dialog "hi"')).allowed).toBe(false);
  });

  it('works in its own folders, not its parent\'s', () => {
    expect(child().file_read).not.toBe('*');
    expect(child().file_read).toContain('/tmp/**');
    expect(child().file_read).toContain(artifactPathFor(CHILD));
    expect(child().file_write).toContain(artifactPathFor(CHILD));
  });

  it('runs its own commands through the shell, pipes and loops included', () => {
    const grant = grantForManifest(CHILD, child());
    expect(authorizeShellScript(grant, cmd('ls -la | wc -l')).allowed, 'pipes').toBe(true);
    expect(authorizeShellScript(grant, cmd('for f in *; do echo $f; done')).allowed, 'loops').toBe(true);
    expect(authorizeProc(grant, cmd('git status')).allowed, 'a plain program').toBe(true);
    expect(authorizeProc(grant, cmd('curl https://example.com')).allowed, 'not on its list').toBe(false);
  });

  it('KEEPS the network reach', () => {
    expect(child().network_domains).toBe('*');
  });

  it('OWNER RULING: cannot make helpers or hand out permissions', () => {
    // "Limited by default": the main agent grants these per job, through spawn_agent's permissions.
    expect(child().can_spawn_agents).toBe(false);
    expect(child().can_assign_permissions).toBe(false);
  });

  it('MUST-SURVIVE: the default helper keeps its seventeen commands on BOTH doors', () => {
    // Owner rulings: mv and cp ("agents do work and must be able to move files"), then sort, jq and tee.
    // The shell follows exec_allow when shell_allow is absent, so the two doors are asked here.
    expect(DEFAULT_SUBAGENT_PERMISSIONS.exec_allow).toHaveLength(17);
    const grant = grantForManifest(CHILD, child());
    for (const name of ['mv', 'cp', 'sort', 'jq', 'tee']) {
      expect(authorizeProc(grant, cmd(`${name} a b`)).allowed, `${name} by argv`).toBe(true);
      expect(authorizeShellScript(grant, cmd(`${name} a b`)).allowed, `${name} by shell`).toBe(true);
    }
  });

  it('MUST-SURVIVE: the deny lists are UNTOUCHED by the mv/cp ruling', () => {
    expect(DEFAULT_SUBAGENT_PERMISSIONS.exec_deny).toEqual(['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *']);
    const grant = grantForManifest(CHILD, child());
    expect(authorizeShellScript(grant, cmd('sudo ls')).allowed).toBe(false);
  });

  it('a helper\'s child never exceeds the helper: each field it lacks narrows to its own', () => {
    const narrow: PermissionManifest = { ...DEFAULT_SUBAGENT_PERMISSIONS, file_read: ['/srv/data/**'], exec_allow: ['ls'], network_domains: 'none', can_spawn_agents: true };
    const r = resolveChildScope(undefined, narrow, CHILD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.file_read).toEqual(['/srv/data/**', artifactPathFor(CHILD), expect.any(String)]);
    expect(r.manifest.exec_allow).toEqual(['ls']);
    expect(r.manifest.network_domains).toBe('none');
  });
});

describe('A — messaging/outbound-send: the danger class already withheld, held by a test', () => {
  // The third member of the danger set has NO manifest field, and this module
  // deliberately does not invent one — a new gate would newly refuse calls that
  // work today, which is the owner's decision (P5-R5). It is already withheld
  // from every sub-agent at four walls, and these clauses are what keep it that
  // way, so the default's claim is held by something that can fail.
  // UX-ACCESS A1: the gate's KIND changed and the REQUIREMENT this clause holds
  // did not — `imessage_send` is still withheld from every default sub-agent,
  // still by a declared gate, still at row 7. It asks the agent's channel grant
  // now, and a default sub-agent's snapshot carries `master:false` and no
  // channel, so the answer is the same one.
  it('`imessage_send` is withheld from a default sub-agent, by a DECLARED gate', async () => {
    const gates = gatesForCall('imessage_send', {});
    expect(gates.some((g) => g.kind === 'channel' && g.row === '7')).toBe(true);
    const { MOST_RESTRICTIVE_GRANTS, mayReachChannel } = await import('@dojo/shared');
    expect(mayReachChannel(MOST_RESTRICTIVE_GRANTS, 'imessage')).toBe(false);
  });
});

describe('C — child ⊆ parent, enforced structurally', () => {
  const parent: PermissionManifest = {
    ...DEFAULT_SUBAGENT_PERMISSIONS,
    file_read: ['/tmp/**'], file_write: ['/tmp/**'],
    exec_allow: ['ls', 'git'], shell_allow: ['ls'],
    network_domains: ['example.com'],
    can_spawn_agents: true, can_assign_permissions: true,
    system_control: ['mouse'],
  };

  it('REFUSES every way a child tries to exceed its parent', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['file_read wildcard', { file_read: '*' }],
      ['file_read new path', { file_read: ['/etc/**'] }],
      ['file_write new path', { file_write: ['/etc/**'] }],
      ['exec a command the parent lacks', { exec_allow: ['curl'] }],
      ['shell a command the parent lacks', { shell_allow: ['curl'] }],
      ['network wildcard', { network_domains: '*' }],
      ['a domain the parent lacks', { network_domains: ['evil.example'] }],
      ['system control the parent lacks', { system_control: ['keyboard'] }],
      ['system control wildcard', { system_control: '*' }],
    ];
    for (const [label, over] of cases) {
      const excesses = scopeExcesses(over as never, parent);
      expect(excesses.length, `${label} must be refused`).toBeGreaterThan(0);
      const resolved = resolveChildScope(over, parent, CHILD);
      expect(resolved.ok, `${label} must refuse the spawn`).toBe(false);
    }
  });

  it('ACCEPTS every legitimate delegation — the positive half', () => {
    // A validator that refuses valid spawns is a capability loss. Each of these
    // is a subset and must land.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['the same paths', { file_read: ['/tmp/**'] }],
      ['fewer commands', { exec_allow: ['ls'] }],
      ['no commands at all', { exec_allow: [] }],
      ['fewer domains', { network_domains: [] }],
      ['no network', { network_domains: 'none' }],
      ['no system control', { system_control: [] }],
      ['dropping spawn', { can_spawn_agents: false }],
      ['an empty object — everything defaulted', {}],
    ];
    for (const [label, over] of cases) {
      expect(scopeExcesses(over as never, parent), `${label} must be allowed`).toEqual([]);
      expect(resolveChildScope(over, parent, CHILD).ok, `${label} must spawn`).toBe(true);
    }
  });

  it('`can_assign_permissions` gates DELEGATION, never ESCALATION', () => {
    // Holding it lets a parent hand a child a manifest; it never lets the child
    // exceed. Asserted from both sides so the distinction cannot rot.
    expect(scopeExcesses({ can_assign_permissions: true } as never, parent)).toEqual([]);
    expect(scopeExcesses({ file_read: '*' } as never, parent).length).toBeGreaterThan(0);
    const noAssign = { ...parent, can_assign_permissions: false };
    expect(scopeExcesses({ can_assign_permissions: true } as never, noAssign).length).toBeGreaterThan(0);
  });

  it('a `\'*\'` parent contains everything, and a `\'*\'` child of a LIST parent does not', () => {
    expect(scopeExcesses({ file_read: '*' } as never, PRIMARY_AGENT_PERMISSIONS)).toEqual([]);
    expect(scopeExcesses({ file_read: '*' } as never, parent).length).toBeGreaterThan(0);
  });

  it('an omitted field cannot be a way to inherit danger', () => {
    // A caller naming only `exec_allow` must not thereby inherit the parent's
    // system control: the fields it does not name come from the default, not
    // from the parent's own manifest.
    const resolved = resolveChildScope({ exec_allow: ['ls'] }, PRIMARY_AGENT_PERMISSIONS, CHILD);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.manifest.system_control).toEqual([]);
  });
});

describe('C — a malformed manifest REFUSES, it never silently downgrades', () => {
  it('refuses the wrong TYPE on a field, naming the field', () => {
    for (const bad of [
      { file_read: 42 },
      { exec_allow: 'ls' },
      { can_spawn_agents: 'yes' },
      { max_processes: 3 },
      { network_domains: 'anything' },
      { unknown_field: true },
    ]) {
      const r = validateManifest(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('refuses a non-object, and says what it got', () => {
    for (const bad of ['a string', 42, true, ['an', 'array']]) {
      expect(validateManifest(bad).ok).toBe(false);
    }
  });

  it('accepts every shape a real stored manifest takes', () => {
    // Measured on the live body: `'{}'` (40 of 56 agents), full manifests, partial legacy manifests with
    // no `system_control` key, and the scalar `system_control: '*'` spelling. A schema that refused any
    // of these would take working agents off the air.
    for (const good of [
      '{}',
      JSON.stringify(PRIMARY_AGENT_PERMISSIONS),
      JSON.stringify(DEFAULT_SUBAGENT_PERMISSIONS),
      '{"file_read":"*","file_write":"none","exec_allow":[],"exec_deny":["*"],"network_domains":"none","can_spawn_agents":false,"can_assign_permissions":false}',
      '{"system_control":"*"}',
      '{"system_control":["*","applescript"]}',
    ]) {
      expect(validateManifest(JSON.parse(good)).ok, good.slice(0, 60)).toBe(true);
    }
  });

  it('a spawn that names NOTHING gets the default, not a refusal', () => {
    const resolved = resolveChildScope(undefined, PRIMARY_AGENT_PERMISSIONS, CHILD);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.manifest.system_control).toEqual([]);
    expect(resolved.manifest.exec_allow).toEqual(DEFAULT_SUBAGENT_PERMISSIONS.exec_allow);
  });
});
