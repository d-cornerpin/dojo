// PHASE-2 T1 Step 3 — preserve-catalogue addition (research 21 §guards-missed):
// `claimAssignmentNoticeForTerminalTask` LIFECYCLE.
//
// Why this exists. Research 21 lists this function as a guard research 02/16
// MISSED, and says why it matters now: with `trackerRetask`'s refusal it is the
// last mechanism carrying the never-regenerate-delivered-work requirement,
// because `markDeliverableShown` is a tombstone that must never be restored.
// The requirement in one sentence: **a task that has gone terminal can never be
// re-driven by its own assignment notice.** The scaffold that creates a task
// pushes the notice inline into the creating turn AND persists it with
// conv_key=NULL; once the turn ends, the engine-event pickup would re-deliver
// that row as a fresh "begin working on this task" prompt on a NEW turn, and the
// floor model redoes the work, overwriting the artifact the user was already
// shown.
//
// What the suite had before this file (measured 2026-07-28, `git grep -n
// claimAssignmentNoticeForTerminalTask -- packages/server/src`): exactly one
// assertion, a source-text conformance line in
// tracker/__tests__/serve-boundary-conformance.test.ts:58-64 checking that the
// function body mentions `retireEngineEventsForTask(taskId`. Nothing ran it.
// Neither arm (keyed retirement, legacy LIKE fallback) had ever been executed
// against a database, so neither could fail if it stopped working.
//
// Phase 2 rekeys this whole area (T6 obligation machinery, T8 tracker
// consolidation), so the requirement is converted to an executable test FIRST,
// per roadmap non-negotiable #2.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
// notify.ts reaches the dashboard and the agent runtime on its OTHER exported
// path (injectTaskAssignmentNotification). Neither is on the path under test;
// stub them so importing the module cannot start a server-side side effect.
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => null }));

import { claimAssignmentNoticeForTerminalTask } from '../notify.js';

const AGENT = 'agent-alpha';
const OTHER = 'agent-beta';
const TASK = 'task-11111111-2222-3333-4444-555555555555';
const OTHER_TASK = 'task-99999999-8888-7777-6666-555555555555';

// The shape the two arms read: `messages` carrying the engine-event columns
// (lane/origin_intent/conv_key/task_id/swept_at) that migrations 099/112/131
// established.
function seed(): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      lane TEXT,
      origin_intent TEXT,
      conv_key TEXT,
      task_id TEXT,
      run_id TEXT,
      swept_at INTEGER,
      served_by_turn INTEGER,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const ins = db.prepare(
    `INSERT INTO messages (id, agent_id, lane, origin_intent, conv_key, task_id, swept_at, content)
     VALUES (@id, @agent_id, @lane, @origin_intent, @conv_key, @task_id, @swept_at, @content)`,
  );
  // 1. The post-112 assignment notice: keyed by task_id, still pending.
  ins.run({
    id: 'm-keyed', agent_id: AGENT, lane: 'events', origin_intent: 'tracker',
    conv_key: null, task_id: TASK, swept_at: null,
    content: `[SOURCE: TRACKER TASK ASSIGNMENT] Begin working on this task. ID: ${TASK}`,
  });
  // 2. A pre-112 notice for the SAME task: task_id NULL, so only the legacy
  //    content-LIKE arm can reach it. This is the row the scar note is about.
  ins.run({
    id: 'm-legacy', agent_id: AGENT, lane: 'events', origin_intent: 'tracker',
    conv_key: null, task_id: null, swept_at: null,
    content: `[SOURCE: TRACKER TASK ASSIGNMENT] Begin working on this task. ID: ${TASK}`,
  });
  // 3. A notice for a DIFFERENT task, same agent — must be untouched.
  ins.run({
    id: 'm-other-task', agent_id: AGENT, lane: 'events', origin_intent: 'tracker',
    conv_key: null, task_id: OTHER_TASK, swept_at: null,
    content: `[SOURCE: TRACKER TASK ASSIGNMENT] Begin working on this task. ID: ${OTHER_TASK}`,
  });
  // 4. A pre-112 notice for THIS task but belonging to ANOTHER agent — the LIKE
  //    arm is agent-scoped, so it must be untouched.
  ins.run({
    id: 'm-other-agent', agent_id: OTHER, lane: 'events', origin_intent: 'tracker',
    conv_key: null, task_id: null, swept_at: null,
    content: `[SOURCE: TRACKER TASK ASSIGNMENT] Begin working on this task. ID: ${TASK}`,
  });
  // 5. A row for this task that a LIVE TURN already claimed (conv_key set). The
  //    serve boundary says a claimed row is not ours to sweep.
  ins.run({
    id: 'm-claimed', agent_id: AGENT, lane: 'events', origin_intent: 'tracker',
    conv_key: 'engine', task_id: TASK, swept_at: null,
    content: `[SOURCE: TRACKER TASK ASSIGNMENT] already served. ID: ${TASK}`,
  });
  // 6. An ordinary owner-lane chat row mentioning the id — never an engine
  //    event, must never be swept or re-keyed.
  ins.run({
    id: 'm-chat', agent_id: AGENT, lane: 'owner', origin_intent: null,
    conv_key: 'owner', task_id: null, swept_at: null,
    content: `I asked about ID: ${TASK} earlier`,
  });
  mockDb.current = db;
}

const row = (id: string) =>
  mockDb.current!.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;

beforeEach(seed);

describe('claimAssignmentNoticeForTerminalTask lifecycle (research 21 §guards-missed)', () => {
  it('KEYED ARM: retires every unserved engine event carrying this task_id', () => {
    expect(row('m-keyed').swept_at).toBeNull();
    claimAssignmentNoticeForTerminalTask(AGENT, TASK);
    // Retired => getPendingEngineEvent can never pick it up => the finished task
    // can never be re-driven into a second, overwriting execution.
    expect(row('m-keyed').swept_at).not.toBeNull();
  });

  it('LEGACY ARM: a pre-112 notice (task_id NULL) is claimed by the content LIKE', () => {
    expect(row('m-legacy').conv_key).toBeNull();
    claimAssignmentNoticeForTerminalTask(AGENT, TASK);
    // conv_key='engine' is the same sentinel the loop stamps when it actually
    // serves an engine event: excluded from the pending pickup, not deleted.
    expect(row('m-legacy').conv_key).toBe('engine');
  });

  it('BLAST RADIUS: another task, another agent, a claimed row and ordinary chat are all untouched', () => {
    claimAssignmentNoticeForTerminalTask(AGENT, TASK);
    // Another task's notice: still pending and unswept.
    expect(row('m-other-task').swept_at).toBeNull();
    expect(row('m-other-task').conv_key).toBeNull();
    // Same task id in ANOTHER agent's history: the LIKE arm is agent-scoped.
    expect(row('m-other-agent').conv_key).toBeNull();
    // A row a live turn already claimed is not the sweeper's to retire.
    expect(row('m-claimed').swept_at).toBeNull();
    // Ordinary owner chat is not an engine event.
    expect(row('m-chat').conv_key).toBe('owner');
    expect(row('m-chat').swept_at).toBeNull();
  });

  it('IDEMPOTENT: a second call changes nothing and does not throw', () => {
    claimAssignmentNoticeForTerminalTask(AGENT, TASK);
    const sweptFirst = row('m-keyed').swept_at;
    expect(() => claimAssignmentNoticeForTerminalTask(AGENT, TASK)).not.toThrow();
    // sweepByReferent requires swept_at IS NULL, so the first stamp survives
    // verbatim — a repeat call cannot re-date the retirement.
    expect(row('m-keyed').swept_at).toBe(sweptFirst);
    expect(row('m-legacy').conv_key).toBe('engine');
  });

  it('NO-OP GUARD: a missing agent id or task id does nothing at all', () => {
    claimAssignmentNoticeForTerminalTask('', TASK);
    claimAssignmentNoticeForTerminalTask(AGENT, '');
    expect(row('m-keyed').swept_at).toBeNull();
    expect(row('m-legacy').conv_key).toBeNull();
  });
});
