// Files go only by iMessage: a turn on SMS that showed a picture and ended with no words sends nothing and
// records nothing (no empty text, no false "held" row).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { initState, advance, type AgentTurnState } from '../state.js';
import { freshReplyDb, personTurn, testDb, AGENT, PERSON } from './helpers/reply-sender.js';

beforeEach(() => freshReplyDb(runMigrations));

describe('a picture on a silent SMS turn writes no reply', () => {
  it('writes no delivery row', async () => {
    const ctx = personTurn('', { channel: 'sms' } as never)[1] as unknown as { turnCtx: { replyFiles: object[] } };
    const state = advance(initState({ agentId: AGENT, turnNumber: 1 } as Parameters<typeof initState>[0]), {
      inboundChannel: 'sms', inboundContext: { smsFromNumber: PERSON, smsToNumber: '+15550199' },
    } as Partial<AgentTurnState>);
    ctx.turnCtx.replyFiles = [{ fileId: 'p1', filename: 'photo.jpg', path: '/tmp/dojo-test-photo.jpg', category: 'image' }];
    await routeTerminalReply(state as never, ctx as never);
    expect(testDb().prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 0 });
  });
});
