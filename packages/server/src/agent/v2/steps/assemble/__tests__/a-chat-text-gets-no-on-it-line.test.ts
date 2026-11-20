// The "on it" line follows one rule on every channel: it is armed for a message judged to be work, never for a
// chat question, whether it came by text or on the dashboard.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => emptyStmt }) }));
vi.mock('../../../../../config/platform.js', () => ({ isPMAgent: () => false, isHealerAgent: () => false, isDreamerAgent: () => false }));
const verdict = { work: false };
vi.mock('../../../classifiers/inbound-routing.js', () => ({ inboundIsWork: async () => verdict.work }));

import { initState } from '../../../state.js';
import { detectMultistepAndScaffold } from '../multistep-detection.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const person = (channel: string, senderIsAgent = false): TurnCounterparty => ({
  kind: 'user', name: 'Owner Example', relation: 'owner', channel, senderId: channel === 'dashboard' ? null : '+15550000000', threadId: null, senderIsAgent,
} as TurnCounterparty);

async function firstCall(counterparty: TurnCounterparty): Promise<string[]> {
  const turnCtx = { startAckSteerArmedThisTurn: false, startAckSteerRequested: false, startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null, inboundClassifiedAsWork: false };
  const state = { ...initState({ agentId: 'the-agent' } as Parameters<typeof initState>[0]), loopCount: 1 };
  const out = await detectMultistepAndScaffold(state, {
    agentId: 'the-agent', turnNumber: 3, turnCtx: turnCtx as never, db: {} as never, counterparty,
    counterpartyIsAgentSender: counterparty.senderIsAgent, lastUserMessageContent: 'Did the internet go down?',
    engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 45,
  });
  return out.steerQueue.pending.map((e) => e.floor);
}

beforeEach(() => { verdict.work = false; });

describe('the "on it" line on a text', () => {
  it('a chat question by iMessage arms nothing', async () => {
    expect(await firstCall(person('imessage'))).toEqual([]);
  });

  it('a work request by iMessage arms one start line on the first call', async () => {
    verdict.work = true;
    expect(await firstCall(person('imessage'))).toEqual(['start-ack']);
  });

  it('the dashboard follows the same rule', async () => {
    expect(await firstCall(person('dashboard'))).toEqual([]);
    verdict.work = true;
    expect(await firstCall(person('dashboard'))).toEqual(['start-ack']);
  });

  it('an agent-flagged sender never gets one, work or not', async () => {
    verdict.work = true;
    expect(await firstCall(person('imessage', true))).toEqual([]);
  });
});
