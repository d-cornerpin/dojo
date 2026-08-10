// ════════════════════════════════════════════════════════════════════════
// UX-REPAIR T3 (leg b) — THE PREFIX STOPS ASSERTING A CAPABILITY THE AGENT
// DOES NOT HAVE, AND STARTS STATING THE TRUTH WHEN IT DOES NOT.
//
// Two surfaces, both PREFIX, both in the phase's PREFIX RE-BLESSING REGISTER:
//
//  1. `sys.tools` — `generateToolsGuidance_v2` had `if (canSpawn)` with NO
//     `else`, so no truthful NEGATIVE capability statement existed anywhere in
//     the tree (investigation issue 3, "Capability truth is surfaced only
//     positively"). Tested THROUGH the generator, with the tool surface as the
//     only input that moves.
//
//  2. `sys.identity` — the default SOUL's `## Capabilities` list asserts
//     "You can manage sub-agents for specialized tasks." unconditionally. The
//     claim is now manifest-conditional. Tested at the helper, because the
//     door it rides (`getSoulContent`) reads `~/.dojo/prompts/SOUL.md` off the
//     real box and a unit test may not depend on the owner's file.
//
// THE REQUIREMENT THIS SUITE HOLDS (register: "agents that CAN spawn keep the
// line verbatim, prefix bytes unchanged for them"): every assertion for a
// spawn-capable agent is an EQUALITY against today's bytes, not a "contains".
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolDefinition } from '../../agent/tools/types.js';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: () => false,
  isTrainerAgent: () => false,
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'primary',
  getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
  getTrainerAgentId: () => 'trainer',
  getTrainerAgentName: () => 'Trainer',
  isTrainerEnabled: () => false,
  getHealerAgentId: () => 'healer',
  getHealerAgentName: () => 'Healer',
}));

vi.mock('../../google/auth.js', () => ({
  getAgentGoogleAccessLevel: () => 'none',
  getGoogleWorkspaceConfig: () => ({ accountEmail: '' }),
  isGoogleConnected: () => false,
  isEmailMonitoringEnabled: () => false,
  isEmailSendingEnabled: () => false,
}));

vi.mock('../../microsoft/auth.js', () => ({
  getAgentMicrosoftAccessLevel: () => 'none',
  getMsAccountType: () => 'msa',
  getMicrosoftWorkspaceConfig: () => ({ accountEmail: '' }),
  isMicrosoftConnected: () => false,
  isMsEmailMonitoringEnabled: () => false,
  isMsEmailSendingEnabled: () => false,
}));

// The one input that moves between cases: the agent's tool surface.
const surface = { tools: [] as ToolDefinition[] };
vi.mock('../../agent/tools/surface.js', () => ({
  getFilteredTools: () => surface.tools,
}));

// The manifest, the SOUL conditional's only authority.
const manifest = { canSpawn: true };
vi.mock('../../agent/manifest.js', () => ({
  getAgentPermissions: () => ({ can_spawn_agents: manifest.canSpawn }),
}));

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {}, required: [] },
});

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, classification TEXT,
      group_id TEXT, parent_agent TEXT, status TEXT, charter TEXT,
      permissions TEXT, spawn_depth INTEGER, created_by TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}', config TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.prepare("INSERT INTO agents (id, name, status, classification) VALUES ('bot', 'Bot', 'idle', 'apprentice')").run();
  mockDb.current = db;
  surface.tools = [];
  manifest.canSpawn = true;
});

import { generateToolsGuidance_v2, applySpawnCapabilityTruth } from '../assembler.js';

// The section as it stands at HEAD 18119c2, byte for byte. A spawn-capable
// agent's prefix must still contain exactly this.
const SPAWNING_SECTION_VERBATIM =
  '## Spawning Sub-Agents\n' +
  'Create a work_open(kind="project") first, then spawn agents into a group with `spawn_agent` and `create_agent_group`. ' +
  'Clean up via `delete_group(terminate_members=true)`. PM monitors all tasks, don\'t create your own monitoring agents.';

describe('sys.tools — the negative capability statement', () => {
  it('states the truth to an agent that cannot spawn but can message existing agents', () => {
    surface.tools = [tool('send_to_agent'), tool('list_agents'), tool('web_search')];
    const guidance = generateToolsGuidance_v2('bot');

    expect(guidance).toContain('## Sub-Agents');
    expect(guidance).toContain('You cannot create new agents');
    expect(guidance).toContain('`send_to_agent`');
    // It states capability, it does not re-argue behaviour: the "mention the
    // choice" steer is the F9 TAIL hint's job (PC-3d — more prefix-side "say so"
    // guidance argues with the terseness rules the same prefix gives).
    expect(guidance).not.toMatch(/briefly (tell|say)/i);
    // And it never claims the positive.
    expect(guidance).not.toContain('## Spawning Sub-Agents');
  });

  it('states it without naming send_to_agent when the agent does not hold it', () => {
    surface.tools = [tool('web_search')];
    const guidance = generateToolsGuidance_v2('bot');
    expect(guidance).toContain('## Sub-Agents');
    expect(guidance).toContain('You cannot create new agents');
    expect(guidance).not.toContain('`send_to_agent`');
  });

  it('CONTROL: a spawn-capable agent keeps the section byte-identical and gains nothing', () => {
    surface.tools = [tool('spawn_agent'), tool('send_to_agent'), tool('create_agent_group')];
    const guidance = generateToolsGuidance_v2('bot');
    expect(guidance).toContain(SPAWNING_SECTION_VERBATIM);
    expect(guidance).not.toContain('## Sub-Agents\n');
    expect(guidance).not.toContain('You cannot create new agents');
  });
});

describe('sys.identity — the SOUL capability claim is manifest-conditional', () => {
  const SOUL = [
    '## Capabilities',
    '- You can read, write, and manage files on the local filesystem.',
    '- You can execute shell commands.',
    '- You can manage sub-agents for specialized tasks.',
    '- You have access to a project tracker for organizing work.',
    '',
  ].join('\n');

  it('CONTROL: a spawn-capable agent gets the soul back byte-identical', () => {
    manifest.canSpawn = true;
    expect(applySpawnCapabilityTruth(SOUL, 'bot')).toBe(SOUL);
  });

  it('drops the claim, and only the claim, for an agent that cannot spawn', () => {
    manifest.canSpawn = false;
    const out = applySpawnCapabilityTruth(SOUL, 'bot');
    expect(out).not.toContain('manage sub-agents');
    expect(out).toContain('- You can execute shell commands.');
    expect(out).toContain('- You have access to a project tracker for organizing work.');
    expect(out).toContain('## Capabilities');
    // Exactly one line removed, nothing else disturbed.
    expect(out.split('\n').length).toBe(SOUL.split('\n').length - 1);
  });

  it('leaves a soul that never made the claim untouched, either way', () => {
    const owner = '# Identity\n\nYou are Kevin.\n\n# Rules\n\n- Be direct.\n';
    manifest.canSpawn = false;
    expect(applySpawnCapabilityTruth(owner, 'bot')).toBe(owner);
    manifest.canSpawn = true;
    expect(applySpawnCapabilityTruth(owner, 'bot')).toBe(owner);
  });
});
