import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-kill-all', 'dojo.db'),
  };
});

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const spawner = vi.hoisted(() => ({ terminateAgent: vi.fn() }));
vi.mock('../../agent/spawner.js', () => spawner);

vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'p1',
  getPrimaryAgentName: () => 'Prime',
}));

vi.mock('../imessage-bridge.js', () => ({
  getSafeSenders: () => [{ address: '+15550001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }],
  findSafeSenderByAddress: (records: Array<{ address: string }>, q: string) =>
    records.find((r) => r.address === q) ?? null,
}));

import { runMigrations } from '../../db/migrations.js';
import { handleIMCommand } from '../imessage-commands.js';

const seed = (id: string, classification: string): void => {
  mockDb.current!.prepare(`
    INSERT INTO agents (id, name, status, classification, created_at, updated_at)
    VALUES (?, ?, 'idle', ?, datetime('now'), datetime('now'))
  `).run(id, `Agent ${id}`, classification);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  spawner.terminateAgent.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the owner\'s "kill all" text', () => {
  it('ends the sub-agents and leaves the main agent and every sensei running', async () => {
    seed('p1', 'sensei');
    seed('h1', 'sensei');
    seed('w1', 'apprentice');
    seed('r1', 'ronin');
    await handleIMCommand('kill all', '+15550001');
    const ended = spawner.terminateAgent.mock.calls.map((c) => c[0]).sort();
    expect(ended).toEqual(['r1', 'w1']);
  });
});
