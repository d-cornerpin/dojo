// While a helper's answer waits to go to the person, the request is not owed by the agent (not on its open work, no
// compile duty) and the compile drive does not climb to a stuck notice or the platform's ghost line.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { liftStandDowns } from '../../work/ask-settlement.js';
import { sweepExpiredJoins } from '../a2a-transport.js';
import { insertMessage } from '../../memory/message-store.js';
import { openObligations } from '../../work/store.js';
import { AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, delegatedTextRequest, helperAnswers, relayRows, requestState, ASK, CONV } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

describe('a relay waiting to go is not called stuck or owed', () => {
  it('nothing serves it again or lifts it, however long it waits, and no second relay is written', async () => {
    await helperAnswers('The venue is free on the 14th.');
    await agentStaysSilent();
    expect(relayRows().map((r) => r.outcome)).toEqual(['pending']);
    for (let i = 0; i < 3; i++) await sweepExpiredJoins();
    insertMessage({ id: 'm-next', agentId: AGENT, role: 'user', content: 'any news?', channel: 'imessage', senderId: PERSON, conversationId: CONV });
    liftStandDowns(AGENT, 'ask:m-next', 3);
    expect(requestState()).toBe('blocked');
    expect(relayRows()).toHaveLength(1);
    expect(openObligations(AGENT).map((o) => o.id)).not.toContain(ASK);
  });

  it('CONTROL: with no relay on its way, the request is owed', async () => {
    expect(openObligations(AGENT).map((o) => o.id)).toContain(ASK);
  });
});
