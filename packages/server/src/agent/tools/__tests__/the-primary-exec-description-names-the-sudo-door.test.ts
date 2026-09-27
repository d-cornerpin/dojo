// ════════════════════════════════════════════════════════════════════════════════════════
// THE PRIMARY'S EXEC DESCRIPTION NAMES THE SUDO DOOR — v3.2.2 blast finding, live.
//
// The permission-aware exec description says "You can ONLY run these commands … Any other
// command will be blocked." A model believes its tools. The v3.2.2 release blast measured
// the consequence on the dev box: asked to run a benign administrator command under
// sudo_policy=gated, the primary agent issued NO sudo call in three attempts — its own
// reply cited the description's list — so the policy broker (which intercepts sudo BEFORE
// the allowlist, proc.ts:188) went unreached, no hold was filed, and the feature was
// unreachable by the one agent it exists for, on every box.
//
// Clauses: the sentence exists exactly where the door exists (primary + gated, primary +
// free, each naming its own behavior) and nowhere else (a sub-agent is walled by role; a
// `blocked` policy makes the flat sentence true). Reverting the surface.ts change turns
// the first two clauses RED by erasing the text they assert — the mutation proof is the
// implementation's absence.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = {
  primaryId: 'fixture-primary',
  policy: 'gated' as string,
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
  getSudoPolicy: () => state.policy,
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

vi.mock('../../permissions.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const manifest = {
    exec_allow: ['ls', 'cat', 'echo', 'node', 'sh'],
    file_read: '*', file_write: '*', file_delete: [],
    network_domains: 'none', max_processes: 2,
    can_spawn_agents: false, can_assign_permissions: false, system_control: [],
  };
  return { ...actual, getAgentPermissions: () => manifest };
});

async function execDescription(agentId: string): Promise<string> {
  vi.resetModules();
  const { getFilteredTools } = await import('../surface.js');
  const exec = getFilteredTools(agentId).find(t => t.name === 'exec');
  if (!exec) throw new Error('the fixture manifest must surface an exec tool for this test to mean anything');
  return exec.description;
}

describe('the exec description and the sudo door agree about who may knock', () => {
  beforeEach(() => { state.policy = 'gated'; });

  it('primary under gated: the description names the sudo exception, the hold, and do-not-retry', async () => {
    const d = await execDescription('fixture-primary');
    expect(d).toContain('sudo');
    expect(d).toContain('HELD');
    expect(d).toContain('not run immediately');
    expect(d).toContain('not retry');
  });

  it('primary under free: the description names the sudo exception and the safety floor, not a hold', async () => {
    state.policy = 'free';
    const d = await execDescription('fixture-primary');
    expect(d).toContain('sudo');
    expect(d).toContain('safety floor');
    expect(d).not.toContain('HELD');
  });

  it('primary under blocked: the flat only-these-commands sentence stands, with no sudo exception', async () => {
    state.policy = 'blocked';
    const d = await execDescription('fixture-primary');
    expect(d).not.toContain('sudo');
  });

  it('a non-primary agent never reads a sudo exception under any policy — the wall is a role boundary', async () => {
    for (const p of ['gated', 'free', 'blocked']) {
      state.policy = p;
      const d = await execDescription('fixture-subagent');
      expect(d, `policy=${p}`).not.toContain('sudo');
    }
  });
});
