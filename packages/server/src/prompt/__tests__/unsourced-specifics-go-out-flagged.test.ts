// ════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 13 / T61 (a) — A FACTUAL SPECIFIC GOES OUT VERIFIED OR FLAGGED.
//
// ── THE INCIDENT (round-13 S1, catalog §8.1–8.6) ──
// "Mount Si … about 3,150 feet over 4 miles … yes, you need a Discover Pass … it's DNR land
// … the standard $30/year state Discover Pass covers it (or pay $10 for the day)." Answered
// in 5.2 seconds with ZERO tool calls. The recorder then asked whether any source existed on
// the box at all: `messages`, `summaries`, `vault_entries`, `briefings` and every uploaded
// file — 0 rows, 0 files. Seven specifics, no source in either direction.
//
// And the private reasoning hedged WIDER than the reply did: "3,150-3,300 feet", "some
// sources say 3,300 ft", "per WTA", "Actually, let me think." None of those four reached the
// user. The $30/year and $10/day figures appear in the reply and NOWHERE in the reasoning.
//
// ── THE HONEST ROOT STATEMENT, recorded beside the fix ──
// The decision "memory or lookup" is taken BEFORE any tool call. T45's door rides web
// RESULTS and cannot fire when no source is consulted. The engine cannot classify "this ask
// needed sources" without reading the prose of the ask, which is the standing ban. So the
// only surface that exists at that moment is the static prompt, and this is that surface:
// ONE engine-owned conduct sentence, T23's precedent exactly, on the re-blessing register.
//
// HONEST BOUND, recorded at the test that could be mistaken for proof of behaviour: this is
// the WEAK surface by our own HL6 evidence. It narrows model judgment; it cannot guarantee
// it. Leg (b) exists precisely because of that — the class becomes COUNTABLE, so a future
// round measures it instead of re-discovering it. If the class persists across rounds, the
// next lever is the owner's model choice, not more engine text.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
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

/** THE REGISTERED RE-BLESSING, BYTE FOR BYTE. This string is the whole prefix delta. */
const CONDUCT_SENTENCE =
  'When you state a factual specific — a number, a price, a fee, a distance, opening hours, '
  + 'a policy, a rule about who may do what — it goes out one of two ways: from a source you '
  + 'actually consulted, or with the reply saying in plain words that you are going from '
  + 'memory and have not verified it.';

const SECTION = '## Stating A Factual Specific';

const SURFACES: Array<[string, ToolDefinition[]]> = [
  ['a bare surface', [tool('web_search')]],
  ['a sub-agent that can message peers', [tool('send_to_agent'), tool('list_agents')]],
  ['a spawn-capable primary', [tool('spawn_agent'), tool('create_agent_group'), tool('send_to_agent')]],
  ['a tracker-holding worker', [tool('work_open'), tool('work_update'), tool('shell')]],
  // The S1 turn's own surface: an agent that COULD have searched and did not.
  ['the S1 shape — search available, unused', [tool('web_search'), tool('web_fetch'), tool('history_search')]],
];

describe('T61(a): the conduct sentence reaches every agent through sys.tools', () => {
  for (const [label, tools] of SURFACES) {
    it(`${label} carries it`, () => {
      surface.tools = tools;
      expect(generateToolsGuidance_v2('bot')).toContain(CONDUCT_SENTENCE);
    });
  }

  it('the primary carries it too — engine-owned, so an already-installed agent gets it', () => {
    surface.tools = [tool('spawn_agent'), tool('imessage_send')];
    expect(generateToolsGuidance_v2('primary')).toContain(CONDUCT_SENTENCE);
  });

  it('it is stated ONCE, not repeated per section', () => {
    surface.tools = [tool('send_to_agent'), tool('work_open'), tool('vault_search')];
    const g = generateToolsGuidance_v2('bot');
    expect(g.split(CONDUCT_SENTENCE).length - 1).toBe(1);
  });
});

describe('T61(a): the cache tenet — static prefix, never per-turn', () => {
  it('byte-identical across two assembles of the same agent', () => {
    surface.tools = [tool('web_search')];
    expect(generateToolsGuidance_v2('bot')).toBe(generateToolsGuidance_v2('bot'));
  });

  it('the BLOCK is the same bytes for every tool surface — nothing volatile rode in with it', () => {
    const blockOf = (g: string): string => {
      const start = g.indexOf(SECTION);
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

  it('CONTROL: T23\'s registered sentence is still there, byte-identical, and still stated once', () => {
    // The prefix delta must be THIS sentence and nothing else. T23's block is the nearest
    // neighbour and the one a careless edit would disturb.
    surface.tools = [tool('web_search')];
    const g = generateToolsGuidance_v2('bot');
    const t23 = 'If your proposal asked the user a question about a specific item, a generic approval '
      + "('yes', 'go ahead') covers only the items you marked unambiguous — act on those, and "
      + 're-ask or leave the questioned item.';
    expect(g).toContain(t23);
    expect(g.split(t23).length - 1).toBe(1);
    expect(g).toContain('## Acting On An Approval');
  });
});

describe('T61(a): OR2 and the classification ban — it steers the AGENT and composes nothing', () => {
  it('names no engine-authored user text and quotes no line to emit', () => {
    surface.tools = [tool('web_search')];
    const g = generateToolsGuidance_v2('bot');
    const start = g.indexOf(SECTION);
    const block = g.slice(start, start + 900);
    expect(block).not.toMatch(/say (exactly|verbatim)|tell the user ["“]/i);
    // It does not forbid answering — the S1 control is that a from-memory answer still goes.
    expect(block).not.toMatch(/refuse|do not answer|never answer/i);
  });

  it('the honest bound is recorded where the rule is written, not only in a report', () => {
    // The plan's own words: this is the weak surface, and the file must say so.
    const text = readFileSync(new URL('../assembler.ts', import.meta.url), 'utf8');
    const at = text.indexOf(SECTION);
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(Math.max(0, at - 3000), at)).toMatch(/HONEST BOUND/);
  });
});
