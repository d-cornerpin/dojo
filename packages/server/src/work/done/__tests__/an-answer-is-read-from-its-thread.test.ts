// The answer to a PM question is read from the question's own thread, whatever the asked agent is called now: a
// renamed agent, a name reused after a termination, or two agents of one name. The answer is shown, by the
// answering agent's name, and the hold on the hand-in ends.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../memory/embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, handedIn, call, PM, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { pmCanRun, resetLadderWorld, review } from './helpers/ladder-world.js';

const rename = (id: string, name: string): void => { doneDb().prepare('UPDATE agents SET name = ? WHERE id = ?').run(name, id); };
const agent = (id: string, name: string, status: string): void => {
  doneDb().prepare("INSERT INTO agents (id, name, status, classification, created_at) VALUES (?, ?, ?, 'ronin', datetime('now', '+1 minute'))").run(id, name, status);
};

/** The PM asks the worker by `name` in a review; the worker answers on that thread. */
async function askedByNameAndAnswered(name: string, between: () => void = () => {}): Promise<void> {
  await handedIn();
  await review(PM, async () => {
    expect((await call(PM, 'send_to_agent', { agent: name, intent: 'QUESTION', payload: 'Which sheet holds the totals?' })).isError).toBe(false);
  });
  const thread = (doneDb().prepare("SELECT thread_id FROM tool_receipts WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1").get(PM) as { thread_id: string }).thread_id;
  between();
  expect((await call(WORKER, 'send_to_agent', { agent: PM, intent: 'ANSWER', payload: 'Sheet 3 holds the totals.', thread_id: thread })).isError).toBe(false);
}

beforeEach(() => { resetLadderWorld(); freshBoard(); pmCanRun(PM); rename(WORKER, 'Sheet clerk'); });

describe('an answer is read from its thread', () => {
  it('an agent renamed after the question', async () => {
    await askedByNameAndAnswered('Sheet clerk', () => rename(WORKER, 'Totals clerk'));
    const report = await review(PM);
    expect(report, 'the hold ended at the answer').toContain(TASK);
    expect(report).toContain('Totals clerk answered');
    expect(report).toContain('Sheet 3 holds the totals.');
  });

  it('a name reused by a newer agent after the asked one ended', async () => {
    await askedByNameAndAnswered('Sheet clerk');
    doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
    agent('agent-new-clerk', 'Sheet clerk', 'idle');
    const report = await review(PM);
    expect(report).toContain(TASK);
    expect(report).toContain('Sheet 3 holds the totals.');
  });

  it('two agents of one name, the newer one ended', async () => {
    agent('agent-old-twin', 'Sheet clerk', 'terminated');
    await askedByNameAndAnswered('Sheet clerk');
    const report = await review(PM);
    expect(report, 'the hold ended at the answer').toContain(TASK);
    expect(report).toContain('Sheet 3 holds the totals.');
  });
});
