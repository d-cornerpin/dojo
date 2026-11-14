// A held-call approval card filed for the main agent has no consumer: the one-time start sweep closes it,
// pending or approved, so the Healer never re-runs it. Other agents' cards stay as they are.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  getPrimaryAgentId: () => 'main-agent',
}));

const { runMigrations } = await import('../../db/migrations.js');
const { runStartupRecoverySweep } = await import('../runtime.js');

const card = (id: string, agentId: string, status: string): void => {
  mockDb.current!.prepare(`
    INSERT INTO healer_proposals (id, category, severity, title, description, proposed_fix, status, agent_id, approval_token, created_at)
    VALUES (?, 'destructive_action', 'warning', 'A held call', 'd', 'Run this action: x', ?, ?, 'token', datetime('now'))
  `).run(id, status, agentId);
};
const statusOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT status FROM healer_proposals WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});

describe('a main-agent approval card', () => {
  it('is closed at start, pending or approved; another agent\'s card stays pending', () => {
    card('pending-card', 'main-agent', 'pending');
    card('approved-card', 'main-agent', 'approved');
    card('other-card', 'helper-agent', 'pending');
    runStartupRecoverySweep();
    expect(statusOf('pending-card')).toBe('auto_resolved');
    expect(statusOf('approved-card')).toBe('auto_resolved');
    expect(statusOf('other-card')).toBe('pending');
  });
});
