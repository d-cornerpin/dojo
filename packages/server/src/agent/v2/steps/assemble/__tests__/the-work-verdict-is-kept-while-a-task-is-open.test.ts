// The "is this message work" verdict is recorded for every person's message, even while the agent has an open task
// it touched in the last half hour; only the start line is skipped then, as a follow-up rides under that task.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const openTask = { touched: false };
const stmt = (sql: string) => ({ all: () => [], run: () => ({ changes: 0 }), get: () => (openTask.touched && /FROM work w/.test(sql) ? { id: 'task-1' } : undefined) });
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: stmt }) }));
vi.mock('../../../../../config/platform.js', () => ({ isPMAgent: () => false, isHealerAgent: () => false, isDreamerAgent: () => false }));
vi.mock('../../../classifiers/inbound-routing.js', () => ({ inboundIsWork: async () => true }));

import { initState } from '../../../state.js';
import { detectMultistepAndScaffold } from '../multistep-detection.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const owner = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false } as TurnCounterparty;

async function judge(): Promise<{ work: boolean; steers: string[] }> {
  const turnCtx = { startAckSteerArmedThisTurn: false, startAckSteerRequested: false, startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null, inboundClassifiedAsWork: false };
  const state = { ...initState({ agentId: 'the-agent' } as Parameters<typeof initState>[0]), loopCount: 1 };
  const out = await detectMultistepAndScaffold(state, {
    agentId: 'the-agent', turnNumber: 3, turnCtx: turnCtx as never, db: {} as never, counterparty: owner,
    counterpartyIsAgentSender: false, lastUserMessageContent: 'Book the movers and send me three quotes.',
    engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 45,
  });
  return { work: turnCtx.inboundClassifiedAsWork, steers: out.steerQueue.pending.map((e) => e.floor) };
}

beforeEach(() => { openTask.touched = false; });

describe('the work verdict and an open task', () => {
  it('with an open task touched recently, the verdict is still recorded and no start line is armed', async () => {
    openTask.touched = true;
    expect(await judge()).toEqual({ work: true, steers: [] });
  });

  it('with no such task, the verdict is recorded and the start line is armed', async () => {
    expect(await judge()).toEqual({ work: true, steers: ['start-ack'] });
  });
});
