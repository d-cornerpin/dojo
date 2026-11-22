// The owner's Stop ends the request being served for good: it is called off, its job is cancelled with it (a job
// with no request behind it is held with no due),
// and nothing serves it again, not after the turn ends and not after a restart. The engine self-wakes queued before
// a stopped turn are not served either; one tied to a person's request or scheduled run is, as is any queued after.
// A Stop at the turn's very start ends everything the turn took up, as one later in the turn does.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
const atFirstAwait = { run: null as null | (() => void) };   // runs at the turn start's first await
vi.mock('../../tools/tool-docs.js', async (orig) => ({ ...(await orig<object>()), rehydrateSessionToolsFromHistory: () => atFirstAwait.run?.() }));

import { runMigrations } from '../../db/migrations.js';
import { stopByOwner } from '../runtime.js';
import { nextOwed, dueOf } from '../v2/owed.js';
import { insertEngineEvent } from '../../memory/message-store.js';
import { startTurn, finalizeTurn } from '../v2/turn-record.js';
import { getPendingEngineEvent } from '../v2/counterparty.js';
import { stoppedAgents } from '../shared-state.js';
import { reconcileOrphanedClaims } from '../../work/orphaned-claims.js';
import { healStuckClaims } from '../../work/ask-remediation.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

// A run's start clears the Stop flag; these turns start without the runtime, so each test starts clear.
beforeEach(() => { freshAgentsDb(runMigrations); stoppedAgents.clear(); atFirstAwait.run = null; });

const nothingComesBack = (): void => {
  expect(nextOwed(HELPER)).toEqual([]);
  expect(dueOf(HELPER).now).toBe(false);
};

const queue = (content: string, rootKind: string | null = null) => insertEngineEvent({
  agentId: HELPER, content, originIntent: 'completion_report', work: rootKind ? { taskId: null, runId: null, rootKind, rootId: 'm-1' } : null,
});
const stoppedTurn = (): void => {
  finalizeTurn(HELPER, startTurn({ agentId: HELPER, kind: 'engine', subjectKind: null, subjectId: null, rootKind: null, rootId: null, sourceMessageId: null, convKey: null }), 'stop', false, null);
};

describe('stop ends the request and nothing serves it again', () => {
  it('Stop during the turn: the request is called off, and after a restart nothing finds it', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('stopped', () => expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 }));
    expect(rowOf(ask).state).toBe('abandoned');
    nothingComesBack();
    reconcileOrphanedClaims({ agentId: HELPER });
    healStuckClaims();
    expect(rowOf(ask).state).toBe('abandoned');
    nothingComesBack();
  });

  it('Stop on a job turn: its task is cancelled with its request, so the job never comes back', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await stretch('stopped', () => stopByOwner(HELPER));
    expect(rowOf(ask).state).toBe('abandoned');
    expect(rowOf(task)).toMatchObject({ state: 'abandoned', due: null });
    nothingComesBack();
  });

  it('Stop while the job is parked and the agent is idle ends the job with its request', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 });
    expect(rowOf(ask).state).toBe('abandoned');
    expect(rowOf(task)).toMatchObject({ state: 'abandoned', due: null });
    nothingComesBack();
  });

  it('Stop after the owner asked how the parked job is going ends that job, and after a restart nothing wakes it', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await ownerAsks('m-2', 'How is it going?');
    expect(await stretch('answers')).toMatchObject({ root: 'm-2' });
    const stopped = stopByOwner(HELPER);
    expect(stopped.nothingRunning).toBeUndefined();
    expect(stopped.ended).toBe(1);
    expect(rowOf(ask).state).toBe('abandoned');
    const by = testDb().prepare("SELECT json_extract(payload, '$.by') AS by FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1").get(ask);
    expect(by).toEqual({ by: 'owner' });
    expect(rowOf(task)).toMatchObject({ state: 'abandoned', due: null });
    nothingComesBack();
    reconcileOrphanedClaims({ agentId: HELPER });
    healStuckClaims();
    nothingComesBack();
  });

  it('Stop at the first moment of the turn carrying the job ends the question and the job\'s request with it', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const question = await ownerAsks('m-2', 'How is it going?');
    atFirstAwait.run = () => { stopByOwner(HELPER); };
    await stretch('stopped');
    expect([rowOf(question).state, rowOf(ask).state]).toEqual(['abandoned', 'abandoned']);
  });

  it('Stop ends a parked job whose hold was written before the hold named its task as evidence', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    testDb().prepare(`UPDATE work_events SET payload = json_set(json_remove(payload, '$.evidence_ref'), '$.reason', ?)
      WHERE id = (SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'transition')`).run(`held: its job is still running (task ${task})`, ask);
    expect(rowOf(ask).state).toBe('blocked');
    expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 });
    expect(rowOf(ask).state).toBe('abandoned');
    expect(rowOf(task)).toMatchObject({ state: 'abandoned', due: null });
    nothingComesBack();
  });

  it("Stop with the agent's own task parked and no request behind it ends that job", () => {
    seedTrackerTask(testDb(), { id: 'own-task', agentId: HELPER, title: 'Tidy the archive', next_attempt_at: Date.now() - 1_000 });
    expect(nextOwed(HELPER).map((i) => i.kind)).toEqual(['job']);
    expect(stopByOwner(HELPER).nothingRunning).toBeUndefined();
    expect(rowOf('own-task')).toMatchObject({ due: null, hold: 'paused' });
    nothingComesBack();
  });

  it('a self-wake queued before a stopped turn is neither owed nor served', () => {
    queue('report the finished task to the owner');
    expect(dueOf(HELPER).now).toBe(true);
    stoppedTurn();
    expect(getPendingEngineEvent(HELPER)).toBeNull();
    nothingComesBack();
  });

  it.each(['ask', 'occurrence'])("a wake tied to a person's request or schedule (%s) still stands after the Stop", (rootKind) => {
    const tied = queue('the delegated piece never came back', rootKind);
    stoppedTurn();
    expect(getPendingEngineEvent(HELPER)?.id).toBe(tied.id);
  });

  it('a self-wake queued after the Stop is served', () => {
    const before = queue('report the finished task to the owner');
    stoppedTurn();
    testDb().prepare('UPDATE messages SET created_at = created_at - 10000 WHERE id = ?').run(before.id);
    testDb().prepare("UPDATE turns SET ended_at = datetime('now', '-5 seconds') WHERE agent_id = ?").run(HELPER);
    const later = queue('report the next finished task');
    expect(getPendingEngineEvent(HELPER)?.id).toBe(later.id);
  });
});
