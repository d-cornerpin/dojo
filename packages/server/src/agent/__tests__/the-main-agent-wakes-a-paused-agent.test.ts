// The wake-block for a paused agent lifts for the main agent, as it already does for the Healer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

const handleMessageSpy = vi.fn(() => Promise.resolve());
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: handleMessageSpy }),
}));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { clearPlatformConfigCache } from '../../config/platform.js';

beforeEach(() => {
  handleMessageSpy.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('agent-main', 'main', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('agent-target', 'target', 'm', 'paused', '{}', 'sensei')").run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('agent-helper', 'helper', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'agent-main')").run();
  clearPlatformConfigCache();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the main agent wakes a paused agent', () => {
  it("the main agent's question wakes a paused agent", async () => {
    await deliverA2AMessage({ intent: 'QUESTION', requiresResponse: true, payload: 'Are you there?', toAgent: 'agent-target', fromAgent: 'agent-main', threadId: '' } as never);
    expect(handleMessageSpy).toHaveBeenCalledWith('agent-target', expect.anything());
  });

  it("a helper's question is stored but does not wake it", async () => {
    await deliverA2AMessage({ intent: 'QUESTION', requiresResponse: true, payload: 'Are you there?', toAgent: 'agent-target', fromAgent: 'agent-helper', threadId: '' } as never);
    expect(handleMessageSpy).not.toHaveBeenCalledWith('agent-target', expect.anything());
  });
});
