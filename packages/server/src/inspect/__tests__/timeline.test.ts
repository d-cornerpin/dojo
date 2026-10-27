// v3.5 inspect B1 — the timeline of a task, a project, a turn and an agent, from a migrated
// database seeded with one task's whole life (`seed.ts`): an open, a claim, three tool calls
// (one failed), a provider receipt, a delivery, a PM poke and a close.
//
// REVIEW FOCUS 3: an agent that no longer exists is still answered from the records that
// remain, labelled "(agent deleted)".

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null as unknown, file: '' }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => h.db, getReadOnlyDb: () => h.db, closeDb: () => {}, getDbPath: () => h.file,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { timeline } from '../timeline.js';
import { resolveWindow } from '../scope.js';
import { seedTaskStory, TASK, PROJECT, SECOND_TASK, BEARER, at, sqlTime } from './seed.js';

let db: Database.Database;
// One test purges the worker and its rows and two others add turns, so a database shared across
// tests leaks its mutations into the next one in whatever order the runner runs them.
function freshStory(): void {
  db = new Database(':memory:');
  h.db = db;
  runMigrations();
  seedTaskStory(db);
}
beforeEach(freshStory);

const lines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('['));

describe('timeline of a task', () => {
  it('tells the whole story in time order, every source present, and nothing from outside the task', () => {
    const out = timeline({ task_id: TASK }, db);
    const ls = lines(out);
    const times = ls.map((l) => l.slice(1, 20));
    expect([...times].sort()).toEqual(times);
    expect(out).toMatch(/events 5 · tools 4 · receipts 1 · deliveries 1 · turns 1 · messages 5/);
    const story = ls.join('\n');
    expect(story).toMatch(/task task0000 · opened by owner/);
    expect(story).toMatch(/open → claimed: turn pickup/);
    expect(story).toMatch(/tool gmail_label \(error\)/);
    expect(story).toMatch(/receipt gmail_label \(verified, provider-id\) · tool_receipts rcpt-1 · provider id prov-77/);
    expect(story).toMatch(/delivery send_message → dashboard the owner \(delivered\)/);
    expect(story).toMatch(/poke by pm \(agent-pm\)/);
    expect(story).toMatch(/agent pm \(agent-pm\) · tool work_update/);
    expect(story).toMatch(/claimed → done: delivered via dashboard/);
    expect(story).toMatch(/turn 5 conv started · turns {2}ended 2026-10-19 09:06:00 UTC \(answered, 3 effectful calls\)/);
    expect(story).not.toContain('an unrelated earlier turn');
    expect(story).not.toContain('a second piece');
  });

  it('names a tool call before the receipt that confirms it when they share a second', () => {
    const ls = lines(timeline({ task_id: TASK }, db));
    const call = ls.findIndex((l) => l.includes('09:03:30') && l.includes('tool gmail_label (success)'));
    const receipt = ls.findIndex((l) => l.includes('receipt gmail_label'));
    expect(call).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(call);
  });

  it('passes every cell through the redaction', () => {
    const out = timeline({ task_id: TASK }, db);
    expect(out).toContain('msg msg-w-4');
    expect(out).not.toContain(BEARER);
  });

  it('a project interleaves every child task with its own events', () => {
    const out = timeline({ project_id: PROJECT }, db);
    expect(out).toContain('task task0000');
    expect(out).toContain(`task ${SECOND_TASK.slice(0, 8)} · opened by pm`);
  });

  it('an unknown task says so and how to find one', () => {
    expect(timeline({ task_id: 'no-such-task' }, db)).toMatch(/No task or project with id no-such-task/);
  });
});

describe('timeline of a turn and of an agent', () => {
  it('a turn is that agent\'s turn row and its calls, and needs the agent', () => {
    expect(timeline({ turn: 5 }, db)).toMatch(/give agent as well as turn/);
    const out = timeline({ agent: 'worker', turn: 5 }, db);
    expect(out).toContain('tool gmail_search');
    expect(out).not.toContain('an unrelated earlier turn');
  });

  it('an agent with no time given is its latest turn, and the header says how to ask for more', () => {
    const out = timeline({ agent: 'primary' }, db);
    expect(out).toMatch(/the latest turn \(turn 9\); give since\/until or around for more/);
    expect(out).toContain('how did the inbox labelling go?');
  });

  it('around a message is the turn that message belongs to', () => {
    const out = timeline({ agent: 'agent-worker', around: 'msg-w-4' }, db);
    expect(out).toMatch(/around message msg-w-4 \(turn 5\)/);
    expect(out).toContain('tool gmail_search');
    expect(out).not.toContain('an unrelated earlier turn');
  });
});

describe('fix round 1 — never-closed turns, conversation scope, one pass over text', () => {
  it('a turn that never closed ends at its last record, so "around" does not run on to now', () => {
    // An orphan: the worker's turn 3 began and never closed (85 such turns on the dev box).
    db.prepare("INSERT INTO turns (agent_id, turn_number, kind, started_at, answered) VALUES ('agent-worker', 3, 'conv', ?, 0)").run(sqlTime(at(-30)));
    db.prepare("INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES ('msg-orphan', 'agent-worker', 'owner', 'assistant', 'an orphaned reply', 3, ?, ?)").run(at(-29), at(-29));
    const iso = new Date(at(2)).toISOString();
    expect(resolveWindow(db, { around: iso }, 'agent-worker').to).toBe(at(6));
    expect(resolveWindow(db, { around: iso }, null).to).not.toBeNull();
    expect(resolveWindow(db, { around: 'msg-orphan' }, null)).toMatchObject({ from: at(-30), to: at(-29) });
  });

  it('a conversation with no time given is its whole history, not the platform\'s latest turn', () => {
    db.prepare("INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered) VALUES ('agent-worker', 7, 'conv', ?, ?, 'answered', 1)").run(sqlTime(at(40)), sqlTime(at(41)));
    const out = timeline({ conversation: 'conv-owner' }, db);
    expect(out).toContain('how did the inbox labelling go?');
    expect(out).toContain('It went fine.');
  });

  it("a project's timeline searches message text once, for the project, not once per task", () => {
    const seen: string[] = [];
    const spy = new Proxy(db, { get: (t, k) => (k === 'prepare' ? (q: string) => { seen.push(q); return t.prepare(q); } : Reflect.get(t, k)) });
    timeline({ project_id: PROJECT }, spy as Database.Database);
    const messagesQuery = seen.find((q) => /FROM messages WHERE/.test(q) && q.includes('instr(content'));
    expect(messagesQuery).toBeDefined();
    expect(messagesQuery?.match(/instr\(content/g)).toHaveLength(1);
    const auditQuery = seen.find((q) => /FROM audit_log WHERE/.test(q));
    expect(auditQuery?.match(/instr\(detail/g)).toHaveLength(1);
  });
});

describe('REVIEW FOCUS 3 — a deleted agent', () => {
  it('still renders the task from the records that remain, labelled "(agent deleted)"', () => {
    // The 3.4 purge removes an agent and most of its rows; what is left must still answer.
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM agents WHERE id = 'agent-worker'").run();
    db.prepare("DELETE FROM messages WHERE agent_id = 'agent-worker'").run();
    db.pragma('foreign_keys = ON');
    const out = timeline({ task_id: TASK }, db);
    expect(out).toMatch(/Timeline of task task0000 \(agent-wo \(agent deleted\)\)/);
    expect(out).toContain('agent agent-wo (agent deleted) · tool gmail_label (error)');
    expect(out).toMatch(/messages 0/);
    expect(out).toContain('claimed → done');
  });
});
