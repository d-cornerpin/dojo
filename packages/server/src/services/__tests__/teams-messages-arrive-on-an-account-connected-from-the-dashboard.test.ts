// On a box whose Microsoft account was connected from the dashboard, the account's id is random, not the
// word "agent". The Teams watcher reads Teams with the id of the account it watches, so the agent's
// Teams messages arrive.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const msGraphRead = vi.hoisted(() => vi.fn(async (_endpoint: string) => ({ ok: true, data: { value: [] } })));

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
vi.mock('../../microsoft/accounts.js', () => ({
  getPrimaryMicrosoftAccount: () => ({ id: '7d3f0c2a-5b1e-4c6d-9a8f-2e4b6c8d0f12' }),
}));

import { startTeamsWatcher, stopTeamsWatcher } from '../teams-watcher.js';

describe('teams messages arrive on an account connected from the dashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    msGraphRead.mockClear();
  });
  afterEach(() => {
    stopTeamsWatcher();
    vi.useRealTimers();
  });

  it('every Teams read names the watched account by its own id', async () => {
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(msGraphRead.mock.calls.length).toBeGreaterThan(0);
    for (const call of msGraphRead.mock.calls) expect(call[5]).toBe('7d3f0c2a-5b1e-4c6d-9a8f-2e4b6c8d0f12');
  });
});
