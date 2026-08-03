// ════════════════════════════════════════
// Phase 7 — squad_share / squad_recall integration test
//
// Exercises the actual executeTool dispatch path (not the namespaces helper
// in isolation). Verifies:
//   - Two squad members can hand off via squad_share → squad_recall
//   - Agents in different squads can't see each other's writes
//   - Agents with no squad get a clear error on either tool
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

let embedCounter = 0;
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => {
    embedCounter++;
    const v = new Float32Array(8);
    for (let i = 0; i < 8; i++) v[i] = Math.sin(embedCounter * (i + 1));
    return v;
  }),
  queueEmbedding: vi.fn(),
}));

// Stub anything executeTool's deep imports might hit that the test doesn't care
// about — auditLog needs the audit_log table; permissions need agent_permissions.
vi.mock('../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  isPMAgent: () => false,
  isDreamerAgent: () => false,
  getDreamerAgentId: () => 'dreamer',
  getPrimaryAgentId: () => 'primary',
}));

vi.mock('../runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn() }),
}));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      group_id TEXT,
      classification TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}',
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'idle',
      permissions TEXT,
      spawn_depth INTEGER DEFAULT 0,
      created_by TEXT,
      task_id TEXT
    );
    CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 1.0,
      is_permanent INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0,
      is_obsolete INTEGER DEFAULT 0,
      superseded_by TEXT,
      retrieval_count INTEGER DEFAULT 0,
      last_retrieved_at TEXT,
      source_conversation_id TEXT,
      source TEXT DEFAULT 'extraction',
      citation TEXT,
      embedding BLOB,
      namespace TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      action_type TEXT,
      tool_name TEXT,
      result TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Two members of squad 'alpha', one member of squad 'bravo', one soloist.
  db.prepare("INSERT INTO agents (id, name, group_id, classification) VALUES ('alpha-1', 'AlphaOne', 'alpha', 'apprentice')").run();
  db.prepare("INSERT INTO agents (id, name, group_id, classification) VALUES ('alpha-2', 'AlphaTwo', 'alpha', 'apprentice')").run();
  db.prepare("INSERT INTO agents (id, name, group_id, classification) VALUES ('bravo-1', 'BravoOne', 'bravo', 'apprentice')").run();
  db.prepare("INSERT INTO agents (id, name, group_id, classification) VALUES ('solo', 'Solo', NULL, 'apprentice')").run();
  mockDb.current = db;
  embedCounter = 0;
});

import { executeTool, toolResultOf } from '../tools/index.js';

describe('Phase 7 — squad_share / squad_recall integration', () => {
  it('squad members hand off: alpha-1 shares, alpha-2 recalls', async () => {
    const shareResult = toolResultOf(await executeTool('alpha-1', {
      id: 'tc-1',
      name: 'squad_share',
      arguments: {
        content: 'Customer prefers calls before 5pm PT.',
        tags: ['customer', 'comms'],
      },
    }));
    expect(shareResult.isError).toBeFalsy();
    expect(shareResult.content).toMatch(/squad:alpha/);

    const recallResult = toolResultOf(await executeTool('alpha-2', {
      id: 'tc-2',
      name: 'squad_recall',
      arguments: { query: 'customer' },
    }));
    expect(recallResult.isError).toBeFalsy();
    expect(recallResult.content).toContain('AlphaOne');
    expect(recallResult.content).toContain('5pm');
    expect(recallResult.content).toMatch(/squad:alpha/);
  });

  it('squad isolation: bravo-1 cannot recall alpha\'s shares', async () => {
    toolResultOf(await executeTool('alpha-1', {
      id: 'tc-1',
      name: 'squad_share',
      arguments: { content: 'alpha-only secret handshake' },
    }));
    const recallResult = toolResultOf(await executeTool('bravo-1', {
      id: 'tc-2',
      name: 'squad_recall',
      arguments: { query: 'handshake' },
    }));
    expect(recallResult.isError).toBeFalsy();
    expect(recallResult.content).toMatch(/no squad memory entries match/i);
  });

  it('soloist gets a clear error on squad_share', async () => {
    const result = toolResultOf(await executeTool('solo', {
      id: 'tc-1',
      name: 'squad_share',
      arguments: { content: 'should not save' },
    }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a member of any squad/i);
  });

  it('soloist gets a clear error on squad_recall', async () => {
    const result = toolResultOf(await executeTool('solo', {
      id: 'tc-2',
      name: 'squad_recall',
      arguments: { query: 'anything' },
    }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a member of any squad/i);
  });

  it('squad_share rejects empty content', async () => {
    const result = toolResultOf(await executeTool('alpha-1', {
      id: 'tc-1',
      name: 'squad_share',
      arguments: { content: '   ' },
    }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/content is required/i);
  });
});
