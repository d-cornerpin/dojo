// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 5 — THE CONDENSING CHECK MEASURES THE MODEL THE ROUTER DIALS.
//
// ── THE WITNESS (a user's box, 2026-10-08) ──────────────────────────────────────────────
// An auto-routed agent ran 89 calls on 128K models while the condensing check measured a much
// larger window: at v3.3.2 a 200K stand-in for `'__auto__'`; on this branch through round 4,
// the LARGEST window among every enabled routed model — and that box has several 1M rows
// enabled. Condensing never fired for the model actually dialed; the turns built views the
// dialed model could not hold, and the last-moment repair cut them down instead.
//
// ── THE DOORS (the engine's own steps, in the driver's order; no inner function alone) ──
//   1. `getContextWindow('__auto__')`   — the turn's window, exactly as `preflight/turn-trigger.ts`
//                                          computes it for an auto-routed agent
//   2. `runPreCallGates`                — the pre-call step, as the driver calls it
//   3. `assembleWithNothingOutOfViewUnsummarised(… assembleContext('__auto__'))` — the assemble step
//   4. `selectModel` (call-llm)         — the call step's own routing (tier decision scripted: the
//                                          subject is which window is measured, not classification)
//   5. `reassembleForFitIfNeeded`       — the call step, once the router has named its pick
//   6. `callModel`                      — the dial, through the provider boundary
// Real migrations, real router selector, real window resolver, real gate, real assembler, real
// compaction trigger. Scripted: the tier decision, the summariser's text, the transport, the vault.
// `checkAndCompact` is wrapped (not replaced) so every routine condense DECISION is recorded with
// the window and dialed model it was measured for.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

vi.mock('../../../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => { /* not the subject */ }, stampPersistedRow: (e: unknown) => e }));

vi.mock('../../../../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

const TOOL_PAYLOAD_TOKENS = 2_000;
vi.mock('../../../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../tools/tool-docs.js')>('../../../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => TOOL_PAYLOAD_TOKENS, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});

/** The summariser's TEXT is not the subject: a fixed, fictional summary, instantly. */
vi.mock('../../../../../memory/summarize.js', () => ({
  generateSummary: async () => ({ ok: true, text: 'Earlier the crew counted the north dock and logged the damaged lids.', tokenCount: 14 }),
}));

/** The tier the call step's router decides. Scripted: which tier is classification's business. */
const route = vi.hoisted(() => ({ tier: 'standard' as 'light' | 'standard' | 'heavy' }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: async () => ({
    tier: route.tier, method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '',
  }),
}));

/** Every routine condense DECISION: the window it measured and the model it measured it for. */
const decisions = vi.hoisted(() => [] as Array<{ contextWindow: number; dialedModelId?: string; cause?: string }>);
vi.mock('../../../../../memory/compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../memory/compaction.js')>();
  return {
    ...actual,
    checkAndCompact: (agentId: string, modelId: string, contextWindow: number, opts?: { leaving?: { cause: string }; dialedModelId?: string }) => {
      if (opts?.leaving) decisions.push({ contextWindow, dialedModelId: opts.dialedModelId, cause: opts.leaving.cause });
      return (actual.checkAndCompact as (...a: unknown[]) => unknown)(agentId, modelId, contextWindow, opts);
    },
  };
});

/** THE SCRIPTED PROVIDER: the in-tree agent-sdk transport, recording the model each turn request names. */
const provider = vi.hoisted(() => ({ dialed: [] as string[] }));
vi.mock('../../../../../providers/anthropic-sdk.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callAnthropicViaSdk: async (params: { systemPrompt: string; apiModelId: string }) => {
    if (String(params.systemPrompt ?? '').includes('Runtime Information')) provider.dialed.push(params.apiModelId);
    return { content: 'Noted.', toolCalls: [], inputTokens: 40, outputTokens: 12, stopReason: 'end_turn' };
  },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { assembleWithNothingOutOfViewUnsummarised } from '../../../../../memory/out-of-view-fold.js';
import { __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../../../../../memory/assembled-estimate-cache.js';
import { backgroundDrains } from '../../../../shared-state.js';
import { callModel, getContextWindow } from '../../../../model.js';
import { advance, initState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../../pre-call-gates/index.js';
import { selectModel } from '../model-selection.js';
import { reassembleForFitIfNeeded } from '../reassemble-for-fit.js';
import type { PromptTurnContext } from '../../../../../prompt/assembler.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t140-routed-128k';
const PICK_128K = 'm-routed-128k';
const BIG_1M = 'm-enabled-1m';
const API_128K = 'routed-128k-api';
const API_1M = 'enabled-1m-api';
const WINDOW_128K = 128_000;
const WINDOW_1M = 1_000_000;

const db = (): Database.Database => mockDb.current!;

/**
 * A box like the reporting one. `shape`:
 *  · 'owner'  — the 128K model is every tier's first pick; the 1M model is enabled and sits in a
 *               tier below it (the router never reaches it while the 128K answers).
 *  · 'mixed'  — the 1M model is the HEAVY tier's first pick; standard and light pick the 128K.
 */
function seedBox(shape: 'owner' | 'mixed'): void {
  db().prepare(
    `INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
     VALUES ('prov-routed', 'Routed', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`,
  ).run();
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
     VALUES (?, 'prov-routed', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?, datetime('now'), datetime('now'))`,
  );
  model.run(PICK_128K, 'Routed 128K', API_128K, WINDOW_128K, 0.3, 1.2);
  model.run(BIG_1M, 'Enabled 1M', API_1M, WINDOW_1M, 3, 15);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');
  if (shape === 'owner') {
    tier.run('light', PICK_128K, 0);
    tier.run('standard', PICK_128K, 0);
    tier.run('heavy', PICK_128K, 0);
    tier.run('heavy', BIG_1M, 1);
  } else {
    tier.run('light', PICK_128K, 0);
    tier.run('standard', PICK_128K, 0);
    tier.run('heavy', BIG_1M, 0);
  }
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
     VALUES (?, 'Dock Counter', 'auto', 'idle', '{}', datetime('now'), datetime('now'))`,
  ).run(AGENT);
}

/** Fictional bodies (G1). 150 exchanges ≈ 94K tokens over 300 rows — measured: FULL for the 128K
 *  pick (the trim's one-block lead is crossed) yet nothing is cut and the gate's emergency arms stay
 *  quiet (ratio 0.74); nowhere near full for 1M; under both windows' row ceilings (512 and 640). That
 *  is the band where only a check measured for the dialed model condenses ahead of the cut. */
const ASK = 'Please keep counting the crates on the north dock and tell me the running total.';
const REPLY = 'Counted another stack on the north dock; the running total is written on the board beside the ramp, '
  + 'and the damaged lids are set aside for the repair bench this afternoon. ';
function seedConversation(exchanges: number): void {
  for (let t = 1; t <= exchanges; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] ${ASK}`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${REPLY.repeat(14)}`, turnNumber: t });
  }
}

const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

/** One auto-routed turn's first iteration, through the engine's own steps (header, 1–6). */
async function oneRoutedCall(): Promise<{ turnWindow: number; dialedModelId: string }> {
  // 1. preflight/turn-trigger.ts: `contextWindow = getContextWindow('__auto__')`.
  const turnWindow = getContextWindow('__auto__');
  // 2. the pre-call gates, first iteration, nothing locked yet.
  let state = advance(initState({
    agentId: AGENT, contextWindow: turnWindow, isAutoRouted: true, configuredModelId: 'auto',
    turnNumber: 201, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: ASK, lastUserMessageId: null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  }), { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
  const gateCtx = {
    agentId: AGENT, turnNumber: 201, contextWindow: turnWindow, contextModelId: '__auto__',
    configuredModelId: 'auto', isAutoRouted: true, counterparty: OWNER,
    assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: () => { /* not the subject */ },
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  const gated = await runPreCallGates(state, gateCtx);
  expect(gated.directive, 'the gate lets the turn proceed').toBe('proceed');
  state = gated.state;
  // 3. the assemble step: the turn's model id and window, through the engine's assembly door.
  const turnCtx = undefined as unknown as PromptTurnContext;
  const assembled = await assembleWithNothingOutOfViewUnsummarised(AGENT, turnWindow, () => assembleContext(AGENT, '__auto__', turnCtx));
  // 4. the call step's router.
  const selection = await selectModel(state, AGENT, true, 'auto', ASK, assembled.systemPrompt, assembled.messages, () => undefined);
  // 5. the call step, once the pick is named.
  const re = await reassembleForFitIfNeeded({
    agentId: AGENT, modelId: selection.modelId, messages: assembled.messages as never,
    systemPrompt: assembled.systemPrompt, volatileFrom: assembled.messages.length, assemblyTurnContext: turnCtx,
  });
  // 6. the dial.
  await callModel({
    agentId: AGENT, modelId: selection.modelId,
    messages: (re?.messages ?? assembled.messages) as never,
    systemPrompt: re?.systemPrompt ?? assembled.systemPrompt, tools: true,
  });
  for (let i = 0; i < 600 && backgroundDrains.has(AGENT); i++) await new Promise((r) => setTimeout(r, 5));
  return { turnWindow, dialedModelId: selection.modelId };
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  decisions.length = 0;
  provider.dialed.length = 0;
  route.tier = 'standard';
  backgroundDrains.clear();
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
});

afterEach(async () => {
  for (let i = 0; i < 600 && backgroundDrains.has(AGENT); i++) await new Promise((r) => setTimeout(r, 5));
  const { withLock } = await import('../../../../../db/with-lock.js');
  await Promise.race([withLock(`compact:${AGENT}`, async () => undefined, { ifBusy: 'wait' }), new Promise((r) => setTimeout(r, 15_000))]);
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 5 — an auto-routed turn is measured against the model the router dials', () => {
  it('the reporting box\'s shape: every tier picks the 128K model first and a 1M model is enabled below it — the turn\'s window is the 128K pick\'s, not the 1M row\'s', () => {
    seedBox('owner');
    expect(getContextWindow('__auto__'), 'the window the turn builds against is the window of the model the router dials first').toBe(WINDOW_128K);
  });

  it('the reporting box\'s shape: the condensing check measures 128K for the 128K call, and condenses for it', async () => {
    seedBox('owner');
    seedConversation(150);
    const { dialedModelId } = await oneRoutedCall();
    expect(dialedModelId, 'the router dialed the 128K pick').toBe(PICK_128K);
    expect(provider.dialed, 'the provider received the 128K pick\'s request').toEqual([API_128K]);
    expect(decisions.length, 'the condensing check found the view full for the model dialed, and condensed').toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.contextWindow, 'every condensing decision measured the dialed model\'s window').toBe(WINDOW_128K);
      expect(d.dialedModelId, 'and named the dialed model').toBe(PICK_128K);
    }
  });

  it('a box whose HEAVY tier picks the 1M model first: a STANDARD-routed call to the 128K model is measured for 128K, never 1M', async () => {
    seedBox('mixed');
    seedConversation(150);
    route.tier = 'standard';
    const { dialedModelId } = await oneRoutedCall();
    expect(dialedModelId).toBe(PICK_128K);
    expect(provider.dialed).toEqual([API_128K]);
    expect(decisions.length, 'the condensing check found the view full for the model dialed, and condensed').toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.contextWindow, 'no condensing decision measured a window the dialed model does not have').toBe(WINDOW_128K);
      expect(d.dialedModelId).toBe(PICK_128K);
    }
  });

  it('the same mixed box, a HEAVY-routed call to the 1M model: nothing is condensed — the view is nowhere near full for the model dialed', async () => {
    seedBox('mixed');
    seedConversation(150);
    route.tier = 'heavy';
    const { dialedModelId } = await oneRoutedCall();
    expect(dialedModelId).toBe(BIG_1M);
    expect(provider.dialed).toEqual([API_1M]);
    expect(decisions, 'no condense: the 1M model can hold the whole view').toEqual([]);
  });
});
