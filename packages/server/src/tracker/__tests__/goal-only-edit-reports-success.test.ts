// ════════════════════════════════════════════════════════════════════════════
// A GOAL-ONLY EDIT IS A SUCCESSFUL EDIT, NOT A DELETION.
//
// ── THE FACT THIS PINs ──────────────────────────────────────────────────────
// `work_update(action="edit")` with ONLY `goal` writes the goal — the goal block
// in `trackerEditTask` calls `patchWork(taskId, { goal })` and appends its own
// `goal_edited` observation — and then tells the agent:
//   Error: Task <id> was deleted before the update completed. It no longer exists.
// The lie's route: `goal` never enters the `updates` object the tail of the
// function builds, so `updateTask(taskId, {})` reaches the attribute door with
// an empty patch, the door answers `no_change` / `empty-patch`
// (`work/tracker-store.ts`), `updateTask` folds every non-`applied` arm into
// `null`, and the caller reads that `null` as "row gone". An edit whose only
// change was already applied by an earlier step must read the task and report
// success: "nothing left to patch" is not "task deleted".
//
// ── WHY THE DOOR AND NOT THE INNER FUNCTION ─────────────────────────────────
// Every clause goes through `trackerHandlers['work_update:edit']`, the object
// the tool executor dispatches into — the same seam style as
// `anchor-time-seam.test.ts`, whose mocks and fixture this copies. Note the
// door wraps an edit body's error string with `isError: false`
// (`measure-door.ts`), so every assertion below reads `res.content`.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const AGENT = 'a1';
const OLD_GOAL = 'the old goal';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, channel TEXT, counterparty_name TEXT, counterparty_id TEXT);
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL, mood TEXT,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, group_id TEXT, channel TEXT, sender_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
      a2a_requires_response INTEGER, token_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT, cost REAL, latency_ms INTEGER, reasoning_content TEXT,
      inbound_meta TEXT, attachments TEXT, external_message_id TEXT, speaker TEXT,
      voice_session_id TEXT, task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      served_by_turn INTEGER, answer_message_id TEXT, swept_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, retired_at TEXT,
      origin_kind TEXT DEFAULT NULL, source TEXT DEFAULT NULL, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      sent_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** A live task the calling agent holds, carrying a goal the test will replace. */
function seedGoalTask(db: Database.Database, id: string): void {
  seedTrackerTask(db, {
    id, agentId: AGENT, title: 'brief the owner', status: 'on_deck', goal: OLD_GOAL,
  });
}

const rowOf = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT goal, title FROM work WHERE id = ?').get(id) as Record<string, unknown>;

/** How many `goal_edited` observations the trail carries for this row. */
const goalEditedCount = (id: string): number =>
  (mockDb.current!.prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.entry_kind') = 'observation'
        AND json_extract(payload, '$.action_taken') = 'goal_edited'`,
  ).get(id) as { n: number }).n;

const edit = async (args: Record<string, unknown>): Promise<string> => {
  const res = await trackerHandlers['work_update:edit']({ agentId: AGENT, args } as never);
  return String(res.content);
};

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

describe('work_update(action="edit") with only `goal`', () => {
  it('reports success and the row carries the new goal — "was deleted" is a lie here', async () => {
    seedGoalTask(mockDb.current!, 'task-goal-only');
    const content = await edit({ task_id: 'task-goal-only', goal: 'a new goal for the test' });

    // Pre-fix this is the false deletion: the goal wrote, the row is alive, and
    // the reply says the task is gone.
    expect(content, 'the edit wrote the goal but the reply claims the task is gone').not.toContain('deleted');
    expect(content.startsWith('[OK]'), content).toBe(true);
    expect(content, `the Fields changed line must name the field that changed: ${content}`)
      .toMatch(/Fields changed: [^\n]*\bgoal\b/);
    expect(rowOf('task-goal-only').goal).toBe('a new goal for the test');
  });

  it('the goal_edited observation is written exactly once', async () => {
    seedGoalTask(mockDb.current!, 'task-goal-once');
    await edit({ task_id: 'task-goal-once', goal: 'a new goal for the test' });
    expect(goalEditedCount('task-goal-once')).toBe(1);
  });

  it('control: goal PLUS title still edits and succeeds exactly as before', async () => {
    seedGoalTask(mockDb.current!, 'task-goal-and-title');
    const content = await edit({ task_id: 'task-goal-and-title', goal: 'a new goal for the test', title: 'new title' });

    expect(content, 'the two-field edit regressed').not.toContain('deleted');
    expect(content.startsWith('[OK]'), content).toBe(true);
    expect(content).toContain('Fields changed: title');
    const row = rowOf('task-goal-and-title');
    expect(row.title).toBe('new title');
    expect(row.goal).toBe('a new goal for the test');
  });

  it('control: an unknown id keeps answering with the not-found error', async () => {
    const content = await edit({ task_id: 'task-no-such-task', goal: 'a new goal for the test' });
    expect(content.startsWith('Error:'), content).toBe(true);
    expect(content).toContain('not found');
  });
});
