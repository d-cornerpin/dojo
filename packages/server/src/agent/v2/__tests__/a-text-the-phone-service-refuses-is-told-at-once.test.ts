// The phone service refuses a text for a reason that cannot clear (a 4xx that is not a rate limit): the text fails on
// its first try, the reminder queued behind it for the same person is tried at once and fails the same way, and one
// owner card counts both. A rate limit is still waited out.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../twilio/auth.js', () => ({ getTwilioCreds: () => ({ sid: 'AC-test', token: 'test-token' }), getDefaultFromNumber: () => '+15550009999' }));

import { runMigrations } from '../../../db/migrations.js';
import { queueReply } from '../deliveries.js';
import { deliverDueReplies } from '../channel-sender.js';
import { servedOwnerNotices } from '../../../healer/owner-notice-kinds.js';
import { freshReplyDb, replyRows, testDb, AGENT } from './helpers/reply-sender.js';

const ASKER = '+15555550155';
const twilio = vi.fn();
const answer = (status: number, message: string) => twilio.mockImplementation(async () => new Response(JSON.stringify({ message }), { status }));

/** The answer to the asker's text, then the reminder they set, both queued for their number. */
async function twoTextsQueued(): Promise<void> {
  const address = { channel: 'sms' as const, to: ASKER, from: null };
  await queueReply({ agentId: AGENT, turnNumber: 1, root: { kind: 'ask', id: 'm-1', sourceMessageId: 'm-1', conversationId: 'conv-sms' }, text: 'The vet is open until six.', address });
  await queueReply({ agentId: AGENT, turnNumber: 2, root: { kind: 'occurrence', id: 'run-1', sourceMessageId: null, conversationId: 'conv-sms' }, text: 'Time to feed the cat.', address });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  testDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('twilio_sms_approved_senders', JSON.stringify([{ address: ASKER, name: 'a person' }]));
  twilio.mockReset();
  vi.stubGlobal('fetch', twilio);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('a text the phone service refuses is told at once', () => {
  it('an invalid number: both texts fail on their first try and one card counts both', async () => {
    answer(400, "Invalid 'To' Phone Number");
    await twoTextsQueued();
    await deliverDueReplies(Date.now());
    await deliverDueReplies(Date.now() + 1_000);
    expect(replyRows().map((r) => [r.outcome, r.attempts])).toEqual([['failed', 1], ['failed', 1]]);
    expect(twilio).toHaveBeenCalledTimes(2);
    expect(servedOwnerNotices().map((c) => c.words)).toEqual([expect.stringMatching(/^2 replies could not be delivered/)]);
  });

  it('a rate limit is tried again after its wait', async () => {
    answer(429, 'Too Many Requests');
    await twoTextsQueued();
    await deliverDueReplies(Date.now());
    expect(replyRows().map((r) => r.outcome)).toEqual(['pending', 'pending']);
  });
});
