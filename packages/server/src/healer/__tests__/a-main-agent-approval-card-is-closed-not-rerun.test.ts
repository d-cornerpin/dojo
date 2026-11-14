// A held-call approval card filed for the main agent has no consumer: the healing cycle closes it,
// pending or approved, and the Healer is never woken to re-run it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../diagnostic.js', () => ({
  compileDiagnosticReport: () => ({ id: 'd1', items: [], reportText: '', criticalCount: 0, warningCount: 0, infoCount: 0 }),
}));
vi.mock('../auto-fix.js', () => ({ runAutoFixes: () => ({ fixCount: 0 }) }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
const runtime = vi.hoisted(() => ({ handleMessage: vi.fn(async () => undefined) }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => runtime }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  getPrimaryAgentId: () => 'main-agent',
  getHealerAgentId: () => 'healer-agent',
}));

const { runMigrations } = await import('../../db/migrations.js');
const { runHealingCycle } = await import('../healer-agent.js');

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
  runtime.handleMessage.mockClear();
});

describe('a main-agent approval card', () => {
  it('is closed by the healing cycle, and the Healer is not woken to re-run it', async () => {
    card('pending-card', 'main-agent', 'pending');
    card('approved-card', 'main-agent', 'approved');
    const { llmTriggered } = await runHealingCycle();
    expect(statusOf('pending-card')).toBe('auto_resolved');
    expect(statusOf('approved-card')).toBe('auto_resolved');
    expect(llmTriggered).toBe(false);
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it('a Healer card stays as it is', async () => {
    card('healer-card', 'healer-agent', 'pending');
    await runHealingCycle();
    expect(statusOf('healer-card')).toBe('pending');
  });
});
