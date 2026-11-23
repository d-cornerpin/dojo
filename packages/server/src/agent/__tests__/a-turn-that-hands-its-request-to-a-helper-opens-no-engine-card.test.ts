// A turn whose request a helper carries opens no engine "Multi-step task" card: not in the response that hands the job on
// after five work calls (C7), nor in the compile turn that reads the helpers' files (F1). A request whose every helper job was
// called off, which the agent then works itself, still gets its card.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { liveTurn } from '../v2/__tests__/helpers/live-turn.js';
import { boardCancel, settled } from './helpers/call-off-world.js';
import { AGENT, ASK, BOT, CORA, assign, engineCards, jobOf, ownerAsks, piecesUnder, respond, turnEnds, world } from './helpers/hand-on-world.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
const reads = (n: number): Array<[string, Record<string, unknown>]> => Array.from({ length: n }, (_, i) => ['file_read', { path: `/tmp/dojo-no-such-list-${i}.md` }]);

/** The owner's request handed to `helpers` in one response; the owner then cancels the jobs of `cancelled`. */
async function fannedOut(helpers: string[], cancelled: string[]): Promise<void> {
  ownerAsks('Have helpers make a games list and a snacks list, and give me both lists in one answer.');
  await respond(AGENT, helpers.map((h) => assign(h, `Make a beach list (${h}).`)), { reply: 'Helpers are on it.' });
  turnEnds(AGENT);
  for (const h of cancelled) expect(await boardCancel(jobOf(h).id)).toBe(200);
  await settled();
}
/** The main agent's next turn on the request makes six work calls. */
async function sixCallsOnTheRequest(): Promise<number> {
  liveTurn(AGENT, { turnNumber: 2, convKey: 'imessage:owner', root: { kind: 'ask', id: 'm-owner', sourceMessageId: 'm-owner' } });
  await respond(AGENT, reads(6));
  return engineCards();
}

beforeEach(() => world());

describe('a turn that hands its request to a helper opens no engine card', () => {
  it('C7: five work calls and the hand-over in one response: the turn ends delegated, with no card', async () => {
    ownerAsks('End that helper yourself and give the job to another helper.');
    const out = await respond(AGENT, [...reads(5), assign(CORA, 'Write the sandcastle tips.')], { reply: 'A new helper is on it.' });
    expect(out).toMatchObject({ directive: 'exit', reason: 'delegation-send-async-exit' });
    expect(engineCards()).toBe(0);
  });

  it('F1: the compile turn of a fan-out, one job cancelled by the owner, reads six files: no card', async () => {
    await fannedOut([CORA, BOT], [BOT]);
    const thread = piecesUnder(ASK).find((p) => p.assignee_agent === CORA)!.id.slice(`piece:${ASK}:`.length);
    expect(await deliverA2AMessage({ intent: 'COMPLETE', threadId: thread, requiresResponse: false, payload: 'Games: frisbee, volleyball.', toAgent: AGENT, fromAgent: CORA } as never))
      .toMatchObject({ delivered: true });
    await settled();
    expect(await sixCallsOnTheRequest()).toBe(0);
  });

  it('every helper job called off, the agent works the request itself: the card opens', async () => {
    await fannedOut([CORA], [CORA]);
    expect(await sixCallsOnTheRequest()).toBe(1);
  });

});
