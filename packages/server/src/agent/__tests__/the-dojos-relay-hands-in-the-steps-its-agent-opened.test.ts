// When the Dojo itself relays a helper's answer to the person, the steps his main agent opened for that request are
// handed in on that same delivery: none is left open for the stall ladder to chase as unmoved work (round three's
// unasked turns), and none waits for a review of work already answered.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { deliverDueReplies } from '../v2/channel-sender.js';
import { runLadder } from '../../work/done/ladder.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { agentStaysSilent, helperAnswers, relayRows, requestState } from './helpers/text-relay.js';
import { delegated, settled, stateOf, task, AGENT } from './helpers/call-off-world.js';

const MIN = 60_000;
const chased = (id: string): number => (testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND content LIKE '[Engine hint:%' AND content LIKE ?")
  .get(AGENT, `%${id}%`) as { n: number }).n;

describe("the Dojo's relay hands in the steps its agent opened", () => {
  it('a step card of the answered request is handed in on the relay, and the ladder never chases it', async () => {
    delegated();
    task('card-step');
    testDb().prepare("UPDATE work SET origin_kind = 'model' WHERE id = 'card-step'").run();
    testDb().prepare("UPDATE _migrations SET applied_at = datetime(applied_at, '-7200 seconds') WHERE name LIKE '901%'").run();   // the ladder's anchor, long past
    await helperAnswers('Tent, stove, two sleeping bags.');
    await agentStaysSilent();
    await deliverDueReplies(Date.now());
    await settled();
    expect([requestState(), relayRows().length > 0]).toEqual(['done', true]);
    for (const at of [6, 30, 120, 1440]) await runLadder(Date.now() + at * MIN);
    expect([stateOf('card-step'), chased('card-step')]).toEqual(['handed_in', 0]);
  });
});
