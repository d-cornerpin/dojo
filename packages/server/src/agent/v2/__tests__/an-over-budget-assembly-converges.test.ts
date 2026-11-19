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
// next turn the park's wake would run. A park dates the job's task row: due now is an immediate wake, a due at
// the brake's expiry is the timer park, and a lock-free event moves it to now.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
const seen = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string; error?: string }>, texts: [] as string[], summaries: 0, wakes: 0, throwIn: null as null | (() => void) }));
vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string; error?: string }) => { seen.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../runtime.js', () => ({
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => { seen.wakes++; }) }),
}));
// The one clock is not driven here: a park's due time on the task row is what each round reads.
vi.mock('../owed.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), armOwedClock: () => undefined }));
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
import { lastCompactionDividerAt } from '../../shared-state.js';
import { withLock } from '../../../db/with-lock.js';
import { contextWindowPolicy, estimateTokens } from '../../../memory/budget.js';
import { resultReadHandlers } from '../../tools/cat/result-read.js';
import { compactionFailureReason } from '../../../memory/compaction-defect.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import * as coldImport1 from '../../../memory/window-starvation-card.js';
import * as coldImport2 from '../full-context-wait.js';

vi.setConfig({ testTimeout: 120_000 });

const AGENT = 'agent-d18-converge';
const MODEL = 'm-d18-32k';
const WINDOW = 32_768;
const db = (): Database.Database => mockDb.current!;
/** How far over the witness's first dial is: more than one fold of the oldest groups can win back. */
const OVER_BY = 4_000;

beforeEach(async () => { await seed(); });
/** A fresh world: the store, the 120 exchanges, and every per-process record a round reads. */
async function seed(): Promise<void> {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seen.cards.length = 0; seen.texts.length = 0; seen.summaries = 0; seen.wakes = 0; seen.throwIn = null;
  lastCompactionDividerAt.clear();
  __resetBrakesForTests();
  coldImport1.__resetStarvedWindowsForTests();
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
  coldImport2.__resetFullContextWaitForTests();
}
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

/** When the job's task is due again (null: not parked); the job turn's pickup clears it. */
const jobDue = (): number | null => (db().prepare("SELECT MIN(next_attempt_at) AS due FROM work WHERE agent_id = ? AND kind = 'task'").get(AGENT) as { due: number | null }).due;
const jobDueNow = (): boolean => { const d = jobDue(); return d !== null && d <= Date.now(); };
const jobPickedUp = (): void => { db().prepare("UPDATE work SET next_attempt_at = NULL WHERE agent_id = ? AND kind = 'task'").run(AGENT); };

/** One turn's recovery: the turn serves the owner's latest request, so its park has a task to date. */
async function recover(err: unknown, turnNumber: number): Promise<void> {
  const ask = (db().prepare("SELECT id FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1").get(AGENT) as { id: string }).id;
  const bag = openTurnContext(AGENT);
  bag.turnNumber = turnNumber;
  bag.root = { kind: 'ask', id: ask, sourceMessageId: ask };
  try { await recoverWith(err, turnNumber); } finally { endTurnContext(AGENT); }
}

async function recoverWith(err: unknown, turnNumber: number): Promise<void> {
  const state = advance(initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL, turnNumber,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'keep counting',
    lastUserMessageId: null, inboundChannel: null, inboundContext: null,
  }), { loopCount: 1 });
  await recoverFromError(state, err, { isUserFacingTurn: true });
}

/** The turn's own rows sized so the FIRST dial is over the boundary's budget by `overBy` tokens. */
async function witnessSize(overBy: number): Promise<number> {
  const assembled = await assembleContext(AGENT, MODEL);
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
      expect(jobDueNow(), `round ${round}: one wake, the re-assembly`).toBe(true);
      jobPickedUp();   // the drain serves it: the next round is that turn
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
    expect(jobDueNow(), 'so the wake waits for it, not at once').toBe(false);
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

  // v3.5 D18 r5 (ruling 3): a turn never waits on another compaction's lock (t140 r6/r7). The refusal's own
  // condense finds the lock busy and returns at once; the door parks, and the wake comes when that pass lands.
  it('a refusal while another compaction holds the lock: the turn does not wait; it parks, and wakes ONCE when that pass lands', async () => {
    const size = await witnessSize(1_000);
    let release!: () => void;
    const held = withLock(`compact:${AGENT}`, () => new Promise<void>((r) => { release = r; }), { ifBusy: 'wait' });
    const { refusal } = await dial(size);
    let done = false;
    const recovering = recover(refusal, 401).then(() => { done = true; });
    for (let i = 0; i < 200 && !done; i++) await new Promise((r) => setTimeout(r, 5));
    expect(done, 'the turn did not wait on the other pass\'s lock').toBe(true);
    await recovering;
    expect(jobDueNow(), 'no immediate wake').toBe(false);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(jobDueNow(), 'no wake while the other pass runs').toBe(false);
    release();
    await held;
    for (let i = 0; i < 100 && !jobDueNow(); i++) await new Promise((r) => setTimeout(r, 30));
    expect(jobDueNow(), 'due when it lands: the one re-assembly').toBe(true);
  });
});

// ── Fix round 3 (re-review probe): a single STORED row that alone fills the room ──────────────────────
// A 32K window, the 120 exchanges of history, then one owner message of ~39.6K tokens; the instructions
// and tools fit. Round 2 folded the history once and then refused identically on the brake's timer for
// ever, telling nobody. The ruling: such a row is kept whole and shown as its head, its tail and the
// kept-result pointer (t200), readable with `tool_result_read`; the assembler never forces the whole
// over-room row back in. Driven through the REAL timer park (fake timers advance the brake's clock).
describe('D18 fix round 3: a single stored row that alone exceeds the room', () => {
  const HUGE_TOKENS = 39_600;
  function storeHugeOwnerMessage(): string {
    const id = 'msg-the-whole-manifest';
    insertMessage({ id, agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner',
      content: `[ask 121] Here is the whole manifest, please check every line:\n${'crate 0412, north dock, sealed, 40 kg, inspected\n'.repeat(Math.ceil(HUGE_TOKENS * 4 / 50))}END OF MANIFEST`, turnNumber: 121 });
    return id;
  }

  it('it fits within a few rounds through the real park and wake, the agent answers, and the whole is one read away', async () => {
    const id = storeHugeOwnerMessage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let fitted = false;
    let rounds = 0;
    try {
      for (let round = 1; round <= 6 && !fitted; round++) {
        rounds = round;
        const { refusal } = await dial(0);
        if (!refusal) { fitted = true; break; }
        await recover(refusal, 500 + round);
        if (jobDueNow()) { jobPickedUp(); continue; }
        await vi.advanceTimersByTimeAsync(16 * 60_000);   // the brake's clock: the timer park comes due
        expect(jobDueNow(), `round ${round}: the timer park is due`).toBe(true);
        jobPickedUp();
      }
    } finally { vi.useRealTimers(); }
    expect(fitted, 'the agent answers').toBe(true);
    expect(rounds, 'within a few rounds').toBeLessThanOrEqual(3);
    const assembled = await assembleContext(AGENT, MODEL);
    const shown = JSON.stringify(assembled.messages);
    expect(shown, 'the head is shown').toContain('[ask 121] Here is the whole manifest');
    expect(shown, 'the tail is shown').toContain('END OF MANIFEST');
    expect(shown, 'with the kept-result pointer').toContain('KEPT WHOLE, NOT ALL SHOWN');
    expect(shown, 'naming the row to read').toContain(`msg:${id}`);
    const read = await resultReadHandlers.tool_result_read({ agentId: AGENT, name: 'tool_result_read', args: { id: `msg:${id}`, search: 'END OF MANIFEST' }, callId: 'c', toolCall: {} as never });
    expect(read.isError, read.content.slice(0, 200)).toBe(false);
    expect(read.content).toContain('END OF MANIFEST');
    expect(seen.texts).toEqual([]);
  });
});

describe('D18 fix round 3: a large stored row and the TIMER park, multi-round', () => {
  it('a stored owner message filling a quarter of the room, the turn\'s rows over it, and a first pass that throws: the timer park wakes it after the brake and it converges', async () => {
    const half = Math.floor(contextWindowPolicy(WINDOW, { toolPayloadTokens: 2_000, maxOutputTokens: 4096 }).assemblyBudgetTokens / 4);
    insertMessage({ id: 'msg-half-manifest', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner',
      content: `[ask 121] A quarter of the manifest:\n${'crate 0412, north dock, sealed, 40 kg, inspected\n'.repeat(Math.ceil(half * 4 / 50))}`, turnNumber: 121 });
    const size = await witnessSize(1_000);   // over by less than the history a fold wins back
    let throws = 1;
    seen.throwIn = () => { if (throws > 0) { throws--; throw new Error('the summary store could not be read'); } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let fitted = false;
    let timerParks = 0;
    let rounds = 0;
    try {
      for (let round = 1; round <= 8 && !fitted; round++) {
        rounds = round;
        const { refusal } = await dial(size);
        if (!refusal) { fitted = true; break; }
        await recover(refusal, 700 + round);
        if (jobDueNow()) { jobPickedUp(); continue; }
        expect(compactionBrakeMsLeft(AGENT), `round ${round}: parked on the brake's timer`).not.toBeNull();
        timerParks++;
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        expect(jobDueNow(), `round ${round}: the timer park is due`).toBe(true);
        jobPickedUp();
      }
    } finally { vi.useRealTimers(); }
    expect(timerParks, 'the timer park was exercised').toBeGreaterThan(0);
    expect(fitted, `it converged in ${rounds} rounds`).toBe(true);
    expect(seen.texts.filter((t) => /stuck/i.test(t))).toEqual([]);
  });
});

describe('D18 fix round 3: a genuine stall is reported once, never silently parked', () => {
  it('the turn\'s own rows alone more than any fold can win back: the brake\'s timer park, the defect recorded, and the owner told once', async () => {
    const size = await witnessSize(30_000);   // this turn's rows alone overflow: nothing stored can shrink enough
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // Every fold wins something until the stored history is gone; then the brake parks it on its timer.
      let braked = 0;
      for (let round = 1; round <= 60 && braked < 3; round++) {
        const { refusal } = await dial(size);
        expect(refusal, `round ${round}: still over`).not.toBeNull();
        await recover(refusal, 800 + round);
        if (jobDueNow()) { jobPickedUp(); continue; }
        braked++;
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        jobPickedUp();
      }
      expect(braked, 'it reached the stall').toBe(3);
    } finally { vi.useRealTimers(); }
    expect(compactionFailureReason(AGENT), 'the stall is a recorded defect').toBe('nothing_left_to_shrink');
    expect(seen.texts.filter((t) => /stuck/i.test(t)), 'the owner is told once').toHaveLength(1);
  });
});

// ── Fix round 3: EVERY forced pass records its outcome, structurally ─────────────────────────────────
describe('D18 fix round 3: a forced pass with nothing to condense records its outcome on every caller', () => {
  it('context-overflow recovery (the recovery door\'s forced pass) arms the brake: no immediate wake on consecutive rounds', async () => {
    db().prepare('DELETE FROM messages WHERE agent_id = ?').run(AGENT);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'Is the north dock open?', turnNumber: 1 });
    for (const turn of [601, 602]) {
      jobPickedUp();
      await recover(new Error('prompt is too long: 40000 tokens > 32768 maximum'), turn);
      expect(compactionBrakeMsLeft(AGENT), `round ${turn}: the no-progress pass armed the brake`).not.toBeNull();
      expect(jobDueNow(), `round ${turn}: no wake at once`).toBe(false);
    }
  });
});

// ── Fix round 4 (re-review t257-rereview-3.md) ──────────────────────────────────────────────────────
/** Rounds through the real park and wake (fake timers advance the brake's clock) until the dial fits. */
async function answersThroughThePark(maxRounds: number, size = 0): Promise<{ fitted: boolean; rounds: number }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let rounds = 0;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      const { refusal } = await dial(size);
      if (!refusal) return { fitted: true, rounds };
      await recover(refusal, 900 + round);
      if (jobDueNow()) { jobPickedUp(); continue; }
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      jobPickedUp();
    }
  } finally { vi.useRealTimers(); }
  return { fitted: false, rounds };
}

async function readWhole(id: string, search: string): Promise<{ isError: boolean; content: string }> {
  return resultReadHandlers.tool_result_read({ agentId: AGENT, name: 'tool_result_read', args: { id, search }, callId: 'c', toolCall: {} as never });
}

describe('D18 fix round 4, finding 1: a structured or JSON-looking owner message over the room is never forced in whole', () => {
  it('the re-reviewer\'s shape: the owner pastes a ~99K-character JSON array export; it is pointered like any row and the agent answers', async () => {
    const id = 'msg-the-json-export';
    const rows = Array.from({ length: 1_400 }, (_, i) => ({ crate: 4000 + i, dock: 'north', sealed: true, kg: 40, inspected: 'yes' }));
    const content = `${JSON.stringify(rows).slice(0, -1)},{"crate":"END OF EXPORT"}]`;
    expect(content.length, 'precondition: the re-reviewer\'s size').toBeGreaterThan(95_000);
    insertMessage({ id, agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content, turnNumber: 121 });
    const { fitted, rounds } = await answersThroughThePark(6);
    expect(fitted, `the agent answers (after ${rounds} rounds)`).toBe(true);
    expect(rounds).toBeLessThanOrEqual(3);
    const shown = JSON.stringify((await assembleContext(AGENT, MODEL)).messages);
    expect(shown, 'with the kept-result pointer naming the row').toContain(`msg:${id}`);
    const read = await readWhole(`msg:${id}`, 'END OF EXPORT');
    expect(read.isError, read.content.slice(0, 200)).toBe(false);
    expect(read.content).toContain('END OF EXPORT');
    expect(seen.texts, 'no stall, so no text').toEqual([]);
  });

  it('a real content-block row: the over-room TEXT block is head + tail + pointer, the image block keeps its own representation, and the agent answers', async () => {
    const id = 'msg-manifest-with-photo';
    const text = `Here is the whole manifest and a photo of the dock:\n${'crate 0412, north dock, sealed, 40 kg, inspected\n'.repeat(3_200)}END OF MANIFEST`;
    const photo = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } };
    insertMessage({ id, agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: JSON.stringify([{ type: 'text', text }, photo]), turnNumber: 121 });
    const { fitted, rounds } = await answersThroughThePark(6);
    expect(fitted, `the agent answers (after ${rounds} rounds)`).toBe(true);
    expect(rounds).toBeLessThanOrEqual(3);
    const messages = (await assembleContext(AGENT, MODEL)).messages as Array<{ role: string; content: unknown }>;
    const row = messages.find((m) => JSON.stringify(m.content).includes('Here is the whole manifest'));
    expect(row, 'the row is in view').toBeDefined();
    const blocks = row!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === 'image'), 'the image block is still a block').toBe(true);
    const shownText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(shownText, 'the head').toContain('Here is the whole manifest');
    expect(shownText, 'the tail').toContain('END OF MANIFEST');
    expect(shownText, 'the pointer names the block').toContain(`msg:${id}#0`);
    expect(shownText.length, 'never the whole').toBeLessThan(text.length / 4);
    const read = await readWhole(`msg:${id}#0`, 'END OF MANIFEST');
    expect(read.isError, read.content.slice(0, 200)).toBe(false);
    expect(read.content).toContain('END OF MANIFEST');
    expect(seen.texts).toEqual([]);
  });
});

describe('D18 fix round 5, ruling 3: the recovery door never waits on another pass\'s lock; it parks until that pass lands', () => {
  it('three consecutive rounds while a background condense holds the lock: each returns at once, no immediate wake, and exactly one wake per pass that lands', async () => {
    db().prepare('DELETE FROM messages WHERE agent_id = ?').run(AGENT);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'Is the north dock open?', turnNumber: 1 });
    for (const turn of [611, 612, 613]) {
      jobPickedUp();
      let release!: () => void;
      const held = withLock(`compact:${AGENT}`, () => new Promise<void>((r) => { release = r; }), { ifBusy: 'wait' });
      let done = false;
      const recovering = recover(new Error('prompt is too long: 40000 tokens > 32768 maximum'), turn).then(() => { done = true; });
      for (let i = 0; i < 200 && !done; i++) await new Promise((r) => setTimeout(r, 5));
      expect(done, `round ${turn}: the turn does not wait on the other pass's lock`).toBe(true);
      await recovering;
      expect(jobDueNow(), `round ${turn}: no immediate wake`).toBe(false);
      release();
      await held;
      for (let i = 0; i < 100 && !jobDueNow(); i++) await new Promise((r) => setTimeout(r, 30));
      expect(jobDueNow(), `round ${turn}: due when it landed`).toBe(true);
    }
  });
});

describe('D18 fix round 4, finding 3: a stall whose first no-progress pass threw is still reported once', () => {
  /** The genuine-stall shape through the timer park; the round of its first timer park, and what was said. */
  async function stall(throwAtRound: number | null): Promise<{ firstPark: number; braked: number }> {
    const size = await witnessSize(30_000);
    let firstPark = 0;
    let braked = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      for (let round = 1; round <= 70 && braked < 4; round++) {
        if (round === throwAtRound) seen.throwIn = () => { seen.throwIn = null; throw new Error('the summary store could not be read'); };
        const { refusal } = await dial(size);
        expect(refusal, `round ${round}: still over`).not.toBeNull();
        await recover(refusal, 1_000 + round);
        if (jobDueNow()) { jobPickedUp(); continue; }
        if (firstPark === 0) firstPark = round;
        braked++;
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        jobPickedUp();
      }
    } finally { vi.useRealTimers(); }
    return { firstPark, braked };
  }

  it('throw then stall: the defect is recorded and the owner is told exactly once', async () => {
    const plain = await stall(null);
    expect(plain.firstPark, 'precondition: the plain stall reaches its first no-progress pass').toBeGreaterThan(1);
    await seed();
    seen.cards.length = 0; seen.texts.length = 0;
    const thrown = await stall(plain.firstPark);
    expect(thrown.firstPark, 'the throw landed on the first no-progress pass').toBe(plain.firstPark);
    expect(thrown.braked).toBe(4);
    expect(compactionFailureReason(AGENT), 'the stall is a recorded defect').toBe('nothing_left_to_shrink');
    expect(seen.texts.filter((t) => /stuck/i.test(t)), 'the owner is told once').toHaveLength(1);
  });
});

// ── Fix round 5 (re-review t257-rereview-4.md) ──────────────────────────────────────────────────────
describe('D18 fix round 5, finding 1: a block row over the room although no single block is', () => {
  it('the re-reviewer\'s shape: 4,000 short text blocks (~500K characters) collapse into ONE head + tail + pointer; it fits and the agent answers', async () => {
    const id = 'msg-many-short-blocks';
    const blocks = Array.from({ length: 4_000 }, (_, i) => ({ type: 'text', text: `crate ${4000 + i}, north dock, sealed, 40 kg, inspected by the morning shift on the ramp beside the board${'.'.repeat(30)}` }));
    blocks.push({ type: 'text', text: 'END OF TRANSCRIPT' });
    const content = JSON.stringify(blocks);
    expect(content.length, 'precondition: the re-reviewer\'s size').toBeGreaterThan(450_000);
    insertMessage({ id, agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content, turnNumber: 121 });
    const { fitted, rounds } = await answersThroughThePark(6);
    expect(fitted, `the agent answers (after ${rounds} rounds)`).toBe(true);
    expect(rounds).toBeLessThanOrEqual(3);
    const shown = JSON.stringify((await assembleContext(AGENT, MODEL)).messages);
    expect(shown, 'one pointer naming the row').toContain(`msg:${id}`);
    expect(shown, 'the head').toContain('crate 4000, north dock');
    expect(shown, 'the tail').toContain('END OF TRANSCRIPT');
    const read = await readWhole(`msg:${id}`, 'END OF TRANSCRIPT');
    expect(read.isError, read.content.slice(0, 200)).toBe(false);
    expect(read.content).toContain('END OF TRANSCRIPT');
    expect(seen.texts, 'no stall, so no text').toEqual([]);
  });
});

describe('D18 fix round 5, finding 2: a msg: read is allowed exactly when the view showed the pointer', () => {
  it('the re-reviewer\'s shape: an ENGINE turn whose trigger is an over-room events row with no conversation — the view pointers it, and the pointer reads on that turn', async () => {
    const id = 'msg-engine-event-huge';
    insertMessage({ id, agentId: AGENT, role: 'user', lane: 'events', content: `[engine] The dock sensor log:\n${'sensor 7, north dock, door open, 12 C\n'.repeat(12_000)}END OF SENSOR LOG`, turnNumber: 121 });
    const bag = openTurnContext(AGENT);
    bag.root = { kind: 'engine', id: 'engine-root', sourceMessageId: null, conversationId: null };
    bag.conversationId = null;
    bag.triggerMessageId = id;
    let shown = '';
    let read: { isError: boolean; content: string };
    try {
      shown = JSON.stringify((await assembleContext(AGENT, MODEL)).messages);
      read = await readWhole(`msg:${id}`, 'END OF SENSOR LOG');
    } finally { endTurnContext(AGENT); }
    // (On this turn the row reaches the view through the empty-context fallback, a third site that used to force
    // an over-room row in whole.)
    expect(shown.length, 'never the whole row').toBeLessThan(100_000);
    expect(shown, 'the view pointers the row').toContain(`msg:${id}`);
    expect(read.isError, read.content.slice(0, 200)).toBe(false);
    expect(read.content).toContain('END OF SENSOR LOG');
  });

  it('a row the view never showed is refused, though it is the agent\'s own', async () => {
    insertMessage({ id: 'msg-never-shown', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'a short note', turnNumber: 121 });
    await assembleContext(AGENT, MODEL);
    const read = await readWhole('msg:msg-never-shown', 'note');
    expect(read.isError).toBe(true);
  });
});
