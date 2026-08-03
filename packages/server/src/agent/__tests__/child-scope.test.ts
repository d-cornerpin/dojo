// ════════════════════════════════════════════════════════════════════════════
// THE DECIDED DEFAULT, THE SUBSET RULE, AND THE REFUSALS (PHASE-5 T5).
//
// Owner decision, DECIDED 2026-07-26: *"a spawned worker's default scope = its
// parent's effective scope MINUS destructive tools, system control, and
// messaging/outbound-send"*. This file is that decision as clauses, plus the two
// halves the plan's Step 2 asks for — child ⊆ parent, and a malformed manifest
// REFUSING rather than silently downgrading.
//
// EVERY REFUSAL HERE HAS A POSITIVE CONTROL BESIDE IT. A validator that refuses
// valid spawns is a capability loss, and the phase's posture makes that the more
// dangerous of the two failure modes.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  defaultChildScope, resolveChildScope, validateManifest, parseStoredManifest,
  scopeExcesses, artifactPathFor,
} from '../scope.js';
import { PRIMARY_AGENT_PERMISSIONS, DEFAULT_SUBAGENT_PERMISSIONS } from '../manifest.js';
import { grantForManifest } from '../brokers/grants.js';
import { authorizeShellScript, authorizeProc } from '../brokers/proc.js';
import { authorizeAppleScript } from '../brokers/applescript.js';
import { authorizeSystemControl } from '../brokers/index.js';
import { resolveCommandArg } from '../brokers/resolve.js';
import type { PermissionManifest } from '@dojo/shared';

const CHILD = 'child-1';
const child = () => defaultChildScope(PRIMARY_AGENT_PERMISSIONS, CHILD);

const cmd = (text: string) => {
  const r = resolveCommandArg(text);
  if (!r.ok) throw new Error(`fixture did not resolve: ${text}`);
  return r.value;
};

describe('A — the DECIDED default: inherit parent, minus danger', () => {
  it('STRIPS system control, which is the member that actually changes anything', () => {
    // Today a child receives its parent's manifest verbatim, so a child of the
    // primary inherits `['*','applescript']`. Two live sub-agents on the dev body
    // are exactly that shape, by inheritance. This is what stops for NEW spawns.
    expect(PRIMARY_AGENT_PERMISSIONS.system_control).toEqual(['*', 'applescript']);
    expect(child().system_control).toEqual([]);
    const grant = grantForManifest(CHILD, child());
    for (const category of ['mouse', 'keyboard', 'screen', 'web_browse']) {
      expect(authorizeSystemControl(grant, category, 'x').allowed, category).toBe(false);
    }
    expect(authorizeAppleScript(grant, cmd('display dialog "hi"')).allowed).toBe(false);
  });

  it('STRIPS destructive — `file_delete` is the only destructive thing a manifest says', () => {
    expect(child().file_delete).toBe('none');
  });

  it('⚠ KEEPS THE EXEC AND SHELL REACH — shell/pipes is NOT in the danger set', () => {
    // Plan T5 INBOUND (c), and the MUST-SURVIVE item. Withholding `shell_allow`
    // by default would be a narrowing the owner's ruling does not authorize, so
    // this is asserted through the real brokers rather than on the field.
    const grant = grantForManifest(CHILD, child());
    expect(child().exec_allow).toEqual(PRIMARY_AGENT_PERMISSIONS.exec_allow);
    expect(child().shell_allow).toEqual(PRIMARY_AGENT_PERMISSIONS.shell_allow);
    expect(authorizeShellScript(grant, cmd('ls -la | wc -l')).allowed, 'pipes').toBe(true);
    expect(authorizeShellScript(grant, cmd('for f in *; do echo $f; done')).allowed, 'loops').toBe(true);
    expect(authorizeProc(grant, cmd('git status')).allowed, 'a plain program').toBe(true);
  });

  it('KEEPS the network reach — the false `none` default is dead', () => {
    expect(child().network_domains).toBe('*');
    expect(DEFAULT_SUBAGENT_PERMISSIONS.network_domains).toBe('*');
  });

  it('KEEPS delegation flags — neither is in the named danger set', () => {
    // Stripping `can_spawn_agents` would narrow what a child of the primary holds
    // today. Leaving `can_assign_permissions` is safe only because the subset
    // rule below bounds it, which is the trade stated in the module header.
    expect(child().can_spawn_agents).toBe(true);
    expect(child().can_assign_permissions).toBe(true);
  });

  it('ADDS the child’s own artifact directory — the path T2 staged a window for', () => {
    const scoped = defaultChildScope(
      { ...PRIMARY_AGENT_PERMISSIONS, file_read: ['/tmp/**'], file_write: ['/tmp/**'] },
      CHILD,
    );
    expect(scoped.file_read).toContain(artifactPathFor(CHILD));
    expect(scoped.file_write).toContain(artifactPathFor(CHILD));
    // …and a `'*'` parent is left alone: turning a wildcard into an enumeration
    // would NARROW it.
    expect(child().file_read).toBe('*');
  });

  it('MUST-SURVIVE: the default sub-agent keeps its twelve commands on BOTH doors', () => {
    // T3's measurement, and the brief names it: the new default must not shrink
    // it. Counted rather than eyeballed.
    expect(DEFAULT_SUBAGENT_PERMISSIONS.exec_allow).toHaveLength(12);
    expect(DEFAULT_SUBAGENT_PERMISSIONS.shell_allow).toHaveLength(12);
    expect(DEFAULT_SUBAGENT_PERMISSIONS.shell_allow).toEqual(DEFAULT_SUBAGENT_PERMISSIONS.exec_allow);
  });
});

describe('A — messaging/outbound-send: the danger class already withheld, held by a test', () => {
  // The third member of the danger set has NO manifest field, and this module
  // deliberately does not invent one — a new gate would newly refuse calls that
  // work today, which is the owner's decision (P5-R5). It is already withheld
  // from every sub-agent at four walls, and these clauses are what keep it that
  // way, so the default's claim is held by something that can fail.
  it('`imessage_send` is primary-only, by a DECLARED gate', async () => {
    const { gatesForCall } = await import('../tools/gates.js');
    const gates = gatesForCall('imessage_send', {});
    expect(gates.some((g) => g.kind === 'primary_only' && g.row === '7')).toBe(true);
  });

  it('the three Twilio verbs are primary-only, by their own handler walls', async () => {
    // These live in the handler bodies rather than in the gate table, which is
    // why they need naming: a reader scanning `gates.ts` alone would conclude a
    // sub-agent can place a phone call.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const p = await import('node:path');
    const commsPath = p.resolve(
      p.dirname(url.fileURLToPath(import.meta.url)), '..', 'tools', 'cat', 'comms.ts',
    );
    const source = fs.readFileSync(commsPath, 'utf8');
    for (const tool of ['sms_send', 'voice_call', 'voice_call_end', 'voice_call_status']) {
      expect(
        source,
        `${tool} must keep its primary-only wall`,
      ).toContain(`only the primary agent can use ${tool}`);
    }
  });
});

describe('C — child ⊆ parent, enforced structurally', () => {
  const parent: PermissionManifest = {
    ...DEFAULT_SUBAGENT_PERMISSIONS,
    file_read: ['/tmp/**'], file_write: ['/tmp/**'],
    exec_allow: ['ls', 'git'], shell_allow: ['ls'],
    network_domains: ['example.com'], max_processes: 3,
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
      ['more processes', { max_processes: 99 }],
      ['delete when the parent cannot', { file_delete: ['/tmp/x'] }],
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
      ['fewer processes', { max_processes: 1 }],
      ['no system control', { system_control: [] }],
      ['no delete', { file_delete: 'none' }],
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
    // system control: the fields it does not name come from the minus-danger
    // default, not from the parent's own manifest.
    const resolved = resolveChildScope({ exec_allow: ['ls'] }, PRIMARY_AGENT_PERMISSIONS, CHILD);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.manifest.system_control).toEqual([]);
    expect(resolved.manifest.file_delete).toBe('none');
  });
});

describe('C — a malformed manifest REFUSES, it never silently downgrades', () => {
  it('refuses the wrong TYPE on a field, naming the field', () => {
    for (const bad of [
      { file_read: 42 },
      { exec_allow: 'ls' },
      { can_spawn_agents: 'yes' },
      { max_processes: -1 },
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

  it('refuses malformed stored TEXT rather than falling back', () => {
    // The distinction the module exists for: `getAgentPermissions` catching a
    // JSON error and returning the default is right for a READ and wrong for a
    // SPAWN, because a child then carries a scope nobody chose.
    for (const bad of ['not json', '{"file_read":', '', null, undefined]) {
      expect(parseStoredManifest(bad as string | null).ok, String(bad)).toBe(false);
    }
  });

  it('ACCEPTS every shape a real stored manifest takes — the positive half', () => {
    // Measured on the live body: `'{}'` (40 of 56 agents), full manifests,
    // partial legacy manifests with no `system_control` key, and the scalar
    // `system_control: '*'` spelling. A schema that refused any of these would
    // take working agents off the air.
    for (const good of [
      '{}',
      JSON.stringify(PRIMARY_AGENT_PERMISSIONS),
      JSON.stringify(DEFAULT_SUBAGENT_PERMISSIONS),
      '{"file_read":"*","file_write":"none","file_delete":"none","exec_allow":[],"exec_deny":["*"],"network_domains":"none","can_spawn_agents":false,"can_assign_permissions":false}',
      '{"system_control":"*"}',
      '{"system_control":["*","applescript"]}',
    ]) {
      expect(parseStoredManifest(good).ok, good.slice(0, 60)).toBe(true);
    }
  });

  it('a spawn that names NOTHING gets the decided default, not a refusal', () => {
    const resolved = resolveChildScope(undefined, PRIMARY_AGENT_PERMISSIONS, CHILD);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.manifest.system_control).toEqual([]);
    expect(resolved.manifest.exec_allow).toEqual(PRIMARY_AGENT_PERMISSIONS.exec_allow);
  });
});
