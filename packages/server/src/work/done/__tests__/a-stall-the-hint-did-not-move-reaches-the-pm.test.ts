// Still nothing one bound after the hint, or a third refused hand-in, and the PM's next report names the
// stalled task (the refusals with their texts). The report lists only hand-ins the PM owes a verdict on and
// the stalls the ladder marked, a stall is reported once, and one marked while a review runs is not lost.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { armDebouncedReview, runPMReview } from '../../../tracker/pm-agent.js';
import { engineHandIn } from '../hand-in.js';
import { freshBoard, handedIn, call, PM, WORKER, TASK } from './helpers/decision-world.js';
import { entries, lastReport, pmCanRun, resetLadderWorld, turn, turnTaken, MIN } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

function anotherTask(id: string, worker: string, title: string): void {
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, ?, 'The owner has it', ?, ?)`,
  ).run(id, worker, id, title, at, at);
}

beforeEach(() => { freshBoard(); pmCanRun(PM); resetLadderWorld(); vi.mocked(armDebouncedReview).mockClear(); });

describe('a stall the hint did not move reaches the PM', () => {
  it('one bound after the hint the task is marked for the PM, the PM is woken, and its report names it once', async () => {
    await runLadder(Date.now() + 6 * MIN);
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(0);
    turnTaken(WORKER);
    await runLadder(Date.now() + 11 * MIN);
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    expect(armDebouncedReview).toHaveBeenCalledWith(TASK, 'ladder');
    await runPMReview();
    expect(lastReport(PM)).toContain(`STALLED: "Write the report" [${TASK}]`);
    expect(lastReport(PM)).toContain('work_validate(action="retask"');
    const reports = (): number => (doneDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'pm_review'").get(PM) as { n: number }).n;
    doneDb().prepare("UPDATE messages SET created_at = created_at + 2000 WHERE agent_id = ? AND origin_intent = 'pm_review'").run(PM);
    await runPMReview();
    expect(reports()).toBe(1);
  });

  it('the report lists only the hand-ins the PM owes a verdict on and the stalls the ladder marked', async () => {
    await handedIn();
    anotherTask('task-quiet', WORKER, 'Tidy the folder');
    anotherTask('task-marked', WORKER, 'Book the venue');
    doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES ('task-marked', 'audit', 'engine', json_object('entry_kind', ?), ?)").run(LADDER_ENTRY.pm, Date.now());
    anotherTask('task-pm-own', PM, 'Sort the backlog');
    expect(engineHandIn('task-pm-own', 'the owner withdrew it', { outcome: 'cant_be_done' }).kind).toBe('handed_in');
    await runPMReview();
    const report = lastReport(PM);
    expect(report).toContain(`HANDED IN: "Write the report" [${TASK}]`);
    expect(report).toContain('Book the venue');
    expect(report).not.toContain('Tidy the folder');
    expect(report).not.toContain('Sort the backlog');
    expect(report).toMatch(/Proof \(open each item before approving\):\n {4}0\. /);
    expect(report).toContain('Sent back so far: never');
  });

  it('a third refused hand-in brings the PM in early, with the refusal texts', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'file', ref: `/tmp/missing-${i}.pdf` }], note: 'Done' });
      expect(r.isError).toBe(true);
    }
    await runLadder(Date.now());
    expect(entries(TASK, LADDER_ENTRY.pm)).toBe(1);
    await runPMReview();
    expect(lastReport(PM)).toContain('Its refused hand-ins:');
    expect(lastReport(PM)).toContain('/tmp/missing-2.pdf');
  });

  it('a stall marked while a review is running is reported by the review that follows it', async () => {
    await handedIn();
    anotherTask('task-late', WORKER, 'Book the venue');
    turn.during = () => {
      turn.during = () => {};
      doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES ('task-late', 'audit', 'engine', json_object('entry_kind', ?), ?)").run(LADDER_ENTRY.pm, Date.now() + 5_000);
      void runPMReview();
    };
    await runPMReview();
    await vi.waitFor(() => expect(lastReport(PM)).toContain('Book the venue'), { timeout: 30_000 });
  });
});
