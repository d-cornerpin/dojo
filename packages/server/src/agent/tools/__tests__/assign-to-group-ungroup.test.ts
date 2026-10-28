// The `assign_to_group` description tells the model: "Pass null as group_id to
// remove the agent from any group and leave it ungrouped." That call must reach
// `assignAgentToGroup(id, null)` — instead it died twice: once at the schema
// boundary (a `required` field received null) and once in `resolveGroupRef`
// (any falsy value refused). The handler now judges `group_id` itself, and
// every OTHER refusal for it keeps byte-for-byte the message the generic
// boundary used, because the model reads and retries on those strings.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-assign-to-group-test', 'dojo.db'),
  };
});

// Stubbed at its own module, the way the other cat-handler suite does it, so
// this file drives one handler and not ~185 account scans.
vi.mock('../surface.js', () => ({
  getFilteredTools: () => [],
}));

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// What the real writer reads first are permanent-agent ids from config; what
// THIS suite must see is what the handler passes down — null for the ungroup
// call, the resolved id otherwise — so the writer itself is the observation.
vi.mock('../../groups.js', async (orig) => ({
  ...(await orig()),
  assignAgentToGroup: vi.fn(() => ({ ok: true })),
}));

import { validateToolArgs } from '../validate-args.js';
import { getAllToolDefinitions } from '../definitions.js';
import { agentsHandlers } from '../cat/agents.js';
import { assignAgentToGroup } from '../../groups.js';
import type { ToolDefinition } from '../types.js';

const defsByName = new Map<string, ToolDefinition>(
  getAllToolDefinitions().map((d) => [d.name, d] as const),
);
const def = (name: string): ToolDefinition => {
  const d = defsByName.get(name);
  if (!d) throw new Error(`no such tool definition: ${name}`);
  return d;
};

const AGENT_ID = 'agent-1';
const GROUP_ID = 'g-42';

async function assignToGroup(args: Record<string, unknown>) {
  const h = agentsHandlers['assign_to_group'];
  return h({
    agentId: 'caller', name: 'assign_to_group', args, callId: 'c1', toolCall: {} as never,
  } as unknown as Parameters<typeof h>[0]);
}

beforeEach(() => {
  vi.mocked(assignAgentToGroup).mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, classification TEXT,
      group_id TEXT, last_error TEXT, last_error_at TEXT, created_at TEXT,
      permissions TEXT DEFAULT '{}', tools_policy TEXT DEFAULT '{}'
    );
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
  `);
  db.prepare(
    `INSERT INTO agents (id, name, status, classification, group_id, created_at)
     VALUES (?, 'Worker', 'idle', 'sensei', ?, '2026-01-01T00:00:00Z')`
  ).run(AGENT_ID, GROUP_ID);
  db.prepare(`INSERT INTO agent_groups (id, name) VALUES (?, 'squad')`).run(GROUP_ID);
});

describe('assign_to_group — the documented null ungroup reaches the writer', () => {
  it('the boundary lets the documented null call through', () => {
    expect(validateToolArgs(def('assign_to_group'), { agent_id: 'a', group_id: null })).toBeNull();
  });

  it('a missing group_id passes the boundary, and the handler gives it the same message', async () => {
    expect(validateToolArgs(def('assign_to_group'), { agent_id: 'a' })).toBeNull();
    const r = await assignToGroup({ agent_id: AGENT_ID });
    expect(r.content).toBe('Error: `group_id` is required.');
    expect(r.isError).toBe(true);
  });

  it('null group_id ungroups through assignAgentToGroup(id, null)', async () => {
    const r = await assignToGroup({ agent_id: AGENT_ID, group_id: null });
    expect(assignAgentToGroup).toHaveBeenCalledTimes(1);
    expect(assignAgentToGroup).toHaveBeenCalledWith(AGENT_ID, null);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('removed from its group');
  });

  it('every OTHER group_id refusal keeps the boundary message byte for byte', async () => {
    expect((await assignToGroup({ agent_id: AGENT_ID, group_id: 5 })).content)
      .toBe('Error: `group_id` must be a string (got number).');
    expect((await assignToGroup({ agent_id: AGENT_ID, group_id: [] })).content)
      .toBe('Error: `group_id` must be a string (got array).');
    expect((await assignToGroup({ agent_id: AGENT_ID, group_id: '  ' })).content)
      .toBe('Error: `group_id` cannot be empty.');
  });

  it('a real group name still assigns through the writer', async () => {
    const r = await assignToGroup({ agent_id: AGENT_ID, group_id: 'squad' });
    expect(assignAgentToGroup).toHaveBeenCalledWith(AGENT_ID, GROUP_ID);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('assigned to group');
  });
});
