// When every tier model is under the 32K floor, an auto agent's turn is not run: the owner is told once, with
// the true fix (add a bigger model to the router), and the kept request is served again when one joins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const cards = vi.hoisted(() => [] as Array<{ type?: string; error?: string }>);
const wakes = vi.hoisted(() => [] as string[]);
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (e: { type?: string }) => { cards.push(e); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn(async () => true) }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async (id: string) => { wakes.push(id); } }) }));
vi.mock('../../../../../tools/tool-docs.js', async (orig) => ({ ...(await orig<typeof import('../../../../../tools/tool-docs.js')>()), measureAgentToolPayloadTokens: async () => 1_000 }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: async () => ({ tier: 'light', method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState } from '../../../state.js';
import { selectModel } from '../model-selection.js';
import { CALL_LLM_PHASE } from '../index.js';
import { tryHonestStopRecovery } from '../../../honest-stop.js';
import { noteModelsChanged } from '../../../honest-stop-lock.js';
import '../../../../../router/router-window.js';

const AGENT = 'agent-small-router';
const db = (): Database.Database => mockDb.current!;
const tiers = (modelId: string): void => {
  for (const t of ['light', 'standard', 'heavy']) db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run(t, modelId);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1)").run();
  const add = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1)`);
  add.run('m-small', 'Small', 'small', 8192);
  add.run('m-big', 'Big', 'big', 200_000);
  tiers('m-small');
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Desk', 'auto', 'idle', '{}')").run(AGENT);
  cards.length = 0;
  wakes.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

async function aTurn(): Promise<boolean> {
  const state = advance(initState({
    agentId: AGENT, contextWindow: 8192, isAutoRouted: true, configuredModelId: 'auto', turnNumber: 2, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null, inboundContext: null,
  }), { phase: CALL_LLM_PHASE, loopCount: 1 });
  const reArmed = vi.fn();
  const thrown = await selectModel(state, {
    agentId: AGENT, isAutoRouted: true, configuredModelId: 'auto', lastUserMessageContent: 'Is the dock open?',
    conversationId: null, turnNumber: 2, turnContext: undefined as never, revertTriggerStampOnAbort: reArmed,
  }).then(() => null, (err: unknown) => err);
  expect(reArmed, 'the request is kept with no re-serve spent').toHaveBeenCalled();
  return tryHonestStopRecovery(state, thrown);
}

describe('a router of only small models holds the request until a bigger one joins', () => {
  it('tells the owner once, then serves the request again when a bigger model is added', async () => {
    expect(await aTurn()).toBe(true);
    expect(await aTurn()).toBe(true);
    const told = cards.filter((c) => c.type === 'chat:error').map((c) => c.error);
    expect(told, 'the agent\'s card and the owner\'s card, once').toHaveLength(2);
    for (const words of told) expect(words).toMatch(/the router has no model with a memory window of 32K or more.*Add one to the router/);
    expect(db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT)).toEqual({ status: 'paused' });

    await noteModelsChanged();
    expect(wakes, 'a model change that adds nothing big keeps the hold').toEqual([]);
    tiers('m-big');
    await noteModelsChanged();
    expect(wakes).toEqual([AGENT]);
    expect(db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT)).toEqual({ status: 'idle' });
  });
});
