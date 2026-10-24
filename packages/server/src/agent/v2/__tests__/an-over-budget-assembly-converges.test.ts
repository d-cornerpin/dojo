// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 fix round 2 — AN OVER-BUDGET ASSEMBLY CONVERGES: IT NEVER LOOPS AND NEVER SURRENDERS.
//
// Round 1 sent every refusal whose instructions and tools fit to the full-context-wait park: condense,
// then one wake. The wake waits only while the compaction brake is armed, and three no-progress shapes
// never armed it, so the agent woke at once into the same refusal, for ever, with nothing said to anyone
// (the t168 "1,216 wakes" class):
//   (i)   a forced pass with nothing outside the protected recent part and every summary fitting;
//   (ii)  a condense that threw;
//   (iii) a forced pass skipped because another compaction held the agent's lock.
// The ruling: every exit of a forced pass records its outcome; a pass with nothing left outside the
// protected part folds the OLDEST whole group of it (summarised, never dropped), one group per pass;
// a throw arms the brake and, after the brake's own bound, tells the owner once (the compaction card).
//
// Driven MULTI-ROUND through the real doors: the assembler, the provider boundary
// (`validateAtProviderBoundary`, with the lane map `callModel` reads), the real forced condense with a
// scripted summary writer (the in-tree transport), `recoverFromError` and its park. Each round is the
// next turn the park's wake would run.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
const seen = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string; error?: string }>, texts: [] as string[], summaries: 0, throwIn: null as null | (() => void) }));
vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string; error?: string }) => { seen.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../runtime.js', () => ({
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined) }),
}));
vi.mock('../../../services/imessage-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAlert: (words: string) => { seen.texts.push(words); },
}));
vi.mock('../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));
vi.mock('../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tools/tool-docs.js')>('../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => 2_000, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});
// The summary writer: the in-tree transport, scripted to a short summary.
vi.mock('../../../providers/anthropic-sdk.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callAnthropicViaSdk: async () => {
    seen.summaries++;
    return { content: 'The crates on the north dock were counted and the totals written on the board.', toolCalls: [], inputTokens: 40, outputTokens: 20, stopReason: 'end_turn' };
  },
}));
// Shape (ii): a forced pass that throws, from inside the pass (its first measurement).
vi.mock('../../../memory/assembled-estimate-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../memory/assembled-estimate-cache.js')>();
  return { ...actual, cachedAssembledEstimate: (...a: Parameters<typeof actual.cachedAssembledEstimate>) => { seen.throwIn?.(); return actual.cachedAssembledEstimate(...a); } };
});

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { assembleContext } from '../../../memory/assembler.js';
import { validateAtProviderBoundary, AssemblyValidationError, assemblyTokens, type ValidatedMessage } from '../../../memory/assembly-validation.js';
import { collectMessageLaneIds } from '../../../memory/message-lane-tag.js';
import { __resetBrakesForTests, compactionBrakeMsLeft } from '../../../memory/compaction-brakes.js';
import { recoverFromError } from '../recovery.js';
import { initState, advance } from '../state.js';
import { pendingWakeups } from '../../shared-state.js';
import { withLock } from '../../../db/with-lock.js';

vi.setConfig({ testTimeout: 120_000 });

const AGENT = 'agent-d18-converge';
const MODEL = 'm-d18-32k';
const WINDOW = 32_768;
const db = (): Database.Database => mockDb.current!;
/** How far over the witness's first dial is: more than one fold of the oldest groups can win back. */
const OVER_BY = 4_000;

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  seen.cards.length = 0; seen.texts.length = 0; seen.summaries = 0; seen.throwIn = null;
  pendingWakeups.clear();
  __resetBrakesForTests();
  (await import('../../../memory/window-starvation-card.js')).__resetStarvedWindowsForTests();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'prov', 'Dock 32K', 'sonnet', '["text","tools"]', ?, 4096, 1, datetime('now'), datetime('now'))`).run(MODEL, WINDOW);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES (?, 'Dock Counter', ?, 'working', '{}', datetime('now'), datetime('now'))`).run(AGENT, MODEL);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'nobody')").run();
  const reply = 'Counted another stack on the north dock; the running total is on the board beside the ramp. ';
  for (let t = 1; t <= 120; t++) {
    db().prepare(`INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
      VALUES (?, ?, 'user', datetime('now'), datetime('now'), 'answered', 1)`).run(AGENT, t);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Keep counting the crates.`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${reply.repeat(6)}`, turnNumber: t });
  }
});
afterEach(async () => {
  await Promise.race([withLock(`compact:${AGENT}`, async () => undefined, { ifBusy: 'wait' }), new Promise((r) => setTimeout(r, 15_000))]);
  mockDb.current?.close();
  mockDb.current = null;
});

/** This turn's own rows, appended by the loop after the assembly (untagged): a tool call and its result. */
function inTurnRows(resultTokens: number): ValidatedMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-count', name: 'vault_get', input: {} }] as never },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-count', content: 'crate ledger line. '.repeat(Math.ceil(resultTokens / 4)) }] as never },
  ];
}

/** One dial of one turn: the assembly plus the turn's own rows, through the boundary. The refusal, or null when it fits. */
async function dial(resultTokens: number): Promise<{ refusal: AssemblyValidationError | null; tokens: number; liveTokens: number }> {
  const assembled = await assembleContext(AGENT, MODEL);
  const messages = [...assembled.messages as ValidatedMessage[], ...inTurnRows(resultTokens)];
  const tokens = assemblyTokens(messages);
  const lanes = collectMessageLaneIds(messages);
  // The live conversation the agent is shown word for word: what a fold of the protected part moves.
  const liveTokens = assemblyTokens(messages.filter((_, i) => lanes[i] === 'lane.fresh-tail'));
  try {
    await validateAtProviderBoundary({ agentId: AGENT, modelId: MODEL, messages, systemPrompt: assembled.systemPrompt, contextWindow: WINDOW, maxOutputTokens: 4096, laneIds: collectMessageLaneIds(messages) });
    return { refusal: null, tokens, liveTokens };
  } catch (e) {
    if (e instanceof AssemblyValidationError) return { refusal: e, tokens, liveTokens };
    throw e;
  }
}

async function recover(err: unknown, turnNumber: number): Promise<void> {
  const state = advance(initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL, turnNumber,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'keep counting',
    lastUserMessageId: null, inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
  }), { loopCount: 1 });
  await recoverFromError(state, err, { isUserFacingTurn: true });
}

/** The turn's own rows sized so the FIRST dial is over the boundary's budget by `overBy` tokens. */
async function witnessSize(overBy: number): Promise<number> {
  const assembled = await assembleContext(AGENT, MODEL);
  const { contextWindowPolicy, estimateTokens } = await import('../../../memory/budget.js');
  const budget = contextWindowPolicy(WINDOW, { toolPayloadTokens: 2_000, maxOutputTokens: 4096 }).assemblyBudgetTokens - estimateTokens(assembled.systemPrompt);
  const first = await dial(0);
  expect(first.refusal, 'precondition: the assembly alone fits').toBeNull();
  const size = budget - first.tokens + overBy;
  return size;
}

describe('D18 fix round 2: the witness shape converges through the real park and wake', () => {
  it('it terminates; every round shrinks the live conversation; no two wakes see the same refusal; never the card, never a text', async () => {
    const size = await witnessSize(OVER_BY);
    const attempted: number[] = [];
    const refusals: string[] = [];
    let fitted = false;
    for (let round = 1; round <= 40 && !fitted; round++) {
      const { refusal, liveTokens, tokens } = await dial(size);
      attempted.push(liveTokens);
      if (!refusal) { fitted = true; break; }
      refusals.push(refusal.message);
      await recover(refusal, 200 + round);
      expect(compactionBrakeMsLeft(AGENT), `round ${round}: the pass made progress (no brake)`).toBeNull();
      expect(pendingWakeups.has(AGENT), `round ${round}: one wake, the re-assembly`).toBe(true);
      pendingWakeups.clear();   // the drain serves it: the next round is that turn
    }
    expect(fitted, `the assembly converged: ${attempted.join(' → ')}`).toBe(true);
    expect(attempted.length, 'it needed more than one round, so the convergence is what was measured').toBeGreaterThan(2);
    for (let i = 1; i < attempted.length; i++) expect(attempted[i], `round ${i + 1}'s live conversation is smaller than round ${i}'s`).toBeLessThan(attempted[i - 1]);
    for (let i = 1; i < refusals.length; i++) expect(refusals[i], `wake ${i + 1} does not see wake ${i}'s refusal`).not.toBe(refusals[i - 1]);
    expect(seen.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL')).toEqual([]);
    expect(seen.texts).toEqual([]);
  });
});

describe('D18 fix round 2: a forced pass that cannot run records its outcome, so the park waits', () => {
  it('a condense that THROWS arms the brake (the wake waits for it), and after the brake\'s bound the owner is told once — the compaction card, never "stuck"', async () => {
    const size = await witnessSize(1_000);
    seen.throwIn = () => { throw new Error('the summary store could not be read'); };
    const first = await dial(size);
    await recover(first.refusal, 301);
    expect(compactionBrakeMsLeft(AGENT), 'the throw armed the brake').not.toBeNull();
    expect(pendingWakeups.has(AGENT), 'so the wake waits for it, not at once').toBe(false);
    expect(seen.cards.filter((c) => c.code === 'COMPACTION_FAILING'), 'not told on the first throw').toEqual([]);
    // The brake's own bound passes; the wake's turn refuses again and the pass throws again.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    try {
      const second = await dial(size);
      await recover(second.refusal, 302);
    } finally { vi.useRealTimers(); }
    expect(seen.cards.filter((c) => c.code === 'COMPACTION_FAILING'), 'told once, through the compaction card').toHaveLength(1);
    expect(seen.texts.filter((t) => /stuck/i.test(t)), 'never the stuck text').toEqual([]);
    expect(seen.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL')).toEqual([]);
  });

  it('a pass skipped because another compaction holds the lock WAITS for it, then re-assembles once', async () => {
    const size = await witnessSize(1_000);
    const { refusal } = await dial(size);
    let release!: () => void;
    const held = withLock(`compact:${AGENT}`, () => new Promise<void>((r) => { release = r; }), { ifBusy: 'wait' });
    await new Promise((r) => setTimeout(r, 20));
    let done = false;
    const recovering = recover(refusal, 401).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(done, 'recovery waits for the running pass').toBe(false);
    release();
    await held;
    await recovering;
    expect(seen.summaries, 'the refusal\'s own pass ran after the other one').toBeGreaterThan(0);
    expect(pendingWakeups.has(AGENT), 'one re-assembly').toBe(true);
  });
});
