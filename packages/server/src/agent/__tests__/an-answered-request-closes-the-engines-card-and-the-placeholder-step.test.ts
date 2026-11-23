// A request's answer ends the engine's own card for it and, once every helper's piece came back and the agent wrote
// the compiled answer, the agent's own "send it to him" step opened beside the helper's job: closed done on the
// request's delivery, so the next turn is shown neither, the stall ladder chases neither, and the manager reviews neither.
// The agent's own card stays open on a request it answered itself, or whose helper's piece was called off.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));
import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);
import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { endCardsOf } from '../../work/done/decide.js';
import { runLadder } from '../../work/done/ladder.js';
import { assembleContext } from '../../memory/assembler.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { helperAnswers, requestState } from './helpers/text-relay.js';
import { turnReplies } from './helpers/turn-reply.js';
import { boardCancel, delegated, ownerTurn, settled, stateOf, task, AGENT, ASK, T2 } from './helpers/call-off-world.js';

const MIN = 60_000;
const ownCard = (id: string): string => { task(id); testDb().prepare("UPDATE work SET origin_kind = 'model' WHERE id = ?").run(id); return id; };
const engineCard = (id: string): string => { task(id); testDb().prepare("UPDATE work SET root_kind = 'engine_scaffold', origin_kind = 'engine_scaffold' WHERE id = ?").run(id); return id; };
const closedOn = (id: string): string | null => (testDb().prepare('SELECT result_delivery_id AS d FROM work WHERE id = ?').get(id) as { d: string | null }).d;
const events = (id: string, kind: string): number => (testDb().prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = ?').get(id, kind) as { n: number }).n;
const hinted = (id: string): number => (testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND content LIKE '[Engine hint:%' AND content LIKE ?")
  .get(AGENT, `%${id}%`) as { n: number }).n;

/** The turn after: what the agent's next turn is shown, through the real assembler. */
async function nextView(): Promise<string> {
  testDb().prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  testDb().prepare(`INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  testDb().prepare("UPDATE agents SET model_id = 'm' WHERE id = ?").run(AGENT);
  return JSON.stringify(await assembleContext(AGENT, 'm'));
}

/** The agent's turn shown the helper's answer writes the compiled answer by text; its turn end settles the request. */
async function agentCompiles(turn = 2): Promise<void> {
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, turn);
  recordPiecesShown(ASK, AGENT, turn, newestPutBack(ASK)!.id);
  turnReplies(turn, 'm-ask');
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
  await settled();
}

describe('an answered request closes the engine\'s card and the placeholder step', () => {
  it('T2: the compiled answer closes the own step card and the engine card on its delivery; the next turn and the ladder see neither', async () => {
    delegated();
    const step = ownCard('card-send-it');
    const engine = engineCard('card-engine');
    await helperAnswers('Tent, stove, two sleeping bags.');
    await agentCompiles();
    expect(requestState()).toBe('done');
    expect([stateOf(step), stateOf(engine)]).toEqual(['done', 'done']);
    expect([closedOn(step), closedOn(engine)]).toEqual([closedOn(ASK), closedOn(ASK)]);
    expect(events(step, 'handed_in'), 'no hand-in, so no manager review').toBe(0);
    for (const at of [6, 30, 120, 1440]) await runLadder(Date.now() + at * MIN);
    expect([hinted(step), hinted(engine)]).toEqual([0, 0]);
    const view = await nextView();
    expect(view).not.toContain('Step card-send-it');
    expect(view).not.toContain('Step card-engine');
  });

  it('a request the agent answered itself closes the engine card only; its own card stays in the next view', async () => {
    delegated();
    ownerTurn('m-2', 'Find a lake for Saturday', 'owner', 3);
    const own = ownCard('card-own');
    const engine = engineCard('card-engine');
    testDb().prepare("UPDATE work SET source_message_id = 'm-2' WHERE id IN (?, ?)").run(own, engine);
    stampClaimingTurn('ask:m-2', 3);
    turnReplies(3, 'm-2');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 3 });
    await settled();
    expect([stateOf('ask:m-2'), stateOf(engine), stateOf(own)]).toEqual(['done', 'done', 'claimed']);
    expect(await nextView()).toContain('Step card-own');
  });

  it('a request answered while one helper\'s job was called off leaves the own card open', async () => {
    delegated('owner', ['thread-relay-0001', T2]);
    const own = ownCard('card-own');
    expect(await boardCancel('task-second-1')).toBe(200);
    await helperAnswers('Tent, stove, two sleeping bags.');
    await agentCompiles();
    expect([requestState(), stateOf(own)]).toEqual(['done', 'claimed']);
    expect(await nextView()).toContain('Step card-own');
  });

  it('a card left open by an answer before this version is closed once at boot, and the second start finds nothing', async () => {
    delegated();
    await helperAnswers('Tent, stove, two sleeping bags.');
    await agentCompiles();
    const left = engineCard('card-left');   // the older version ended nothing on the answer
    endCardsOf(null, 'done', null, 'the request it was opened for was answered');
    expect([stateOf(left), closedOn(left)]).toEqual(['done', closedOn(ASK)]);
    endCardsOf(null, 'done', null, 'the request it was opened for was answered');
    expect(events(left, 'decided')).toBe(1);
    expect(await nextView()).not.toContain('Step card-left');
  });
});
