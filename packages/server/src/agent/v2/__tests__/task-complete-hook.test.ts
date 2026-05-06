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
    CREATE TABLE tasks (
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
  // Kevin (parent) + apprentice with task assignment.
  db.prepare("INSERT INTO agents (id, name) VALUES ('kevin', 'Kevin')").run();
  db.prepare("INSERT INTO agents (id, name, parent_agent) VALUES ('apprentice-1', 'Apprentice One', 'kevin')").run();
  // Apprentice with no parent (top-level).
  db.prepare("INSERT INTO agents (id, name) VALUES ('orphan', 'Orphan')").run();
  db.prepare(
    `INSERT INTO tasks (id, title, description, original_description, completion_summary, status, assigned_to)
     VALUES ('task-1', 'Research vendor X', 'Look into vendor X pricing', 'Look into vendor X pricing', 'Found three pricing tiers, B is best', 'complete', 'apprentice-1')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, description, original_description, completion_summary, status, assigned_to)
     VALUES ('task-2', 'Solo work', 'no parent', 'no parent', 'done', 'complete', 'orphan')`,
  ).run();
  mockDb.current = db;
  broadcastSpy.mockClear();
});

import { onTaskComplete } from '../hooks/task-complete.js';

describe('Phase 7 — onTaskComplete hook', () => {
  it('persists structured note to the parent on sub-agent completion', async () => {
    await onTaskComplete('task-1', 'apprentice-1');

    const msgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system'")
      .all() as Array<{ content: string }>;
    expect(msgs).toHaveLength(1);
    const note = msgs[0].content;
    expect(note).toContain('Apprentice One');
    expect(note).toContain('Research vendor X');
    expect(note).toContain('Original ask: Look into vendor X pricing');
    expect(note).toContain('Completion summary: Found three pricing tiers, B is best');
    expect(note).toContain('Review and decide whether to accept, redirect, or reassign.');
  });

  it('broadcasts chat:message to the parent agent', async () => {
    await onTaskComplete('task-1', 'apprentice-1');
    const calls = broadcastSpy.mock.calls.map((c) => c[0] as { type: string; agentId: string });
    const msgEvent = calls.find((e) => e.type === 'chat:message' && e.agentId === 'kevin');
    expect(msgEvent).toBeDefined();
  });

  it('no-ops when task_id is null', async () => {
    await onTaskComplete(null, 'apprentice-1');
    const msgs = mockDb.current!.prepare('SELECT * FROM messages').all();
    expect(msgs).toHaveLength(0);
  });

  it('no-ops when completing agent has no parent', async () => {
    await onTaskComplete('task-2', 'orphan');
    const msgs = mockDb.current!.prepare('SELECT * FROM messages').all();
    expect(msgs).toHaveLength(0);
  });

  it('no-ops on self-completion (parent_agent === completingAgentId)', async () => {
    // Set up a self-referential edge case.
    mockDb.current!.prepare(
      "UPDATE agents SET parent_agent = 'apprentice-1' WHERE id = 'apprentice-1'",
    ).run();
    await onTaskComplete('task-1', 'apprentice-1');
    const msgs = mockDb.current!.prepare('SELECT * FROM messages').all();
    expect(msgs).toHaveLength(0);
  });

  it('truncates long original_description / completion_summary at 400 chars', async () => {
    const long = 'X'.repeat(800);
    mockDb.current!
      .prepare(
        `INSERT INTO tasks (id, title, description, original_description, completion_summary, status, assigned_to)
         VALUES ('task-long', 'Big task', 'short', ?, ?, 'complete', 'apprentice-1')`,
      )
      .run(long, long);

    await onTaskComplete('task-long', 'apprentice-1');
    const msgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin'")
      .all() as Array<{ content: string }>;
    expect(msgs).toHaveLength(1);
    // Original ask + summary each capped at 400 chars in the note body.
    const xCount = (msgs[0].content.match(/X/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(400 + 400);
  });

  it('falls back to description when original_description is missing', async () => {
    mockDb.current!
      .prepare(
        `INSERT INTO tasks (id, title, description, original_description, completion_summary, status, assigned_to)
         VALUES ('task-fallback', 'Legacy', 'fallback ask', NULL, 'fallback summary', 'complete', 'apprentice-1')`,
      )
      .run();
    await onTaskComplete('task-fallback', 'apprentice-1');
    const msgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin'")
      .all() as Array<{ content: string }>;
    expect(msgs[0].content).toContain('Original ask: fallback ask');
  });

  it('handles missing summary gracefully', async () => {
    mockDb.current!
      .prepare(
        `INSERT INTO tasks (id, title, description, original_description, completion_summary, status, assigned_to)
         VALUES ('task-nosummary', 'No sum', 'ask', 'ask', NULL, 'complete', 'apprentice-1')`,
      )
      .run();
    await onTaskComplete('task-nosummary', 'apprentice-1');
    const msgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin'")
      .all() as Array<{ content: string }>;
    expect(msgs[0].content).toMatch(/Completion summary:.*no summary provided/i);
  });
});
