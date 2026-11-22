// A helper that reached its timeout while idle costs nothing: the notice is kept for its creator's next turn, which
// it does not start, and no follow-up is armed, after a restart either. A helper still working wakes its creator once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const handleMessage = vi.fn(async () => 'ran');
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));

import { runMigrations } from '../../db/migrations.js';
import { fireSpawnTimeoutDecision, reArmSpawnTimeouts } from '../spawner.js';

const notices = (to: string): string[] => (mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND origin_intent LIKE 'spawn_timeout%'")
  .all(to) as Array<{ content: string }>).map((r) => r.content);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  handleMessage.mockClear();
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('agent-main', 'Main', 'idle')").run();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status, parent_agent, created_by, classification, timeout_at)
    VALUES ('agent-helper', 'Helper', 'idle', 'agent-main', 'agent-main', 'apprentice', datetime('now', '-1 minute'))`).run();
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe("an idle helper's timeout starts no turn", () => {
  it('the notice says it is idle and waits; nothing wakes the creator, now, later or after a restart', () => {
    fireSpawnTimeoutDecision('agent-helper');
    expect(notices('agent-main')).toHaveLength(1);
    expect(notices('agent-main')[0]).toContain('is idle');
    reArmSpawnTimeouts();
    vi.advanceTimersByTime(60 * 60_000);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(notices('agent-main')).toHaveLength(1);
  });

  it('a helper still working (here in error) wakes its creator once', () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'error' WHERE id = 'agent-helper'").run();
    fireSpawnTimeoutDecision('agent-helper');
    fireSpawnTimeoutDecision('agent-helper');
    expect(notices('agent-main')[0]).toContain('is still working');
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
