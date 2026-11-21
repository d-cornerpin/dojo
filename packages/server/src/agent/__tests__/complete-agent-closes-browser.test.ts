// ════════════════════════════════════════
// Complete-agent closes browser (terminate parity)
//
// A non-persistent sub-agent that finished normally (complete_task) is
// terminated by completeAgent — same terminal status as terminateAgent — but
// must ALSO close its headless browser session the way terminateAgent does.
// Otherwise every sub-agent that used web_browse leaves a Chromium process (and
// its sessions map entry) alive until the server restarts. A PERSISTENT agent
// stays idle and keeps its session, so it must NOT be closed.
//
// Runs the REAL completeAgent (spawner.js is not mocked) with the same
// db/gateway/platform/runtime mocks spawn-contract uses, plus a browser.js mock
// so the dynamic import's closeSession is observable. The DB schema is extended
// with messages/audit_log.cost because completeAgent reads those unwrapped.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const closeSessionSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: () => false,
  isDreamerAgent: () => false,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getTrainerAgentId: () => 'trainer',
  getHealerAgentId: () => 'healer',
  getDreamerAgentId: () => 'dreamer',
  isSystemServiceAgent: () => false,
  getSystemServiceAgentIds: () => [],
}));

vi.mock('../runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn() }),
}));

// Observable browser.js: completeAgent's dynamic import resolves to this mock.
vi.mock('../browser.js', () => ({ closeSession: closeSessionSpy }));

beforeEach(() => {
  closeSessionSpy.mockClear();
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      model_id TEXT,
      permissions TEXT DEFAULT '{}',
      spawn_depth INTEGER DEFAULT 0,
      created_by TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}',
      group_id TEXT,
      classification TEXT,
      task_id TEXT,
      parent_agent TEXT,
      status TEXT DEFAULT 'idle',
      config TEXT NOT NULL DEFAULT '{}',
      max_runtime INTEGER,
      timeout_at TEXT,
      timeout_decision_pending INTEGER DEFAULT 0,
      last_error TEXT,
      last_error_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      role TEXT,
      content TEXT,
      token_count INTEGER DEFAULT 0,
      model_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      action_type TEXT,
      target TEXT,
      result TEXT,
      detail TEXT,
      cost REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE work (
      id TEXT PRIMARY KEY,
      title TEXT,
      kind TEXT,
      root_kind TEXT,
      agent_id TEXT,
      state TEXT,
      completion_summary TEXT,
      parent_id TEXT,
      source_message_id TEXT,
      is_paused INTEGER DEFAULT 0
    );
  `);
  // One non-persistent (no parent, so no notices are sent) and one persistent.
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status, config) VALUES ('np', 'NonPersistent', 'primary', 'apprentice', 'idle', '{}')").run();
  db.prepare("INSERT INTO agents (id, name, created_by, classification, status, config) VALUES ('persist', 'Persistent', 'primary', 'apprentice', 'idle', '{\"persist\":true}')").run();
  mockDb.current = db;
});

import { completeAgent } from '../spawner.js';

describe('completeAgent closes the browser for a non-persistent agent', () => {
  it('closes the browser session once for a terminating non-persistent agent', async () => {
    await completeAgent('np', 'complete', 'done');
    // Let the fire-and-forget dynamic import settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(closeSessionSpy).toHaveBeenCalledTimes(1);
    expect(closeSessionSpy).toHaveBeenCalledWith('np');
  });

  it('does not close the browser for a persistent agent that stays idle', async () => {
    await completeAgent('persist', 'complete', 'done');
    expect(closeSessionSpy).not.toHaveBeenCalledWith('persist');
  });
});
