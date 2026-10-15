// ════════════════════════════════════════════════════════════════════════════════════════
// t167 — A BUDGET STOP THAT PARKS AN AGENT IS TOLD TO THE OWNER, ONCE PER BUDGET WINDOW.
//
// The witness (a user's box, the S5 walk): the limit was reached and no free model answered, so
// the engine parked the agent (`budget_stop`). By design it sent NO text for that, "always
// preceded by the budget's own crossing alert" — but that alert had said "90%", so the owner was
// never told the agent stopped or why; the chat line the park writes is the agent's own.
//
// The rule now: the park tells the owner ONCE through the existing owner-notice door
// (`tellOwnerOnce`, persisted in `healer_state`) with its card, keyed per BUDGET WINDOW and not
// per agent: ten agents stopping in one window send one text. The next window tells again. The
// no-fit stop is unchanged.
//
// THE DOOR: `runV2Turn` (the engine's real turn entry), the REAL budget wall and router selector,
// the REAL recovery cascade and the REAL owner-notice door; the harness is the t148 file's.
// ════════════════════════════════════════════════════════════════════════════════════════

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
  getSafeSenders: () => [],
  findSafeSenderByAddress: () => ({ is_primary: 1 }),
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


/** A second agent with its own waiting message, pinned to the same priced model. */
function addAgent(id: string, name: string): void {
  const d = db();
  d.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, ?, 'test-model', 'idle', '{}', 'sensei')`).run(id, name);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`).run(`conv-${id}`, id);
  insertMessage({
    id: `msg-${id}`, agentId: id, role: 'user', content: 'Is the south dock open today?',
    turnNumber: 1, channel: 'dashboard', senderId: 'owner', conversationId: `conv-${id}`,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
}
const statusOf = (id: string): string => (db().prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const texts = (): string[] => sendAlertSpy.mock.calls.map((c) => c[0] as string);

const NO_FIT_WORDS = 'Dock Desk can\'t run: none of its models can hold its instructions and tools. '
  + 'Pick a bigger model for it on its detail page, or give it fewer tools, and it will answer your message.';

/** The warning shape: the day climbed to 99.5% (the crossing alert was only a warning), then the wall stopped the agent. */
const gradual = (): void => budget(1.00, 0.995);

describe('t167 (iii): a budget stop that parks an agent is told once per budget window', () => {
  it('a warning only, then the limit stops an agent with no free model: ONE stop text and ONE card, plain words, no agent named', async () => {
    noFreeModel();
    gradual();
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    expect(status()).toBe('paused');
    // The budget's own crossing alert is the first text (a warning: 99%); the stop is the second.
    expect(texts(), 'the warning and the stop, nothing else').toHaveLength(2);
    expect(texts()[0]).toMatch(/99% of your daily budget/);
    const stop = texts()[1];
    expect(sendAlertSpy.mock.calls[1][1], 'a notice, like every owner notice').toBe('notice');
    expect(stop).toMatch(/limit.*reached/i);
    expect(stop).toMatch(/no free model/i);
    expect(stop).toMatch(/waiting/i);
    expect(stop, 'how to release them').toMatch(/raise the limit.*Ledger/i);
    expect(stop, 'the window turning over also releases them').toMatch(/turns over/i);
    expect(stop, 'messages are kept').toMatch(/messages? (?:is|are) kept/i);
    expect(stop, 'no agent is named').not.toContain('Dock Desk');
    expect(healerOwnerCards().map((c) => c.words), 'the card carries the very words that were texted').toEqual([stop]);
    expect(healerOwnerCards()[0].severity).toBe('notice');
  });

  it('a SECOND agent stopping in the same window sends nothing and adds no second card', async () => {
    noFreeModel();
    gradual();
    addAgent('second', 'South Desk');
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    const before = texts().length;
    expect(before).toBe(2);
    await runV2Turn('second');
    expect(statusOf('second'), 'the second agent is parked too').toBe('paused');
    expect(texts().length, 'no second text for the same window').toBe(before);
    expect(healerOwnerCards(), 'one card').toHaveLength(1);
  });

  it('the NEXT window tells again: once the told window has turned over, a new stop texts and the card is the new one', async () => {
    noFreeModel();
    gradual();
    addAgent('second', 'South Desk');
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    const first = texts().length;
    // A day and a bit later (the told-at ages with everything else); the limit still stands and a new agent stops.
    db().prepare(`UPDATE healer_state SET at_ms = at_ms - 2 * 86400000 WHERE scope = 'owner_told'`).run();
    await runV2Turn('second');
    expect(texts().length, 'told again for the new window').toBe(first + 1);
    expect(texts()[first]).toMatch(/limit.*reached/i);
    expect(healerOwnerCards(), 'one card, not two').toHaveLength(1);
  });

  it('the card ends with the last release; changing the limit is a new window, so a later stop tells again', async () => {
    noFreeModel();
    gradual();
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    expect(healerOwnerCards()).toHaveLength(1);
    const { costsRouter } = await import('../../../gateway/routes/costs.js');
    await costsRouter.request('/budget/global', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limitUsd: 10 }) });
    expect(status()).toBe('idle');
    expect(healerOwnerCards(), 'the card ends when the stop is lifted').toEqual([]);
    const before = texts().length;
    await costsRouter.request('/budget/global', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limitUsd: 1 }) });
    await runV2Turn(AGENT);
    expect(status()).toBe('paused');
    expect(texts().slice(before).filter((t) => /waiting/i.test(t)), 'told again').toHaveLength(1);
    expect(healerOwnerCards()).toHaveLength(1);
  });

  it('an agent\'s OWN budget reached is its own window: the stop is told (without naming it), as one text and one card', async () => {
    noFreeModel();
    db().prepare(`INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', 1000, 'daily')`).run();
    db().prepare(`INSERT INTO budgets (id, scope, limit_usd, period) VALUES ('agent_primary', 'agent', 1, 'daily')`).run();
    db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd)
                  VALUES ('spent-agent', ?, 'test-model', 'test-provider', 1, 1, 0.995)`).run(AGENT);
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    expect(status()).toBe('paused');
    const stops = texts().filter((t) => /waiting/i.test(t));
    expect(stops, 'the stop is told').toHaveLength(1);
    expect(stops[0]).not.toContain('Dock Desk');
    expect(healerOwnerCards().map((c) => c.words)).toEqual(stops);
  });
});

describe('t167 amendment: "the limit is reached" is ONE fact, told once per window, whichever door gets there first', () => {
  it('the measured shape (spend already over the limit -> the crossing alert says "reached" -> the stop): exactly ONE text in the window', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    addAgent('second', 'South Desk');
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    expect(status()).toBe('paused');
    await runV2Turn('second');
    expect(statusOf('second')).toBe('paused');
    expect(texts(), 'one text for the whole window, however many agents stop').toHaveLength(1);
    expect(texts()[0]).toMatch(/limit reached.*\$2\.00 of your \$1\.00 daily budget.*\$1\.00 over/i);
    expect(healerOwnerCards(), 'the crossing alert\'s own card is the card; the stop adds none').toEqual([]);
  });

  it('...and when that window has turned over, a new stop is told again', async () => {
    noFreeModel();
    budget(1.00, 2.00);
    addAgent('second', 'South Desk');
    await runV2Turn(AGENT);
    expect(texts()).toHaveLength(1);
    db().prepare(`UPDATE healer_state SET at_ms = at_ms - 2 * 86400000 WHERE scope = 'owner_told'`).run();
    await runV2Turn('second');
    expect(texts().length, 'the shared record aged out with its window').toBe(2);
    expect(texts()[1]).toMatch(/waiting/i);
  });
});

describe('t167 (iv): the no-fit stop is byte-unchanged', () => {
  it('one text, one card, the very same words, the same lock record and chat line, and the budget door adds nothing to it', async () => {
    db().prepare(`UPDATE agents SET model_id = 'm-tiny' WHERE id = ?`).run(AGENT);
    const { contextWindowPolicy, SystemPromptTooLargeError } = await import('../../../memory/budget.js');
    assembleContextMock.mockImplementation(async () => {
      throw new SystemPromptTooLargeError(9_000, contextWindowPolicy(8_192, { toolPayloadTokens: 2_000, maxOutputTokens: 4_096 }));
    });
    const { healerOwnerCards } = await import('../../../healer/owner-notices.js');
    await runV2Turn(AGENT);
    expect(sendAlertSpy.mock.calls).toEqual([[NO_FIT_WORDS, 'notice']]);
    expect(healerOwnerCards().map((c) => ({ words: c.words, severity: c.severity }))).toEqual([{ words: NO_FIT_WORDS, severity: 'notice' }]);
    const lastError = (db().prepare('SELECT last_error FROM agents WHERE id = ?').get(AGENT) as { last_error: string }).last_error;
    expect(lastError).toBe('[no_model_fits] None of this agent\'s models can hold its instructions and tools, so its turn was not run. '
      + 'Your message is kept. Pick a bigger model for this agent (or give it fewer tools) and it will answer.');
    expect(notices()).toEqual(['None of this agent\'s models can hold its instructions and tools, so its turn was not run. '
      + 'Your message is kept. Pick a bigger model for this agent (or give it fewer tools) and it will answer.']);
    const owned = db().prepare(`SELECT key FROM healer_state WHERE scope = 'owner_told'`).all();
    expect(owned).toEqual([{ key: `nofit:${AGENT}` }]);
  });
});
