// ════════════════════════════════════════════════════════════════════════════════════════
// ONE TRUTH ABOUT ADMINISTRATOR COMMANDS — the backwards-lifecycle probes (D5), driven
// through BOTH surfaces at once. UX-ACCESS A4 fold-in, BACKLOG 111.
//
// WHY ONE FILE DRIVES BOTH. The requirement is not "the soul says X" and separately "the
// tool description says X" — it is that they CANNOT DISAGREE. A clause that asks only one
// of them passes on the day the other one drifts, which is the exact state v3.2.2 shipped:
// the tool descriptions told the truth about the sudo door and the soul's `## Capabilities`
// list said nothing at all. So every clause below asks the question twice, in one moment,
// off one state.
//
// THE DOORS ARE REAL. `getSudoPolicy` is the real function (the unrecognised-value fail-safe
// included) over a stubbed platform-config read; `agentMayRunAdminCommands` is the real
// predicate; `getFilteredTools` is the real surface build with its real memo. What is
// fictional is the box: a made-up primary id, a made-up sub-agent, and a manifest literal.
// No owner data, no `~/.dojo` (G1).
//
// ⚠ THE MEMO IS PART OF THE SUBJECT, NOT AN OBSTACLE. `getFilteredTools` caches per agent on
// (tool-config generation, row fingerprint), and the policy is a FIELD of that fingerprint.
// So "flip the policy and the next assembly reflects it" is only true if the fingerprint
// moved, and the clause that proves the soul moved in the same assembly proves the
// fingerprint moved with it — one truth, one moment.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const box = {
  primaryId: 'fixture-primary',
  /** The stored config row. `getSudoPolicy` is real and reads THROUGH this. */
  policyRaw: 'gated' as string | null,
  execAllow: ['*'] as string[],
  shellAllow: undefined as string[] | undefined,
};

vi.mock('../../../config/platform.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === box.primaryId,
    isPMAgent: () => false,
    isTrainerAgent: () => false,
    isHealerAgent: () => false,
    isImaginerAgent: () => false,
    getSudoPolicyRaw: () => box.policyRaw,
  };
});

vi.mock('../../manifest.js', () => ({
  getAgentPermissions: () => ({
    exec_allow: box.execAllow,
    shell_allow: box.shellAllow,
    can_spawn_agents: false,
    file_read: '*', file_write: '*', file_delete: [],
    network_domains: 'none', max_processes: 2,
    can_assign_permissions: false, system_control: [],
  }),
  PRIMARY_AGENT_PERMISSIONS: {},
  DEFAULT_SUBAGENT_PERMISSIONS: {},
}));

// ⚠ THE `permissions` COLUMN IS DERIVED FROM THE SAME FIXTURE STATE THE MANIFEST IS, AND
// THAT IS NOT A CONVENIENCE. `computeAgentToolFingerprint` keys the surface memo on that
// column; in production the manifest IS read from it, so a grant change moves the key. A
// fixture that returned a constant `permissions` while varying the manifest would decouple
// the two and hand back a stale tool list — which is exactly what it did on the first cut of
// this suite, and it would have been read as a product defect.
vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM agents')
        ? {
            permissions: JSON.stringify({ exec_allow: box.execAllow, shell_allow: box.shellAllow }),
            spawn_depth: 0, created_by: 'fixture', tools_policy: null,
            group_id: null, classification: null, task_id: null,
          }
        : undefined),
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  }),
}));

import { applySoulCapabilityTruth } from '../../../prompt/assembler.js';
import { getFilteredTools } from '../../tools/surface.js';
import { SOUL_ADMIN_COMMANDS_LINE } from '../sudo-claim.js';
import { DEFAULT_SOUL_MD } from '../../../prompt/templates.js';

/** The shipped soul, verbatim — so a wording edit in `templates.ts` is what these probes read. */
const SHIPPED_SOUL = DEFAULT_SOUL_MD;

/** What the soul says about administrator commands, as a yes/no. */
function soulClaimsAdminCommands(agentId: string): boolean {
  return applySoulCapabilityTruth(SHIPPED_SOUL, agentId).includes(SOUL_ADMIN_COMMANDS_LINE);
}

/** What the named tool's description says about administrator commands, as a yes/no. */
function toolClaimsAdminCommands(agentId: string, toolName: string): boolean {
  const tool = getFilteredTools(agentId).find(t => t.name === toolName);
  if (!tool) return false; // no tool is no promise — the strongest form of "no".
  return tool.description.includes('Administrator commands:');
}

/** The one question, asked of both surfaces in one moment. */
function bothSurfaces(agentId: string): { soul: boolean; exec: boolean; shell: boolean } {
  return {
    soul: soulClaimsAdminCommands(agentId),
    exec: toolClaimsAdminCommands(agentId, 'exec'),
    shell: toolClaimsAdminCommands(agentId, 'shell'),
  };
}

beforeEach(() => {
  box.primaryId = 'fixture-primary';
  box.policyRaw = 'gated';
  box.execAllow = ['*'];
  box.shellAllow = undefined;
});

describe('the shipped soul carries the line the register answers for', () => {
  it('`DEFAULT_SOUL_MD` ships the administrator line byte-for-byte', () => {
    expect(SHIPPED_SOUL).toContain(SOUL_ADMIN_COMMANDS_LINE);
  });
});

describe('backwards-lifecycle probes — both surfaces, one state, one moment', () => {
  it('policy `gated` + exec granted: the soul says yes AND both tool descriptions say yes', () => {
    expect(bothSurfaces('fixture-primary')).toEqual({ soul: true, exec: true, shell: true });
  });

  it('policy `free` + exec granted: still yes on both, and the tool names the floor', () => {
    box.policyRaw = 'free';
    expect(bothSurfaces('fixture-primary')).toEqual({ soul: true, exec: true, shell: true });
    const exec = getFilteredTools('fixture-primary').find(t => t.name === 'exec')!;
    expect(exec.description).toContain('safety floor');
    expect(exec.description).not.toContain('HELD');
  });

  it('policy `blocked`: BOTH say no', () => {
    box.policyRaw = 'blocked';
    expect(bothSurfaces('fixture-primary')).toEqual({ soul: false, exec: false, shell: false });
  });

  it('no command grant at all: BOTH say no regardless of policy', () => {
    box.execAllow = [];
    box.shellAllow = [];
    for (const policy of ['gated', 'free', 'blocked']) {
      box.policyRaw = policy;
      expect(bothSurfaces('fixture-primary'), `policy=${policy}`)
        .toEqual({ soul: false, exec: false, shell: false });
    }
  });

  it('a shell-only primary: BOTH say yes, and it is the `shell` description that carries it', () => {
    box.execAllow = [];
    box.shellAllow = ['ls', 'cat'];
    const seen = bothSurfaces('fixture-primary');
    expect(seen.soul).toBe(true);
    expect(seen.shell).toBe(true);
    // `exec` is stripped from the surface by an empty `exec_allow`, so there is no exec
    // description to carry anything — which is why "no tool" counts as "no promise".
    expect(getFilteredTools('fixture-primary').some(t => t.name === 'exec')).toBe(false);
  });

  it('the role wall: a sub-agent is told no by both surfaces under every policy', () => {
    for (const policy of ['gated', 'free', 'blocked']) {
      box.policyRaw = policy;
      expect(bothSurfaces('a-sub-agent'), `policy=${policy}`)
        .toEqual({ soul: false, exec: false, shell: false });
    }
  });

  it('an owner-authored soul with no `## Capabilities` list comes back unchanged, by identity', () => {
    const authored = '# Identity\n\nYou are the box owner\'s assistant.\n\n# Rules\n\n- Be direct.\n';
    for (const policy of ['gated', 'free', 'blocked']) {
      box.policyRaw = policy;
      const out = applySoulCapabilityTruth(authored, 'fixture-primary');
      expect(Object.is(out, authored), `policy=${policy}`).toBe(true);
    }
  });
});

describe('a policy flip at runtime moves the soul and the tool fingerprint in the same assembly', () => {
  it('the flip reaches BOTH, and the memo proves the fingerprint moved rather than being bypassed', () => {
    // 1. Steady state: the memo HITS, so the surface is not being rebuilt behind our backs.
    const first = getFilteredTools('fixture-primary');
    const second = getFilteredTools('fixture-primary');
    expect(second).toBe(first);
    const soulBefore = applySoulCapabilityTruth(SHIPPED_SOUL, 'fixture-primary');
    expect(soulBefore).toContain(SOUL_ADMIN_COMMANDS_LINE);
    expect(first.find(t => t.name === 'exec')!.description).toContain('HELD');

    // 2. THE FLIP — gated → blocked, through the real policy reader.
    box.policyRaw = 'blocked';

    // 3. The next assembly: a DIFFERENT array (the fingerprint moved; a stale fingerprint
    //    would have handed back `first`), a description with no door, and a soul with no
    //    claim. One state change, both surfaces, one moment.
    const third = getFilteredTools('fixture-primary');
    expect(third).not.toBe(first);
    expect(third.find(t => t.name === 'exec')!.description).not.toContain('Administrator commands:');
    const soulAfter = applySoulCapabilityTruth(SHIPPED_SOUL, 'fixture-primary');
    expect(soulAfter).not.toContain(SOUL_ADMIN_COMMANDS_LINE);
    expect(soulAfter).not.toBe(soulBefore);

    // 4. And back, so the flip is proven in both directions rather than as a one-way strip.
    box.policyRaw = 'gated';
    expect(getFilteredTools('fixture-primary').find(t => t.name === 'exec')!.description).toContain('HELD');
    expect(applySoulCapabilityTruth(SHIPPED_SOUL, 'fixture-primary')).toContain(SOUL_ADMIN_COMMANDS_LINE);
  });

  it('cache safety: nothing per-turn is in the answer — same state twice, byte-identical both sides', () => {
    const soulA = applySoulCapabilityTruth(SHIPPED_SOUL, 'fixture-primary');
    const execA = getFilteredTools('fixture-primary').find(t => t.name === 'exec')!.description;
    const soulB = applySoulCapabilityTruth(SHIPPED_SOUL, 'fixture-primary');
    const execB = getFilteredTools('fixture-primary').find(t => t.name === 'exec')!.description;
    expect(soulB).toBe(soulA);
    expect(execB).toBe(execA);
  });
});
