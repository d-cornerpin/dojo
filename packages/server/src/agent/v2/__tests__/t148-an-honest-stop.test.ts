// ════════════════════════════════════════════════════════════════════════════════
// t148 (v3.3.3) — AN HONEST STOP. The RED witnesses, through the engine's real turn entry.
//
// A turn the platform stops because of the owner's money guardrail, or because no model the
// agent may use can hold it, is not an injury: nothing is broken and nothing the Healer can do
// changes it. The owner must read the true cause in plain words, once per condition; the agent
// must not be shown as errored; the Healer must not be called; and the message that hit the stop
// must be answered once the condition actually clears (the limit is raised, the window turns
// over, a model that fits is enabled), without the notice repeating and without the message being
// set aside.
//
// THE DOOR: `runV2Turn` (the engine's real turn entry) on the real migration chain, with the REAL
// budget wall (`callModel`'s own check runs; past it the provider is scripted), the REAL router
// selector (its budget filter), the REAL recovery cascade, the real ask spine and the real
// budget route. Scripted: the tier decision, the assembled array, the provider's answer.
//
// Every clause was RED at `5c61cf7f` on its own assertion (the failure lines are in
// overhaul-plans/t148-report.md) and passes now. The stop rides the platform's existing lock
// (`agent/v2/recovery.ts` -> `agent/v2/honest-stop.ts`: status `paused`, the owner's words in
// `last_error`) and is released by the real event, never a timer.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ── Mocks ──
//
// Hoisted via vi.mock, the implementations below replace the real modules
// for the duration of these tests.

const mockDb = { current: null as Database.Database | null };
/** What the agent's tools weigh in the context window; a test that needs a window starved by them raises it. */
const toolPayload = vi.hoisted(() => ({ tokens: 2_000 }));
const broadcastSpy = vi.fn();
const callModelSpy = vi.fn();
const executeToolSpy = vi.fn();
const injectAttachmentBlocksSpy = vi.fn();
const handleMessageSpy = vi.fn();
const onAgentInjuredSpy = vi.fn();
const isContextOverflowErrorMock = vi.fn<(s: string) => boolean>(() => false);
const recoverDreamerFromContextOverflowSpy = vi.fn(async () => false);
const removeCapabilitySpy = vi.fn();
const recordErrorMock = vi.fn(() => false);
const drainPendingAttachmentsSpy = vi.fn(() => []);
const clearConsumedOneShotFlagsSpy = vi.fn();
const enforceModelCapabilitiesSpy = vi.fn(() => ({ useTools: true }));
const recordCostSpy = vi.fn();
const queueEmbeddingSpy = vi.fn();
const sendResponseViaIMessageSpy = vi.fn();
const sendAlertSpy = vi.fn();
const checkAndCompactSpy = vi.fn(() => Promise.resolve({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }));
const estimateAssembledTokensMock = vi.fn(() => ({
  total: 1000,
  summaryTokens: 0,
  freshTailTokens: 1000,
  briefTokens: 0,
  freshTailCount: 1,
  summaryCount: 0,
}));

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    // migrations.ts imports getDbPath for its best-effort pre-chain backup
    // (VACUUM INTO next to the DB file). Point it at the OS temp dir so the
    // snapshot never lands in the repo; a failure there is caught and logged
    // by migrations.ts without failing the chain.
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t137-test', 'dojo.db'),
  };
});

// t137: the REAL broadcast runs behind the spy. It is the production seam that stamps the
// persisted row and writes the dashboard delivery receipt (`recordDashboardDelivery`), and the
// engine's "waiting on the owner" pause keys on exactly that receipt — a harness without it
// could never show the pause this file exists to forbid. With no socket open it sends nothing.
vi.mock('../../../gateway/ws.js', async () => {
  const actual = await vi.importActual<typeof import('../../../gateway/ws.js')>('../../../gateway/ws.js');
  return {
    ...actual,
    broadcast: (event: unknown) => { broadcastSpy(event); actual.broadcast(event as never); },
  };
});

const realModel = vi.hoisted(() => ({ callModel: null as null | ((...a: unknown[]) => Promise<unknown>) }));
vi.mock('../../model.js', async () => {
  const actual = await vi.importActual<typeof import('../../model.js')>('../../model.js');
  realModel.callModel = actual.callModel as (...a: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    callModel: (...args: unknown[]) => callModelSpy(...args),
  };
});

vi.mock('../../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../tools/index.js')>('../../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../tool-outcome.js')>('../../tool-outcome.js');
  return {
    ...actual,
    // PHASE-4 T1 cluster 3: the door answers `ToolOutcome`. The spy keeps returning bare
    // `ToolResult`s (every `mockResolvedValue` below is unchanged) and the REAL classifier
    // wraps them, so these tests exercise the classification rather than stubbing past it.
    executeTool: async (...args: unknown[]) => classifyToolResult(await executeToolSpy(...args)),
    getFilteredTools: () => [],
  };
});

vi.mock('../../runtime.js', () => ({
  injectAttachmentBlocks: (...args: unknown[]) => injectAttachmentBlocksSpy(...args),
  enforceModelCapabilities: (...args: unknown[]) => enforceModelCapabilitiesSpy(...args),
  getAgentRuntime: () => ({ handleMessage: (...args: unknown[]) => handleMessageSpy(...args), getAgentUptime: () => 0 }),
  // PHASE-3 T3 / S3: the turn clears the one-shot markers the assembly reported consuming.
  // The loop imports this statically, so a mock that omits it makes every turn throw.
  clearConsumedOneShotFlags: (...args: unknown[]) => clearConsumedOneShotFlagsSpy(...args),
}));

vi.mock('../../pending-attachments.js', () => ({
  drainPendingAttachments: () => drainPendingAttachmentsSpy(),
  // End-of-turn safety net (loop.ts ~8452/8790) drains with captions; an
  // empty queue result keeps it a no-op here.
  drainPendingAttachmentsWithCaptions: async () => [],
  queuePendingAttachments: vi.fn(),
  queueScreenChip: vi.fn(),
  queueCanvasDoc: vi.fn(),
}));

// The REAL spend reader: the budget wall sums today's cost records. Only the writer is spied.
vi.mock('../../../costs/tracker.js', async () => {
  const actual = await vi.importActual<typeof import('../../../costs/tracker.js')>('../../../costs/tracker.js');
  return { ...actual, recordCost: (...args: unknown[]) => recordCostSpy(...args) };
});

vi.mock('../../../memory/embeddings.js', () => ({
  queueEmbedding: (...args: unknown[]) => queueEmbeddingSpy(...args),
}));

// The loop's persist path runs stripSystemTags on every text reply and the
// channel-routing path resolves IM recipients; missing exports here throw
// mid-turn and silently kill assistant persistence. Neutral no-IM world:
// no pending sender, no safe senders, tags pass through unchanged.
vi.mock('../../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false,
  clearIMResponseFlag: vi.fn(),
  sendResponseViaIMessage: (...args: unknown[]) => sendResponseViaIMessageSpy(...args),
  getPendingIMSenderRaw: () => null,
  parseSafeSenders: () => [],
  stripSystemTags: (s: string) => s,
  sendIMessageWithAttachment: vi.fn(),
  addressesMatch: (a: string, b: string) => a === b,
  getInboundSenderFor: () => null,
  sendAlert: (...args: unknown[]) => sendAlertSpy(...args),
}));

vi.mock('../../../memory/compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../../../memory/compaction.js')>(
    '../../../memory/compaction.js',
  );
  return {
    ...actual,
    checkAndCompact: (...args: unknown[]) => checkAndCompactSpy(...args),
    estimateAssembledTokens: (...args: unknown[]) =>
      estimateAssembledTokensMock(...args as [string, number]),
  };
});

// Controllable so a test can seed the SHAPE of the assembled tail (T1 needs a
// tool-result carrier tail). Returns a FRESH array per call, like the real
// assembler: assembly rebuilds from persisted rows each iteration, so nothing an
// engine injection pushed survives into the next round.
const assembleContextMock = vi.fn(async () => ({
  systemPrompt: '<system prompt>',
  messages: [{ role: 'user', content: 'hello' }] as Array<Record<string, unknown>>,
}));
vi.mock('../../../memory/assembler.js', () => ({
  assembleContext: (...args: unknown[]) => assembleContextMock(...(args as [])),
}));

// (config/runtime.js mock removed in Phase 9 Stage 2, module deleted)

// Mirror the FULL export surface of config/platform.ts (the engine gained
// isHealerAgent / isTrainerAgent / etc. since this mock was written; a
// missing export throws mid-turn and kills the loop before the model call).
// Test world: primary='primary', dreamer='dreamer', all helper roles absent.
vi.mock('../../../config/platform.js', () => ({
  clearPlatformConfigCache: vi.fn(),
  // ⚠ THIS MOCK IS AN EXHAUSTIVE REPLACEMENT (no `...orig`), so every export the modules under
  // test import has to be here. `getSudoPolicyRaw` arrived with the sudo policy (v3.2.2); without
  // it the import is `undefined`, calling it throws inside the dispatch step, and the turn dies —
  // which is exactly how it presented: 39 failures in this file from one missing line.
  getSudoPolicyRaw: () => null,
  getPlatformName: () => 'Dojo',
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'primary',
  getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
  isPMEnabled: () => false,
  getTrainerAgentId: () => 'trainer',
  getTrainerAgentName: () => 'Trainer',
  isTrainerEnabled: () => false,
  getImaginerAgentId: () => 'imaginer',
  getImaginerAgentName: () => 'Imaginer',
  isImaginerEnabled: () => false,
  isSetupCompleted: () => true,
  setPlatformConfig: vi.fn(),
  getAllPlatformConfig: () => ({}),
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: (id: string) => id === 'pm',
  isTrainerAgent: (id: string) => id === 'trainer',
  isImaginerAgent: (id: string) => id === 'imaginer',
  getHealerAgentId: () => 'healer',
  getHealerAgentName: () => 'Healer',
  isHealerAgent: (id: string) => id === 'healer',
  getDreamerAgentId: () => 'dreamer',
  getDreamerAgentName: () => 'Dreamer',
  isDreamerAgent: (id: string) => id === 'dreamer',
  HOUSEHOLD_AGENT_IDS_KEY: 'household_agent_ids',
  getHouseholdAgentIds: () => [],
  isPermanentAgent: (id: string) => id === 'primary' || id === 'dreamer',
  isSystemServiceAgent: () => false,
  getSystemServiceAgentIds: () => [],
  getDashboardHiddenAgentIds: () => new Set<string>(),
  isDashboardHiddenAgent: () => false,
}));

vi.mock('../../spawner.js', () => ({
  checkTimeouts: vi.fn(),
}));

vi.mock('../../errors.js', () => ({
  // T81b: brought up to date with the real class's fields (`code`, `retryable`, `provider`,
  // `preDialRefusal`) — this mock previously only stored the raw `options` bag and never
  // assigned any of them to the instance, so `error.code`/`error.preDialRefusal` (which
  // `v2/recovery.ts`'s pre-dial-refusal step, and T81a's `onAgentInjured(agentId, message,
  // code)` call before it, both read) were silently `undefined` for every test in this file.
  // Real values now, so a mocked `callModel` rejection can exercise those code paths honestly.
  AgentError: class AgentError extends Error {
    public readonly code: string;
    public readonly retryable: boolean;
    public readonly provider: unknown;
    public readonly preDialRefusal: boolean;
    constructor(
      message: string,
      public agentId: string,
      public options?: { code?: string; retryable?: boolean; provider?: unknown; preDialRefusal?: boolean },
    ) {
      super(message);
      this.code = options?.code ?? 'AGENT_ERROR';
      this.retryable = options?.retryable ?? false;
      this.provider = options?.provider ?? null;
      this.preDialRefusal = options?.preDialRefusal ?? false;
    }
  },
  recordError: (...args: unknown[]) => recordErrorMock(...(args as [string])),
  clearErrors: vi.fn(),
}));

// Mocks for v2/recovery.ts dynamic imports, these only fire when an error
// reaches the recovery cascade, so they're a no-op in normal-path tests.
vi.mock('../../../healer/injury-recovery.js', () => ({
  onAgentInjured: (...args: unknown[]) => onAgentInjuredSpy(...args),
  // Clean-turn-end path (loop.ts ~8636) marks recovery; no-op here.
  onAgentRecovered: vi.fn(),
  rehydrateInjuredAgents: vi.fn(),
}));

vi.mock('../../../vault/maintenance.js', () => ({
  isContextOverflowError: (s: string) => isContextOverflowErrorMock(s),
  recoverDreamerFromContextOverflow: (...args: unknown[]) =>
    recoverDreamerFromContextOverflowSpy(...args),
}));

vi.mock('../../../services/capabilities.js', () => ({
  removeCapability: (...args: unknown[]) => removeCapabilitySpy(...args),
  getModelCapabilities: () => ['tools'],
}));

vi.mock('../../../services/presence.js', () => ({
  getPresence: () => 'present',
  maybeForwardToImessage: vi.fn(),
  isImessageConfigured: () => false,
  isImessageEnabled: () => false,
  setPresence: vi.fn(),
}));

// t148: the REAL router selector (its budget filter is the money guardrail on the routed side);
// only the tier decision is scripted.
vi.mock('../../../router/decide.js', () => ({
  decideTier: async () => ({ tier: 'light', method: 'semantic', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 1, headVersion: null, queryPreview: '' }),
}));
vi.mock('../../../router/probe.js', () => ({ maybeProbe: () => undefined }));
vi.mock('../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tools/tool-docs.js')>('../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => toolPayload.tokens };
});

// No-op the logger: the real module buffers every line into the LIVE
// ~/.dojo/logs/dojo.log. This suite deliberately drives error paths
// (injuries, 4xx/5xx classification), so without this mock every test run
// pollutes the dev box's production log with fake failures. Mirrors the
// real export surface (createLogger/setLogLevel/setLogBroadcast/readLogEntries).
// PHASE-6 T1: the warn channel is a SHARED spy rather than a fresh `vi.fn()` per
// `createLogger()` call, because one clause needs to prove a swallow became loud —
// a bare `catch {}` in teardown was replaced by a logged one, and an unobservable
// logger cannot tell the difference between "logged" and "still swallowed".
const loggerWarnSpy = vi.fn();
const loggerErrorSpy = vi.fn();
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarnSpy(...args),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
  }),
  setLogLevel: vi.fn(),
  setLogBroadcast: vi.fn(),
  readLogEntries: () => [],
}));

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T1 — THE FOUR TEARDOWN READS, OBSERVED AT THE ARGUMENT.
//
// Both mocks below are PASS-THROUGHS: the real function still runs, so nothing in
// this file's other 90 tests changes behaviour. They exist to record WHAT THE TURN'S
// `finally` HANDED THEM, which is the only place the defect is visible — every one
// of the four reads degrades through `?.` / `?? null`, so a wrong value produces no
// error, no log line and no failing query. It produces a silently narrower result.
// ════════════════════════════════════════════════════════════════════════════════
const stampTasksSpy = vi.fn();
vi.mock('../../../tracker/task-stamps.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tracker/task-stamps.js')>(
    '../../../tracker/task-stamps.js',
  );
  return {
    ...actual,
    stampTasksAtTurnFinalize: (input: Parameters<typeof actual.stampTasksAtTurnFinalize>[0]) => {
      stampTasksSpy(input);
      return actual.stampTasksAtTurnFinalize(input);
    },
  };
});

const terminalDeliveryForTurnSpy = vi.fn();
const pauseDriveWorkWaitingOnOwnerSpy = vi.fn();
vi.mock('../answered-edge.js', async () => {
  const actual = await vi.importActual<typeof import('../answered-edge.js')>('../answered-edge.js');
  return {
    ...actual,
    terminalDeliveryForTurn: (...args: Parameters<typeof actual.terminalDeliveryForTurn>) => {
      terminalDeliveryForTurnSpy(...args);
      return actual.terminalDeliveryForTurn(...args);
    },
    pauseDriveWorkWaitingOnOwner: (...args: Parameters<typeof actual.pauseDriveWorkWaitingOnOwner>) => {
      pauseDriveWorkWaitingOnOwnerSpy(...args);
      return actual.pauseDriveWorkWaitingOnOwner(...args);
    },
  };
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 3 — THE STEER, OBSERVED AT THE ARGUMENT.
//
// A PASS-THROUGH, exactly like the two above: the real queue still runs, so nothing
// else in this file changes behaviour. It exists because the mid-turn compaction
// recap (P47) is enqueued and the turn then BREAKS, so the recap never reaches a
// model call this turn and there is no other observation point for its CONTENT.
// The content is the whole guard — "this is still the SAME turn, do not re-apologize"
// is the sentence the seven-apologies incident is about.
// ════════════════════════════════════════════════════════════════════════════════
const enqueueSteerSpy = vi.fn();
vi.mock('../steer-queue.js', async () => {
  const actual = await vi.importActual<typeof import('../steer-queue.js')>('../steer-queue.js');
  return {
    ...actual,
    enqueueSteer: (...args: Parameters<typeof actual.enqueueSteer>) => {
      enqueueSteerSpy(...args);
      return actual.enqueueSteer(...args);
    },
  };
});

// Now import the module under test (after mocks are set up)

import { runV2Turn } from '../loop.js';
import {
  stoppedAgents, recoveryRunStreak, pendingWakeups, turnContinuationCounts,
  doomedPrefillCompactionSpent, declaredPatienceHonestFailTurn,
} from '../../shared-state.js';
import { continuationContext, MAX_DRAIN_STUCK } from '../../turn-state.js';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';


let migratedImage: Buffer | null = null;
function migratedDb(): Database.Database {
  if (migratedImage === null) {
    const seed = new Database(':memory:');
    mockDb.current = seed;
    runMigrations();
    migratedImage = seed.serialize();
    seed.close();
  }
  const db = new Database(migratedImage);
  db.pragma('foreign_keys = ON');
  return db;
}

const AGENT = 'primary';
const ANSWER = 'Yes, the north dock is open today.';

function setupTestDb(): Database.Database {
  const db = migratedDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('test-provider', 'Test', 'anthropic', 'agent-sdk', 1)`).run();
  const model = db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'test-provider', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?)`);
  model.run('test-model', 'Test Model', 'test-1', 200_000, 3, 15);   // priced: the budget wall applies
  model.run('m-tiny', 'Tiny', 'tiny', 8_192, 0, 0);                   // free, and too small for this agent
  const tier = db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)');
  tier.run('light', 'm-tiny');
  tier.run('standard', 'test-model');
  tier.run('heavy', 'test-model');
  db.prepare(
    `INSERT INTO agents (id, name, model_id, status, config, classification)
     VALUES (?, 'Dock Desk', 'test-model', 'idle', '{}', 'sensei')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-desk', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
  insertMessage({
    id: 'msg-user-1', agentId: AGENT, role: 'user', content: 'Is the north dock open today?',
    turnNumber: 1, channel: 'dashboard', senderId: 'owner', conversationId: 'conv-desk',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
  return db;
}

/** The owner's daily limit, and what has been spent against it in the last 24 hours. */
function budget(limitUsd: number, spentUsd: number): void {
  db().prepare(`INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', ?, 'daily')`).run(limitUsd);
  db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd)
                VALUES ('spent-today', ?, 'test-model', 'test-provider', 1000, 1000, ?)`).run(AGENT, spentUsd);
}

const db = (): Database.Database => mockDb.current!;
const noFreeModel = (): void => { db().prepare(`UPDATE models SET is_enabled = 0 WHERE id = 'm-tiny'`).run(); };

beforeEach(async () => {
  mockDb.current = setupTestDb();
  (await import('../../../costs/tracker.js')).invalidateDailySpendCache();
  (await import('../../../memory/window-starvation-card.js')).__resetStarvedWindowsForTests();
  for (const s of [broadcastSpy, callModelSpy, executeToolSpy, handleMessageSpy, onAgentInjuredSpy, recordCostSpy,
    loggerWarnSpy, loggerErrorSpy, assembleContextMock, recordErrorMock, sendAlertSpy]) s.mockClear();
  callModelSpy.mockReset();
  assembleContextMock.mockImplementation(async () => ({
    systemPrompt: '<system prompt>',
    messages: [{ role: 'user', content: 'Is the north dock open today?' }] as Array<Record<string, unknown>>,
  }));
  enforceModelCapabilitiesSpy.mockImplementation(() => ({ useTools: true }));
  isContextOverflowErrorMock.mockImplementation(() => false);
  recordErrorMock.mockImplementation(() => false);
  toolPayload.tokens = 2_000;
  stoppedAgents.clear(); recoveryRunStreak.clear(); doomedPrefillCompactionSpent.clear();
  declaredPatienceHonestFailTurn.clear(); pendingWakeups.clear(); turnContinuationCounts.clear(); continuationContext.clear();
  // The scripted provider. The REAL wall in `callModel` decides first: while the limit stands it
  // throws exactly what it throws on a user's box; past it, the provider answers.
  callModelSpy.mockImplementation(async (p: { agentId: string; modelId: string }) => {
    (await import('../../../costs/tracker.js')).invalidateDailySpendCache();
    const { checkBudget } = await import('../../../costs/budget.js');
    const priced = p.modelId === 'test-model';
    if (priced && !checkBudget(p.agentId, 0.01).allowed) return realModel.callModel!(p);
    return { content: ANSWER, toolCalls: [], inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' };
  });
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

/** Everything the owner was shown about this agent: chat rows broadcast and notices. */
function ownerSaw(): string[] {
  return broadcastSpy.mock.calls.map((c) => c[0] as { type?: string; agentId?: string; error?: string; message?: { content?: string } })
    .filter((e) => e.agentId === AGENT && (e.type === 'chat:error' || e.type === 'chat:message'))
    .map((e) => (e.type === 'chat:error' ? e.error ?? '' : e.message?.content ?? ''));
}
const notices = (): string[] => broadcastSpy.mock.calls.map((c) => c[0] as { type?: string; agentId?: string; error?: string })
  .filter((e) => e.type === 'chat:error' && e.agentId === AGENT).map((e) => e.error ?? '');
const status = (): string => (db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status;
const ask = (): string => (db().prepare(`SELECT state FROM work WHERE kind = 'ask' AND root_id = 'msg-user-1'`).get() as { state: string }).state;

/** The honest stop, in the owner's terms. */
function expectAnHonestStop(cause: RegExp): void {
  const saw = ownerSaw();
  expect(saw.some((t) => cause.test(t)), `the owner reads the true cause; saw: ${JSON.stringify(saw)}`).toBe(true);
  expect(saw.filter((t) => /Healer/.test(t)), 'no Healer text').toEqual([]);
  expect(status(), 'the agent is not shown as errored').not.toBe('error');
  expect(onAgentInjuredSpy, 'the Healer is not called').not.toHaveBeenCalled();
  expect(recordErrorMock, 'not counted as an error').not.toHaveBeenCalled();
}

describe('t148 — a turn stopped by the money guardrail, or by no model that can hold the agent, is an honest stop', () => {
  it('a PINNED model with today\'s spending limit reached and no free model: the owner reads the true cause, the agent is not errored, no Healer', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    await runV2Turn(AGENT);
    expectAnHonestStop(/spending limit/i);
  });

  it('a PINNED model past the limit whose only free stand-in is too small for the agent: the same honest stop', async () => {
    budget(1.00, 2.00);   // the wall redirects to the free model; the re-fit for it refuses
  toolPayload.tokens = 7_000;   // the tools alone fill the free model's 8K window, the priced one's 200K holds them
    await runV2Turn(AGENT);
    expectAnHonestStop(/spending limit/i);
  });

  it('an AUTO-ROUTED agent whose every routed model is past the limit: the same honest stop (the router finds no model at all)', async () => {
    db().prepare(`UPDATE agents SET model_id = 'auto' WHERE id = ?`).run(AGENT);
    budget(1.00, 2.00);
    await runV2Turn(AGENT);
    expectAnHonestStop(/spending limit/i);
  });

  it('a PINNED model genuinely too small for the agent: the true card, and no Healer, not errored', async () => {
    db().prepare(`UPDATE agents SET model_id = 'm-tiny' WHERE id = ?`).run(AGENT);
    const { contextWindowPolicy, SystemPromptTooLargeError } = await import('../../../memory/budget.js');
    const { reportStarvedWindow } = await import('../../../memory/window-starvation-card.js');
    // The assembler's own refusal, as it does it (memory/assembler.ts): card once, then throw.
    assembleContextMock.mockImplementation(async () => {
      const policy = contextWindowPolicy(8_192, { toolPayloadTokens: 2_000, maxOutputTokens: 4_096 });
      reportStarvedWindow(AGENT, 9_000, policy);
      throw new SystemPromptTooLargeError(9_000, policy);
    });
    await runV2Turn(AGENT);
    expectAnHonestStop(/cannot hold a conversation/i);
  });

  it('the stop is told ONCE: the runtime drain does not serve the stopped message back into the same stop', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    await runV2Turn(AGENT);
    // What the runtime's human drain does next (runtime.ts, "Human conversation drain"): while the
    // agent is not in a stop state and a person's ask is waiting, serve it again — up to
    // MAX_DRAIN_STUCK passes, after which the ask is set aside as poisoned.
    const { getWaitingHumanConversations } = await import('../counterparty.js');
    const drainWouldServe = (): boolean => !['error', 'paused', 'terminated'].includes(status())
      && getWaitingHumanConversations(AGENT).length > 0;
    let reServed = 0;
    for (let pass = 1; pass < MAX_DRAIN_STUCK && drainWouldServe(); pass++) { reServed++; await runV2Turn(AGENT); }
    expect(notices(), 'one notice, naming the true cause').toEqual([expect.stringMatching(/spending limit/i)]);
    expect(reServed, 'nothing re-served into a stop that still stands').toBe(0);
    expect(['done', 'abandoned']).not.toContain(ask());
  });

  it('the message is answered once the owner raises the limit — driven by that change, not a timer — with no second notice', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    await runV2Turn(AGENT);
    handleMessageSpy.mockClear();
    const { costsRouter } = await import('../../../gateway/routes/costs.js');
    const res = await costsRouter.request('/budget/global', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limitUsd: 10 }),
    });
    expect(res.status).toBe(200);
    expect(handleMessageSpy.mock.calls.map((c) => c[0]), 'raising the limit wakes the stopped agent').toContain(AGENT);
    await runV2Turn(AGENT);   // the woken turn
    const answered = db().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant'`).all(AGENT) as Array<{ content: string }>;
    expect(answered.map((r) => r.content)).toContain(ANSWER);
    expect(ask()).toBe('done');
    expect(notices().length, 'the stop was told once, and not again on the way out').toBe(1);
  });

  // ── t140's own no-pick exit, the budget stop and the rollover: the same lock, the same release ──

  it('t140\'s no-pick exit (light tier on a free 8K model too small for the agent, the roomy model over the limit) tells the owner ONCE, hands nothing back, and the message is answered after the limit is raised', async () => {
    db().prepare(`UPDATE agents SET model_id = 'auto' WHERE id = ?`).run(AGENT);
    toolPayload.tokens = 7_000;   // the free 8K model cannot hold the agent's tools; the 200K one can
    budget(1.00, 0.999);   // under the line, so the free model is still offered; the priced one's call would cross it
    await runV2Turn(AGENT);
    expectAnHonestStop(/spending limit/i);
    expect(callModelSpy, 'the stop came from the router\'s no-pick exit: no model was dialed').not.toHaveBeenCalled();
    expect(status()).toBe('paused');
    expect(ask(), 'the message is still the owner\'s open ask, not handed back through a settlement rung').toBe('open');
    // The drain stands down for the lock, so nothing re-serves it and nothing is said again.
    const { getWaitingHumanConversations } = await import('../counterparty.js');
    expect(['error', 'paused', 'terminated']).toContain(status());
    expect(getWaitingHumanConversations(AGENT).length).toBeGreaterThan(0);
    expect(notices().length, 'told once').toBe(1);
    const turnExit = db().prepare(`SELECT exit_reason FROM turns WHERE agent_id = ? ORDER BY turn_number DESC LIMIT 1`).get(AGENT) as { exit_reason: string | null };
    expect(turnExit.exit_reason, 'the turn does not claim the model chose silence').not.toBe('no_reply_intended');

    handleMessageSpy.mockClear();
    const { costsRouter } = await import('../../../gateway/routes/costs.js');
    await costsRouter.request('/budget/global', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limitUsd: 10 }) });
    expect(handleMessageSpy.mock.calls.map((c) => c[0])).toContain(AGENT);
    await runV2Turn(AGENT);
    const answered = db().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant'`).all(AGENT) as Array<{ content: string }>;
    expect(answered.map((r) => r.content)).toContain(ANSWER);
    expect(ask()).toBe('done');
    expect(notices().length, 'not told again on the way out').toBe(1);
  });

  it('the window turning over releases the stop and wakes the agent (the scheduler tick), and a limit that STILL stops it releases nothing', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    await runV2Turn(AGENT);
    expect(status()).toBe('paused');
    const { kickMemoryRecheck, backgroundChecksSettled } = await import('../../../scheduler/background-checks.js');
    const tracker = await import('../../../costs/tracker.js');
    handleMessageSpy.mockClear();
    kickMemoryRecheck(); await backgroundChecksSettled();
    expect(handleMessageSpy, 'the window has not turned over: still parked').not.toHaveBeenCalled();
    expect(status()).toBe('paused');
    db().prepare(`UPDATE cost_records SET created_at = datetime('now', '-2 days')`).run();
    tracker.invalidateDailySpendCache();
    kickMemoryRecheck(); await backgroundChecksSettled();
    expect(handleMessageSpy.mock.calls.map((c) => c[0])).toContain(AGENT);
    expect(status()).toBe('idle');
    await runV2Turn(AGENT);
    const answered = db().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant'`).all(AGENT) as Array<{ content: string }>;
    expect(answered.map((r) => r.content)).toContain(ANSWER);
    expect(ask()).toBe('done');
  });

  it('a second stop in the same window sends no second text and no second notice (the crossing alert is the one text)', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    await runV2Turn(AGENT);
    expect(sendAlertSpy.mock.calls.length, 'the budget\'s own crossing alert, once').toBe(1);
    // The lock lifted by something that is not the event (a long-errored sweep), then the same stop again.
    const { writeAgentStatus } = await import('../../agent-status.js');
    writeAgentStatus(AGENT, 'idle');   // the sweep keeps the diagnostic, as the lock's own record
    await runV2Turn(AGENT);
    expect(sendAlertSpy.mock.calls.length, 'no second text').toBe(1);
    expect(notices().length, 'no second notice').toBe(1);
    expect(status()).toBe('paused');
  });

  it('no_model_fits: changing the agent\'s model releases the lock and wakes it; the Healer is never called', async () => {
    db().prepare(`UPDATE agents SET model_id = 'm-tiny' WHERE id = ?`).run(AGENT);
    const { contextWindowPolicy, SystemPromptTooLargeError } = await import('../../../memory/budget.js');
    assembleContextMock.mockImplementation(async () => {
      throw new SystemPromptTooLargeError(9_000, contextWindowPolicy(8_192, { toolPayloadTokens: 2_000, maxOutputTokens: 4_096 }));
    });
    await runV2Turn(AGENT);
    expect(status()).toBe('paused');
    handleMessageSpy.mockClear();
    const { agentsRouter } = await import('../../../gateway/routes/agents.js');
    const res = await agentsRouter.request(`/${AGENT}/model`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'test-model' }),
    });
    expect(res.status).toBe(200);
    expect(handleMessageSpy.mock.calls.map((c) => c[0])).toContain(AGENT);
    expect(status()).toBe('idle');
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
  });
});
