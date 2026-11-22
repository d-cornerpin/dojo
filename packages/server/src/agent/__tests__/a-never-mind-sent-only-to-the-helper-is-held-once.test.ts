// "Never mind" with no model: in a turn on the owner's new message, his main agent's first message (not a new job) to
// a helper still working another of his requests is held once, naming that request by its id, passing it on by a re-send
// and the door that ends it on his words, whatever channel he wrote on; sent again, it goes. A contact's message never holds it.
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
import { turnContext } from '../turn-context.js';
import { initState } from '../v2/state.js';
import { runRefusalGates } from '../v2/steps/execute/refusal-gates.js';
import { buildOpenWorkInjection } from '../../work/obligations.js';
import { call, delegated, expectEndedAsHis, ownerTurn, pieceOf, settled, stateOf, ASK, AGENT, HELPER, THREAD } from './helpers/call-off-world.js';

vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

/** One send by the main agent in its live turn, through the execute step's gates: the refusal's words, or null. */
const send = (args: Record<string, unknown>, seen: Set<string>): string | null => runRefusalGates(
  initState({ agentId: AGENT, turnNumber: 2, lastUserMessageContent: null } as never) as never,
  { id: randomUUID(), name: 'send_to_agent', arguments: { agent: HELPER, ...args } } as never,
  { agentId: AGENT, turnNumber: 2, turnCtx: turnContext(AGENT), refusedOnceSigs: seen } as never).refusal?.content ?? null;

describe('a never mind sent only to the helper is held once', () => {
  it("round two's question, the owner writing on the dashboard about his text request: held once with its id, the close ends it", async () => {
    delegated();
    expect(buildOpenWorkInjection(AGENT, null)).toContain(`[${ASK}]`);   // the waiting request is shown with its id
    ownerTurn('m-2', 'Cancel the camping list', 'dashboard');
    const seen = new Set<string>();
    const held = send({ intent: 'QUESTION', thread_id: THREAD, payload: 'Cancel the camping list' }, seen);
    expect(held).toContain(`[${ASK}]`);
    expect(held).toContain(`work_close_request(id="${ASK}", disposition="dropped"`);
    expect(send({ intent: 'QUESTION', thread_id: THREAD, payload: 'Cancel the camping list' }, seen)).toBeNull();
    const r = await call(AGENT, 'work_close_request', { id: ASK, disposition: 'dropped', note: 'Cancel the camping list' });
    expect(r.isError, String(r.content)).toBeFalsy();
    await settled();
    expectEndedAsHis(ASK, pieceOf(), 'task-helper-1');
  });

  it("round three's note to stand down, by text: held once; any other message to the helper in the same turn goes", () => {
    delegated();
    ownerTurn('m-2', 'Stand down on the camping list.');
    const seen = new Set<string>();
    expect(send({ intent: 'FYI', thread_id: THREAD, payload: 'Stand down.' }, seen)).toContain(`[${ASK}]`);
    expect(send({ intent: 'QUESTION', payload: 'And how many towels?' }, seen)).toBeNull();
  });

  it('an add-on is held as a plain fact with both ways on, and the same send again passes with the request alive', () => {
    delegated();
    ownerTurn('m-2', 'Also have her include parking.');
    const seen = new Set<string>();
    const addOn = { intent: 'FYI', thread_id: THREAD, payload: 'Also include parking, please.' };
    const held = send(addOn, seen) ?? '';
    const resend = held.indexOf('send it again');
    const close = held.indexOf(`only if he called that request off, end it with work_close_request(id="${ASK}"`);
    expect([resend > 0, close > resend]).toEqual([true, true]);
    expect(send(addOn, seen)).toBeNull();
    expect(stateOf(ASK)).not.toBe('abandoned');
  });

  it("a new job for the same helper, or a contact's message, is never held", () => {
    delegated();
    ownerTurn('m-2', 'Also ask her for a ski list.');
    expect(send({ intent: 'ASSIGN', payload: 'A ski list, please.' }, new Set())).toBeNull();
    ownerTurn('m-3', 'Never mind the camping list.', 'known_contact', 3);
    expect(send({ intent: 'FYI', thread_id: THREAD, payload: 'Stand down.' }, new Set())).toBeNull();
  });
});
