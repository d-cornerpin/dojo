// ════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 5 / T23 — AN UNANSWERED QUESTION IS NOT APPROVAL.
//
// ── THE INCIDENT (round-5 S5) ──
// The agent proposed a deletion list and marked one file honestly: grocery-list.md,
// "Borderline (want your call)… Yours, or delete it?". Its own pause note said "needs his
// call". The owner replied "Yes, go ahead." — and the borderline item went with the rest.
//
// There was NO conduct contract behind that judgment. Nothing in any prompt surface says what
// a generic approval covers when the proposal itself asked a question about a specific item.
// The SOUL template's one generic caution line ("You are cautious with destructive
// operations") is per-install: an installed agent never receives template edits, so a fix
// that lives only there reaches nobody who is already running.
//
// So the sentence is ENGINE-OWNED and rides `sys.tools`, which every agent gets on every
// turn, and it is folded into `DEFAULT_SOUL_MD` as well so a fresh install carries it in its
// own voice too. This suite is the STRUCTURAL half of the task and it is the hard one: the
// sentence is IN the assembled prompt, for every tool surface, and it is the same bytes every
// time (the cache tenet — a conduct rule that moved per turn would be a prefix break).
//
// HONEST BOUND, recorded here because it belongs beside the test that could be mistaken for
// proof of behaviour: this narrows model judgment, it cannot guarantee it. The behavioural
// replay is recorded as OBSERVED behaviour in the task report, never as an assertion.
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

const surface = { tools: [] as ToolDefinition[] };
vi.mock('../../agent/tools/surface.js', () => ({
  getFilteredTools: () => surface.tools,
}));

const manifest = { canSpawn: true };
vi.mock('../../agent/manifest.js', () => ({
  getAgentPermissions: () => ({ can_spawn_agents: manifest.canSpawn }),
}));

const tool = (name: string): ToolDefinition => ({
  name, description: name,
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
  db.prepare("INSERT INTO agents (id, name, status, classification) VALUES ('primary', 'Primary', 'idle', 'primary')").run();
  mockDb.current = db;
  surface.tools = [];
  manifest.canSpawn = true;
});

import { generateToolsGuidance_v2 } from '../assembler.js';
import { DEFAULT_SOUL_MD } from '../templates.js';

/** The registered re-blessing, byte for byte. THIS STRING IS THE PREFIX DELTA. */
const CONDUCT_SENTENCE =
  'If your proposal asked the user a question about a specific item, a generic approval '
  + "('yes', 'go ahead') covers only the items you marked unambiguous — act on those, and "
  + 're-ask or leave the questioned item.';

const SURFACES: Array<[string, ToolDefinition[]]> = [
  ['a bare surface', [tool('web_search')]],
  ['a sub-agent that can message peers', [tool('send_to_agent'), tool('list_agents')]],
  ['a spawn-capable primary', [tool('spawn_agent'), tool('create_agent_group'), tool('send_to_agent')]],
  ['a tracker-holding worker', [tool('work_open'), tool('work_update'), tool('shell')]],
];

describe('T23: the conduct sentence reaches every agent through sys.tools', () => {
  for (const [label, tools] of SURFACES) {
    it(`${label} carries it`, () => {
      surface.tools = tools;
      expect(generateToolsGuidance_v2('bot')).toContain(CONDUCT_SENTENCE);
    });
  }

  it('the primary carries it too — the surface is engine-owned, not per-install', () => {
    surface.tools = [tool('spawn_agent'), tool('imessage_send')];
    expect(generateToolsGuidance_v2('primary')).toContain(CONDUCT_SENTENCE);
  });

  it('it is stated ONCE, not repeated per section', () => {
    surface.tools = [tool('send_to_agent'), tool('work_open'), tool('vault_search')];
    const g = generateToolsGuidance_v2('bot');
    expect(g.split(CONDUCT_SENTENCE).length - 1).toBe(1);
  });
});

describe('T23: the cache tenet — the sentence is static prefix, never per-turn', () => {
  it('byte-identical across two assembles of the same agent', () => {
    surface.tools = [tool('send_to_agent')];
    expect(generateToolsGuidance_v2('bot')).toBe(generateToolsGuidance_v2('bot'));
  });

  it('the BLOCK is the same bytes for every tool surface — nothing volatile rode in with it', () => {
    const blockOf = (g: string): string => {
      const start = g.indexOf('## Acting On An Approval');
      expect(start, 'the section must exist to be compared').toBeGreaterThan(-1);
      const rest = g.slice(start + 1);
      const end = rest.indexOf('\n## ');
      return end === -1 ? rest : rest.slice(0, end);
    };
    const blocks = SURFACES.map(([, tools]) => {
      surface.tools = tools;
      return blockOf(generateToolsGuidance_v2('bot'));
    });
    expect(new Set(blocks).size, 'one block, one set of bytes').toBe(1);
  });
});

describe('T23: a fresh install carries the same rule in its own voice', () => {
  it('DEFAULT_SOUL_MD states it', () => {
    expect(DEFAULT_SOUL_MD).toContain(CONDUCT_SENTENCE);
  });

  it('CONTROL: the destructive-caution trait it sits beside is untouched', () => {
    expect(DEFAULT_SOUL_MD).toContain('- You are cautious with destructive operations (deleting files, overwriting data).');
  });

  it('CONTROL: the spawn-capability line the T3 conditional keys on is byte-identical', () => {
    // `applySpawnCapabilityTruth` finds this line by its exact text; templates.ts says so in
    // its own header. A soul edit that moved it would disarm that conditional silently.
    expect(DEFAULT_SOUL_MD).toContain('- You can manage sub-agents for specialized tasks.');
  });
});

describe('T23: OR2 — this steers the AGENT and composes nothing for the user', () => {
  it('the sentence is addressed to the agent, and names no engine-authored user text', () => {
    surface.tools = [tool('send_to_agent')];
    const g = generateToolsGuidance_v2('bot');
    const start = g.indexOf('## Acting On An Approval');
    const block = g.slice(start, start + 600);
    // No quoted line for the agent to emit verbatim, and no instruction to relay engine words.
    expect(block).not.toMatch(/say (exactly|verbatim)|tell the user ["“]/i);
    expect(block).toContain('re-ask or leave the questioned item.');
  });
});
