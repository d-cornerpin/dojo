// A call the compile gate refuses still announces itself on the live feed; an argument its tool declares secret is blanked there.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const sent: Array<{ type: string; tool?: string; args?: unknown }> = [];
const AGENT = 'helper-agent';
const FAKE_TOKEN = 'zq9FakeGateValue0000000000043';

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  isPrimaryAgent: () => false,
}));
vi.mock('../../../../../gateway/ws.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../gateway/ws.js')>()),
  broadcast: (e: { type: string; tool?: string; args?: unknown }) => { sent.push(e); },
}));
vi.mock('../../../compile-owed-gate.js', () => ({
  compileOwedGateDecision: () => ({ live: ['ask-1'], refuse: true, standDownUnverified: false }),
}));

import { runRefusalGates } from '../refusal-gates.js';
import { initState } from '../../../state.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  sent.length = 0;
});

describe('the compile gate frame carries no saved secret', () => {
  it('a refused credential_add frame shows the call with the value blanked', () => {
    const state = initState({
      agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test',
      turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
      lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null,
      inboundContext: null,
    });
    const call = { id: 'tc-1', name: 'credential_add', arguments: { service_name: 'example_service', credentials: { api_key: FAKE_TOKEN } } };
    const out = runRefusalGates(state, call as never, { agentId: AGENT, turnNumber: 1, turnCtx: {}, refusedOnceSigs: new Set<string>() } as never);
    expect(out.refusal?.content).toContain('engine compile gate');
    const frame = sent.find((e) => e.type === 'chat:tool_call' && e.tool === 'credential_add');
    expect(frame).toBeTruthy();
    expect(JSON.stringify(frame)).toContain('example_service');
    expect(JSON.stringify(frame)).not.toContain(FAKE_TOKEN);
  });
});
