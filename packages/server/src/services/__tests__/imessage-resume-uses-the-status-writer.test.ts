// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP s07 F6 — "resume" goes through the one status writer.
//
// The owner's "resume" command used to run a raw `UPDATE agents SET status = 'idle'`, which
// skips what writeAgentStatus does (agent/agent-status.ts): clearing a park tag
// ([budget_stop] / [no_model_fits]) from last_error, and closing the "agent has stopped"
// owner card (agentStatusMoved) so an open dashboard stops showing it. The raw UPDATE also had
// no condition on the current status, so "resume" sent while the primary agent is working
// marked it idle in the middle of a turn. This file drives handleIMCommand and pins the
// outcomes: paused/error resume, working/idle do not.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-resume-status-writer', 'dojo.db'),
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

// The REAL writeAgentStatus runs (agent-status.js is NOT mocked) and calls the owner-card
// module; we mock only that module so the call can be asserted.
const agentStatusMovedMock = vi.hoisted(() => ({ agentStatusMoved: vi.fn() }));
vi.mock('../../agent/agent-owner-cards.js', () => agentStatusMovedMock);

vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../imessage-bridge.js', () => ({
  getSafeSenders: () => [{ address: '+15550001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }],
  findSafeSenderByAddress: (records: Array<{ address: string }>, q: string) =>
    records.find((r) => r.address === q) ?? null,
}));

import { runMigrations } from '../../db/migrations.js';
import { handleIMCommand } from '../imessage-commands.js';

const db = (): Database.Database => mockDb.current!;

const seedAgent = (status: string, lastError: string | null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, status, last_error, created_at, updated_at)
    VALUES ('p1', 'Prime', ?, ?, datetime('now'), datetime('now'))
  `).run(status, lastError);
};

const row = (): { status: string; last_error: string | null } =>
  db().prepare('SELECT status, last_error FROM agents WHERE id = ?').get('p1') as {
    status: string;
    last_error: string | null;
  };

const OWNER = '+15550001';

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  agentStatusMovedMock.agentStatusMoved.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('handleIMCommand("resume") routes through the one status writer', () => {
  it('resumes a paused agent: clears the park tag and closes the owner card', async () => {
    seedAgent('paused', '[budget_stop] over the line');
    expect(await handleIMCommand('resume', OWNER)).toBe('Dojo: Agent resumed.');
    expect(row()).toEqual({ status: 'idle', last_error: null });
    expect(agentStatusMovedMock.agentStatusMoved).toHaveBeenCalledWith('p1', 'idle');
  });

  it('resumes an errored agent', async () => {
    seedAgent('error', 'provider 429');
    expect(await handleIMCommand('resume', OWNER)).toBe('Dojo: Agent resumed.');
    expect(row().status).toBe('idle');
  });

  it('leaves a working agent alone: "resume" does not mark it idle mid-turn', async () => {
    seedAgent('working', null);
    expect(await handleIMCommand('resume', OWNER)).toBe('Dojo: Agent is not paused.');
    expect(row().status).toBe('working');
  });

  it('leaves an idle agent alone', async () => {
    seedAgent('idle', null);
    expect(await handleIMCommand('resume', OWNER)).toBe('Dojo: Agent is not paused.');
    expect(row().status).toBe('idle');
  });

  it('control: "pause" still pauses the primary agent', async () => {
    seedAgent('idle', null);
    expect(await handleIMCommand('pause', OWNER)).toBe('Dojo: Agent paused. Send "resume" to continue.');
    expect(row().status).toBe('paused');
  });
});
