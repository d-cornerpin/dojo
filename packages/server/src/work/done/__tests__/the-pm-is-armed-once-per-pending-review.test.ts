// The ladder arms the project manager once per review: while that review has not finished, a newly due hand-in waits,
// however many sweeps pass inside one bound; it is armed once a PM turn finishes, or once the bound has passed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
const arms = vi.hoisted(() => [] as string[]);
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: (id: string) => { arms.push(id); } }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder } from '../ladder.js';
import { freshBoard, PM, WORKER, OTHER } from './helpers/decision-world.js';
import { resetLadderWorld, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

let start = 0;
function handedIn(id: string, worker: string, ago: number): void {
  doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
    VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'handed_in', 'task', 1, 0, ?, ?, ?)`).run(id, worker, id, id, start - 30 * MIN, start - ago);
  doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'handed_in', ?, ?, ?)")
    .run(id, worker, JSON.stringify({ outcome: 'finished', items: [], note: 'done', filedBy: worker }), start - ago);
}
async function sweepTo(min: number): Promise<void> { vi.setSystemTime(start + min * MIN); await runLadder(); }

beforeEach(() => {
  freshBoard(); resetLadderWorld(); arms.length = 0;
  doneDb().prepare("UPDATE work SET state = 'abandoned', closed_at = 1 WHERE kind = 'task'").run();
  start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  handedIn('task-first', WORKER, 10 * MIN);
  handedIn('task-second', OTHER, 4 * MIN);
});
afterEach(() => { vi.useRealTimers(); });

describe('the PM is armed once per pending review', () => {
  it('no second arm inside the bound while the review has not finished; armed again once it finishes', async () => {
    await sweepTo(0);
    expect(arms).toEqual(['task-first']);
    for (const m of [1, 2, 3, 4]) await sweepTo(m);
    expect(arms, 'the second hand-in waits for the pending review').toEqual(['task-first']);
    doneDb().prepare('INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason) VALUES (?, 1, ?, ?, 1, ?)').run(PM, new Date(start + 4 * MIN).toISOString(), new Date(start + 4 * MIN).toISOString(), 'answered');
    await sweepTo(4.5);
    expect(arms).toEqual(['task-first', 'task-second']);
  });

  it('a review that never finishes stops blocking once the bound has passed', async () => {
    await sweepTo(0);
    for (const m of [1, 2, 3, 4.5]) await sweepTo(m);
    expect(arms).toEqual(['task-first']);
    await sweepTo(5.5);
    expect(arms, 'armed again past the bound').toHaveLength(2);
  });
});
