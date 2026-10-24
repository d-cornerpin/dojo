// K34 — `lesson_record` is the Dreamer's one door into the lessons table: validated against the
// task's own events, an expiry on every lesson, a recurring cue renews instead of duplicating,
// and the owner hears once per cycle through the existing card, never through the main agent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
const broadcast = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcast(e) }));
// Cues are embedded by topic so "the same cue, worded differently" is a real cosine, not a string match.
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: async (text: string) => {
    const t = text.toLowerCase();
    return new Float32Array(t.includes('label') ? [1, t.includes('worded') ? 0.1 : 0, 0] : t.includes('timeout') ? [0, 1, 0] : [0, 0, 1]);
  },
}));

import { runMigrations } from '../../db/migrations.js';
import { vaultHandlers } from '../../agent/tools/cat/vault.js';
import { announceLessons, lessonReportLines } from '../lessons-announce.js';
import { getDreamerAgentId } from '../../config/platform.js';

const DAY = 24 * 60 * 60 * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
let eventA = 0;
let eventB = 0;

const call = (agentId: string, args: Record<string, unknown>) =>
  vaultHandlers.lesson_record!({ agentId, args } as never) as Promise<{ content: string; isError: boolean }>;
const lessons = () => mockDb.current!.prepare('SELECT * FROM lessons ORDER BY created_at').all() as Array<Record<string, any>>;
const base = (over: Record<string, unknown> = {}) => ({
  task_id: 'task-1', cue: 'invalid label on a mail move', lesson: 'List the labels first',
  evidence_event_ids: [eventA], confidence: 0.8, component: 'technique', ...over,
});

beforeEach(() => {
  broadcast.mockReset();
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-x', 'X', 'idle', '{}')").run();
  for (const id of ['task-1', 'task-2']) {
    db.prepare(
      `INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, opened_at, updated_at, provenance)
       VALUES (?, 'task', 'agent-x', 'agent-x', 'owner', 'owner', 'tracker', ?, 'claimed', 'action', 1, 0, 't', ?, ?, 'live')`,
    ).run(id, `turn:${id}`, Date.now() - DAY, Date.now() - DAY);
  }
  const ev = db.prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'rearm_refused', '{}', 'engine', ?)");
  eventA = Number(ev.run('task-1', Date.now() - 3600_000).lastInsertRowid);
  eventB = Number(ev.run('task-2', Date.now() - 3600_000).lastInsertRowid);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('lesson_record', () => {
  it('a lesson lands with a 90-day expiry, owned by the task\'s agent', async () => {
    const r = await call(getDreamerAgentId(), base());
    expect(r.isError).toBe(false);
    const [row] = lessons();
    expect(row).toMatchObject({ agent_id: 'agent-x', task_id: 'task-1', component: 'technique', confidence: 0.8, renewed_count: 0 });
    expect(JSON.parse(row.evidence_event_ids)).toEqual([eventA]);
    expect(row.expires_at - row.created_at).toBe(90 * DAY);
  });

  it('an evidence id outside the task\'s own events is refused, and nothing is stored', async () => {
    const r = await call(getDreamerAgentId(), base({ evidence_event_ids: [eventA, eventB] }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain(String(eventB));
    expect(lessons()).toHaveLength(0);
  });

  it('only the Dreamer may record one', async () => {
    const r = await call('agent-x', base());
    expect(r.isError).toBe(true);
    expect(lessons()).toHaveLength(0);
  });

  it('refuses an unknown task, an unknown component, an out-of-range confidence, and no evidence at all', async () => {
    const d = getDreamerAgentId();
    expect((await call(d, base({ task_id: 'nope' }))).isError).toBe(true);
    expect((await call(d, base({ component: 'vault' }))).isError).toBe(true);
    expect((await call(d, base({ confidence: 1.5 }))).isError).toBe(true);
    expect((await call(d, base({ evidence_event_ids: [] }))).isError).toBe(true);
    expect(lessons()).toHaveLength(0);
  });

  it('the same cue, again, renews the lesson instead of duplicating it', async () => {
    const d = getDreamerAgentId();
    await call(d, base());
    const first = lessons()[0];
    mockDb.current!.prepare('UPDATE lessons SET expires_at = expires_at - ?').run(30 * DAY);
    const r = await call(d, base({ task_id: 'task-2', evidence_event_ids: [eventB], cue: 'invalid label on a mail move, worded differently' }));
    expect(r.isError).toBe(false);
    const rows = lessons();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].renewed_count).toBe(1);
    expect(rows[0].expires_at).toBeGreaterThan(first.expires_at - 30 * DAY + 29 * DAY);
    expect(JSON.parse(rows[0].evidence_event_ids).sort()).toEqual([eventA, eventB].sort());
  });

  it('a different cue is a second lesson', async () => {
    const d = getDreamerAgentId();
    await call(d, base());
    await call(d, base({ task_id: 'task-2', cue: 'a timeout while waiting', evidence_event_ids: [eventB] }));
    expect(lessons()).toHaveLength(2);
  });

  it('at most one lesson per task per cycle: a second record for the same task is refused plainly', async () => {
    const d = getDreamerAgentId();
    expect((await call(d, base())).isError).toBe(false);
    const again = await call(d, base({ cue: 'a timeout while waiting' }));
    expect(again.isError).toBe(true);
    expect(again.content).toMatch(/already has a lesson/i);
    expect(lessons()).toHaveLength(1);
  });

  it('the one-per-task rule holds when the first lesson renewed another task\'s row', async () => {
    const d = getDreamerAgentId();
    await call(d, base());
    await call(d, base({ task_id: 'task-2', evidence_event_ids: [eventB], cue: 'invalid label on a mail move, worded differently' }));
    expect(lessons()).toHaveLength(1);
    const again = await call(d, base({ task_id: 'task-2', evidence_event_ids: [eventB], cue: 'a timeout while waiting' }));
    expect(again.isError).toBe(true);
  });

  it('the next cycle may record for the same task again', async () => {
    const d = getDreamerAgentId();
    await call(d, base());
    // A new ROUGH TASKS batch is built: that is the start of the next cycle.
    mockDb.current!.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('dreamer.lessons_batch_ms', ?)").run(String(Date.now() + 1000));
    expect((await call(d, base({ cue: 'a timeout while waiting' }))).isError).toBe(false);
    expect(lessons()).toHaveLength(2);
  });
});

describe('the owner hears once per cycle, through the existing card, and the main agent hears nothing', () => {
  it('one card for the cycle\'s lessons, worded for the owner', async () => {
    const d = getDreamerAgentId();
    const cycleStart = Date.now() - 1000;
    await call(d, base());
    await call(d, base({ cue: 'a timeout while waiting', task_id: 'task-2', evidence_event_ids: [eventB] }));
    expect(announceLessons(cycleStart)).toBe(2);
    const cards = broadcast.mock.calls.map((c) => c[0] as Record<string, any>).filter((e) => e.type === 'chat:error');
    expect(cards).toHaveLength(1);
    expect(cards[0].error).toMatch(/2 lessons/);
    expect(cards[0].severity).toBe('warning');
    expect(lessonReportLines(cycleStart).join(' ')).toMatch(/2 lessons/);
  });

  it('no lessons, no card', () => {
    expect(announceLessons(Date.now() - 1000)).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(lessonReportLines(Date.now() - 1000)).toEqual([]);
  });

  it('recording and announcing write no message to anyone', async () => {
    const before = (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    await call(getDreamerAgentId(), base());
    announceLessons(Date.now() - 1000);
    expect((mockDb.current!.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(before);
  });

  it('the Dreamer\'s tools policy gains lesson_record and still has no way to message another agent', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'maintenance.ts'), 'utf8');
    const policy = src.slice(src.indexOf('const DREAMER_TOOLS_POLICY'), src.indexOf('function getDreamerPermissions'));
    expect(policy).toContain("'lesson_record'");
    expect(policy).not.toContain("'send_to_agent'");
    expect(policy).not.toContain("'list_agents'");
  });
});
