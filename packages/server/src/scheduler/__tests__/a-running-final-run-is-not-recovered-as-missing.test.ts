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
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
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

import { cleanupStaleRuns } from '../runner.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER,
      turn_number INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mood TEXT,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, group_id TEXT,
      channel TEXT, sender_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
      a2a_requires_response INTEGER,
      token_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT, cost REAL, latency_ms INTEGER, reasoning_content TEXT,
      inbound_meta TEXT, attachments TEXT,
      external_message_id TEXT, speaker TEXT, voice_session_id TEXT,
      task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      served_by_turn INTEGER, answer_message_id TEXT,
      swept_at TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
      retired_at TEXT,
      origin_kind TEXT DEFAULT NULL, source TEXT DEFAULT NULL, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      sent_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

const DAY = 86_400_000;

function seedBounded(db: Database.Database, id: string, over: Record<string, unknown>): void {
  const now = Date.now();
  seedTrackerTask(db, {
    id,
    title: 'bounded reminder',
    status: 'in_progress',
    createdBy: 'primary',
    repeat_interval: 1,
    repeat_unit: 'days',
    repeat_end_type: 'after_count',
    repeat_end_value: '3',
    attempts: 2,
    schedule_status: 'running',
    is_paused: 0,
    scheduled_start: now - 3 * DAY,
    anchor_local: new Date(now - 3 * DAY).toISOString().slice(0, 19),
    last_run_at: now,
    updated_at: now,
    next_run_at: null,
    ...over,
  });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
});

describe('a running final run is not recovered as missing', () => {
  it('leaves a row alone while its last run is still in flight', () => {
    const db = mockDb.current!;
    seedBounded(db, 'final-run', {});
    cleanupStaleRuns();
    const row = db.prepare('SELECT next_run_at, schedule_status FROM work WHERE id = ?').get('final-run') as { next_run_at: number | null; schedule_status: string };
    expect(row.next_run_at).toBeNull();
    expect(row.schedule_status).toBe('running');
  });

  it('still re-arms a genuinely lost schedule (waiting, no next run)', () => {
    const db = mockDb.current!;
    seedBounded(db, 'lost', { schedule_status: 'waiting', attempts: 1 });
    cleanupStaleRuns();
    const row = db.prepare('SELECT next_run_at FROM work WHERE id = ?').get('lost') as { next_run_at: number | null };
    expect(row.next_run_at).not.toBeNull();
    expect(row.next_run_at as number).toBeGreaterThan(Date.now());
  });
});
