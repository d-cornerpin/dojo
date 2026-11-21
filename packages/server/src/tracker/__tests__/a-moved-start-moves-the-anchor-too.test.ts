// A repeating task moved to a new start keeps no stale anchor: the anchor moves with the start.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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
const ORIGINAL_TZ = process.env.TZ;

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
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

/** A daily task that has already run once: 09:00 anchor, last run 2026-10-31T09:00Z. */
function seedRanDaily(db: Database.Database, id: string): void {
  seedTrackerTask(db, {
    id, agentId: AGENT, title: 'daily brief', status: 'on_deck',
    scheduled_start: Date.parse('2026-10-01T09:00:00.000Z'),
    repeat_interval: 1, repeat_unit: 'days', repeat_end_type: 'never',
    anchor_local: '2026-10-01T09:00:00.000Z', schedule_status: 'waiting',
    attempts: 5, last_run_at: Date.parse('2026-10-31T09:00:00.000Z'),
    next_run_at: Date.parse('2026-11-01T09:00:00.000Z'),
  });
}

const rowOf = (id: string): { anchor_local: string; scheduled_start: number; next_run_at: number } =>
  mockDb.current!.prepare('SELECT anchor_local, scheduled_start, next_run_at FROM work WHERE id = ?').get(id) as never;

const NEW_START = '2026-11-02T14:00:00.000Z';

beforeEach(() => {
  process.env.TZ = 'UTC';
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('moving a repeating task to a new start moves its anchor too', () => {
  it('the anchor follows the new start, and the next run is at the new time of day, not before the start', async () => {
    seedRanDaily(mockDb.current!, 'task-moved-1');
    const res = await trackerHandlers['work_update:edit']({ agentId: AGENT, args: { task_id: 'task-moved-1', scheduled_start: NEW_START } } as never);
    expect(res.isError, res.content).toBe(false);
    const row = rowOf('task-moved-1');
    expect(row.anchor_local).toBe(NEW_START);
    expect(row.next_run_at).toBeGreaterThanOrEqual(Date.parse(NEW_START));
    expect(new Date(row.next_run_at).getUTCHours()).toBe(14);
  });

  it('an explicit anchor_time in the same call wins', async () => {
    seedRanDaily(mockDb.current!, 'task-moved-2');
    const res = await trackerHandlers['work_update:edit']({
      agentId: AGENT, args: { task_id: 'task-moved-2', scheduled_start: NEW_START, anchor_time: '2026-11-02T16:00:00Z' },
    } as never);
    expect(res.isError, res.content).toBe(false);
    expect(rowOf('task-moved-2').anchor_local).toBe('2026-11-02T16:00:00.000Z');
  });

  it('an edit that does not move the start leaves the anchor alone', async () => {
    seedRanDaily(mockDb.current!, 'task-moved-3');
    const res = await trackerHandlers['work_update:edit']({ agentId: AGENT, args: { task_id: 'task-moved-3', repeat_interval: 2 } } as never);
    expect(res.isError, res.content).toBe(false);
    expect(rowOf('task-moved-3').anchor_local).toBe('2026-10-01T09:00:00.000Z');
  });
});
