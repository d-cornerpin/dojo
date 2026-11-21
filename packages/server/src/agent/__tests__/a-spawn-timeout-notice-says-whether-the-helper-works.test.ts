// The notice that a helper reached its timeout tells its creator whether the helper is working or idle.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { fireSpawnTimeoutDecision } from '../spawner.js';

const notice = (): string => (mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = 'agent-main' AND origin_intent = 'spawn_timeout_decision'").get() as { content: string }).content;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('agent-main', 'Main', 'idle')").run();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, parent_agent, created_by, classification) VALUES ('agent-helper', 'Helper', ?, 'agent-main', 'agent-main', 'apprentice')").run('idle');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a spawn timeout notice says whether the helper works', () => {
  it('an idle helper is called idle, not still running', () => {
    fireSpawnTimeoutDecision('agent-helper');
    expect(notice()).toContain('is idle');
    expect(notice()).not.toMatch(/still (running|working)/);
  });

  it('a helper in error is still working', () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'error' WHERE id = 'agent-helper'").run();
    fireSpawnTimeoutDecision('agent-helper');
    expect(notice()).toContain('is still working');
  });
});
