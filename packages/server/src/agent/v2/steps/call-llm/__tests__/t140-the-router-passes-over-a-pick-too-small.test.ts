// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 6 (H2, ruling R-V333-15) — A ROUTER PICK TOO SMALL FOR THE AGENT IS PASSED OVER, LIKE
// A FALLBACK; WHAT THE OWNER SEES IS THE ANSWER, OR ONE HONEST REFUSAL.
//
// Round 5 stopped the "cannot hold a conversation" card from showing when only the router's own
// pick was too small (the card was false: other routed models hold the agent). But nothing passed
// that pick over: the call step refused it by name and the turn failed — every ask routed to that
// tier failed. A fallback candidate that is too small has been passed over since round 2; the
// router's own pick now is too: the next model the router would offer is dialled, no card.
// When nothing the router can reach right now holds the agent, the turn ends with the refusal by
// name — and the card only if it is true (the agent's own models cannot hold it).
//
// THE DOOR: `runCallLLM`, the engine's call step, on a migrated DB with the real router selector,
// the real assembler and re-fit; scripted: the tier decision and the provider call.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

const dialed = vi.hoisted(() => [] as string[]);
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: async (p: { modelId: string }) => {
    dialed.push(p.modelId);
    return { content: 'The dock is open.', toolCalls: [], inputTokens: 10, outputTokens: 4, stopReason: 'end_turn' };
  },
}));
const owner = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }> }));
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string }) => { owner.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {},
}));
vi.mock('../../../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../tools/tool-docs.js')>('../../../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => 2_000, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});
vi.mock('../../../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../outbound-ledger.js')>()),
  getRecentOutbound: () => [],
}));
vi.mock('../../../../../memory/deliveries-lane.js', () => ({ renderDeliveriesLaneMessage: () => null }));
vi.mock('../../../../../work/obligations.js', () => ({ buildOpenWorkInjection: () => null }));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../runtime.js', () => ({ enforceModelCapabilities: async () => ({ useTools: true }) }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: async () => ({ tier: 'light', method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { advance, initState } from '../../../state.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../index.js';
import type { PromptTurnContext } from '../../../../../prompt/assembler.js';

const AGENT = 'agent-t140-tiny-light';
const TINY = 'm-tiny-8k';
const ROOMY = 'm-roomy-200k';
const db = (): Database.Database => mockDb.current!;
const starvedCards = (): number => owner.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL').length;

function seed(roomyOverBudget: boolean): void {
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
                VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?, datetime('now'), datetime('now'))`);
  model.run(TINY, 'Tiny', 'tiny', 8_192, 0, 0);
  model.run(ROOMY, 'Roomy', 'roomy', 200_000, 3, 15);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('light', TINY);
  tier.run('standard', ROOMY);
  tier.run('heavy', ROOMY);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
                VALUES (?, 'Dock Desk', 'auto', 'idle', '{}', datetime('now'), datetime('now'))`).run(AGENT);
  if (roomyOverBudget) {
    // Today's spend is past the owner's daily limit, so the router passes over the priced model;
    // the free tiny one is all it can reach right now.
    db().prepare("INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', 0.000001, 'daily')").run();
  }
  for (let t = 1; t <= 20; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Is the north dock open?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${'Yes, the dock is open and the crates are counted. '.repeat(12)}`, turnNumber: t });
  }
}

async function callStep(): Promise<Awaited<ReturnType<typeof runCallLLM>>> {
  const turnCtx = undefined as unknown as PromptTurnContext;
  const assembled = await assembleContext(AGENT, '__auto__', turnCtx);
  const ctx: CallLLMContext = {
    agentId: AGENT,
    turnCtx: { agentId: AGENT, conversationId: null } as unknown as CallLLMContext['turnCtx'],
    turnNumber: 21, db: db(),
    counterparty: { kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted: true, configuredModelId: 'auto', lastUserMessageContent: 'Is the north dock open?',
    messages: assembled.messages as CallLLMContext['messages'], systemPrompt: assembled.systemPrompt, assembled,
    modelContext: {} as CallLLMContext['modelContext'], volatileFrom: assembled.messages.length, steerAwaitingConfirm: null,
    assemblyTurnContext: turnCtx, revertTriggerStampOnAbort: () => {},
  };
  return runCallLLM(advance(initState(AGENT, 'auto'), { phase: CALL_LLM_PHASE, loopCount: 1 }), ctx);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  dialed.length = 0;
  owner.cards.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t140 round 6 — the router\'s own pick, too small for the agent', () => {
  it('is passed over like a fallback: the next model the router offers answers, and the owner sees the answer, no card', async () => {
    seed(false);
    const out = await callStep();
    expect(out.directive, 'the turn went on').toBe('proceed');
    expect(dialed, 'the roomy model answered; the tiny one was never dialled').toEqual([ROOMY]);
    expect((out as { result: { content: string } }).result.content).toBe('The dock is open.');
    expect(starvedCards(), 'the agent can hold a conversation; no card').toBe(0);
  });

  it('when nothing the router can reach right now holds the agent (the roomy model is over budget): one refusal by name, and no false card', async () => {
    seed(true);
    const err = await callStep().then(() => null, (e: unknown) => e as Error);
    expect(err, 'the turn ends with a refusal').not.toBeNull();
    expect(String(err?.message), 'what the owner is shown names the cause').toMatch(/system prompt does not fit its own budget/);
    expect(dialed, 'nothing that cannot hold the agent was dialled').toEqual([]);
    expect(starvedCards(), 'the card would be false: the agent holds a conversation on its own roomy model once the budget allows').toBe(0);
  });
});
