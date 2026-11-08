// A final reply on an assign thread, sent through the receiver's own send_to_agent, hands the assigned task
// in where that reply's delivery is recorded, whether the task is still Open or Working: finished with the
// reply's delivery as proof, can't be done on a FAIL. A progress reply hands in nothing.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran', isRunning: () => false }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { latestHandIn } from '../record.js';
import { freshBoard, call, stateOf, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

function anAssignThread(state: 'open' | 'claimed'): void {
  freshBoard();
  doneDb().prepare("UPDATE work SET state = ?, requester = 'agent', requester_id = ?, a2a_thread_id = 'thr-assign-1' WHERE id = ?").run(state, MAIN, TASK);
}

const reply = (intent: string, payload: string) =>
  call(WORKER, 'send_to_agent', { agent: MAIN, intent, payload, thread_id: 'thr-assign-1' });

const replyDelivery = (): string | undefined => (doneDb().prepare(
  "SELECT id FROM deliveries WHERE agent_id = ? AND tool = 'send_to_agent' ORDER BY rowid DESC LIMIT 1",
).get(WORKER) as { id: string } | undefined)?.id;

describe('a final reply on an assign thread hands the task in', () => {
  it('an answer on a still-Open assign task hands it in finished, with the reply\'s own delivery as proof', async () => {
    anAssignThread('open');
    const r = await reply('ANSWER', 'The report has 12 sections; the totals are on page 3.');
    expect(r.isError, r.content).toBe(false);
    expect(stateOf()).toBe('handed_in');
    expect(latestHandIn(TASK)).toMatchObject({ outcome: 'finished', filedBy: 'engine' });
    expect(latestHandIn(TASK)?.items.map((i) => i.ref)).toEqual([replyDelivery()]);
  });

  it('a FAIL reply hands it in as can\'t be done', async () => {
    anAssignThread('claimed');
    expect((await reply('FAIL', 'I cannot reach the shared drive, it refuses my credentials.')).isError).toBe(false);
    expect(stateOf()).toBe('handed_in');
    expect(latestHandIn(TASK)?.outcome).toBe('cant_be_done');
  });

  it('a progress reply hands in nothing', async () => {
    anAssignThread('claimed');
    expect((await reply('STATUS', 'Halfway through the sections now.')).isError).toBe(false);
    expect(stateOf()).toBe('claimed');
  });
});
