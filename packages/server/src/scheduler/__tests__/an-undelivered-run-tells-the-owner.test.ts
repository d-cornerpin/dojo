// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T19 (D4) — A RUN THAT REACHED NOBODY IS NOT A NEUTRAL BADGE.
//
// 2026-08-10, the owner's box. A reminder occurrence sat `open` for thirty minutes and was
// closed by `cleanupStaleRuns` with `'failed'` and the note *"Auto-failed: assigned agent idle
// for 30+ minutes"*. That path walked straight past `settleOccurrence`'s deliverable gate
// (which only ever looked at `complete`), the one-shot owner notice was skipped because the
// claim had pre-advanced `next_run_at`, and the only place the failure was visible to the
// owner was a neutral badge inside an expanded task detail on a row the board does not show.
// `DESIGN.md:46` names that shape: *"it NEVER errs toward silence, a parked ticket, or a quiet
// close."*
//
// Two halves, both here:
//   * the authority RENAMES the run's word (UNDELIVERED, never `failed`), asserted in
//     `work/__tests__/a-fired-reminder-reaches-the-user.test.ts`;
//   * the close SURFACES it in the PLATFORM's own voice — OR2's last rung, the same
//     `recordFloorGhost` three-part record the in-turn floors use, never the agent's face.
//
// The safety net itself is untouched: same 30-minute rule, same trigger, same retry-next-cycle
// promise. Only the word and the surface changed.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
}));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => 'notice-id' }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
}));

import { onTaskRunComplete } from '../runner.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { declareDeliverableOnSchedule } from '../../work/deliverable-declaration.js';
import { RUN_STATUS_UNDELIVERED } from '../../work/run-deliver-drive.js';
import { OCCURRENCE_EVENT } from '../../work/occurrences.js';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';

const AGENT = 'primary';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, channel TEXT,
      created_at INTEGER, turn_number INTEGER, message_id TEXT
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL, mood TEXT,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, group_id TEXT, channel TEXT, sender_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT, a2a_requires_response INTEGER,
      token_count INTEGER NOT NULL DEFAULT 0,
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

/** A one-shot reminder schedule, mid-run: `schedule_status='running'`, no further occurrence. */
function seedReminder(taskKind: string | null): string {
  const id = 'task-reminder';
  seedTrackerTask(mockDb.current!, {
    id, title: 'Reminder: routine', description: 'routine', status: 'in_progress',
    agentId: AGENT, createdBy: 'owner', schedule_status: 'running',
    next_run_at: null, is_paused: 0, task_kind: taskKind,
  });
  if (taskKind) declareDeliverableOnSchedule(id);
  return id;
}

function seedRun(taskId: string): string {
  const id = 'run-1';
  mockDb.current!.prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
                      root_kind, root_id, state, intent, wakes, closes_thread, title, sequence,
                      opened_at, updated_at)
    VALUES (?, 'occurrence', ?, ?, ?, 'schedule', ?, 'schedule', ?, 'open',
            'occurrence', 0, 0, 'occurrence #1', 1, ?, ?)
  `).run(id, taskId, AGENT, AGENT, taskId, taskId, Date.now() - 60_000, Date.now() - 60_000);
  return id;
}

const settledRunStatus = (id: string): string | null => {
  const r = mockDb.current!.prepare(
    `SELECT json_extract(payload, '$.run_status') AS s FROM work_events
      WHERE work_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
  ).get(id, OCCURRENCE_EVENT.settled) as { s: string | null } | undefined;
  return r?.s ?? null;
};

const ghostRows = (): number => (mockDb.current!.prepare(
  `SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted'`,
).get() as { n: number }).n;

const ownerNotes = (): string[] => (mockDb.current!.prepare(
  `SELECT content FROM messages WHERE role = 'system'`,
).all() as Array<{ content: string }>).map((r) => r.content);

beforeEach(() => {
  frames.length = 0;
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
});

describe('the 30-minute idle reaper stops closing an undelivered reminder in silence', () => {
  it('the owner is told, in the platform\'s own voice, that nothing was delivered', async () => {
    const taskId = seedReminder('reminder');
    const runId = seedRun(taskId);

    await onTaskRunComplete(taskId, 'failed', 'Auto-failed: assigned agent idle for 30+ minutes');

    expect(settledRunStatus(runId)).toBe(RUN_STATUS_UNDELIVERED);
    expect(ghostRows()).toBe(1);
    const notes = ownerNotes();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain(OWNER_ALERT_HEADS_UP_PREFIX);
    expect(notes[0]).toContain('without delivering anything to you');
    // and it is the PLATFORM speaking, never the agent: no assistant row, no reminder text
    // re-read out of the work row and spoken as if the agent had said it.
    expect(notes[0]).not.toContain('routine.');
    expect(frames.some((f) => f.type === 'chat:error' && f.code === 'FLOOR_GHOSTED')).toBe(true);
  });

  it('CONTROL: a task that owes NOBODY a message closes failed, silently, exactly as before', async () => {
    const taskId = seedReminder(null);
    const runId = seedRun(taskId);

    await onTaskRunComplete(taskId, 'failed', 'Auto-failed: assigned agent idle for 30+ minutes');

    expect(settledRunStatus(runId)).toBe('failed');
    expect(ghostRows()).toBe(0);
    expect(ownerNotes()).toEqual([]);
  });

  it('CONTROL: a reminder run that DID deliver is closed complete and says nothing alarming', async () => {
    const taskId = seedReminder('reminder');
    const runId = seedRun(taskId);
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, display_kind, display_tier)
       VALUES ('m-1', ?, 'assistant', 'Time to stretch.', 'agent-text', 'user-visible')`,
    ).run(AGENT);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, outcome, tool, channel, created_at, turn_number, message_id)
       VALUES ('d-1', ?, 'delivered', 'dashboard', 'dashboard', ?, 4621, 'm-1')`,
    ).run(AGENT, new Date().toISOString().slice(0, 19).replace('T', ' '));

    await onTaskRunComplete(taskId, 'complete', 'delivered');

    expect(settledRunStatus(runId)).toBe('complete');
    expect(ghostRows()).toBe(0);
    expect(ownerNotes()).toEqual([]);
  });

  it('ONE alert per run: an in-turn floor ghost already recorded means this arm stays quiet', async () => {
    const taskId = seedReminder('reminder');
    const runId = seedRun(taskId);
    mockDb.current!.prepare(
      `INSERT INTO work_events (work_id, kind, payload, actor, created_at)
       VALUES (?, 'floor_ghosted', '{"floor":"reminder-silence"}', 'engine', ?)`,
    ).run(taskId, Date.now());

    await onTaskRunComplete(taskId, 'failed', 'Auto-failed: assigned agent idle for 30+ minutes');

    expect(settledRunStatus(runId)).toBe(RUN_STATUS_UNDELIVERED);
    expect(ghostRows()).toBe(1); // the one that was already there
    expect(ownerNotes()).toEqual([]);
  });
});
