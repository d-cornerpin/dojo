// Stop always stops. If calling off a request breaks inside the Stop, nothing is dropped (the drop and the
// call-off are one transaction), but the agent is still stopped and the owner gets a plain answer, not an error.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

vi.mock('../../../work/store.js', async (orig) => {
  const real = await orig<typeof import('../../../work/store.js')>();
  return { ...real, transition: (id: string, input: Parameters<typeof real.transition>[1]) => {
    if (input.to === 'abandoned') throw new Error('disk I/O error');
    return real.transition(id, input);
  } };
});

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { freshReplyDb, personTurn, replyRows, AGENT, PERSON, T0 } from './helpers/reply-sender.js';
import { askState, claimedAsk, pressStop } from './helpers/owner-stop.js';
import { stoppedAgents } from '../../shared-state.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('Stop stops even when calling off a request fails', () => {
  it('the agent is stopped, the answer is plain, and the reply and its request are left as they were', async () => {
    const ask = claimedAsk('msg-1', `conv-${PERSON}`, 1);
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }, 1));

    const { status, body } = await pressStop();
    expect(status).toBe(200);
    expect(body.data?.repliesNotSent).toBe(0);
    expect(stoppedAgents.has(AGENT)).toBe(true);
    expect(replyRows()[0].outcome).toBe('pending');
    expect(askState(ask)).toBe('claimed');
  });
});
