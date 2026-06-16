// Tests for autoCreateAssignTask — engine-driven task creation when an
// agent uses send_to_agent with intent=ASSIGN.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => { /* no-op */ },
}));

import { autoCreateAssignTask, getTask } from '../schema.js';

beforeEach(() => {
  const db = new Database(':memory:');
  // Minimal schema needed for the test — tasks table + a2a_thread_id column.
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      original_description TEXT,
      goal TEXT,
      completion_summary TEXT,
      status TEXT NOT NULL,
      assigned_to TEXT,
      created_by TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      step_number INTEGER,
      total_steps INTEGER,
      phase INTEGER NOT NULL DEFAULT 1,
      depends_on TEXT NOT NULL DEFAULT '[]',
      a2a_thread_id TEXT,
      paused_reason TEXT,
      paused_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_a2a_thread ON tasks(a2a_thread_id);
  `);
  mockDb.current = db;
});

describe('autoCreateAssignTask', () => {
  it('creates a task assigned to the receiver, created by the sender', () => {
    const result = autoCreateAssignTask({
      senderId: 'kevin',
      receiverId: 'maddy',
      payload: 'Build me a 14-slide deck for Meridian Health.',
      threadId: 'thread-1',
    });
    expect(result).not.toBeNull();
    expect(result!.isNew).toBe(true);
    const task = getTask(result!.taskId);
    expect(task).not.toBeNull();
    expect(task!.assignedTo).toBe('maddy');
    expect(task!.createdBy).toBe('kevin');
    expect(task!.status).toBe('in_progress');
    expect(task!.title).toBe('Build me a 14-slide deck for Meridian Health');
    expect(task!.description).toBe('Build me a 14-slide deck for Meridian Health.');
  });

  it('reuses the existing task when a second ASSIGN arrives on the same thread', () => {
    const first = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: 'Build the deck.', threadId: 'thread-1',
    });
    const second = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: 'Also include a closing slide.', threadId: 'thread-1',
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.taskId).toBe(first!.taskId);
    expect(second!.isNew).toBe(false);
  });

  it('creates separate tasks for separate threads even with the same sender/receiver', () => {
    const a = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: 'First job.', threadId: 'thread-A',
    });
    const b = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: 'Second job.', threadId: 'thread-B',
    });
    expect(a!.taskId).not.toBe(b!.taskId);
    expect(a!.isNew).toBe(true);
    expect(b!.isNew).toBe(true);
  });

  it('truncates long titles to a sentence or 80 chars', () => {
    const long = 'A'.repeat(200);
    const result = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: long, threadId: 'thread-long',
    });
    const task = getTask(result!.taskId);
    expect(task!.title.length).toBeLessThanOrEqual(80);
    // Description preserves the full payload.
    expect(task!.description).toBe(long);
  });

  it('uses first-sentence as title when payload has multiple sentences', () => {
    const result = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: 'Draft a press release. Include a quote from the CEO. Aim for 300 words.',
      threadId: 'thread-multi',
    });
    const task = getTask(result!.taskId);
    expect(task!.title).toBe('Draft a press release');
  });

  it('falls back to a placeholder title for empty/whitespace payloads', () => {
    const result = autoCreateAssignTask({
      senderId: 'kevin', receiverId: 'maddy',
      payload: '   ', threadId: 'thread-empty',
    });
    const task = getTask(result!.taskId);
    expect(task!.title).toBe('Assigned task (untitled)');
  });
});
