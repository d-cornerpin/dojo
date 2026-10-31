// ════════════════════════════════════════════════════════════════════════════════════════
// THE SMS ACK ARM MARKS ONLY WHAT ACTUALLY LEFT.
//
// `sendSms` does not throw on a refused send — it returns `{ ok: false, error }` — so the
// ack arm has to keep that value the way the end-of-turn SMS reply does
// (`finalize/channel-push.ts`) and the Teams arm of this same function already does: the
// routing marker is the record of what reached the person, and a refused text must not
// arrive in the conversation as "[Reply routed via SMS to <person>]". The harness below is
// the Teams ack file's harness (`the-ack-reaches-teams-and-never-email.test.ts`), reused;
// the twilio mocks are the only additions — the arm reaches Twilio through
// `sendSms` + `getDefaultFromNumber`, and both are declared rather than touched.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { broadcastSpy, insertSpy, executeToolSpy, outboundIntents, engineMayRouteToSpy } = vi.hoisted(() => ({
  broadcastSpy: vi.fn(),
  insertSpy: vi.fn(),
  executeToolSpy: vi.fn(async () => ({ kind: 'applied', result: { content: 'sent' } })),
  outboundIntents: [] as Array<Record<string, unknown>>,
  engineMayRouteToSpy: vi.fn((_agentId: string, _channel: string) => true),
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: broadcastSpy }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: insertSpy,
}));
vi.mock('../../../../tools/index.js', () => ({
  executeTool: (...a: unknown[]) => executeToolSpy(...(a as [])),
}));
vi.mock('../../../outbound.js', () => ({
  withOutboundAsync: async (intent: Record<string, unknown>, fn: () => Promise<unknown>) => {
    outboundIntents.push(intent);
    return fn();
  },
}));
vi.mock('../../../../../contacts/resolve-recipient.js', () => ({
  resolveRecipientDisplay: (_c: string, id: string) => id,
}));
vi.mock('../../../../access/engine-route.js', () => ({
  engineMayRouteTo: (...a: unknown[]) => engineMayRouteToSpy(...(a as [string, string])),
}));
vi.mock('../../../../turn-state.js', () => ({ continuationContext: { set: vi.fn() } }));

const { sendSmsSpy } = vi.hoisted(() => ({ sendSmsSpy: vi.fn() }));
vi.mock('../../../../../twilio/client.js', () => ({ sendSms: (...a: unknown[]) => sendSmsSpy(...a) }));
vi.mock('../../../../../twilio/auth.js', () => ({ getDefaultFromNumber: () => '+15550009999' }));

import { runTurnClosures } from '../turn-closures.js';
import { type TurnCounterparty } from '../../../counterparty.js';
import type { PreflightContext, PreflightScratch } from '../index.js';
import type { TurnContext } from '../../../../turn-context.js';
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;

const person = (over: Partial<TurnCounterparty> = {}): TurnCounterparty => ({
  kind: 'user', name: FX.n11, relation: 'owner', channel: 'imessage',
  senderId: '+15550000000', threadId: null, senderIsAgent: false, ...over,
} as TurnCounterparty);

/** The ack closure as the turn hands it out, with only what its body reads. */
function ackFor(counterparty: TurnCounterparty, inboundContext: Record<string, unknown> | null) {
  const turnCtx = {
    root: { conversationId: 'conv-1' },
    state: { inboundContext },
  } as unknown as TurnContext;
  const sc: PreflightScratch = {
    claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null,
  };
  return runTurnClosures(
    turnCtx,
    { agentId: AGENT } as unknown as PreflightContext,
    sc,
    {
      counterparty, chosenConvKey: 'teams:chat', chosenConversationId: 'conv-1',
      turnNumber: 9, revertTriggerStampOnAbort: vi.fn(),
    },
  ).deliverEngineUserAck;
}

const routingMarkers = (): string[] => insertSpy.mock.calls
  .map((c) => c[0] as { role?: string; content?: string })
  .filter((m) => m.role === 'system')
  .map((m) => m.content ?? '');

beforeEach(() => {
  broadcastSpy.mockClear(); insertSpy.mockClear(); executeToolSpy.mockClear();
  sendSmsSpy.mockReset();
  outboundIntents.length = 0;
  engineMayRouteToSpy.mockClear();
  engineMayRouteToSpy.mockReturnValue(true);
});

describe('the SMS ack arm: the marker follows the send, not the other way round', () => {
  it('RED: a refused send goes nowhere and marks nothing — no SMS to anyone in the record', async () => {
    sendSmsSpy.mockResolvedValue({ ok: false, error: 'Twilio 21211: invalid To number' });
    const deliver = ackFor(person({ channel: 'sms', senderId: '+15551112222' }),
      { smsFromNumber: '+15551112222' });
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(sendSmsSpy).toHaveBeenCalledTimes(1);
    expect(sendSmsSpy).toHaveBeenCalledWith('+15551112222', 'On it.', '+15550009999');
    expect(routingMarkers().some((m) => m.includes('SMS to'))).toBe(false);
  });

  it('GREEN (before and after): a delivered send keeps the same marker wording it always wrote', async () => {
    sendSmsSpy.mockResolvedValue({ ok: true, data: { sid: 'SM1' } });
    const deliver = ackFor(person({ channel: 'sms', senderId: '+15551112222' }),
      { smsFromNumber: '+15551112222' });
    await deliver('On it.', 'start_ack', null, 'agent-text');
    expect(routingMarkers().some((m) => m.includes('SMS to +15551112222'))).toBe(true);
  });

  it('the ack row itself stands in chat whichever way the send went', async () => {
    sendSmsSpy.mockResolvedValue({ ok: false, error: 'Twilio 21211: invalid To number' });
    await ackFor(person({ channel: 'sms', senderId: '+15551112222' }),
      { smsFromNumber: '+15551112222' })('On it.', 'start_ack', null, 'agent-text');
    expect(insertSpy.mock.calls.some((c) => (c[0] as { role?: string }).role === 'assistant')).toBe(true);

    sendSmsSpy.mockResolvedValue({ ok: true, data: { sid: 'SM1' } });
    await ackFor(person({ channel: 'sms', senderId: '+15551112222' }),
      { smsFromNumber: '+15551112222' })('On it.', 'start_ack', null, 'agent-text');
    expect(insertSpy.mock.calls.some((c) => (c[0] as { role?: string }).role === 'assistant')).toBe(true);
  });
});
