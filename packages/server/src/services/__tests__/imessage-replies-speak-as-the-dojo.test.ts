// P9 (OR-ENGINE-LABELLED): the Dojo's replies to text commands and approvals are plainly the Dojo speaking (start
// "Dojo:", never "I"), and the agent is told the exact text and recipient on its next turn.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-voice-commands', 'dojo.db'),
  };
});

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

vi.mock('../../agent/spawner.js', () => ({
  terminateAgent: vi.fn(),
}));

vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'p1',
  getPrimaryAgentName: () => 'Prime',
}));

vi.mock('../imessage-bridge.js', () => ({
  getSafeSenders: () => [{ address: '+15550001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }],
  findSafeSenderByAddress: (records: Array<{ address: string }>, q: string) =>
    records.find((r) => r.address === q) ?? null,
}));

const noticeMock = vi.hoisted(() => vi.fn());
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: noticeMock }));

import { runMigrations } from '../../db/migrations.js';
import { handleIMCommand } from '../imessage-commands.js';

const OWNER = '+15550001';
beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status, created_at, updated_at) VALUES ('p1', 'Prime', 'paused', datetime('now'), datetime('now'))`).run();
  noticeMock.mockClear();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('replies to text commands are labelled as the Dojo and the agent is told', () => {
  it('an approval with no match is the Dojo speaking, never "I"', async () => {
    mockDb.current!.prepare(`INSERT INTO healer_proposals (id, status, surface, category, severity, title, description, proposed_fix, created_at) VALUES ('abc123ff', 'pending', 'imessage', 'x', 'low', 't', 'd', 'f', datetime('now'))`).run();
    const reply = await handleIMCommand('yes deadbeef', OWNER);
    expect(reply).toMatch(/^Dojo: /);
    expect(reply).not.toMatch(/\bI\b/);
  });

  it('the status report is labelled too', async () => {
    const reply = await handleIMCommand('status', OWNER);
    expect(reply).toMatch(/^Dojo: /);
  });

  it('text that is not a command is not answered and nobody is told', async () => {
    expect(await handleIMCommand('hello there', OWNER)).toBeNull();
    expect(noticeMock).not.toHaveBeenCalled();
  });
});
