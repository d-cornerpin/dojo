// ════════════════════════════════════════
// P3 spawn timeout decision verb - unit tests for the REAL spawner function.
//
// applySpawnTimeoutDecision is the creator-owned decision the timeout notice
// asks for. These cover the cheap, security-relevant early-return paths without
// touching the heavy terminate/extend machinery:
//   - creator-only: a non-creator caller is refused (the user path is dashboard)
//   - unknown agent id: clean error
//   - extend with no/invalid minutes: teaching error
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  getPrimaryAgentId: () => 'primary',
}));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn() }) }));
vi.mock('../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../agent-bus.js', () => ({ sendAgentMessage: vi.fn() }));
vi.mock('../permissions.js', () => ({ getAgentPermissions: vi.fn(), checkPermission: vi.fn(() => ({ allowed: true })) }));
vi.mock('../../memory/retrieval.js', () => ({ memoryGrep: vi.fn(() => 'No results found') }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: vi.fn() }));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'idle',
      classification TEXT,
      created_by TEXT,
      parent_agent TEXT,
      task_id TEXT,
      timeout_at TEXT,
      max_runtime INTEGER,
      timeout_decision_pending INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, classification, created_by, timeout_decision_pending) VALUES ('sub', 'Sub', 'apprentice', 'creator', 1)").run();
  mockDb.current = db;
});

import { applySpawnTimeoutDecision } from '../spawner.js';

describe('applySpawnTimeoutDecision - P3 decision verb', () => {
  it('refuses a caller who did not create the sub-agent (creator-only)', async () => {
    const r = await applySpawnTimeoutDecision({ callerAgentId: 'someone-else', agentId: 'sub', action: 'extend', extendMinutes: 10 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/only the agent that created/i);
    // The decision must NOT have been applied.
    const row = mockDb.current!.prepare('SELECT timeout_decision_pending FROM agents WHERE id = ?').get('sub') as { timeout_decision_pending: number };
    expect(row.timeout_decision_pending).toBe(1);
  });

  it('errors cleanly on an unknown agent id', async () => {
    const r = await applySpawnTimeoutDecision({ callerAgentId: 'creator', agentId: 'nope', action: 'terminate' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no agent found/i);
  });

  it('extend with no positive minutes returns a teaching error', async () => {
    const r = await applySpawnTimeoutDecision({ callerAgentId: 'creator', agentId: 'sub', action: 'extend' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/extend_minutes/);
  });

  it('the creator can extend, which clears the pending flag and sets a new timeout', async () => {
    const r = await applySpawnTimeoutDecision({ callerAgentId: 'creator', agentId: 'sub', action: 'extend', extendMinutes: 20 });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/20 more minute/);
    const row = mockDb.current!.prepare('SELECT timeout_decision_pending, max_runtime, timeout_at FROM agents WHERE id = ?').get('sub') as { timeout_decision_pending: number; max_runtime: number; timeout_at: string | null };
    expect(row.timeout_decision_pending).toBe(0);
    expect(row.max_runtime).toBe(20 * 60);
    expect(row.timeout_at).toBeTruthy();
  });
});
