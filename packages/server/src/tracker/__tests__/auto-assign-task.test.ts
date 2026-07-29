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
import { createWorkTable } from '../../work/__tests__/work-fixture.js';

beforeEach(() => {
  const db = new Database(':memory:');
  // Minimal schema needed for the test — tasks table + a2a_thread_id column.
  createWorkTable(db);
  db.exec(`
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

  // ── PHASE-1 T11 Step 1b's tracker half: RETIRED DELIBERATELY at PHASE-2 T8b ──
  //
  // These two tests asserted `legacy_tasks.created_by_kind` — the copy of the creating
  // agent's kind that the tracker stamped on every row it made. T8a enumerated every
  // occurrence of that column in production (four INSERT column lists in `tracker/schema.ts`
  // and nothing else) and every occurrence in the kit (fifteen, all of them
  // `agents.created_by_kind`; the clean-slate sweep deletes tracker rows by JOINING on
  // `created_by`/`assigned_to`, never on the tracker's own copy). Migration `137` therefore
  // did not carry it onto `work`, and this task stopped writing it.
  //
  // requirement preserved: *a harness fixture's auto-created work is structurally
  // identifiable.* It still is, and by the reader that was always doing the work —
  // `agents.created_by_kind` on the creating agent, which `inheritedCreatorKind` reads and
  // `agent/spawner.ts` propagates. What is gone is a second copy of that fact on a row
  // nobody consulted. The assertion is retired HERE, in the change that drops the write,
  // rather than left to break later (PHASE-2 T0 concern 1's condition).
  it('the creating agent still carries the kind the sweep reads', () => {
    mockDb.current!.prepare('INSERT INTO agents (id, name, created_by_kind) VALUES (?, ?, ?)')
      .run('behavpeer', 'BehavPeer-x', 'harness');
    const result = autoCreateAssignTask({
      senderId: 'behavpeer', receiverId: 'maddy',
      payload: 'Fixture work.', threadId: 'thread-harness',
    });
    expect(result).not.toBeNull();
    const kind = (mockDb.current!.prepare('SELECT created_by_kind FROM agents WHERE id = ?')
      .get('behavpeer') as { created_by_kind: string | null }).created_by_kind;
    expect(kind).toBe('harness');
    // ...and the row it made names that agent, which is the join the sweep performs.
    const createdBy = (mockDb.current!.prepare('SELECT requester_id FROM work WHERE id = ?')
      .get(result!.taskId) as { requester_id: string }).requester_id;
    expect(createdBy).toBe('behavpeer');
  });
});
