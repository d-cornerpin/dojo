// The dashboard's live "tool call" frame shows a call's arguments; an argument the tool declares secret
// is blanked there, the same way it is blanked where the call is stored.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const sent: Array<{ type: string; tool?: string; args?: unknown }> = [];
const PRIMARY = 'primary-agent';
const FAKE_TOKEN = 'zq9FakeFrameValue0000000000042';

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
  isHealerAgent: () => false,
  getPrimaryAgentId: () => PRIMARY,
}));
vi.mock('../../../../../gateway/ws.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../gateway/ws.js')>()),
  broadcast: (e: { type: string; tool?: string; args?: unknown }) => { sent.push(e); },
}));

import { recordDispatchAndHold } from '../dispatch-bookkeeping.js';
import { initState } from '../../../state.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  sent.length = 0;
});

describe('the live tool call frame carries no saved secret', () => {
  it('a credential_add frame shows the call with the value blanked', async () => {
    const state = initState({
      agentId: PRIMARY, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test',
      turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
      lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null,
      inboundContext: null,
    });
    await recordDispatchAndHold(
      state,
      ({ id: 'tc-1', name: 'credential_add', arguments: { service_name: 'example_service', credentials: { api_key: FAKE_TOKEN } } } as never),
      ({ agentId: PRIMARY, db: mockDb.current, agent: { name: 'Main' } } as never),
    );
    const frame = sent.find((e) => e.type === 'chat:tool_call' && e.tool === 'credential_add');
    expect(frame).toBeTruthy();
    expect(JSON.stringify(frame)).toContain('example_service');
    expect(JSON.stringify(frame)).not.toContain(FAKE_TOKEN);
  });
});
