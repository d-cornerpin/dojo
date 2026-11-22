// The person's first request is with a helper. Their follow-up ("also have her include parking", or a second
// question) starts a new turn; the agent passes it to the working helper on that request's thread and says so. The
// turn served the request it forwarded to, which waits on the helper, so the promise floor never pushes the agent to
// do the work itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));
vi.mock('../../services/presence.js', () => ({ getPresence: () => 'away' }));

import { getAgentRuntime } from '../runtime.js';
import { executeTool, toolResultOf } from '../tools/index.js';
import { insertMessage } from '../../memory/message-store.js';
import { claimAsk } from '../../work/store.js';
import { endTurnContext } from '../turn-context.js';
import { activeRuns } from '../shared-state.js';
import { endTurn, modelSays, steered } from '../v2/steps/post-call-classify/__tests__/post-call-kit.js';
import { AGENT, PERSON } from '../v2/__tests__/helpers/reply-sender.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { delegatedTextRequest, CONV, THREAD, HELPER } from './helpers/text-relay.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const followUp = { kind: 'ask', id: 'm-follow', sourceMessageId: 'm-follow', conversationId: CONV };

beforeEach(() => {
  for (const id of [AGENT, HELPER]) endTurnContext(id);
  activeRuns.clear();
  delegatedTextRequest({ relation: 'owner' });
});

describe('a follow-up passed to a working helper is not pushed to do the work', () => {
  for (const [intent, words] of [['FYI', 'Also have her include parking.'], ['QUESTION', 'And ask her how many towels.']] as const) {
    it(`a ${intent === 'FYI' ? 'note' : 'question'} forwarded on the helper's thread: no promise-floor steer`, async () => {
      insertMessage({ id: 'm-follow', agentId: AGENT, role: 'user', content: words, channel: 'imessage', senderId: PERSON, conversationId: CONV });
      claimAsk('ask:m-follow', AGENT);
      liveTurn(AGENT, { turnNumber: 2, root: followUp });
      const sent = toolResultOf(await executeTool(AGENT, { id: 'tc-fwd', name: 'send_to_agent', arguments: { agent: HELPER, intent, thread_id: THREAD, payload: words } }));
      expect(sent.isError, sent.content).toBeFalsy();
      modelSays({ only_promises_to_start: true });
      const out = await endTurn('Passed that on to the helper; it will be in the list she sends.', [], undefined, { root: followUp }, { agentId: AGENT, turnNumber: 2 });
      expect(steered(out)).not.toContain('promise-floor');
    });
  }
});
