// A request the provider is too busy for waits on its own record, uncounted, and the one clock serves it once, when the
// limit clears. A wait past two minutes puts the Dojo's line on the owner's dashboard with the clock time.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
const wake = vi.hoisted(() => vi.fn(async () => 'ran'));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../db/migrations.js';
import { armOwedClock } from '../../agent/v2/owed.js';
import { freshReplyDb, testDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, turnEnds, askOf, countsOf } from './helpers/a-request-handed-back.js';

const RESET = T0 + 5 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  wake.mockClear();
  samAsks('m-1');
  servedBy('m-1', 1);
  turnEnds(1, 'provider_error', { retryAt: RESET });
});

describe('a rate-limited request is served once when the limit clears', () => {
  it('it waits uncounted on its record, and the clock wakes the agent once, at the reset', async () => {
    expect(askOf('m-1')).toEqual({ state: 'open', due: RESET });
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 0 });
    armOwedClock();
    await vi.advanceTimersByTimeAsync(RESET - T0 - 1_000);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(wake).toHaveBeenCalledWith(AGENT, '');
  });

  it('the owner sees the Dojo line saying when it will be answered', async () => {
    await vi.waitFor(() => expect(testDb().prepare("SELECT content FROM messages WHERE id = 'park-note:m-1'").get()).toBeTruthy());
    const { content } = testDb().prepare("SELECT content FROM messages WHERE id = 'park-note:m-1'").get() as { content: string };
    expect(content).toMatch(new RegExp(`^Dojo: ${AGENT}'s AI provider is limiting requests right now, so this message waits\\. It is answered when the limit clears, about \\d{1,2}:\\d{2}`));
  });
});
