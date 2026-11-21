// A task another agent assigned is reported to that agent on its thread, never to the owner: when it and the
// owner's own task are handed in on one A2A turn, the completion report names only the owner's task.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { autoCreateAssignTask } from '../../../../../tracker/schema.js';
import { scheduleCompletionReport } from '../close-the-loop.js';
import type { FinalizeContext } from '../index.js';

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const started = Date.now() - 5 * 60_000;

function handIn(id: string): void {
  mockDb.current!.prepare("UPDATE work SET state = 'handed_in', updated_at = ? WHERE id = ?").run(Date.now(), id);
  mockDb.current!.prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'handed_in', ?, ?, ?)")
    .run(id, JSON.stringify({ outcome: 'finished', items: [], note: '', filedBy: MAIN }), MAIN, Date.now());
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Main', 'idle', '1970-01-01'), (?, 'Helper', 'idle', '1970-01-01')").run(MAIN, HELPER);
  mockDb.current.prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
    VALUES ('task-owner', 'task', ?, 'owner', 'tracker', 'task-owner', 'claimed', 'tracker', 0, 0, 'Write the beach list', ?, ?)`).run(MAIN, started, started);
});

describe('a task another agent asked for gets no owner completion report', () => {
  it("only the owner's task is named when both are handed in on one A2A turn", async () => {
    const relay = autoCreateAssignTask({ senderId: HELPER, receiverId: MAIN, payload: 'Relay the list to the owner.', threadId: 'thread-relay' })!;
    // The owner's card the agent opened and gave a helper, back in its hands: it keeps its thread.
    mockDb.current!.prepare(`INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, a2a_thread_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
      VALUES ('task-card', 'task', ?, 'agent', ?, 'tracker', 'task-card', 'thread-card', 'claimed', 'tracker', 0, 0, 'Book the campsite', ?, ?)`).run(MAIN, MAIN, started, started);
    for (const id of ['task-owner', 'task-card', relay.taskId]) handIn(id);
    await scheduleCompletionReport({ agentId: MAIN, turnNumber: 9, db: mockDb.current!, isA2ATurn: true, turnStartedAt: new Date(started).toISOString().slice(0, 19).replace('T', ' ') } as unknown as FinalizeContext);
    const reports = mockDb.current!.prepare("SELECT content FROM messages WHERE origin_intent = 'completion_report'").all() as Array<{ content: string }>;
    expect(reports).toHaveLength(1);
    expect(reports[0].content).toContain('Write the beach list');
    expect(reports[0].content, 'its own card back from a helper').toContain('Book the campsite');
    expect(reports[0].content).not.toContain('Relay the list');
  });
});
