// ════════════════════════════════════════════════════════════════════════════════════════
// THE SMS ACK ARM MARKS ONLY WHAT ACTUALLY LEFT.
//
// `sendSms` does not throw on a refused send (it returns `{ ok: false, error }`), and the one
// reply sender keeps that value for the start line as for every reply: the routing marker is the
// record of what reached the person, and a refused text must not arrive in the conversation as
// "[Reply routed via SMS to <person>]". Twilio is faked at `sendSms` + `getDefaultFromNumber`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sms = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../../../../db/connection.js', async () => (await import('../../../__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../../../twilio/client.js', () => ({ sendSms: (...a: unknown[]) => sms.send(...a) }));
vi.mock('../../../../../twilio/auth.js', () => ({ getDefaultFromNumber: () => '+15550009999' }));

import { runMigrations } from '../../../../../db/migrations.js';
import { START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import { runTurnClosures } from '../turn-closures.js';
import { deliverDueReplies } from '../../../channel-sender.js';
import { freshReplyDb, testDb, AGENT } from '../../../__tests__/helpers/reply-sender.js';
import { FX } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

/** The start line as the turn delivers it to an SMS asker, then one pass of the reply sender. */
async function startLine(): Promise<void> {
  const turnCtx = { root: { kind: 'ask', id: 'ask-1', sourceMessageId: 'm-1', conversationId: 'conv-1' }, state: { inboundContext: { smsFromNumber: '+15551112222' } } };
  const counterparty = { kind: 'user', name: FX.n11, relation: 'owner', channel: 'sms', senderId: '+15551112222', threadId: null, senderIsAgent: false };
  const { deliverEngineUserAck } = runTurnClosures(turnCtx as never, { agentId: AGENT } as never, { terminalAnswerRowId: null } as never, {
    counterparty: counterparty as never, chosenConvKey: 'sms', chosenConversationId: 'conv-1', turnNumber: 9, revertTriggerStampOnAbort: () => {},
  });
  await deliverEngineUserAck('On it.', START_ACK_ORIGIN_INTENT, null, 'agent-text');
  await deliverDueReplies(Date.now());
}

const markers = (): string[] => (testDb().prepare("SELECT content FROM messages WHERE role = 'system' ORDER BY rowid").all() as Array<{ content: string }>).map((r) => r.content);
const SENT = '[Reply routed via SMS to a person]';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  testDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('twilio_sms_approved_senders', JSON.stringify([{ address: '+15551112222', name: 'a person' }]));
  sms.send.mockReset();
});

describe('the SMS start line: the marker follows the send, not the other way round', () => {
  it('a refused send is never marked sent', async () => {
    sms.send.mockResolvedValue({ ok: false, error: 'Twilio 21211: invalid To number' });
    await startLine();
    expect(sms.send).toHaveBeenCalledWith('+15551112222', 'On it.', '+15550009999');
    expect(markers()).not.toContain(SENT);
    expect(testDb().prepare('SELECT outcome FROM deliveries').all()).toEqual([{ outcome: 'failed' }]);
  });

  it('a delivered send keeps the same marker wording it always wrote', async () => {
    sms.send.mockResolvedValue({ ok: true, data: { sid: 'SM1' } });
    await startLine();
    expect(markers().at(-1)).toBe(SENT);
  });

  it('the ack row itself stands in chat whichever way the send went', async () => {
    sms.send.mockResolvedValue({ ok: false, error: 'Twilio 21211: invalid To number' });
    await startLine();
    expect(testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND content = 'On it.'").get()).toEqual({ n: 1 });
  });
});
