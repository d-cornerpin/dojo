// An idle Stop that dropped a waiting reply leaves no stop standing: the person's next text starts a turn
// that is not cut at the stop check. A Stop while a turn runs still cuts that turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));


import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { activeRuns, isStopFenced, stoppedAgents, stopFencedRuns } from '../../shared-state.js';
import { freshReplyDb, personTurn, AGENT, T0 } from './helpers/reply-sender.js';
import { pressStop } from './helpers/owner-stop.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
  stoppedAgents.clear();
  stopFencedRuns.clear();
  await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
});

describe("after an idle Stop the person's next text is not cut", () => {
  it('no stop stands once an idle Stop has dropped the reply', async () => {
    expect((await pressStop()).body.data?.repliesNotSent).toBe(1);
    expect(isStopFenced(AGENT)).toBe(false);
  });

  it('CONTROL: a Stop while a turn runs still stands for that turn', async () => {
    activeRuns.add(AGENT);
    try {
      await pressStop();
      expect(isStopFenced(AGENT)).toBe(true);
    } finally { activeRuns.delete(AGENT); }
  });
});
