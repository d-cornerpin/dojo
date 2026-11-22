// A task is worked across several turns. Each turn that works it is recorded once against the task
// at the turn's end (`work/task-turns.ts`), so `timeline(task_id)` shows everything its assignee did
// in those turns and `lastTurnEnd` reads the last turn's end. A task worked before that record
// existed says so plainly rather than showing a silent gap.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null as unknown, file: '' }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => h.db, getReadOnlyDb: () => h.db, closeDb: () => {}, getDbPath: () => h.file,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { timeline } from '../timeline.js';
import { stampTasksAtTurnFinalize } from '../../tracker/task-stamps.js';
import { lastTurnEnd, recordContinued, recordStalled } from '../../work/job-momentum.js';
import { taskMovedAtSql } from '../../work/task-freshness.js';
import { recordTurnOnTasks } from '../../work/task-turns.js';
import { appendWorkEvent } from '../../work/store.js';
import { T0, at, sqlTime } from './seed.js';

const WORKER = 'agent-worker';
const TASK = 'task-m-0000-1111-2222-333344445555';
const OLD_TASK = 'task-old-0000-1111-2222-33334444555';
let db: Database.Database;

const finalize = (turnNumber: number, servedTaskId: string | null = null): void =>
  stampTasksAtTurnFinalize({ agentId: WORKER, turnNumber, outcome: 'answered', answerMessageId: null, convKey: null, servedTaskId });

beforeEach(() => {
  db = new Database(':memory:');
  h.db = db;
  runMigrations();
  db.prepare("INSERT INTO agents (id, name, classification) VALUES (?, 'worker', 'apprentice')").run(WORKER);
  const work = db.prepare(`INSERT INTO work (id, kind, agent_id, assignee_agent, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
    VALUES (?, 'task', ?, ?, 'owner', 'tracker', 'root-x', 'claimed', 'DO', 1, 0, ?, ?, ?)`);
  work.run(TASK, WORKER, WORKER, 'sort the inbox', T0, T0);
  work.run(OLD_TASK, WORKER, WORKER, 'an older job', T0, T0);
  const turn = db.prepare('INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered, effectful_calls) VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
  turn.run(WORKER, 7, 'conv', sqlTime(at(1)), sqlTime(at(3)), 'answered');
  turn.run(WORKER, 8, 'conv', sqlTime(at(10)), sqlTime(at(14)), 'answered');
  turn.run(WORKER, 9, 'conv', sqlTime(at(20)), sqlTime(at(21)), 'answered');   // unrelated to the task
  const call = db.prepare("INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at, turn_number) VALUES (?, ?, 'tool_call', ?, 'success', ?, ?, ?)");
  call.run('aud-a', WORKER, 'gmail_search', 'in:inbox', sqlTime(at(2)), 7);
  call.run('aud-b', WORKER, 'gmail_label', 'label 40 messages', sqlTime(at(11)), 8);
  call.run('aud-c', WORKER, 'gmail_search', 'something else entirely', sqlTime(at(20, 30)), 9);
});

describe('an assignee works a task across two turns', () => {
  it('timeline(task_id) shows the calls of both turns, and not an unrelated turn', () => {
    finalize(7, TASK);                                              // a continuation serving the job
    appendWorkEvent(TASK, 'transition', WORKER, { from: 'claimed', to: 'done', reason: 'finished' }, at(13));   // turn 8 closes it itself
    finalize(8);
    const out = timeline({ task_id: TASK }, db);
    expect(out).toContain('tool gmail_search');
    expect(out).toContain('tool gmail_label');
    expect(out).not.toContain('something else entirely');
    expect(out).not.toMatch(/no per-turn record/);
    expect(out).toMatch(/only through exec, files or mail/);   // the standing gap is always stated
    const claims = db.prepare("SELECT json_extract(payload, '$.turn_number') AS t FROM work_events WHERE work_id = ? AND kind = 'claim_turn' ORDER BY id").all(TASK);
    expect(claims).toEqual([{ t: 7 }, { t: 8 }]);
  });

  it('a turn is recorded once per task, however often its end is processed', () => {
    finalize(7, TASK);
    finalize(7, TASK);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'claim_turn'").get(TASK)).toEqual({ n: 1 });
  });

  it('a turn only woken about the task by a tracker notice did not work it', () => {
    db.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, origin_intent, task_id, served_by_turn, created_at, sent_at)
      VALUES ('m-notice', ?, 'events', 'system', 'PM re-drive', 'tracker', ?, 7, ?, ?)`).run(WORKER, TASK, at(1), at(1));
    db.prepare("UPDATE turns SET effectful_calls = 0 WHERE turn_number = 7").run();
    finalize(7, TASK);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'claim_turn'").get(TASK)).toEqual({ n: 0 });
  });

  it('recording a turn does not make the task look as if it moved', () => {
    const moved = (): number => (db.prepare(`SELECT ${taskMovedAtSql('w')} AS m FROM work w WHERE w.id = ?`).get(TASK) as { m: number }).m;
    const before = moved();
    recordTurnOnTasks(WORKER, 7, [TASK]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'claim_turn'").get(TASK)).toEqual({ n: 1 });
    expect(moved()).toBe(before);
  });
});

describe('lastTurnEnd and its readers are exactly as before the task turns were recorded', () => {
  beforeEach(() => { db.prepare("UPDATE work SET measure_json = '{}' WHERE id = ?").run(TASK); });

  it('continued, then a tool-loop park that wrote nothing, then the continuation: still a continued end', () => {
    recordContinued(TASK, { remaining: 5, touchedThisTurn: 2, novelCallsThisTurn: 1, turnNumber: 7 });
    finalize(7, TASK);
    finalize(8, TASK);                                   // turn 8 carried the job and parked by the loop cap: no continued
    expect(lastTurnEnd(TASK)).toMatchObject({ kind: 'continued', payload: { turnNumber: 7 } });
  });

  it('stalled, then a turn that only noted the task: the stall is still the last end and still reported', () => {
    recordStalled(TASK, { remaining: 10412, turnNumber: 7 });
    appendWorkEvent(TASK, 'activity', WORKER, { note: 'checking in' }, at(12));
    finalize(8);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'claim_turn'").get(TASK)).toEqual({ n: 1 });
    expect(lastTurnEnd(TASK)).toMatchObject({ kind: 'stalled', payload: { remaining: 10412 } });
  });

  it('a task no turn ended on reads null even when turns worked it', () => {
    finalize(7, TASK);
    expect(lastTurnEnd(TASK)).toBeNull();
  });
});

describe('the turn numbers are the holder the readers use', () => {
  it('after a hand-off the new assignee\'s turn is recorded, and the old holder\'s is not', () => {
    db.prepare("INSERT INTO agents (id, name, classification) VALUES ('agent-other', 'other', 'apprentice')").run();
    db.prepare("UPDATE work SET agent_id = 'agent-other', assignee_agent = ? WHERE id = ?").run(WORKER, TASK);
    expect(recordTurnOnTasks(WORKER, 7, [TASK])).toEqual([TASK]);
    expect(recordTurnOnTasks('agent-other', 9, [TASK])).toEqual([]);
  });
});

describe('a task worked before turns were recorded against tasks', () => {
  it('says so in the result, and still shows the turns its continue record names', () => {
    recordContinued(OLD_TASK, { remaining: 5, touchedThisTurn: 2, novelCallsThisTurn: 1, turnNumber: 7 });
    const out = timeline({ task_id: OLD_TASK }, db);
    expect(out).toMatch(/Note: task-old .* no per-turn record/);
    expect(out).toContain('tool gmail_search');          // turn 7, named by its own continued record
    expect(out).not.toContain('tool gmail_label');
  });

  it('a task nobody has worked yet reads truthfully: not worked yet, or worked before', () => {
    expect(timeline({ task_id: TASK }, db)).toMatch(/no per-turn record \(it was not worked yet, or worked before/);
  });
});
