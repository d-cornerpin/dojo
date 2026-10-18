// ════════════════════════════════════════════════════════════════════════════════════════
// t207 (D6, ctx 6) — THE ATTEMPT LEDGER IS LAID OUT IN THE ROOM THE ARRAY LEAVES, NOT IN A FIXED SHAPE.
//
// The ledger on the task list kept the last fixed ceiling: 800 tokens, 2 tasks, 4 notes + 4 transitions, at
// most 6 entries each. An agent working five tasks with twenty entries each saw two tasks and six lines on a
// 128K window with tens of thousands of tokens unused. It now takes the room the task list leaves (after the
// list's own guarantee): every in-progress task, as many entries per task as fit, newest first, and a counted
// "earlier entries" line where the room runs out. Never silent.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { buildWorkBoardLane, type TaskListView } from '../work-board-lane.js';
import { LANE_LIMITS } from '../lanes.js';
import { estimateTokens } from '../budget.js';
import { writeTaskLog } from '../../tracker/task-log.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const AGENT = 'helper';
const TASKS = 5;
const ENTRIES = 20;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES ('helper', 'Helper', 'idle', 'm-a', 'apprentice')`).run();
  for (let t = 0; t < TASKS; t++) {
    seedTrackerTask(d, {
      id: `task-${t}`, agentId: AGENT, status: 'in_progress', title: `audit pass ${t}`,
      opened_at: Date.now() - (TASKS - t) * 60_000, updated_at: Date.now() - 60_000, origin_conv_key: 'c-1', priority: 'normal',
    } as never);
    for (let e = 0; e < ENTRIES; e++) {
      writeTaskLog({ taskId: `task-${t}`, fromEntity: `agent:${AGENT}`, entryKind: 'observation', note: `T${t}-E${String(e).padStart(2, '0')} checked page ${e} of the ledger` });
    }
  }
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const roomy: TaskListView = { availableTokens: 120_000, emitted: [], blocks: [], liveRows: [] };

describe('t207 — a roomy window shows the whole ledger', () => {
  it('five in-progress tasks with twenty entries each: every task, every entry', async () => {
    const lane = await buildWorkBoardLane(AGENT, roomy);
    const ledger = lane.attemptLedger ?? '';
    for (let t = 0; t < TASKS; t++) expect(ledger, `task ${t}`).toContain(`audit pass ${t}`);
    for (let t = 0; t < TASKS; t++) for (let e = 0; e < ENTRIES; e++) {
      expect(ledger, `T${t}-E${e}`).toContain(`T${t}-E${String(e).padStart(2, '0')}`);
    }
    expect(ledger).not.toMatch(/earlier entr/);
  });
});

describe('t207 — a small window gets what fits, newest first, and a count of the rest', () => {
  it('the ledger fits its room, lists every task, and counts what it left off', async () => {
    // The loop's own appends (declared reserves) come off the available tokens first, so this leaves a small room.
    const small: TaskListView = { availableTokens: 2_800, emitted: [], blocks: [], liveRows: [] };
    const lane = await buildWorkBoardLane(AGENT, small);
    const ledger = lane.attemptLedger ?? '';
    expect(ledger.length).toBeGreaterThan(0);
    for (let t = 0; t < TASKS; t++) expect(ledger, `task ${t} is listed`).toContain(`audit pass ${t}`);
    expect(ledger).toMatch(/earlier entr/);                 // never silent
    // newest first: the newest entry of a task is kept before an older one
    for (let t = 0; t < TASKS; t++) expect(ledger).toContain(`T${t}-E19`);
    expect(ledger).not.toContain('T0-E00');
    // and the block plus the list together stay inside the room the array left
    const whole = estimateTokens(ledger) + estimateTokens(lane.activeTasks ?? '');
    expect(whole).toBeLessThanOrEqual(2_800);
  });
});

describe('t207 — the fixed shape is gone from the declared limits', () => {
  it('no row counts and no token cap are declared for the ledger', () => {
    const declared = LANE_LIMITS['lane.attempt-ledger'] as { rows?: unknown; tokens?: unknown };
    expect(declared.rows).toBeUndefined();
    expect(declared.tokens).toBeUndefined();
  });
});
