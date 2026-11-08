// A final reply on an assign thread hands the assigned task in where the reply lands, whether the task is
// still Open or Working: finished on the delivery that proves it, can't be done on a FAIL. A progress
// reply hands in nothing.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { deliverA2AMessage } from '../../../agent/a2a-transport.js';
import { latestHandIn } from '../record.js';
import { freshBoard, stateOf, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

function anAssignThread(state: 'open' | 'claimed'): void {
  freshBoard();
  doneDb().prepare("UPDATE work SET state = ?, requester = 'agent', requester_id = ?, a2a_thread_id = 'thr-assign-1' WHERE id = ?").run(state, MAIN, TASK);
}

function aDeliveryOnTheThread(intent: string, text: string): void {
  const at = Math.floor(Date.now() / 1000) * 1000;
  const body = `[A2A:${intent} thread:thr-assign-1] ${text}`;
  doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at) VALUES ('msg-ans', ?, 'a2a', 'assistant', ?, 1, ?, ?)").run(WORKER, body, at, at);
  doneDb().prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, detail, outcome, created_at, updated_at)
     VALUES ('dlv-ans', ?, 'send_to_agent', 'a2a', ?, 'msg-ans', ?, 'delivered', datetime('now'), datetime('now'))`,
  ).run(WORKER, MAIN, body);
}

const reply = (intent: string, payload: string) =>
  deliverA2AMessage({ intent: intent as never, threadId: 'thr-assign-1', fromAgent: WORKER, toAgent: MAIN, requiresResponse: false, payload });

describe('a final reply on an assign thread hands the task in', () => {
  it('an answer on a still-Open assign task hands it in finished, on that delivery', async () => {
    anAssignThread('open');
    aDeliveryOnTheThread('ANSWER', 'The report has 12 sections; the totals are on page 3.');
    await reply('ANSWER', 'The report has 12 sections; the totals are on page 3.');
    expect(stateOf()).toBe('handed_in');
    expect(latestHandIn(TASK)).toMatchObject({ outcome: 'finished', filedBy: 'engine' });
    expect(latestHandIn(TASK)?.items.map((i) => i.ref)).toEqual(['dlv-ans']);
  });

  it('a FAIL reply hands it in as can\'t be done', async () => {
    anAssignThread('claimed');
    await reply('FAIL', 'I cannot reach the shared drive, it refuses my credentials.');
    expect(stateOf()).toBe('handed_in');
    expect(latestHandIn(TASK)?.outcome).toBe('cant_be_done');
  });

  it('a progress reply hands in nothing', async () => {
    anAssignThread('claimed');
    await reply('STATUS', 'Halfway through the sections now.');
    expect(stateOf()).toBe('claimed');
  });
});
