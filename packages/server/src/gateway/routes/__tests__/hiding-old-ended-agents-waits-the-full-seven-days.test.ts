// HIDING OLD ENDED AGENTS WAITS THE FULL SEVEN DAYS.
//
// The /archive door compared an ISO cutoff ('2026-11-10T12:00:00.000Z') against the
// database's own text datetime('now') writes ('2026-11-10 12:30:00'). A space sorts
// before 'T', so an agent ended less than seven days ago could be hidden up to a day
// early. The cutoff must be in the database's own text shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-archive-seven-days', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => e,
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

const endedAt = (id: string, updatedAt: string) => mockDb.current!.prepare(
  `INSERT INTO agents (id, name, status, classification, agent_type, updated_at) VALUES (?, ?, 'terminated', 'apprentice', 'standard', ?)`,
).run(id, `Agent ${id}`, updatedAt);
const typeOf = (id: string) => (mockDb.current!.prepare('SELECT agent_type FROM agents WHERE id = ?').get(id) as { agent_type: string }).agent_type;

describe('hiding old ended agents waits the full seven days', () => {
  it('an agent ended six days and 23 hours ago stays visible', async () => {
    endedAt('recent', '2026-11-10 12:30:00');
    const res = await agentsRouter.request('/archive', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(typeOf('recent')).toBe('standard');
  });

  it('an agent ended more than seven days ago is hidden', async () => {
    endedAt('old', '2026-11-10 11:00:00');
    await agentsRouter.request('/archive', { method: 'POST' });
    expect(typeOf('old')).toBe('archived');
  });
});
