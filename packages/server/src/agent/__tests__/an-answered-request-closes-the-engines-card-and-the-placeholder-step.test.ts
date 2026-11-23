// A request's answer ends the engine's own card for it, closed done on the request's delivery, so the next turn is not
// shown it and the stall ladder does not chase it. The agent's own cards stay open for it to hand in.
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
import { runLadder } from '../../work/done/ladder.js';
import { assembleContext } from '../../memory/assembler.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { helperAnswers, requestState } from './helpers/text-relay.js';
import { turnReplies } from './helpers/turn-reply.js';
import { delegated, ownerTurn, settled, stateOf, task, AGENT, ASK } from './helpers/call-off-world.js';

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
  it('T2: the compiled answer closes the engine card on its delivery; the agent\'s own step card stays for it to hand in', async () => {
    delegated();
    const step = ownCard('card-send-it');
    const engine = engineCard('card-engine');
    await helperAnswers('Tent, stove, two sleeping bags.');
    await agentCompiles();
    expect(requestState()).toBe('done');
    expect([stateOf(step), stateOf(engine)]).toEqual(['claimed', 'done']);
    expect(closedOn(engine)).toBe(closedOn(ASK));
    for (const at of [6, 30, 120, 1440]) await runLadder(Date.now() + at * MIN);
    expect(hinted(engine)).toBe(0);
    const view = await nextView();
    expect(view).toContain('Step card-send-it');
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
});
