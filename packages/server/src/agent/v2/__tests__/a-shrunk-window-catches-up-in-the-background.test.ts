// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix Y (field failure 4; owner ruling 2026-11-03: "gradually, in the background") — WHEN A
// GROWN AGENT'S WINDOW SHRINKS, THE CATCH-UP FOLD NEVER RUNS INSIDE THE OWNER'S TURN.
//
// The defect, reproduced: an auto-routed agent that grew on 1M-window picks (lots of history, no summaries)
// runs its first turn on the one router window (N42, the smallest tier model's 64K, kept as the owner's
// design). The assembly door folded everything now out of view before the reply — 30K-token summary calls on
// the agent's own model, inside the turn (the field run: 209 rows, 4 leaf + 2 merge calls on turn 1).
//
// The ruling: the turn assembles the newest rows that fit beside the summaries; the older rows are labelled and
// kept (placeholder notes), and a background folder replaces them a span at a time, the next when the one before
// lands, yielding to the agent's live turn; one plain dashboard card says so and leaves when it is done.
//
// THE DOOR: the driver's own two steps for one iteration (`runAssemble`, `runCallLLM`) on the real migration
// chain, with the real assembler, router, out-of-view door and placeholder machinery. Scripted: the tier
// decision and the provider (every summary call is recorded, with when it ran relative to the reply).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

/** Every model call: a summary (its depth) or the turn's reply, in order, and how many summaries ran at once. */
const calls = vi.hoisted(() => ({
  log: [] as Array<'summary' | 'reply'>,
  inFlight: 0, maxInFlight: 0, written: 0,
  /** Called as each summary lands, so a clause can start a live turn in the middle of the folder's work. */
  onSummary: null as null | (() => void),
}));
vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  callModel: async (p: { modelId: string; purpose?: string }) => {
    if (p.purpose === 'memory_summarize') {
      calls.log.push('summary');
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      await new Promise((r) => setImmediate(r));
      calls.inFlight--;
      calls.written++;
      calls.onSummary?.();
      return { content: `Summary ${calls.written}: the desk logged the crates, their bays and their seals.`, toolCalls: [], inputTokens: 10, outputTokens: 20, stopReason: 'end_turn' };
    }
    calls.log.push('reply');
    return { content: 'Bay four is free.', toolCalls: [], inputTokens: 10, outputTokens: 4, stopReason: 'end_turn' };
  },
}));

const frames = vi.hoisted(() => [] as Array<{ type?: string; severity?: string; cardKey?: string; error?: string }>);
vi.mock('../../../gateway/ws.js', () => ({ broadcast: (e: { type?: string }) => { frames.push(e); }, stampPersistedRow: (e: unknown) => e }));
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
vi.mock('../../../router/decide.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../router/decide.js')>()),
  decideTier: async () => ({ tier: 'heavy', method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));

// FIRST, so the summary writer binds the scripted provider: the real model module's own import chain reaches
// `summarize.ts`, and a module first loaded inside that chain would bind the real `callModel`.
import '../../../memory/summarize.js';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { advance, initState } from '../state.js';
import { runAssemble, ASSEMBLE_PHASE } from '../steps/assemble/index.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../steps/call-llm/index.js';
import type { AssembleContext } from '../steps/assemble/index.js';
import { getContextWindow } from '../../model.js';
import { activeRuns, backgroundDrains } from '../../shared-state.js';
import { replacePlaceholdersInBackground } from '../../../memory/uncondensed-placeholder.js';
import { catchUpOwnerCards } from '../../../memory/catch-up-state.js';
import { scheduleLegacyRebuildAtBoot, BOOT_SETTLE_MS } from '../../../memory/legacy-rebuild-boot.js';
import { __resetSummaryWriterHealthForTests } from '../../../memory/summary-writer-health.js';
import * as coldImport1 from '../../../router/rate-limits.js';

const AGENT = 'agent-fix-y-dock-desk';
const LIGHT = 'm-fix-y-light-64k';
const STANDARD = 'm-fix-y-standard-1m';
const HEAVY = 'm-fix-y-heavy-1m';
const ASK = 'Which bay is free for the next crate?';
const CARD_KEY = `memory-catch-up:${AGENT}`;
const db = (): Database.Database => mockDb.current!;

/** A grown history: 90 exchanges of about 1,500 tokens (about 135K), no summaries — what a 1M window held whole. */
function seed(configured: string): void {
  // A closed loopback port: a call that ever slipped past the scripted provider could not leave this machine.
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, base_url, is_validated, created_at, updated_at)
                VALUES ('prov', 'P', 'openai-compatible', 'api_key', 'http://127.0.0.1:9/v1', 1, datetime('now'), datetime('now'))`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m, created_at, updated_at)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1, 3, 15, datetime('now'), datetime('now'))`);
  model.run(LIGHT, 'Dock Light', 'light', 64_000);
  model.run(STANDARD, 'Dock Standard', 'standard', 1_000_000);
  model.run(HEAVY, 'Dock Heavy', 'heavy', 1_000_000);
  const tier = db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)');
  tier.run('light', LIGHT, 0);
  tier.run('standard', STANDARD, 0);
  tier.run('heavy', HEAVY, 0);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
                VALUES (?, 'Dock Desk', ?, 'idle', '{}', datetime('now'), datetime('now'))`).run(AGENT, configured);
  for (let t = 1; t <= 90; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Read me the manifest for bay ${t}.`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${'Crate, bay, weight, seal number, inspector initials, remarks. '.repeat(100)}`, turnNumber: t });
  }
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: ASK, turnNumber: 91 });
}

const OWNER = { kind: 'user' as const, name: 'the owner', relation: 'owner' as const, channel: 'dashboard' as const, senderId: null, threadId: null, senderIsAgent: false };
const turnCtx = (): AssembleContext['turnCtx'] => ({
  agentId: AGENT, conversationId: null, lastAssembledAtIso: null, freshTailDropWarned: false,
  startAckSteerRequested: false, startAckSteerArmedThisTurn: false, startAckSteersInjected: 0,
  startAckSteerInjectedAtLoop: 0, inboundClassifiedAsWork: false,
} as unknown as AssembleContext['turnCtx']);

/** One turn's first iteration, as the driver runs it. Returns the messages the reply was dialled with. */
async function oneTurn(configured: string): Promise<string> {
  const isAutoRouted = configured === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configured;
  const tc = turnCtx();
  let state = advance(initState(AGENT, configured), { phase: ASSEMBLE_PHASE, loopCount: 1 });
  const assembled = await runAssemble(state, {
    agentId: AGENT, turnCtx: tc, turnNumber: 91, db: db(), contextModelId, contextWindow: getContextWindow(contextModelId),
    counterparty: OWNER, counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: true,
    isA2ATurn: false, isEngineTurn: false, isNotificationTurn: false, lastUserMessageContent: ASK,
    latestTtsEngine: null, latestUserSource: null, mostRecentIsA2A: false, pendingEngineEvent: null,
    mostRecentInbound: null, waitingConvs: [], engineStartAckDeliveredThisTurn: false,
    staleTaskWindowMinutes: 60, startAckRepliedNow: () => false, isAutoRouted, revertTriggerStampOnAbort: () => undefined,
  });
  if (assembled.directive !== 'proceed') throw new Error(`assemble exited: ${assembled.reason}`);
  state = advance(assembled.state, { phase: CALL_LLM_PHASE });
  const ctx: CallLLMContext = {
    agentId: AGENT, turnCtx: tc, turnNumber: 91, db: db(), counterparty: OWNER as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false, isAutoRouted, lastUserMessageContent: ASK, selection: assembled.selection,
    messages: assembled.messages, systemPrompt: assembled.systemPrompt, assembled: assembled.assembled,
    modelContext: assembled.modelContext, volatileFrom: assembled.volatileFrom, steerAwaitingConfirm: assembled.steerAwaitingConfirm,
    assemblyTurnContext: assembled.assemblyTurnContext, revertTriggerStampOnAbort: () => undefined,
  };
  const out = await runCallLLM(state, ctx);
  if (out.directive !== 'proceed') throw new Error(`callLLM did not proceed: ${out.directive}`);
  await settle();   // anything the turn started in the background gets its chance to dial, so it is counted
  return JSON.stringify(ctx.messages);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

/** Waits for the background folder (and any pass it chains) to finish. */
async function folderDone(): Promise<void> {
  for (let i = 0; i < 2_000 && backgroundDrains.has(AGENT); i++) await new Promise((r) => setTimeout(r, 5));
  await settle();
}

const placeholders = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { n: number }).n;
const realSummaries = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind != 'uncondensed'").get(AGENT) as { n: number }).n;
const cardFrames = (severity: string) => frames.filter((f) => f.type === 'chat:error' && f.cardKey === CARD_KEY && f.severity === severity);

/** Rows neither in the dialled view nor covered by a summary or note that is itself in the dialled view. */
function lostRows(view: string): string[] {
  const rows = db().prepare('SELECT id, content FROM messages WHERE agent_id = ?').all(AGENT) as Array<{ id: string; content: string }>;
  const cover = db().prepare('SELECT s.content AS content FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE sm.message_id = ?');
  const lost: string[] = [];
  for (const r of rows) {
    const marker = /\[(ask|reply) \d+\]/.exec(r.content)?.[0];
    if (!marker || view.includes(marker)) continue;
    const covers = cover.all(r.id) as Array<{ content: string }>;
    if (!covers.some((c) => view.includes(JSON.stringify(c.content).slice(1, 60)))) lost.push(marker);
  }
  return lost;
}

beforeEach(() => {
  coldImport1.clearRateLimits();
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  calls.log.length = 0;
  calls.inFlight = 0; calls.maxInFlight = 0; calls.written = 0; calls.onSummary = null;
  frames.length = 0;
  activeRuns.clear();
});
afterEach(async () => {
  await folderDone();
  activeRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('field fix Y: a grown auto-routed agent whose window shrinks catches up in the background', () => {
  it('the first turn on the 64K router window dials ZERO summaries; the older rows are labelled and kept, none lost', async () => {
    seed('auto');
    const view = await oneTurn('auto');
    expect(calls.log, 'the reply is the only model call of the turn').toEqual(['reply']);
    expect(placeholders(), 'the backlog waits as labelled notes for the background folder').toBeGreaterThan(1);
    expect(lostRows(view), 'a row out of view with nothing in view standing for it').toEqual([]);
  });

  it('one plain card says so while it runs (and lasts across a reload); none is raised twice', async () => {
    seed('auto');
    await oneTurn('auto');
    const shown = cardFrames('warning');
    expect(shown, 'one card for the catch-up').toHaveLength(1);
    expect(shown[0].error).toBe('Dojo: Dock Desk is tidying its older memory to fit the Router\'s memory size. Replies are not held up; this finishes on its own.');
    expect(catchUpOwnerCards().map((c) => c.cardKey), 'the owner-notices list re-derives it').toEqual([CARD_KEY]);
    // A second turn while the backlog stands: still no summary in the turn, and no second card.
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: '[reply 91] Bay four is free.', turnNumber: 91 });
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: '[ask 92] And the one after?', turnNumber: 92 });
    await oneTurn('auto');
    expect(calls.log.filter((c) => c === 'summary'), 'a turn never folds while the catch-up stands').toEqual([]);
    expect(cardFrames('warning')).toHaveLength(1);
  });

  it('the background folder works through the backlog a span at a time, yields to a live turn, then the card leaves', async () => {
    seed('auto');
    await oneTurn('auto');
    const owed = placeholders();
    expect(owed).toBeGreaterThan(1);

    // Mid-turn it does not start.
    activeRuns.add(AGENT);
    expect(replacePlaceholdersInBackground(AGENT), 'the agent is mid-turn: the folder waits').toBe(false);
    activeRuns.delete(AGENT);

    // It starts at the turn's end; a live turn beginning after its first span lands sets it aside.
    calls.onSummary = () => { activeRuns.add(AGENT); calls.onSummary = null; };
    expect(replacePlaceholdersInBackground(AGENT)).toBe(true);
    await folderDone();
    expect(calls.log.filter((c) => c === 'summary'), 'one span, then it yielded to the live turn').toHaveLength(1);
    expect(placeholders()).toBe(owed - 1);
    expect(cardFrames('info'), 'not done: the card stays').toHaveLength(0);

    // That turn ends (`agent/runtime.ts` starts the folder again): the rest, one at a time, each after the last landed.
    activeRuns.delete(AGENT);
    expect(replacePlaceholdersInBackground(AGENT)).toBe(true);
    await folderDone();
    expect(placeholders(), 'every note replaced by a real summary').toBe(0);
    expect(realSummaries()).toBeGreaterThanOrEqual(owed);
    expect(calls.log.filter((c) => c === 'summary').length, 'successive steps, one per span').toBeGreaterThanOrEqual(owed);
    expect(calls.maxInFlight, 'never two spans at once').toBe(1);
    expect(cardFrames('info'), 'the card leaves when the backlog is empty').toHaveLength(1);
    expect(catchUpOwnerCards()).toEqual([]);
  });

  it('round 2: a catch-up open at a restart resumes at boot with no turn — the backlog folds and the card clears', async () => {
    seed('auto');
    await oneTurn('auto');
    const owed = placeholders();
    expect(owed, 'precondition: the backlog waits as notes').toBeGreaterThan(1);
    expect(catchUpOwnerCards().map((c) => c.cardKey), 'precondition: its record is open').toEqual([CARD_KEY]);
    // The restart: every in-memory fact is gone; only the database (the notes and the record) remains. No turn follows.
    backgroundDrains.clear(); activeRuns.clear(); __resetSummaryWriterHealthForTests();
    calls.log.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      scheduleLegacyRebuildAtBoot();   // the boot's own memory start (index.ts)
      vi.advanceTimersByTime(BOOT_SETTLE_MS);
    } finally { vi.useRealTimers(); }
    await folderDone();
    expect(calls.log, 'no turn ran; only the folder dialled').not.toContain('reply');
    expect(calls.log.filter((c) => c === 'summary').length).toBeGreaterThanOrEqual(owed);
    expect(placeholders(), 'the backlog folded on its own').toBe(0);
    expect(cardFrames('info'), 'the card cleared').toHaveLength(1);
    expect(catchUpOwnerCards()).toEqual([]);
  });

  it('CONTROL: the same history on a fixed 1M model is unchanged — nothing folded, no card', async () => {
    seed(HEAVY);
    await oneTurn(HEAVY);
    expect(calls.log).toEqual(['reply']);
    expect(placeholders()).toBe(0);
    expect(realSummaries()).toBe(0);
    expect(frames.filter((f) => f.cardKey === CARD_KEY)).toEqual([]);
  });
});
