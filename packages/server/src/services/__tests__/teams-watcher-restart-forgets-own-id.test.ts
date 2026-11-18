// A restarted Teams watcher must forget everything it learned about the
// signed-in account. `gateway/routes/microsoft.ts` restarts the watcher after
// every Microsoft sign-in, and a sign-in for the agent slot with a different
// login replaces the existing account in place. If `ownUserId` survives the
// stop, line 254 (`msg.from?.user?.id === myId`) stops recognising the agent's
// own messages — every message the agent sends is read as an incoming message,
// stored, shown on the dashboard and wakes the agent again. The cached
// `userEmails` map would likewise keep labelling senders with the old account.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `me?$select=id` is the one Graph call that answers "who am I". Its id is
// swapped between runs to simulate a sign-in under a different login.
const nextMeId = vi.hoisted(() => ({ value: 'old-account' as string }));
const msGraphRead = vi.hoisted(() =>
  vi.fn(async (endpoint: string) =>
    endpoint.startsWith('me?')
      ? { ok: true, data: { id: nextMeId.value } }
      : { ok: true, data: { value: [] } },
  ),
);

vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: () => 'c1',
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => ({}) }) }),
}));
vi.mock('../../agent/v2/inbound-channel.js', () => ({
  recordInboundMeta: vi.fn(),
}));
vi.mock('../../work/ask-title.js', () => ({
  insertInboundMessageIfAbsent: vi.fn(),
}));
vi.mock('../../agent/v2/channel-auth.js', () => ({
  isSenderAuthorized: () => false,
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});
vi.mock('../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'p',
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {} }),
}));
vi.mock('../../tools/inbound-fences.js', () => ({
  teamsInboundContent: () => 'x',
}));
vi.mock('../../microsoft/auth.js', () => ({
  isMicrosoftEnabled: () => true,
  isMicrosoftConnected: () => true,
  getEnabledMsServices: () => ({ teams: true }),
}));
vi.mock('../watcher-status.js', () => ({
  pushRecent: (l: unknown[]) => l,
  maybeAlertOnFailure: () => false,
  maybeAlertOnRecovery: () => false,
  normalizeError: (e: string) => e,
  watcherFailingOnRecord: () => false,
}));
vi.mock('../../microsoft/client.js', () => ({
  msGraphRead,
}));
vi.mock('../../microsoft/accounts.js', () => ({ getPrimaryMicrosoftAccount: () => ({ id: 'acct-1' }) }));

import { startTeamsWatcher, stopTeamsWatcher } from '../teams-watcher.js';

// Only the `me?$select=id` endpoint starts with `me?`; the `me/chats?...` and
// `chats/...` endpoints do not, so this counts only the "who am I" fetches.
const meCalls = (): number =>
  msGraphRead.mock.calls.filter(([endpoint]) => endpoint.startsWith('me?')).length;

describe('teams-watcher restart forgets own id', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    msGraphRead.mockClear();
  });
  afterEach(() => {
    // `ownUserId` and `userEmails` are module state; the stop clears them, so one
    // case cannot seed the next.
    stopTeamsWatcher();
    vi.useRealTimers();
  });

  it('re-fetches the own user id after a stop/start under a new login', async () => {
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000); // first poll runs at 15 s
    expect(meCalls()).toBe(1);

    stopTeamsWatcher();
    nextMeId.value = 'new-account';
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(meCalls()).toBe(2); // v35: stays 1 because ownUserId is cached

    stopTeamsWatcher();
  });

  it('does not re-fetch the own user id on a second poll without a stop in between', async () => {
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(meCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000); // another poll, same run
    expect(meCalls()).toBe(1);

    stopTeamsWatcher();
  });
});
