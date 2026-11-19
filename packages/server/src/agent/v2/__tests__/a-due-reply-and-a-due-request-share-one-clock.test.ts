// One timer serves every kind of waiting thing: a person's message is served a second after the clock is armed, a
// queued reply goes at its due time, an engine event already due is served, and one on backoff sets the next due time.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async () => 'ran'));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage, insertEngineEvent, recordDeliveryAttempt } from '../../../memory/message-store.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { armOwedClock, dueOf } from '../owed.js';
import { freshReplyDb, imessage, personTurn, testDb, AGENT } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers();
  freshReplyDb(runMigrations);
  wake.mockClear();
});

describe('a due reply and a due request share one clock', () => {
  it('the waiting person is served a second after the clock is armed, and the reply goes at its due time', async () => {
    insertMessage({ agentId: AGENT, role: 'user', content: 'what is on today?', channel: 'dashboard' });
    await routeTerminalReply(...personTurn('see you at noon', { channel: 'imessage' }));
    testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(Date.now() + 5_000);
    imessage.send.mockClear();
    wake.mockClear();
    armOwedClock();
    await vi.advanceTimersByTimeAsync(999);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(AGENT, ''));
    expect(imessage.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(imessage.send).toHaveBeenCalledTimes(1));
  });

  it('an engine event already due is served; one on backoff is not owed now and names its retry time', async () => {
    const due = insertEngineEvent({ agentId: AGENT, content: 'remind the owner to call back', originIntent: 'scheduler', work: null });
    armOwedClock();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(AGENT, ''));
    const retryAt = Date.now() + 60_000;
    recordDeliveryAttempt({ agentId: AGENT, rowid: due.seq, notBefore: retryAt });
    expect(dueOf(AGENT)).toEqual({ now: false, next: retryAt });
  });
});
