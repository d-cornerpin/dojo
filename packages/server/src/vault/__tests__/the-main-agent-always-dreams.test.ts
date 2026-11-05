// ════════════════════════════════════════════════════════════════════════════════════════
// Rulings audit #14 (M20). The owner: "Dreaming is a core principal of the Dojo and I don't believe it can run
// effectively without dreaming." The per-agent "Skip in Dreamer cycle" toggle was shown, and honoured, for the main
// agent too. Now the main agent is always archived for the Dreamer (its own flag or its group's is not read), and the
// config route refuses to switch it off. Other agents keep the toggle (ephemeral test agents, by design).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPrimaryAgentId: () => 'main' }));

import { runMigrations } from '../../db/migrations.js';
import { isDreamerIgnored } from '../archive.js';
import { dreamerIgnoreRefusal } from '../../gateway/routes/agents.js';

const db = (): Database.Database => mockDb.current!;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO agent_groups (id, name, dreamer_ignore, created_by) VALUES ('g', 'Group', 1, 'owner')").run();
  db().prepare("INSERT INTO agents (id, name, status, config, dreamer_ignore, group_id) VALUES ('main', 'Main', 'idle', '{}', 1, 'g')").run();
  db().prepare("INSERT INTO agents (id, name, status, config, dreamer_ignore) VALUES ('test-agent', 'Test', 'idle', '{}', 1)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the main agent always dreams', () => {
  it('its own flag and its group\'s flag are not read: it is archived for the Dreamer', () => {
    expect(isDreamerIgnored('main')).toBe(false);
  });
  it('CONTROL: another agent with the toggle on is still skipped', () => {
    expect(isDreamerIgnored('test-agent')).toBe(true);
  });
  it('the config route refuses to switch dreaming off for the main agent, and lets it be switched on', () => {
    expect(dreamerIgnoreRefusal('main', true)).toMatch(/main agent always dreams/);
    expect(dreamerIgnoreRefusal('main', false)).toBeNull();
    expect(dreamerIgnoreRefusal('test-agent', true)).toBeNull();
  });
});
