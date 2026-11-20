// When the person who asked is another Dojo's agent, a helper's answer passed back goes as the answer alone, with no
// "Dojo:" label and no framing line; the dashboard copy keeps both.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { deliverDueReplies } from '../v2/channel-sender.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, delegatedTextRequest, helperAnswers, relayed, requestState, textsSent } from './helpers/text-relay.js';

describe('a helper\'s answer to another Dojo\'s agent goes without the Dojo label', () => {
  beforeEach(() => delegatedTextRequest({ senderIsAgent: true }));

  it('the answer alone goes, and the request settles on it', async () => {
    await helperAnswers('The venue is free on the 14th.');
    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual(['The venue is free on the 14th.']);
    expect(requestState()).toBe('done');
    const copy = testDb().prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant'").all(AGENT);
    expect(copy).toEqual([{ content: relayed('The venue is free on the 14th.') }]);
  });
});

describe('CONTROL: a person', () => {
  beforeEach(() => delegatedTextRequest());

  it('gets the labelled line', async () => {
    await helperAnswers('The venue is free on the 14th.');
    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual([relayed('The venue is free on the 14th.')]);
  });
});
