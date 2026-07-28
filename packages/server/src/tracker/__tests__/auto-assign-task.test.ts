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
      -- PHASE-1 T11 (migration 134): who made this row. This hand-built fixture went RED
      -- the moment the writer started naming the column ("no such column" -> the writer's
      -- own catch -> autoCreateAssignTask returned null on all six tests), which is the
      -- fixture doing its job: a minimal schema has to move with the writer it exercises.
      created_by_kind TEXT CHECK (created_by_kind IN ('user', 'agent', 'harness')),
      priority TEXT NOT NULL DEFAULT 'normal',
      step_number INTEGER,
      total_steps INTEGER,
      phase INTEGER NOT NULL DEFAULT 1,
      depends_on TEXT NOT NULL DEFAULT '[]',
      a2a_thread_id TEXT,
      source_message_id TEXT,
      origin_turn INTEGER,
      origin_conv_key TEXT,
      origin_kind TEXT,
      paused_reason TEXT,
      paused_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_a2a_thread ON tasks(a2a_thread_id);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by_kind TEXT
    );
  `);
  mockDb.current = db;
});

describe('autoCreateAssignTask', () => {
  it('creates a task assigned to the receiver, created by the sender', () => {
    const result = autoCreateAssignTask({
      senderId: 'primary',
      receiverId: 'maddy',
      payload: 'Build me a 14-slide deck for Meridian Health.',
      threadId: 'thread-1',
    });
    expect(result).not.toBeNull();
    expect(result!.isNew).toBe(true);
    const task = getTask(result!.taskId);
    expect(task).not.toBeNull();
    expect(task!.assignedTo).toBe('maddy');
    expect(task!.createdBy).toBe('primary');
    expect(task!.status).toBe('in_progress');
    expect(task!.title).toBe('Build me a 14-slide deck for Meridian Health');
    expect(task!.description).toBe('Build me a 14-slide deck for Meridian Health.');
  });

  it('reuses the existing task when a second ASSIGN arrives on the same thread', () => {
    const first = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: 'Build the deck.', threadId: 'thread-1',
    });
    const second = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: 'Also include a closing slide.', threadId: 'thread-1',
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.taskId).toBe(first!.taskId);
    expect(second!.isNew).toBe(false);
  });

  it('creates separate tasks for separate threads even with the same sender/receiver', () => {
    const a = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: 'First job.', threadId: 'thread-A',
    });
    const b = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: 'Second job.', threadId: 'thread-B',
    });
    expect(a!.taskId).not.toBe(b!.taskId);
    expect(a!.isNew).toBe(true);
    expect(b!.isNew).toBe(true);
  });

  it('truncates long titles to a sentence or 80 chars', () => {
    const long = 'A'.repeat(200);
    const result = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: long, threadId: 'thread-long',
    });
    const task = getTask(result!.taskId);
    expect(task!.title.length).toBeLessThanOrEqual(80);
    // Description preserves the full payload.
    expect(task!.description).toBe(long);
  });

  it('uses first-sentence as title when payload has multiple sentences', () => {
    const result = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: 'Draft a press release. Include a quote from the CEO. Aim for 300 words.',
      threadId: 'thread-multi',
    });
    const task = getTask(result!.taskId);
    expect(task!.title).toBe('Draft a press release');
  });

  it('falls back to a placeholder title for empty/whitespace payloads', () => {
    const result = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: '   ', threadId: 'thread-empty',
    });
    const task = getTask(result!.taskId);
    expect(task!.title).toBe('Assigned task (untitled)');
  });

  // ── PHASE-1 T11 Step 1b: authorship travels with the row ──
  //
  // The engine creates this task, not the harness — which is the whole reason the kind
  // has to PROPAGATE rather than be stamped by whoever happens to call an API. Measured
  // on the dev box before the column existed: every one of 51 tasks and 102 of 104
  // projects carried BehaviorBot's agent id in `created_by`. A column only the kit
  // stamped would have been NULL on exactly the rows the clean-slate sweep must find,
  // and switching the sweep to it would have made the sweep see LESS than the name
  // pattern it replaces.
  const kindOf = (taskId: string) =>
    (mockDb.current!.prepare('SELECT created_by_kind FROM tasks WHERE id = ?').get(taskId) as
      { created_by_kind: string | null }).created_by_kind;

  it("inherits the SENDING agent's created_by_kind", () => {
    mockDb.current!.prepare('INSERT INTO agents (id, name, created_by_kind) VALUES (?, ?, ?)')
      .run('behavpeer', 'BehavPeer-x', 'harness');
    const result = autoCreateAssignTask({
      senderId: 'behavpeer', receiverId: 'maddy',
      payload: 'Fixture work.', threadId: 'thread-harness',
    });
    expect(kindOf(result!.taskId)).toBe('harness');
  });

  it('records NULL — never a guess — when the sender names no known agent', () => {
    // An absence is not evidence (roadmap #15). The sweep matches `= 'harness'`
    // positively, so a row like this is outside every blast radius.
    const result = autoCreateAssignTask({
      senderId: 'primary', receiverId: 'maddy',
      payload: 'Ordinary work.', threadId: 'thread-unknown',
    });
    expect(kindOf(result!.taskId)).toBeNull();
  });
});
