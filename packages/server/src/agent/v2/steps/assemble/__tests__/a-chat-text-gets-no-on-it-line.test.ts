// The "on it" line follows one rule on every channel: it is armed for a message judged to be work, never for a
// chat question, whether it came by text or on the dashboard, and the start-line timer keeps the same rule.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => emptyStmt }) }));
vi.mock('../../../../../config/platform.js', () => ({ isPMAgent: () => false, isHealerAgent: () => false, isDreamerAgent: () => false }));
const verdict = { work: false };
vi.mock('../../../classifiers/inbound-routing.js', () => ({ inboundIsWork: async () => verdict.work }));

import { initState } from '../../../state.js';
import { detectMultistepAndScaffold } from '../multistep-detection.js';
import { runStartAck } from '../../preflight/start-ack.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const person = (channel: string, senderIsAgent = false): TurnCounterparty => ({
  kind: 'user', name: 'Owner Example', relation: 'owner', channel, senderId: channel === 'dashboard' ? null : '+15550000000', threadId: null, senderIsAgent,
} as TurnCounterparty);

async function firstCall(counterparty: TurnCounterparty, turnCtx: Record<string, unknown> = {}): Promise<string[]> {
  Object.assign(turnCtx, { startAckSteerArmedThisTurn: false, startAckSteerRequested: false, startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null, inboundClassifiedAsWork: undefined });
  const state = { ...initState({ agentId: 'the-agent' } as Parameters<typeof initState>[0]), loopCount: 1 };
  const out = await detectMultistepAndScaffold(state, {
    agentId: 'the-agent', turnNumber: 3, turnCtx: turnCtx as never, db: {} as never, counterparty,
    counterpartyIsAgentSender: counterparty.senderIsAgent, lastUserMessageContent: 'Did the internet go down?',
    engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 45,
  });
  return out.steerQueue.pending.map((e) => e.floor);
}

beforeEach(() => { verdict.work = false; });
afterEach(() => { vi.useRealTimers(); });

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

describe('the start-line timer on a chat question', () => {
  it('a dashboard question whose turn works past the timer still gets no "on it" line', async () => {
    vi.useFakeTimers();
    const turnCtx: Record<string, unknown> = { anyToolStartedThisTurn: true, engineStartAckDeliveredThisTurn: false, state: { explicitSendThisTurn: {} } };
    const out = runStartAck(turnCtx as never, { agentId: 'the-agent', engineStartAckAfterMs: 30_000 } as never, {
      db: { prepare: () => emptyStmt } as never, counterparty: person('dashboard'),
      triggerRow: { rowid: 1, id: 'm-1', conversation_id: 'conv-1' } as never, turnNumber: 3,
    });
    expect(await firstCall(person('dashboard'), turnCtx)).toEqual([]);
    vi.advanceTimersByTime(30_001);
    await out.fireStartAckIfOwed('first-tool');
    expect(turnCtx.startAckSteerRequested).toBe(false);
    clearTimeout(turnCtx.startAckTimer as ReturnType<typeof setTimeout>);
  });
});
