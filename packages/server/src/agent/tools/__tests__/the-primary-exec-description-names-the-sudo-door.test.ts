// ════════════════════════════════════════════════════════════════════════════════════════
// THE PRIMARY'S COMMAND-TOOL DESCRIPTIONS NAME THE SUDO DOOR — v3.2.2 blast finding, live,
// plus the review's two findings on the first cut.
//
// Round 1 (the blast): told "Any other command will be blocked", the primary never issued a
// sudo call — the broker (proc.ts:188, ahead of the allowlist) went unreached on every box.
// Round 2 (the blast again): the first fix lived only in the finite-allowlist branch, and
// the DEFAULT primary manifest is exec_allow ['*'] — the one agent most boxes have never
// read the sentence. Round 3 (the review): the policy was read twice, so a flip landing
// between the reads stored new text under the old cache key with nothing to heal it; and
// the sentence overpromised — sudo raises privilege, it does not widen the grant, so the
// finite form must carry the caveat.
//
// Clauses below hold all three rounds at once. Reverting the surface.ts change erases the
// asserted text — the mutation proof is the implementation's absence.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = {
  primaryId: 'fixture-primary',
  policy: 'gated' as string,
  policyReads: 0,
  policyQueue: [] as string[],
  execAllow: ['ls', 'cat', 'echo', 'node', 'sh'] as string[],
};

vi.mock('../../../config/platform.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === state.primaryId,
    isPMAgent: () => false,
  };
});

vi.mock('../../brokers/sudo-policy.js', () => ({
  getSudoPolicy: () => {
    state.policyReads++;
    return state.policyQueue.length > 0 ? state.policyQueue.shift()! : state.policy;
  },
}));

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM agents')
        ? {
            permissions: null, spawn_depth: 0, created_by: 'user', tools_policy: null,
            group_id: null, classification: null, task_id: null,
          }
        : undefined),
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  }),
}));

// t107 (t92 review Minor 5): THE MOCK HAS TO NAME THE MODULE THE DOOR READS.
// This mocked `agent/permissions.js` while `brokers/sudo-claim.ts` — the door whose sentence
// every clause below asserts — read `agent/manifest.js`. The planted `exec_allow` therefore
// reached `tools/surface.ts` and NOT `agentMayRunAdminCommands`, so `state.execAllow` was
// steering half of what the test believed it steered. Both readers now import
// `agent/manifest.js`, so one mock drives both; `the-sudo-door-and-the-surface-read-one-manifest`
// is the census that keeps them from drifting apart again.
vi.mock('../../manifest.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentPermissions: () => ({
      exec_allow: state.execAllow,
      file_read: '*', file_write: '*', file_delete: [],
      network_domains: 'none', max_processes: 2,
      can_spawn_agents: false, can_assign_permissions: false, system_control: [],
    }),
  };
});

async function surfaceFor(agentId: string): Promise<{ getFilteredTools: (id: string) => Array<{ name: string; description: string }> }> {
  vi.resetModules();
  return await import('../surface.js') as never;
}

async function description(agentId: string, tool: string): Promise<string> {
  const { getFilteredTools } = await surfaceFor(agentId);
  const t = getFilteredTools(agentId).find(x => x.name === tool);
  if (!t) throw new Error(`the fixture must surface a ${tool} tool for this test to mean anything`);
  return t.description;
}

describe('the command-tool descriptions and the sudo door agree about who may knock', () => {
  beforeEach(() => {
    state.policy = 'gated';
    state.policyQueue = [];
    state.policyReads = 0;
    state.execAllow = ['ls', 'cat', 'echo', 'node', 'sh'];
  });

  it('finite-allowlist primary under gated: the exception, the hold, do-not-retry, AND the no-wider-grant caveat', async () => {
    const d = await description('fixture-primary', 'exec');
    expect(d).toContain('sudo');
    expect(d).toContain('HELD');
    expect(d).toContain('not retry');
    expect(d).toContain('does not widen your command list');
  });

  it("the DEFAULT primary (exec_allow ['*']) reads the door too — the agent most boxes have", async () => {
    state.execAllow = ['*'];
    const d = await description('fixture-primary', 'exec');
    expect(d).toContain('sudo');
    expect(d).toContain('HELD');
    expect(d).not.toContain('does not widen your command list');
  });

  it('the shell tool carries the same door for the primary', async () => {
    state.execAllow = ['*'];
    const d = await description('fixture-primary', 'shell');
    expect(d).toContain('sudo');
    expect(d).toContain('HELD');
  });

  it('primary under free: the floor is named, no hold is promised', async () => {
    state.policy = 'free';
    const d = await description('fixture-primary', 'exec');
    expect(d).toContain('sudo');
    expect(d).toContain('safety floor');
    expect(d).not.toContain('HELD');
  });

  it('primary under blocked, and every non-primary under every policy: no door is named', async () => {
    state.policy = 'blocked';
    expect(await description('fixture-primary', 'exec')).not.toContain('sudo');
    for (const p of ['gated', 'free', 'blocked']) {
      state.policy = p;
      const d = await description('fixture-subagent', 'exec');
      expect(d, `policy=${p}`).not.toContain('sudo');
    }
  });

  // ── THE FIXTURE REACHES THE DOOR, NOT ONLY THE SURFACE (t107, t92 review Minor 5) ──
  // Every clause above asks `getFilteredTools` for words, and the words are chosen by
  // `adminCommandsToolSentence` only AFTER `agentMayRunAdminCommands` has said yes. That door
  // read `agent/manifest.js` while the mock at the top of this file named
  // `agent/permissions.js`, so `state.execAllow` never reached it: the door answered from the
  // production manifest, where a primary holds `exec_allow: ['*']` unconditionally, and the
  // "who may knock" half of this suite was green for a reason unrelated to its fixture.
  // This clause is the one that could not pass before the import direction was unified — the
  // no-grant arm asserts FALSE where the production manifest says TRUE.
  it('the fixture manifest steers the DOOR: no command grant, no claim, whatever the policy', async () => {
    state.execAllow = [];
    vi.resetModules();
    const closed = await import('../../brokers/sudo-claim.js');
    for (const p of ['gated', 'free'] as const) {
      expect(closed.agentMayRunAdminCommands('fixture-primary', p), `policy=${p}`).toBe(false);
    }

    state.execAllow = ['*'];
    vi.resetModules();
    const open = await import('../../brokers/sudo-claim.js');
    expect(open.agentMayRunAdminCommands('fixture-primary', 'gated')).toBe(true);
    // And the other two guards the door holds are still the door's, not the manifest's.
    expect(open.agentMayRunAdminCommands('fixture-primary', 'blocked')).toBe(false);
    expect(open.agentMayRunAdminCommands('fixture-subagent', 'gated')).toBe(false);
  });

  it('ONE policy read per surface build: a flip mid-compute cannot store new text under an old key', async () => {
    // Review finding on the first cut: fingerprint and description each read the policy,
    // so gated→free between the reads cached FREE text under the GATED fingerprint and
    // nothing ever healed it. With one read, the queue below would need TWO entries to
    // straddle a build; one build consumes exactly one.
    const { getFilteredTools } = await surfaceFor('fixture-primary');
    state.policyReads = 0;
    state.policyQueue = ['gated', 'free'];
    const first = getFilteredTools('fixture-primary').find(t => t.name === 'exec')!.description;
    expect(state.policyReads).toBe(1);
    expect(first).toContain('HELD');
    // The next build reads 'free' (queue) — and must NOT be served the gated cache entry.
    const second = getFilteredTools('fixture-primary').find(t => t.name === 'exec')!.description;
    expect(second).toContain('safety floor');
    expect(second).not.toContain('HELD');
  });
});
