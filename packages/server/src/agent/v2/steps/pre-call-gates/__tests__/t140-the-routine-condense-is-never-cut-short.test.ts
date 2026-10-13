// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 5 — THE ROUTINE BACKGROUND CONDENSE HAS NO CLOCK AND NO CHUNK CAP (owner ruling
// 2026-10-13: no hard limits; the dojo knows when enough is enough).
//
// On a user's box a real summary was refused because the background drain's 60-second clock
// aborted the writer mid-call. This branch's routine condense carried the same shape: a three-
// minute clock and ten chunks per run. Neither says anything true about the work: a writer that
// is answering is not hung (its provider's own patience, in the transport, says when it is), and
// the rows leaving the view are exactly as many as are leaving. The background condense now folds
// exactly the leaving span, ends only on Stop, a preemption by the turn, or the writer's own
// transport giving up — and tries the owner's preferred writer even after it failed once, since
// in the background nobody waits on it, and its first answer is how the engine learns it is back.
//
// THE DOOR: `runPreCallGates`, as the driver calls it, on a migrated DB; the summariser's text is
// scripted, on a fake clock.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => 2_000,
}));

/** The writer: answers after `slowMs` of (fake) time unless its call is aborted first. */
const summariser = vi.hoisted(() => ({ slowMs: 0, calls: [] as string[] }));
vi.mock('../../../../../memory/summarize.js', async () => {
  const health = await import('../../../../../memory/summary-writer-health.js');
  return {
    generateSummary: async (args: { modelId?: string; abortSignal?: AbortSignal }) => {
      summariser.calls.push(args.modelId ?? '?');
      const ok = await new Promise<boolean>((resolve) => {
        if (summariser.slowMs <= 0) { resolve(true); return; }
        const t = setTimeout(() => resolve(true), summariser.slowMs);
        const cut = () => { clearTimeout(t); resolve(false); };
        if (args.abortSignal?.aborted) cut(); else args.abortSignal?.addEventListener('abort', cut, { once: true });
      });
      health.noteSummaryWriterOutcome(args.modelId, ok, args.abortSignal);
      return ok
        ? { ok: true, text: `Earlier dock questions, part ${summariser.calls.length}, all answered.`, tokenCount: 9 }
        : { ok: false, reason: 'summarizer call was aborted before it finished' };
    },
  };
});

vi.mock('../../../../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));
vi.mock('../../../../../config/platform.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemServiceAgent: vi.fn(() => false),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { backgroundDrains, pendingWakeups, stoppedAgents, turnContinuationCounts } from '../../../../shared-state.js';
import { __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../../../../../memory/assembled-estimate-cache.js';
import { __resetSummaryWriterHealthForTests, noteSummaryWriterOutcome } from '../../../../../memory/summary-writer-health.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t140-unhurried';
const MODEL = 'm-t140-own';
const CHEAPER = 'm-t140-cheaper';
const db = (): Database.Database => mockDb.current!;
const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

function seedAgent(window: number): void {
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p-own', 'Own', 'openai-compatible', 'api_key')`).run();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p-cheap', 'Cheap', 'openai-compatible', 'api_key')`).run();
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
     VALUES (?, ?, ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?)`,
  );
  model.run(MODEL, 'p-own', 'Own', 'own', window, 3, 15);
  model.run(CHEAPER, 'p-cheap', 'Cheaper', 'cheaper', window, 0.1, 0.4);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Busy Desk', ?, 'idle', '{}', datetime('now'))`).run(AGENT, MODEL);
}

/** `rows` rows of `body` each — under the row ceiling's lead, the ceiling is the cause. */
function seedRows(rows: number, body: string): void {
  for (let i = 0; i < rows; i++) {
    insertMessage({
      agentId: AGENT, role: i % 2 === 0 ? 'user' : 'assistant', lane: 'owner', senderId: i % 2 === 0 ? 'owner' : null,
      content: `[row ${i}] ${body}`, turnNumber: 1 + Math.floor(i / 2),
    });
  }
}

function gate(window: number): Promise<unknown> {
  const s: AgentTurnState = advance(initState({
    agentId: AGENT, contextWindow: window, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber: 400, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'is the dock open?', lastUserMessageId: null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  }), { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
  const ctx = {
    agentId: AGENT, turnNumber: 400, contextWindow: window, contextModelId: MODEL,
    configuredModelId: MODEL, isAutoRouted: false, counterparty: OWNER,
    assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: () => { /* not the subject */ },
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  return runPreCallGates(s, ctx);
}

/** Let the background condense run on the fake clock until it is done (bounded). */
async function settleOnTheClock(maxSeconds = 600): Promise<void> {
  for (let t = 0; t < maxSeconds && backgroundDrains.has(AGENT); t++) await vi.advanceTimersByTimeAsync(1_000);
  if (backgroundDrains.has(AGENT)) throw new Error('the background condense never finished');
}

const summaryCount = (): number => (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?').get(AGENT) as { n: number }).n;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  mockDb.current = new Database(':memory:');
  runMigrations();
  backgroundDrains.clear();
  pendingWakeups.clear();
  stoppedAgents.clear();
  turnContinuationCounts.clear();
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  __resetSummaryWriterHealthForTests();
  summariser.slowMs = 0;
  summariser.calls = [];
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 5 — the routine background condense is never cut short by a clock of ours', () => {
  it('a writer that answers after 200 s — longer than the old three-minute clock — gets its summary written', async () => {
    seedAgent(200_000);
    seedRows(610, 'Quick one: is the dock open? Yes, the dock is open.');   // the ceiling cause
    summariser.slowMs = 200_000;
    await gate(200_000);
    expect(backgroundDrains.has(AGENT), 'precondition: a background condense started').toBe(true);
    await settleOnTheClock();
    expect(summaryCount(), 'the working writer finished; nothing refused its summary').toBeGreaterThan(0);
  });

  it('a leaving span of more than ten leaf chunks is folded in one background run — exactly as many as are leaving', async () => {
    seedAgent(1_000_000);
    // ~1,000 tokens a row, 610 rows: far from full on 1M, but at the row ceiling's lead —
    // 320 rows (~320K tokens, eleven 30K chunks) are leaving.
    seedRows(610, 'The north dock tally, row by row, with the damaged lids noted beside each stack. '.repeat(48));
    await gate(1_000_000);
    await settleOnTheClock();
    expect(summariser.calls.length, 'every chunk of the leaving span, not ten').toBeGreaterThan(10);
  });

  // Round 6 (R-V333-15): the retry is earned by a real change — this gate is a person's new turn.
  it('a writer that failed once is tried first again at a person\'s new turn — the change that earns it another try', async () => {
    seedAgent(200_000);
    seedRows(610, 'Quick one: is the dock open? Yes, the dock is open.');
    noteSummaryWriterOutcome(MODEL, false);   // it failed a moment ago
    await gate(200_000);
    await settleOnTheClock();
    expect(summariser.calls[0], 'the agent\'s own writer, first, in the background').toBe(MODEL);
  });
});
