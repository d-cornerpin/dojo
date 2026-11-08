// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 (GitHub #25, the owner's design) — AN AUTO-ROUTED AGENT RUNS EVERY PICK AT ONE WINDOW.
//
// The defect: an auto-routed agent's memory was sized by the model picked for THIS request
// (`assemble/index.ts`'s `dialWindow = getContextWindow(modelId)`, the assembler's own window read).
// One cheap light-tier turn on a small model folded the rows that window could not hold, and folding
// moves the compaction boundary for good, so the next turn on a bigger model did not get them back.
//
// The owner's design: ONE window for the whole router — the owner's setting `router.context_window`,
// topped at the smallest window among the light, standard and heavy models — and every pick runs at it.
//
// THE DOOR: the driver's own two steps for one iteration, `runAssemble` then `runCallLLM`, on the real
// migration chain, with the real assembler, router selector and window readers. Scripted: the tier
// decision, the provider call, and the out-of-view fold (recorded: the window each turn hands it is the
// window the step sized the turn for).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

const dialed = vi.hoisted(() => [] as string[]);
vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  callModel: async (p: { modelId: string }) => {
    dialed.push(p.modelId);
    return { content: 'Bay four is free.', toolCalls: [], inputTokens: 10, outputTokens: 4, stopReason: 'end_turn' };
  },
}));

/** Per turn: the window the assemble step sized the turn for, and what the assembler left out of view. */
const turns = vi.hoisted(() => [] as Array<{ window: number; budget?: number; outOfView?: number }>);
vi.mock('../../../memory/out-of-view.js', () => ({
  assembleWithNothingOutOfViewUnsummarised: async (_a: string, window: number, build: () => Promise<{ allocation?: { budgetTokens: number }; outOfViewThroughSeq?: number }>) => {
    const built = await build();
    turns.push({ window, budget: built.allocation?.budgetTokens, outOfView: built.outOfViewThroughSeq ?? 0 });
    return built;
  },
}));

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
  semanticTechniqueMatches: async () => [],
}));
vi.mock('../../../memory/vector-search.js', () => ({ vectorSearch: async () => [] }));
vi.mock('../../../techniques/store.js', () => ({
  listTechniques: () => [], getTechniqueDetail: () => null, recordTechniqueUsage: () => undefined,
}));
vi.mock('../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tools/tool-docs.js')>('../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => 2_000, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});
vi.mock('../../runtime.js', () => ({
  clearConsumedOneShotFlags: () => undefined,
  injectAttachmentBlocks: () => [],
  enforceModelCapabilities: async () => ({ useTools: true }),
}));
vi.mock('../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../outbound-ledger.js')>()),
  getRecentOutbound: () => [],
}));
vi.mock('../../../memory/deliveries-lane.js', () => ({ renderDeliveriesLaneMessage: () => null }));
vi.mock('../../../work/obligations.js', () => ({ buildOpenWorkInjection: () => null }));
vi.mock('../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../router/probe.js', () => ({ maybeProbe: () => undefined }));

const route = vi.hoisted(() => ({ tier: 'heavy' as 'light' | 'standard' | 'heavy' }));
vi.mock('../../../router/decide.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../router/decide.js')>()),
  decideTier: async () => ({ tier: route.tier, method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { advance, initState } from '../state.js';
import { runAssemble, ASSEMBLE_PHASE } from '../steps/assemble/index.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../steps/call-llm/index.js';
import type { AssembleContext } from '../steps/assemble/index.js';
import { getContextWindow } from '../../model.js';
import * as coldImport1 from '../../../router/rate-limits.js';

const AGENT = 'agent-n42-dock-desk';
const LIGHT = 'm-n42-light-32k';
const STANDARD = 'm-n42-standard-128k';
const HEAVY = 'm-n42-heavy-200k';
const TINY = 'm-n42-light-16k';
const ASK = 'Which bay is free for the next crate?';
const db = (): Database.Database => mockDb.current!;

function seed(configured: string): void {
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
                VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, 0, 0, datetime('now'), datetime('now'))`);
  model.run(LIGHT, 'Dock Light', 'light', 32_000);
  model.run(STANDARD, 'Dock Standard', 'standard', 128_000);
  model.run(HEAVY, 'Dock Heavy', 'heavy', 200_000);
  model.run(TINY, 'Dock Tiny', 'tiny', 16_000);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');
  tier.run('light', LIGHT, 0);
  tier.run('standard', STANDARD, 0);
  tier.run('heavy', HEAVY, 0);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
                VALUES (?, 'Dock Desk', ?, 'idle', '{}', datetime('now'), datetime('now'))`).run(AGENT, configured);
  // ~60K tokens of history: the heavy and standard windows hold all of it, the light one cannot.
  for (let t = 1; t <= 30; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Read me the manifest for bay ${t}.`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${'Crate, bay, weight, seal number, inspector initials, remarks. '.repeat(130)}`, turnNumber: t });
  }
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: ASK, turnNumber: 31 });
}

const setting = (tokens: number): void => {
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('router.context_window', ?)").run(String(tokens));
};

const OWNER = { kind: 'user' as const, name: 'the owner', relation: 'owner' as const, channel: 'dashboard' as const, senderId: null, threadId: null, senderIsAgent: false };
const turnCtx = (): AssembleContext['turnCtx'] => ({
  agentId: AGENT, conversationId: null, lastAssembledAtIso: null, freshTailDropWarned: false,
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false, startAckSteersInjected: 0,
  startAckSteerInjectedAtLoop: 0, inboundClassifiedAsWork: false,
} as unknown as AssembleContext['turnCtx']);

/** One turn's first iteration, as the driver runs it: the window the turn opens with, `assemble`, `callLLM`. */
async function oneTurn(configured: string, tier: 'light' | 'standard' | 'heavy'): Promise<void> {
  route.tier = tier;
  const isAutoRouted = configured === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configured;
  const tc = turnCtx();
  let state = advance(initState(AGENT, configured), { phase: ASSEMBLE_PHASE, loopCount: 1 });
  const assembled = await runAssemble(state, {
    agentId: AGENT, turnCtx: tc, turnNumber: 31, db: db(), contextModelId, contextWindow: getContextWindow(contextModelId),
    counterparty: OWNER, counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: true,
    isA2ATurn: false, isEngineTurn: false, isNotificationTurn: false, lastUserMessageContent: ASK,
    latestTtsEngine: null, latestUserSource: null, mostRecentIsA2A: false, pendingEngineEvent: null,
    mostRecentInbound: null, waitingConvs: [], engineStartAckDeliveredThisTurn: false,
    staleTaskWindowMinutes: 60, startAckRepliedNow: () => false, isAutoRouted, revertTriggerStampOnAbort: () => undefined,
  });
  if (assembled.directive !== 'proceed') throw new Error(`assemble exited: ${assembled.reason}`);
  state = advance(assembled.state, { phase: CALL_LLM_PHASE });
  const ctx: CallLLMContext = {
    agentId: AGENT, turnCtx: tc, turnNumber: 31, db: db(), counterparty: OWNER as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted, lastUserMessageContent: ASK, selection: assembled.selection,
    messages: assembled.messages, systemPrompt: assembled.systemPrompt, assembled: assembled.assembled,
    modelContext: assembled.modelContext, volatileFrom: assembled.volatileFrom, steerAwaitingConfirm: assembled.steerAwaitingConfirm,
    assemblyTurnContext: assembled.assemblyTurnContext, revertTriggerStampOnAbort: () => undefined,
  };
  const out = await runCallLLM(state, ctx);
  if (out.directive !== 'proceed') throw new Error(`callLLM did not proceed: ${out.directive}`);
}

beforeEach(async () => {
  coldImport1.clearRateLimits();
  mockDb.current = new Database(':memory:');
  runMigrations();
  turns.length = 0;
  dialed.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('N42: an auto-routed agent keeps one window across tiers', () => {
  it('a heavy turn then a light turn: both sized for the 32K floor, the same budget, nothing new out of view on the switch', async () => {
    seed('auto');
    await oneTurn('auto', 'heavy');
    await oneTurn('auto', 'light');
    expect(dialed, 'the router still picks by tier (cheap picks stay cheap)').toEqual([HEAVY, LIGHT]);
    expect(turns.map((t) => t.window), 'every pick runs at the router window: the smallest tier model').toEqual([32_000, 32_000]);
    expect(turns[1].budget, 'the same budget on both turns').toBe(turns[0].budget);
    expect(turns[1].outOfView, 'the switch to the light pick takes nothing new out of view').toBe(turns[0].outOfView);
  });

  it('the owner\'s setting of 20K: both turns at 20K', async () => {
    seed('auto');
    setting(20_000);
    await oneTurn('auto', 'heavy');
    await oneTurn('auto', 'light');
    expect(turns.map((t) => t.window)).toEqual([20_000, 20_000]);
  });

  it('a setting of 500K is clamped to the 32K floor (the slider\'s own top)', async () => {
    seed('auto');
    setting(500_000);
    await oneTurn('auto', 'heavy');
    expect(turns.map((t) => t.window)).toEqual([32_000]);
  });

  it('a 16K model assigned to the light tier: the window follows the new floor to 16K', async () => {
    seed('auto');
    db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)').run('light', TINY, 1);
    await oneTurn('auto', 'heavy');
    expect(turns.map((t) => t.window)).toEqual([16_000]);
  });

  it('CONTROL: an agent with a fixed model is sized by its own model, as before', async () => {
    seed(HEAVY);
    setting(20_000);
    await oneTurn(HEAVY, 'light');
    expect(dialed).toEqual([HEAVY]);
    expect(turns.map((t) => t.window), 'the fixed model\'s own 200K, untouched by the router setting').toEqual([200_000]);
  });
});
