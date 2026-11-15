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
// lands, yielding to the agent's live turn; the orb's task glyph for the agent says so (field fix 3 #9: no card) and leaves when it is done.
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
  /** Round 3 (review R2/R4): every writer down, or one span answered empty every time. */
  fail: false as boolean, refuse: null as null | string,
}));
vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  callModel: async (p: { modelId: string; purpose?: string }) => {
    if (p.purpose === 'memory_summarize') {
      calls.log.push('summary');
      if (calls.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:9');
      if (calls.refuse && JSON.stringify(p).includes(calls.refuse)) return { content: '', toolCalls: [], inputTokens: 10, outputTokens: 0, stopReason: 'end_turn' };
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

const frames = vi.hoisted(() => [] as Array<{ type?: string; severity?: string; cardKey?: string; error?: string; data?: { id?: string; phase?: string; agentId?: string | null; kind?: string } }>);
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
import { releaseBackgroundSlot, replacePlaceholdersInBackground } from '../../../memory/out-of-view.js';
import { __resetCompactionFailuresForTests, compactionFailureReason } from '../../../memory/compaction-defect.js';
import { clearOn, markWaiting, clearOn } from '../../../memory/writer.js';
import { scheduleLegacyRebuildAtBoot, BOOT_SETTLE_MS } from '../../../memory/legacy-rebuild-boot.js';
import { __resetSummaryWriterHealthForTests } from '../../../memory/writer.js';
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
    isA2ATurn: false, isAutoRouted, selection: assembled.selection,
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
// v3.5 field fix 3 (#9, OR-FIELD3 (c)): the catch-up needs nothing from the owner, so it is no card: it is the orb's
// task glyph for this agent (`engine:activity`, keyed `CARD_KEY`), ended when the last note lands.
const progress = (phase: 'start' | 'end') => frames.filter((f) => f.type === 'engine:activity' && f.data?.id === CARD_KEY && f.data?.phase === phase);
/** Is the glyph up now (its newest frame a start)? */
const showing = (): boolean => { const mine = frames.filter((f) => f.type === 'engine:activity' && f.data?.id === CARD_KEY); return mine.at(-1)?.data?.phase === 'start'; };
const anyCard = () => frames.filter((f) => f.type === 'chat:error' && f.cardKey === CARD_KEY);

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
  calls.inFlight = 0; calls.maxInFlight = 0; calls.written = 0; calls.onSummary = null; calls.fail = false; calls.refuse = null;
  frames.length = 0;
  activeRuns.clear(); backgroundDrains.clear(); __resetCompactionFailuresForTests();
});
afterEach(async () => {
  await folderDone();
  activeRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

/** The owner speaks again: the reply to the last ask lands and a new ask arrives (the next turn's trigger). */
let asks = 91;
function askAgain(): void {
  insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${asks}] Bay four is free.`, turnNumber: asks });
  asks++;
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${asks}] And the one after?`, turnNumber: asks });
}

describe('field fix Y: a grown auto-routed agent whose window shrinks catches up in the background', () => {
  beforeEach(() => { asks = 91; });

  it('the first turn on the 64K router window dials ZERO summaries; the older rows are labelled and kept, none lost', async () => {
    seed('auto');
    const view = await oneTurn('auto');
    expect(calls.log, 'the reply is the only model call of the turn').toEqual(['reply']);
    expect(placeholders(), 'the backlog waits as labelled notes for the background folder').toBeGreaterThan(1);
    expect(lostRows(view), 'a row out of view with nothing in view standing for it').toEqual([]);
  });

  it('round 3 (F3), field fix 3 (#9): the glyph shows when the owner\'s NEXT turn starts on notes: the agent\'s own, no card, never red', async () => {
    seed('auto');
    await oneTurn('auto');
    expect(progress('start'), 'the turn that began the catch-up shows nothing').toHaveLength(0);
    expect(showing()).toBe(false);
    askAgain();
    await oneTurn('auto');   // the owner is talking to an agent still running on notes
    expect(calls.log.filter((c) => c === 'summary'), 'a turn never folds while the catch-up stands').toEqual([]);
    const shown = progress('start');
    expect(shown, 'one glyph for the catch-up').toHaveLength(1);
    expect(shown[0].data).toMatchObject({ kind: 'compaction', agentId: AGENT });
    expect(anyCard(), 'no owner card at all: it needs nothing from him').toEqual([]);
    askAgain();
    await oneTurn('auto');
    expect(new Set(progress('start').map((f) => f.data?.id)), 'shown again at the next turn, as the SAME glyph (a tab opened since picks it up)').toEqual(new Set([CARD_KEY]));
    expect(showing()).toBe(true);
  });

  it('the background folder works through the backlog a span at a time, yields to a live turn, then the card leaves', async () => {
    seed('auto');
    await oneTurn('auto');
    askAgain();
    await oneTurn('auto');   // the card is up
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
    expect(progress('end'), 'not done: the glyph stays').toHaveLength(0);

    // That turn ends (`agent/runtime.ts` starts the folder again): the rest, one at a time, each after the last landed.
    activeRuns.delete(AGENT);
    expect(replacePlaceholdersInBackground(AGENT)).toBe(true);
    await folderDone();
    expect(placeholders(), 'every note replaced by a real summary').toBe(0);
    expect(realSummaries()).toBeGreaterThanOrEqual(owed);
    expect(calls.log.filter((c) => c === 'summary').length, 'successive steps, one per span').toBeGreaterThanOrEqual(owed);
    expect(calls.maxInFlight, 'never two spans at once').toBe(1);
    expect(progress('end'), 'the glyph leaves when the backlog is empty').toHaveLength(1);
    expect(showing()).toBe(false);
  });

  it('round 3 (F1, review R1): the routine condense holds the shared slot at turn end; its release hands the slot on and the catch-up finishes', async () => {
    seed('auto');
    await oneTurn('auto');
    askAgain();
    await oneTurn('auto');
    const owed = placeholders();
    expect(owed).toBeGreaterThan(1);
    backgroundDrains.add(AGENT);   // the gate's fire-and-forget condense (context-gates.ts) still running at turn end
    expect(replacePlaceholdersInBackground(AGENT), 'the turn-end restart is refused while the slot is held').toBe(false);
    releaseBackgroundSlot(AGENT);   // the condense finishes: its release (context-gates.ts `.finally`)
    await folderDone();
    expect(placeholders(), 'not stranded: the backlog folded with no other signal').toBe(0);
    expect(progress('end'), 'and the glyph cleared').toHaveLength(1);
  });

  it('round 3 (F2, review R2): every writer down — the failure notice speaks and the "finishes on its own" card is withdrawn; it is not raised again while failing', async () => {
    seed('auto');
    await oneTurn('auto');
    askAgain();
    await oneTurn('auto');
    expect(progress('start')).toHaveLength(1);
    calls.fail = true;
    replacePlaceholdersInBackground(AGENT);
    await folderDone();
    expect(compactionFailureReason(AGENT), 'the failure is recorded').not.toBeNull();
    expect(progress('end'), 'the catch-up glyph left every dashboard').toHaveLength(1);
    expect(showing()).toBe(false);
    askAgain();
    await oneTurn('auto');
    expect(progress('start'), 'not shown again while the failure speaks').toHaveLength(1);
    expect(placeholders(), 'the notes stand; nothing is lost').toBeGreaterThan(0);
    // The writers come back: the person's turn re-arms them, the folder finishes, nothing is left standing.
    calls.fail = false;
    clearOn({ kind: 'person-spoke', agentId: AGENT });
    replacePlaceholdersInBackground(AGENT);
    await folderDone();
    expect(placeholders()).toBe(0);
    expect(compactionFailureReason(AGENT)).toBeNull();
    expect(showing()).toBe(false);
  });

  it('round 3 (F2, review R4): one span every writer answers empty — the same: the failure notice, not the promise', async () => {
    seed('auto');
    await oneTurn('auto');
    askAgain();
    await oneTurn('auto');
    calls.refuse = '[reply 3]';
    for (let i = 0; i < 3; i++) { replacePlaceholdersInBackground(AGENT); await folderDone(); }
    expect(placeholders(), 'the refused span waits as a note').toBeGreaterThan(0);
    expect(compactionFailureReason(AGENT)).not.toBeNull();
    expect(showing()).toBe(false);
    expect(progress('end'), 'the catch-up glyph was withdrawn').toHaveLength(1);
  });

  it('round 3 (F2): no writer at all — the owner gets the existing failure notice, never the catch-up card', async () => {
    seed('auto');
    for (const m of [STANDARD, HEAVY, LIGHT]) markWaiting(AGENT, m, '', 'not-answering');   // every writer of its order failed: none can run now
    await oneTurn('auto');
    expect(calls.log).toEqual(['reply']);
    expect(placeholders()).toBeGreaterThan(1);
    expect(compactionFailureReason(AGENT), 'the failure notice speaks (its card, unless the breaker already told him)').not.toBeNull();
    askAgain();
    await oneTurn('auto');
    expect(progress('start'), 'no glyph that says the work is moving').toHaveLength(0);
    expect(anyCard()).toEqual([]);
  });

  it('round 3 (F3, review R6): a backlog that folds before the next turn raises no card — first catch-up or a later big turn', async () => {
    seed('auto');
    await oneTurn('auto');
    replacePlaceholdersInBackground(AGENT); await folderDone();
    expect(placeholders()).toBe(0);
    // One ordinary exchange with large tool-ish results (about 40K tokens out of view next turn).
    for (const tag of ['91', '91b', '91c']) insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${tag}] ${'Row: crate, bay, weight, seal, inspector, remarks. '.repeat(1200)}`, turnNumber: 91 });
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: '[ask 92] Summarise the yard.', turnNumber: 92 });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: '[reply 92] Done.', turnNumber: 92 });
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: '[ask 93] Next?', turnNumber: 93 });
    const v = await oneTurn('auto');
    expect(lostRows(v)).toEqual([]);
    replacePlaceholdersInBackground(AGENT); await folderDone();
    expect(placeholders()).toBe(0);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: '[ask 94] Thanks.', turnNumber: 94 });
    await oneTurn('auto');
    expect(frames.filter((f) => f.cardKey === CARD_KEY || f.data?.id === CARD_KEY), 'nothing raised or ended at any point').toEqual([]);
  });

  it('round 2: a catch-up open at a restart resumes at boot with no turn — the backlog folds and the card clears', async () => {
    seed('auto');
    await oneTurn('auto');
    askAgain();
    await oneTurn('auto');
    const owed = placeholders();
    expect(owed, 'precondition: the backlog waits as notes').toBeGreaterThan(1);
    expect(showing(), 'precondition: its glyph is up').toBe(true);
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
    expect(progress('end'), 'the glyph cleared').toHaveLength(1);
    expect(showing()).toBe(false);
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
