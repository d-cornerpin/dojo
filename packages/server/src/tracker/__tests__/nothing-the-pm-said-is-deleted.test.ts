// Nothing the project manager said, heard or decided is deleted: after a hundred reviews and the agents'
// answers, on a store that already holds its old summaries, every row is still stored and searchable.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import { runPMReview } from '../pm-agent.js';
import { insertMessage } from '../../memory/message-store.js';
import { createLeafSummary } from '../../memory/dag.js';
import { freshBoard, call, deliveredToOwner, PM, WORKER } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { pmCanRun, turn } from '../../work/done/__tests__/helpers/ladder-world.js';

/** A board task worked by the worker, handed in with real proof. */
async function handIn(id: string, title: string): Promise<void> {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The owner has it', ?, ?)`,
  ).run(id, WORKER, id, title, at, at);
  const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Sent' });
  if (r.isError) throw new Error(r.content);
}

const pmRows = (): number => (doneDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?').get(PM) as { n: number }).n;

describe('nothing the PM said or heard is deleted', () => {
  it('keeps every report, reply and answer through a hundred reviews, and finds the oldest by search', async () => {
    freshBoard(); pmCanRun(PM);
    let n = 0;
    turn.during = () => {
      n += 1;
      insertMessage({ agentId: PM, role: 'assistant', content: `Review ${n}: looked at the hand-in.` });
      insertMessage({ agentId: PM, role: 'user', lane: 'a2a', sourceAgentId: WORKER, a2aThreadId: `thread-${n}`, a2aIntent: 'ANSWER',
        content: n === 1 ? 'The marmalade figures are in column B.' : `Answer ${n}: nothing new.` });
    };
    await handIn('task-first', 'Count the quokka census');
    await runPMReview();
    const first = doneDb().prepare('SELECT id FROM messages WHERE agent_id = ? ORDER BY seq').all(PM) as Array<{ id: string }>;
    // The store as boxes hold it today: the PM's older rows already have a summary.
    createLeafSummary(PM, 'The first review.', 20, first.map((r) => r.id), '2026-01-01 00:00:00', '2026-01-01 00:01:00');
    for (let i = 1; i < 100; i += 1) {
      if (i % 2 === 1) await handIn(`task-${i}`, `Write report ${i}`);
      await runPMReview();
    }
    expect(n).toBe(100);
    expect(pmRows(), 'a report, a reply and an answer per review').toBe(300);
    for (const word of ['quokka', 'marmalade']) {
      const found = await call(PM, 'history_search', { pattern: word, scope: 'messages' });
      expect(found.content, word).toContain('RAW MESSAGES');
    }
  });
});
