// The Healer's raw INSERT or UPDATE of a row of one of the Dojo's own core tables is held for the owner
// by the destructive-action approval, quoted or schema-qualified or behind a WITH, whatever its words say.
// An UPDATE of another table runs directly, whatever its string literals name, and another agent is untouched.
// Driven through the two functions the dispatcher asks before it holds a call.

import { describe, it, expect, vi } from 'vitest';

const healerManifest = JSON.stringify({
  file_read: '*', file_write: '*',
  exec_allow: ['*'], exec_deny: [], network_domains: '*',
  max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (...params: unknown[]) => (/FROM agents/i.test(sql) && params[0] === 'agent-healer'
        ? { id: 'agent-healer', permissions: healerManifest, spawn_depth: 1, created_by: 'agent-primary' }
        : undefined),
      all: () => [],
    }),
    exec: () => ({}),
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
  }),
}));

vi.mock('../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../config/platform.js')>('../../config/platform.js');
  return { ...actual, isPrimaryAgent: () => false, isHealerAgent: (id: string) => id === 'agent-healer', isTrainerAgent: () => false };
});

const { isDestructiveCall, manifestPermitsDestructiveCall } = await import('../destructive-gate.js');

const DB = '~/.dojo/data/dojo.db';
const held = (tool: 'shell' | 'exec', args: Record<string, unknown>): boolean =>
  isDestructiveCall(tool, args, 'agent-healer') !== null && manifestPermitsDestructiveCall('agent-healer', tool, args);

describe("the Healer's row edits of core tables wait for the owner", () => {
  it.each([
    `sqlite3 ${DB} "UPDATE messages SET content = ''"`,
    `sqlite3 ${DB} "UPDATE agents SET status = 'terminated' WHERE id = 'x'"`,
    `sqlite3 ${DB} "INSERT INTO work (id) VALUES ('w')"`,
    `sqlite3 ${DB} "insert or ignore into config (key, value) values ('k', 'v')"`,
    `sqlite3 ${DB} 'UPDATE "agents" SET name = 1'`,
    `sqlite3 ${DB} "UPDATE main.agents SET name = 1"`,
    `sqlite3 ${DB} "WITH x AS (SELECT 1) UPDATE agents SET name = 1"`,
  ])('held: %s', (script) => {
    expect(held('shell', { script })).toBe(true);
  });

  it('held at the exec door too', () => {
    expect(held('exec', { argv: ['sqlite3', DB, "UPDATE work SET next_run_at = 1 WHERE id = 'w'"] })).toBe(true);
  });

  it.each([
    `sqlite3 ${DB} "UPDATE notes SET body = 'update agents set x = 1' WHERE id = 'a'"`,
    `sqlite3 ${DB} "INSERT INTO notes (body) VALUES ('insert into messages')"`,
    `sqlite3 -readonly ${DB} "SELECT id FROM agents"`,
  ])('runs directly: %s', (script) => {
    expect(isDestructiveCall('shell', { script }, 'agent-healer')).toBeNull();
  });

  it("another agent's same call is not held by this rule", () => {
    expect(isDestructiveCall('shell', { script: `sqlite3 ${DB} "UPDATE agents SET name = 1"` }, 'agent-main')).toBeNull();
  });
});
