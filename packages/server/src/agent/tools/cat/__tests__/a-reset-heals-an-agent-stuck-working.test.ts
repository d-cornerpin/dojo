// A session reset has ONE function now: an agent wedged at 'working' with no live run
// heals to idle, and the reset agent's queued self-wake is dropped. The tool drives that
// same function, so these clauses run the real handler against a real in-memory DB.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-reset-heals-stuck-working', 'dojo.db'),
  };
});

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../vault/archive.js', () => ({ archiveAgentConversation: vi.fn(() => 'archive-1') }));
vi.mock('../../../session-reset.js', () => ({ buildSessionResetMessage: vi.fn(() => '[System: reoriented]') }));
vi.mock('../../../v2/counterparty.js', () => ({ rehomeUnclaimedEngineEvents: vi.fn() }));
vi.mock('../../../../memory/message-store.js', () => ({ insertMessageIfAbsent: vi.fn(() => null) }));
vi.mock('../../../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../../../db/migrations.js';
import { sessionHandlers } from '../session.js';
import { activeRuns, pendingWakeups } from '../../../shared-state.js';
import { drainRecoveryNotices } from '../../../../healer/injury-recovery.js';

const HEALER = 'healer';
const TARGET = 'stuck-agent';

/** Drives the REAL `reset_session` handler, the cast idiom every cat/* handler test uses. */
async function callReset(callerId: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const h = sessionHandlers['reset_session'];
  return h({ agentId: callerId, args } as unknown as Parameters<typeof h>[0]);
}

function statusOf(id: string): string {
  const row = mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string };
  return row.status;
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    "INSERT INTO agents (id, name, status) VALUES ('stuck-agent', 'Stuck', 'working'), ('healer', 'Healer', 'idle')",
  ).run();
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'healer')").run();
});

afterEach(async () => {
  activeRuns.delete(TARGET);
  pendingWakeups.delete(TARGET);
  await drainRecoveryNotices();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a reset through the tool runs the one reset function', () => {
  it('a reset of an agent stuck working with no live run sets it idle', async () => {
    const result = await callReset(HEALER, { agent_id: TARGET });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Agent status restored to idle.');
    expect(statusOf(TARGET)).toBe('idle');
  });

  it('a reset of an agent in a live turn is refused and changes nothing', async () => {
    activeRuns.add(TARGET);
    const result = await callReset(HEALER, { agent_id: TARGET });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('in the middle of a live turn');
    expect(statusOf(TARGET)).toBe('working');
    const row = mockDb.current!.prepare("SELECT session_started_at FROM agents WHERE id = 'stuck-agent'").get() as { session_started_at: string | null };
    expect(row.session_started_at).toBeNull();
  });

  it('a reset drops the reset agent\'s queued self-wake', async () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = 'stuck-agent'").run();
    pendingWakeups.add(TARGET);
    const result = await callReset(HEALER, { agent_id: TARGET });
    expect(result.isError).toBe(false);
    expect(pendingWakeups.has(TARGET)).toBe(false);
  });
});
