// ════════════════════════════════════════
// Phase 7 — onTaskComplete hook (Part X)
//
// Verifies the engine fires a structured "[System: …]" message into the
// parent agent's conversation containing original ask + completion summary,
// and that no-op cases (no parent, self-completion, missing task) don't
// crash or persist phantom messages.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const broadcastSpy = vi.fn();

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (e: unknown) => broadcastSpy(e),
}));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      parent_agent TEXT,
      group_id TEXT,
      classification TEXT,
      status TEXT DEFAULT 'idle'
    );
    CREATE TABLE legacy_tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      original_description TEXT,
      completion_summary TEXT,
      status TEXT,
      assigned_to TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // The primary agent (parent) + apprentice with task assignment.
  db.prepare("INSERT INTO agents (id, name) VALUES ('primary', 'Primary')").run();
  db.prepare("INSERT INTO agents (id, name, parent_agent) VALUES ('apprentice-1', 'Apprentice One', 'primary')").run();
  // Apprentice with no parent (top-level).
  db.prepare("INSERT INTO agents (id, name) VALUES ('orphan', 'Orphan')").run();
  db.prepare(
    `INSERT INTO legacy_tasks (id, title, description, original_description, completion_summary, status, assigned_to)
     VALUES ('task-1', 'Research vendor X', 'Look into vendor X pricing', 'Look into vendor X pricing', 'Found three pricing tiers, B is best', 'complete', 'apprentice-1')`,
  ).run();
  db.prepare(
    `INSERT INTO legacy_tasks (id, title, description, original_description, completion_summary, status, assigned_to)
     VALUES ('task-2', 'Solo work', 'no parent', 'no parent', 'done', 'complete', 'orphan')`,
  ).run();
  mockDb.current = db;
  broadcastSpy.mockClear();
});

import { onTaskComplete } from '../hooks/task-complete.js';

describe('onTaskComplete hook — no-op contract (comms-audit 2026-07-01, rank 3)', () => {
  // The hook used to inject a full "[System: <agent> completed task…] Original ask:…
  // Completion summary:… Review and decide…" report into the parent's conversation +
  // dashboard chat on every task-linked completion. That was a firehose duplicating the
  // brief AGENT NOTICE spawner.completeAgent now writes, and it flooded the owner's
  // dashboard chat. It is now a documented no-op: it must NOT write a message row and
  // must NOT broadcast. The parent still learns of the completion via the brief AGENT
  // NOTICE; the original ask + summary live on the tracker task row and the agent bus.
  it('does NOT inject any message into the parent on a task-linked completion', async () => {
    await onTaskComplete('task-1', 'apprentice-1');
    const msgs = mockDb.current!.prepare('SELECT * FROM messages').all();
    expect(msgs).toHaveLength(0);
  });

  it('does NOT broadcast a chat:message to the parent', async () => {
    await onTaskComplete('task-1', 'apprentice-1');
    const calls = broadcastSpy.mock.calls.map((c) => c[0] as { type: string; agentId: string });
    const msgEvent = calls.find((e) => e.type === 'chat:message' && e.agentId === 'primary');
    expect(msgEvent).toBeUndefined();
  });

  it('no-ops for every input shape (null task, orphan, self-completion, long fields)', async () => {
    await onTaskComplete(null, 'apprentice-1');
    await onTaskComplete('task-2', 'orphan');
    mockDb.current!.prepare("UPDATE agents SET parent_agent = 'apprentice-1' WHERE id = 'apprentice-1'").run();
    await onTaskComplete('task-1', 'apprentice-1');
    const long = 'X'.repeat(800);
    mockDb.current!
      .prepare(
        `INSERT INTO legacy_tasks (id, title, description, original_description, completion_summary, status, assigned_to)
         VALUES ('task-long', 'Big task', 'short', ?, ?, 'complete', 'apprentice-1')`,
      )
      .run(long, long);
    await onTaskComplete('task-long', 'apprentice-1');
    const msgs = mockDb.current!.prepare('SELECT * FROM messages').all();
    expect(msgs).toHaveLength(0);
    expect(broadcastSpy.mock.calls.length).toBe(0);
  });
});
