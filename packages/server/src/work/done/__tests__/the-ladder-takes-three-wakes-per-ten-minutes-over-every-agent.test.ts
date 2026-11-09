// The box takes at most three ladder wakes in any ten minutes over every agent, the project manager included;
// the PM is never armed again while its last wake has no report; and every due step is taken in a later window.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
const arms = vi.hoisted(() => [] as number[]);
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: () => { arms.push(Date.now()); } }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';
import { freshBoard, PM, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { turn, entries, resetLadderWorld, workingTask, anchorBack, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

const WORKERS = [WORKER, OTHER, FXID.n5, FXID.n6, FXID.n7, FXID.n8];
afterEach(() => { vi.useRealTimers(); });

describe('the ladder takes three wakes per ten minutes over every agent', () => {
  it('20 due rows across 6 agents and 5 waiting hand-ins, swept every 30 seconds', async () => {
    freshBoard(); resetLadderWorld(); anchorBack(30 * MIN);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    for (const a of WORKERS.slice(2)) doneDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'standard')").run(a, a);
    const rows = [TASK, ...Array.from({ length: 19 }, (_, i) => workingTask(`task-due-${i}`, WORKERS[(i + 1) % 6], `Job ${i}`, 10 * MIN))];
    const handIns = Array.from({ length: 5 }, (_, i) => {
      const id = `task-handed-${i}`;
      doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
        VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'handed_in', 'task', 1, 0, ?, ?, ?)`).run(id, WORKERS[i], id, `Handed ${i}`, start - 20 * MIN, start - 10 * MIN);
      doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'handed_in', ?, ?, ?)")
        .run(id, WORKERS[i], JSON.stringify({ outcome: 'finished', items: [], note: 'done', filedBy: WORKERS[i] }), start - 10 * MIN);
      return id;
    });
    const wakes: number[] = [];
    turn.during = () => { wakes.push(Date.now()); };
    let reports = 0;
    for (let t = 0; t <= 60 * MIN; t += 30_000) {
      vi.setSystemTime(start + t);
      const armed = arms.length;
      await runLadder();
      if (arms.length > armed) expect(armed, 'armed only once its last wake has a report').toBe(reports);
      wakes.push(...arms.slice(armed));
      if (arms.length > reports) {   // the review starts and writes its report before the next sweep
        doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, origin_intent, authorized, sent_at, created_at) VALUES (?, ?, 'events', 'user', 'report', 'pm_review', 1, ?, ?)")
          .run(`report-${reports}`, PM, Date.now() + 1, Date.now() + 1);
        reports = arms.length;
      }
    }
    for (const w of wakes) expect(wakes.filter((x) => x >= w && x < w + 10 * MIN).length, 'wakes in a 10-minute window').toBeLessThanOrEqual(3);
    expect(rows.map((id) => entries(id, LADDER_ENTRY.hint) > 0)).toEqual(rows.map(() => true));
    expect(handIns.map((id) => entries(id, LADDER_ENTRY.pm) > 0)).toEqual(handIns.map(() => true));
  });
});
