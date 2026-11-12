// The Healer's DELETE, DROP and ALTER against the Dojo's own database are held for the owner
// by the destructive-action approval; its routine UPDATE and INSERT repairs run directly.
// Driven through the two functions the dispatcher asks before it holds a call.

import { describe, it, expect, vi } from 'vitest';

const healerManifest = JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
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

describe("the Healer's SQL deletes wait for the owner", () => {
  it.each([
    `sqlite3 ${DB} "DELETE FROM messages WHERE agent_id = 'x'"`,
    `sqlite3 ${DB} "DROP TABLE scratch_rows"`,
    `sqlite3 ${DB} "ALTER TABLE agents ADD COLUMN extra TEXT"`,
  ])('held at the shell door: %s', (script) => {
    expect(held('shell', { script })).toBe(true);
  });

  it('held at the exec door too', () => {
    expect(held('exec', { argv: ['sqlite3', DB, 'delete from messages where id = 1'] })).toBe(true);
  });

  it.each([
    `sqlite3 ${DB} "UPDATE agents SET model_id = 'm2' WHERE id = 'x'"`,
    `sqlite3 ${DB} "INSERT INTO config (key, value) VALUES ('k', 'v')"`,
    `sqlite3 -readonly ${DB} "SELECT id FROM agents"`,
    'sqlite3 ./app.db "DELETE FROM t"',
  ])('runs directly: %s', (script) => {
    expect(isDestructiveCall('shell', { script }, 'agent-healer')).toBeNull();
  });
});
