// The PM's effort review: a verdict that cannot be used (unparseable, or the model did not answer)
// used to leave the request pending and the same question was asked again every tick, unchanged,
// for ever. Now each failed verdict is recorded with its reason; the next ask carries that reason;
// and when the PM has failed to give a usable verdict on the SAME request twice in a row, the
// owner is told through the PM's own chat line and the request is closed (not asked again).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-pm-effort-failed-verdict');
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pm-effort-failed-verdict');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pm-effort-failed-verdict', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined), getAgentUptime: () => 0 }),
  stopAgent: vi.fn(),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async () => ({ delivered: true })),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
const { asked, reply } = vi.hoisted(() => ({
  asked: [] as string[],
  reply: { text: '' as string | null, throws: false },
}));
vi.mock('../../agent/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/model.js')>()),
  callModel: vi.fn(async (p: { messages: Array<{ content: string }> }) => {
    asked.push(p.messages[0].content);
    if (reply.throws) throw new Error('aborted: latency budget');
    return { content: reply.text };
  }),
}));

import { runMigrations } from '../../db/migrations.js';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { runEffortReview, queueEffortReviewIfNeeded, findPendingEffortReviewTaskIds } from '../pm-agent.js';
import { EFFORT_REVIEW_DELTA_CALLS } from '../effort-governor.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const db = (): Database.Database => mockDb.current!;
const GOOD = (id: string): string => JSON.stringify({ advancing: true, reason: 'landing progress', task_id: id });
const ownerNotes = (id: string): string[] => (db().prepare(
  "SELECT content FROM messages WHERE task_id = ? AND role = 'assistant' AND agent_id = 'pm'",
).all(id) as Array<{ content: string }>).map((r) => r.content);
const failedRows = (id: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'effort_review_failed'",
).get(id) as { n: number }).n;
const baseline = (id: string): number => (db().prepare('SELECT effort_reviewed_calls AS b FROM work WHERE id = ?').get(id) as { b: number }).b;

function pendingTask(id: string): void {
  seedTrackerTask(db(), { id, agentId: 'helper', status: 'in_progress', title: 'Sweep the mailbox' } as never);
  db().prepare('UPDATE work SET effort_calls = ?, effort_reviewed_calls = 0 WHERE id = ?').run(EFFORT_REVIEW_DELTA_CALLS, id);
  expect(queueEffortReviewIfNeeded(id)).toBe(true);
}

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'P', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'M', 'm')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('helper', 'Helper', 'idle', 'm-a', 'apprentice'), ('pm', 'PM', 'idle', 'm-a', 'sensei')`).run();
  asked.length = 0;
  reply.text = ''; reply.throws = false;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a failed effort verdict is learned from, then handed to the owner', () => {
  it('an unusable answer is recorded with its reason, and the next ask carries that reason', async () => {
    pendingTask('t-1');
    reply.text = 'sorry, I got distracted';
    await runEffortReview('t-1');
    expect(failedRows('t-1')).toBe(1);
    expect(baseline('t-1')).toBe(0);                       // still pending: one more try
    reply.text = GOOD('t-1');
    await runEffortReview('t-1');
    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toContain('last answer');
    expect(asked[1]).toContain('Your last answer to this question could not be used');
    expect(asked[1]).toContain('JSON object');             // what was wrong with it
    expect(baseline('t-1')).toBeGreaterThan(0);            // the usable answer resolved it
    expect(ownerNotes('t-1')).toEqual([]);
  });

  it('a timed-out call is not the PM answering badly: nothing is recorded, and two in a row never reach the owner', async () => {
    pendingTask('t-2');
    reply.throws = true;
    await runEffortReview('t-2');
    await runEffortReview('t-2');
    expect(failedRows('t-2')).toBe(0);
    expect(ownerNotes('t-2')).toEqual([]);
    expect(findPendingEffortReviewTaskIds()).toContain('t-2');   // still pending: the next tick asks again
    reply.throws = false; reply.text = GOOD('t-2');
    await runEffortReview('t-2');
    expect(asked[2]).not.toContain('last answer');
    expect(baseline('t-2')).toBeGreaterThan(0);
  });

  it('two unusable answers in a row on the same request: the owner is told and the PM is not asked again', async () => {
    pendingTask('t-3');
    reply.text = 'no';
    await runEffortReview('t-3');
    expect(ownerNotes('t-3')).toEqual([]);
    await runEffortReview('t-3');
    const notes = ownerNotes('t-3');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Sweep the mailbox');
    expect(findPendingEffortReviewTaskIds()).not.toContain('t-3');   // closed: no third ask
    await runEffortReview('t-3');
    expect(asked).toHaveLength(2);
  });

  it('a timeout between two unusable answers does not break or add to the run', async () => {
    pendingTask('t-5');
    reply.text = 'no';
    await runEffortReview('t-5');
    reply.throws = true;
    await runEffortReview('t-5');
    expect(ownerNotes('t-5')).toEqual([]);
    reply.throws = false;
    await runEffortReview('t-5');
    expect(ownerNotes('t-5')).toHaveLength(1);
  });

  it('a usable answer between two failures breaks the run: failures count per request, in a row', async () => {
    pendingTask('t-4');
    reply.text = 'no';
    await runEffortReview('t-4');                          // failure 1 of request A
    reply.text = GOOD('t-4');
    await runEffortReview('t-4');                          // resolves request A
    db().prepare('UPDATE work SET effort_calls = effort_calls + ? WHERE id = ?').run(EFFORT_REVIEW_DELTA_CALLS, 't-4');
    expect(queueEffortReviewIfNeeded('t-4')).toBe(true);   // request B
    reply.text = 'no';
    await runEffortReview('t-4');                          // failure 1 of request B, not 2
    expect(ownerNotes('t-4')).toEqual([]);
    expect(findPendingEffortReviewTaskIds()).toContain('t-4');
  });
});
