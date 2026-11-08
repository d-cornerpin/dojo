// The owner's start-and-finish rule: a turn that handed work in (the worker, or the engine for it) and
// is ending with nothing said to the person is steered once to say it. The decision comes later, in the
// decider's turn and steers nobody.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../db/connection.js', async () => (await import('../../../../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runSilentCloseout } from '../silent-closeout.js';
import { emptySteerQueue } from '../../../steer-queue.js';
import { freshBoard, handedIn, call, PM, WORKER, TASK } from '../../../../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../../../../work/done/__tests__/helpers/done-db.js';

const sqlText = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function endTurn(turnStartedMs: number): Promise<string[]> {
  const rows: string[] = [];
  const state = { steerQueue: emptySteerQueue(), surfacedReplyThisTurn: false, lastAssistantTextForIM: null, explicitSendThisTurn: {}, loopCount: 1 };
  const ctx = {
    agentId: WORKER, counterparty: { kind: 'user' }, counterpartyIsAgentSender: false, db: doneDb(), hasUnansweredUser: true,
    isA2ATurn: false, messageId: 'msg-end', persistAndBroadcastSystemRow: (t: string) => { rows.push(t); },
    turnCtx: { deferredUserReplyWithTools: false, address: undefined }, turnNumber: 9, turnStartedAt: sqlText(turnStartedMs),
  };
  await runSilentCloseout(state as never, ctx as never, { persistedContent: '' } as never);
  return rows;
}

describe('the finish steer fires on the hand-in turn', () => {
  beforeEach(() => freshBoard());

  it('a turn that handed the work in and said nothing is steered to tell the person', async () => {
    const start = Date.now() - 1_000;
    await handedIn();
    const steers = await endTurn(start);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatch(/this turn handed in the task "Write the report"/);
  });

  it('the turn in which the work is decided done is not steered: the hand-in was earlier', async () => {
    await handedIn();
    doneDb().prepare("UPDATE work_events SET created_at = created_at - 60000 WHERE kind = 'handed_in'").run();
    const start = Date.now() - 1_000;
    await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
    expect((await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report reached the owner' })).isError).toBe(false);
    expect(await endTurn(start)).toHaveLength(0);
  });
});
