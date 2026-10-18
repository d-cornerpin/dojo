// ════════════════════════════════════════════════════════════════════════════════════════
// t212 (v3.4 D11) — AN AUTO-ROUTED TURN IS BUILT ONCE, FOR THE MODEL IT WILL DIAL.
//
// The router used to read the ASSEMBLED array, so an auto-routed turn was assembled first for the
// largest window the router opens a tier on, routed, and assembled AGAIN for its pick whenever the
// pick's window was smaller (`reassemble-for-fit.ts`). Routing now reads the newest rows from the
// store (`router/routing-view.ts`) and the turn is assembled once, for its pick.
//
// THE DOOR: the driver's own two steps for one iteration, in its order — `runAssemble`, then
// `runCallLLM` — on the real migration chain, with the real assembler (counted, never replaced),
// the real router selector and window resolver. Scripted: the tier decision (classification is not
// the subject), the provider call, the vault and embeddings. The out-of-view fold is the assembly
// door's own business and is reduced to one build, so each count below is one assembly the turn asked for.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

const dialed = vi.hoisted(() => [] as Array<{ modelId: string; systemPrompt: string }>);
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: async (p: { modelId: string; systemPrompt: string }) => {
    dialed.push({ modelId: p.modelId, systemPrompt: p.systemPrompt });
    return { content: 'Bay four is free.', toolCalls: [], inputTokens: 10, outputTokens: 4, stopReason: 'end_turn' };
  },
}));

/** Every assembly the turn asks for, by the model it is built for. */
const built = vi.hoisted(() => [] as string[]);
vi.mock('../../../../../memory/assembler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../memory/assembler.js')>();
  return {
    ...actual,
    assembleContext: (...a: Parameters<typeof actual.assembleContext>) => { built.push(a[1]); return actual.assembleContext(...a); },
  };
});
vi.mock('../../../../../memory/out-of-view-fold.js', () => ({
  assembleWithNothingOutOfViewUnsummarised: async (_a: string, _w: number, build: () => Promise<unknown>) => build(),
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
  semanticTechniqueMatches: async () => [],
}));
vi.mock('../../../../../memory/vector-search.js', () => ({ vectorSearch: async () => [] }));
vi.mock('../../../../../techniques/store.js', () => ({
  listTechniques: () => [], getTechniqueDetail: () => null, recordTechniqueUsage: () => undefined,
}));
vi.mock('../../../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../tools/tool-docs.js')>('../../../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => 2_000, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});
vi.mock('../../../../runtime.js', () => ({
  clearConsumedOneShotFlags: () => undefined,
  injectAttachmentBlocks: () => [],
  enforceModelCapabilities: async () => ({ useTools: true }),
}));
vi.mock('../../../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../outbound-ledger.js')>()),
  getRecentOutbound: () => [],
}));
vi.mock('../../../../../memory/deliveries-lane.js', () => ({ renderDeliveriesLaneMessage: () => null }));
vi.mock('../../../../../work/obligations.js', () => ({ buildOpenWorkInjection: () => null }));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));

/** The tier the router decides. Scripted: which tier is classification's business, not this file's. */
const route = vi.hoisted(() => ({ tier: 'light' as 'light' | 'standard' | 'heavy' }));
vi.mock('../../../../../router/decide.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../router/decide.js')>()),
  decideTier: async () => ({ tier: route.tier, method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { advance, initState } from '../../../state.js';
import { runAssemble, ASSEMBLE_PHASE, type AssembleContext } from '../../assemble/index.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../index.js';

const AGENT = 'agent-t212-dock-desk';
const SMALL = 'm-t212-small-32k';
const LARGE = 'm-t212-large-200k';
const ASK = 'Which bay is free for the next crate?';
const db = (): Database.Database => mockDb.current!;

function seed(configured: string): void {
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
                VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, 0, 0, datetime('now'), datetime('now'))`);
  model.run(SMALL, 'Small', 'small', 32_000);
  model.run(LARGE, 'Large', 'large', 200_000);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('light', SMALL);
  tier.run('standard', LARGE);
  tier.run('heavy', LARGE);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
                VALUES (?, 'Dock Desk', ?, 'idle', '{}', datetime('now'), datetime('now'))`).run(AGENT, configured);
  // ~60K tokens of history: the large window holds all of it, the small one cannot.
  for (let t = 1; t <= 30; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Read me the manifest for bay ${t}.`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${'Crate, bay, weight, seal number, inspector initials, remarks. '.repeat(130)}`, turnNumber: t });
  }
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: ASK, turnNumber: 31 });
}

const OWNER = { kind: 'user' as const, name: 'the owner', relation: 'owner' as const, channel: 'dashboard' as const, senderId: null, threadId: null, senderIsAgent: false };
const turnCtx = (): AssembleContext['turnCtx'] => ({
  agentId: AGENT, conversationId: null, lastAssembledAtIso: null, freshTailDropWarned: false,
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false, startAckSteersInjected: 0,
  startAckSteerInjectedAtLoop: 0, inboundClassifiedAsWork: false,
} as unknown as AssembleContext['turnCtx']);

/** One iteration of the driver: `assemble`, then `callLLM`, each handed what the driver hands it. */
async function oneIteration(configured: string): Promise<void> {
  const isAutoRouted = configured === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configured;
  const { getContextWindow } = await import('../../../../model.js');
  const tc = turnCtx();
  let state = advance(initState(AGENT, configured), { phase: ASSEMBLE_PHASE, loopCount: 1 });
  const assembled = await runAssemble(state, {
    agentId: AGENT, turnCtx: tc, turnNumber: 31, db: db(), contextModelId, contextWindow: getContextWindow(contextModelId),
    counterparty: OWNER, counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: true,
    isA2ATurn: false, isEngineTurn: false, isNotificationTurn: false, lastUserMessageContent: ASK,
    latestTtsEngine: null, latestUserSource: null, mostRecentIsA2A: false, pendingEngineEvent: null,
    mostRecentInbound: null, waitingConvs: [], engineStartAckDeliveredThisTurn: false,
    staleTaskWindowMinutes: 60, startAckRepliedNow: () => false,
  });
  if (assembled.directive !== 'proceed') throw new Error(`assemble exited: ${assembled.reason}`);
  state = advance(assembled.state, { phase: CALL_LLM_PHASE });
  const ctx: CallLLMContext = {
    agentId: AGENT, turnCtx: tc, turnNumber: 31, db: db(), counterparty: OWNER as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted, configuredModelId: configured, lastUserMessageContent: ASK,
    messages: assembled.messages, systemPrompt: assembled.systemPrompt, assembled: assembled.assembled,
    modelContext: assembled.modelContext, volatileFrom: assembled.volatileFrom, steerAwaitingConfirm: assembled.steerAwaitingConfirm,
    assemblyTurnContext: assembled.assemblyTurnContext, revertTriggerStampOnAbort: () => undefined,
  };
  const out = await runCallLLM(state, ctx);
  if (out.directive !== 'proceed') throw new Error(`callLLM did not proceed: ${out.directive}`);
}

beforeEach(async () => {
  (await import('../../../../../router/rate-limits.js')).clearRateLimits();
  mockDb.current = new Database(':memory:');
  runMigrations();
  built.length = 0;
  dialed.length = 0;
  route.tier = 'light';
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t212 — an auto-routed turn is assembled once, for the model it dials', () => {
  it('routed to a model smaller than the largest tier: ONE assembly, built for that model, and that is what is dialled', async () => {
    seed('auto');
    await oneIteration('auto');
    expect(dialed.map((d) => d.modelId), 'the router picked the small model and it answered').toEqual([SMALL]);
    expect(built, 'the turn was assembled once, for the model it dialled').toEqual([SMALL]);
    expect(dialed[0].systemPrompt, 'the system prompt dialled is the one built for that model').toContain(`Model: ${SMALL}`);
  });

  it('routed to the largest model: one assembly, for it', async () => {
    seed('auto');
    route.tier = 'heavy';
    await oneIteration('auto');
    expect(dialed.map((d) => d.modelId)).toEqual([LARGE]);
    expect(built).toEqual([LARGE]);
  });

  it('CONTROL: a pinned agent on the small model is assembled once, for its model, as before', async () => {
    seed(SMALL);
    await oneIteration(SMALL);
    expect(dialed.map((d) => d.modelId)).toEqual([SMALL]);
    expect(built).toEqual([SMALL]);
  });
});
