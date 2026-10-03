// ════════════════════════════════════════════════════════════════════════════════
// t90 D3 — A REFUSAL THAT ENDS THE DISCOVERY LOOP. (live-test report #4)
//
// The report: a sub-agent spawned to write one line into a file tried a file-write tool, was
// refused because the tool's group was not in its grants, tried the SHELL tool for the same
// effect, and was refused by the same gate for the same reason. *"The task was therefore
// unrunnable end to end."* Neither refusal told it that every path was closed, so it burned its
// turns finding that out one call at a time.
//
// The report names the cheap half of the fix itself and this file pins it: *"A short 'your grants
// cover these groups: …' line in the refusal would have turned the discovery loop into a single
// call."*
//
// §1 the fact — which groups does this agent hold, read from its own grant record
// §2 the sentence — three shapes, because three situations need different advice
// §3 THE WIRE — the real row-17 refusal, on the report's own scenario
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t90-held-groups');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { gatesForCall } from '../../tools/gates.js';
import { evaluateGate } from '../../tools/gate-eval.js';
import { forgetAccessGrants } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { heldGroupLabels, heldGroupsClause, HELD_GROUPS_NAMED_MAX } from '../../tools/held-groups.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
import type { AccessGrants } from '@dojo/shared';

const db = (): Database.Database => mockDb.current!;

function agent(id: string, classification: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

const ctx = (agentId: string, name: string, args: Record<string, unknown> = {}) => ({
  agentId, name, args, resolveRef: () => null,
});
const row17 = (name: string, args: Record<string, unknown> = {}) =>
  gatesForCall(name, args).find((g) => g.row === '17');

async function refusalFor(agentId: string, tool: string): Promise<string> {
  const out = await evaluateGate(row17(tool)!, ctx(agentId, tool));
  expect(out.verdict.allowed, `${tool} must be refused for this fixture`).toBe(false);
  return out.verdict.allowed === false ? out.verdict.blockedMessage : '';
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — THE FACT
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 which groups does this agent actually hold', () => {
  it('reads the agent\'s own grant record, in declaration order', () => {
    // Deliberately out of declaration order in the grant to prove the ORDER comes from the
    // catalogue and not from however the grant happened to be written.
    agent('sub', 'ronin', (g) => { g.tools.categories = ['Managing Other Agents', 'Meta']; });
    const held = heldGroupLabels('sub');
    expect(held).not.toBe('*');
    const declarationOrder = TOOL_CATEGORIES.map((c) => c.label)
      .filter((l) => l === 'Meta' || l === 'Managing Other Agents');
    expect(held).toEqual(declarationOrder);
  });

  it('`*` passes through as itself rather than expanding to every label', () => {
    agent('everything', 'ronin', (g) => { g.tools.categories = '*'; });
    expect(heldGroupLabels('everything'), 'thirty-eight labels in a tool result is not an answer')
      .toBe('*');
  });

  it('an agent granted no groups reads as none, not as everything', () => {
    agent('nothing', 'ronin', (g) => { g.tools.categories = []; });
    expect(heldGroupLabels('nothing')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — THE SENTENCE
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 the sentence tells the agent what to do next', () => {
  it('names the groups it holds, and says to ask by name rather than guess again', () => {
    agent('sub', 'ronin', (g) => { g.tools.categories = ['Meta', 'Managing Other Agents']; });
    const clause = heldGroupsClause('sub');
    expect(clause).toContain('grants cover');
    expect(clause).toContain('Meta');
    expect(clause).toContain('Managing Other Agents');
    expect(clause, 'the whole point is to stop the next blind retry').toContain('ask for the group');
  });

  it('⚠ NO GROUPS is the case report #4 hit, and it says so out loud', () => {
    agent('nothing', 'ronin', (g) => { g.tools.categories = []; });
    const clause = heldGroupsClause('nothing');
    expect(clause).toContain('NO tool groups');
    expect(clause, 'because retrying another tool is exactly what the reporting agent did')
      .toMatch(/cannot work|will not help/);
  });

  it('an all-groups agent is told the refusal is a deny rule, not a missing grant', () => {
    agent('everything', 'ronin', (g) => { g.tools.categories = '*'; });
    const clause = heldGroupsClause('everything');
    expect(clause).toContain('every tool group');
    expect(clause).not.toContain('grants cover');
  });

  it('caps the list so a long grant cannot push the useful half out of the window', () => {
    const many = TOOL_CATEGORIES.map((c) => c.label).slice(0, HELD_GROUPS_NAMED_MAX + 3);
    expect(many.length, 'the catalogue must be big enough to test the cap')
      .toBe(HELD_GROUPS_NAMED_MAX + 3);
    agent('broad', 'ronin', (g) => { g.tools.categories = many; });
    const clause = heldGroupsClause('broad');
    expect(clause).toContain('(+3 more)');
    expect(clause).toContain(many[0]);
    expect(clause, 'past the cap the labels are counted, not printed')
      .not.toContain(many[HELD_GROUPS_NAMED_MAX + 2]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — THE WIRE: the real refusal, on the report's own scenario
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 the row-17 refusal carries it', () => {
  beforeEach(() => {
    // The report's sub-agent: real grants, just not the one its assignment needed. It holds
    // Meta and agent-management; its job was to write a file.
    agent('file-less', 'ronin', (g) => {
      g.channels.master = true;
      g.tools.categories = ['Meta', 'Managing Other Agents'];
    });
  });

  it('⚠ THE REPORT: the FIRST refusal already says every path is closed', async () => {
    const message = await refusalFor('file-less', 'file_write');

    // What it already said, unchanged — the group and who can grant it.
    expect(message).toContain('file_write');
    expect(message).toMatch(/not performed/);
    expect(message).toMatch(/primary agent/);

    // What t90 adds: the agent can now see that neither file_write NOR the shell tool it tried
    // next is reachable, from this one message.
    expect(message, 'the discovery loop ends here').toContain('grants cover');
    expect(message).toContain('Meta');
    expect(message).toContain('Managing Other Agents');
    expect(message).toContain('ask for the group');
  });

  it('and the second tool the reporting agent reached for says the same thing', async () => {
    // Two tools, one cause. Before t90 these two messages were indistinguishable and neither
    // carried the fact that made them identical.
    const shell = await refusalFor('file-less', 'shell');
    expect(shell).toContain('grants cover');
    expect(shell).toContain('Meta');
  });

  it('a GRANTED call is untouched — the sentence rides refusals only', async () => {
    agent('granted', 'ronin', (g) => { g.tools.categories = '*'; });
    const out = await evaluateGate(row17('file_write')!, ctx('granted', 'file_write'));
    expect(out.verdict.allowed, 'control: this agent holds the group').toBe(true);
  });
});
