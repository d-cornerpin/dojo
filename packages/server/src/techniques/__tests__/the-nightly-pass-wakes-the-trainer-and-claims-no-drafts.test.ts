// The nightly learning pass wakes the Trainer with its batch, tells the main agent it asked the Trainer to
// draft (never that drafts exist), counts a lesson as fed only once the Trainer's turn took the batch up, and
// names a flagged technique once, not every night.

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const wake = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));
const notice = vi.hoisted(() => vi.fn());
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: notice }));
vi.mock('../../memory/vector-search.js', () => ({ vectorSearch: async () => [] }));

const { scratchDojo, MAIN } = await import('../../agent/tools/__tests__/scratch-dojo.js');
await scratchDojo('nightly-pass');
const { getDb } = await import('../../db/connection.js');
const { clearPlatformConfigCache } = await import('../../config/platform.js');
const { runDistillationCycle } = await import('../distillation.js');

const TRAINER = 'agent-trainer';
const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, spawn_depth, created_by) VALUES (?, 'trainer', 'idle', '{}', 'sensei', 1, ?)").run(TRAINER, MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('trainer_agent_id', ?)").run(TRAINER);
  clearPlatformConfigCache();
});

function lesson(id: string, cue: string): void {
  const at = Date.now();
  getDb().prepare(
    `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
     VALUES (?, ?, 'task-1', ?, 'use the saved filter first', '[1]', 0.7, 'technique', ?, ?)`,
  ).run(id, MAIN, cue, at, at + 90 * DAY);
}

function doneTask(id: string, title: string): void {
  const db = getDb(), at = Date.now();
  db.prepare("INSERT INTO deliveries (id, agent_id, tool, channel, outcome) VALUES (?, ?, 'send_message', 'chat', 'delivered')").run(`del-${id}`, MAIN);
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at, closed_at, result_delivery_id)
     VALUES (?, 'task', ?, 'schedule', 'legacy', 'legacy', 'done', 'FYI', 0, 0, ?, ?, ?, ?, ?)`,
  ).run(id, MAIN, title, at, at, at, `del-${id}`);
}

const trainerBatches = () => getDb().prepare(
  "SELECT id, content FROM messages WHERE agent_id = ? AND source_agent_id = 'system' ORDER BY seq",
).all(TRAINER) as Array<{ id: string; content: string }>;

describe('the nightly pass wakes the Trainer and claims no drafts', () => {
  it('wakes the Trainer and tells the main agent it asked for drafts', async () => {
    for (const [i, d] of ['6/3', '6/10', '6/17'].entries()) doneTask(`w${i}`, `Send weekly status email ${d}`);
    lesson('l1', 'moving mail to junk');
    await runDistillationCycle();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]).toContain(TRAINER);
    expect(trainerBatches()).toHaveLength(1);
    const brief = (notice.mock.calls[0][0] as { brief: string }).brief;
    expect(brief).toContain('Asked the Trainer to draft 1 technique');
    expect(brief).not.toMatch(/\bDrafted\b/);
  });

  it('offers a lesson again until the Trainer took the batch up, then never again', async () => {
    await runDistillationCycle();
    expect(trainerBatches()).toHaveLength(2);
    expect(trainerBatches()[1].content).toContain('moving mail to junk');

    getDb().prepare('UPDATE messages SET served_by_turn = 1 WHERE id = ?').run(trainerBatches()[1].id);
    getDb().prepare("UPDATE work SET updated_at = 0 WHERE id LIKE 'w%'").run();
    await runDistillationCycle();
    expect(trainerBatches()).toHaveLength(2);
  });

  it('names a flagged technique once, not every night', async () => {
    const db = getDb();
    db.prepare("INSERT INTO techniques (id, name, directory_path, state) VALUES ('t-bad', 'Bad one', '/nowhere', 'published')").run();
    const use = db.prepare("INSERT INTO technique_usage (id, technique_id, agent_id, success, used_at) VALUES (?, 't-bad', ?, 0, datetime('now'))");
    for (let i = 0; i < 5; i++) use.run(`u${i}`, MAIN);
    notice.mockClear();
    await runDistillationCycle();
    await runDistillationCycle();
    const briefs = notice.mock.calls.map((c) => (c[0] as { brief: string }).brief);
    expect(briefs.filter((b) => b.includes('"Bad one"'))).toHaveLength(1);
  });
});
