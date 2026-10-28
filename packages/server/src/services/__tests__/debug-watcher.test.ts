import { describe, it, expect, vi } from 'vitest';

const nextMeId = vi.hoisted(() => ({ value: 'old-account' as string }));
const msGraphRead = vi.hoisted(() =>
  vi.fn(async (endpoint: string) =>
    endpoint.startsWith('me?')
      ? { ok: true, data: { id: nextMeId.value } }
      : { ok: true, data: { value: [] } },
  ),
);

vi.mock('../../memory/conversations.js', () => ({ resolveOrCreateConversation: () => 'c1' }));
vi.mock('../../db/connection.js', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => ({}) }) }) }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: vi.fn() }));
vi.mock('../../agent/v2/channel-auth.js', () => ({ isSenderAuthorized: () => false }));
vi.mock('../../logger.js', () => { const noop = (): void => {}; return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] }; });
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'p' }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../../tools/inbound-fences.js', () => ({ teamsInboundContent: () => 'x' }));
vi.mock('../../microsoft/auth.js', () => ({ isMicrosoftEnabled: () => true, isMicrosoftConnected: () => true, getEnabledMsServices: () => ({ teams: true }) }));
vi.mock('../watcher-status.js', () => ({ pushRecent: (l: unknown[]) => l, maybeAlertOnFailure: () => false, maybeAlertOnRecovery: () => false, normalizeError: (e: string) => e, watcherFailingOnRecord: () => false }));
vi.mock('../../microsoft/client.js', () => ({ msGraphRead }));

import { startTeamsWatcher, stopTeamsWatcher } from '../teams-watcher.js';

describe('debug', () => {
  it('logs', async () => {
    vi.useFakeTimers();
    msGraphRead.mockClear();
    startTeamsWatcher();
    console.log('after start, calls=', JSON.stringify(msGraphRead.mock.calls));
    await vi.advanceTimersByTimeAsync(16_000);
    console.log('after advance, ALL calls=', JSON.stringify(msGraphRead.mock.calls));
    console.log('after advance, ME calls=', msGraphRead.mock.calls.filter(([e]) => e.startsWith('me?')).length);
    stopTeamsWatcher();
    vi.useRealTimers();
  });
});
