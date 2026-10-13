// ════════════════════════════════════════════════════════════════════════════════
// t137 (v3.3.3) — LONG JOBS ARE LEFT ALONE TO FINISH. Tracker #9, #10 and the t125 regression.
//
// The owner's ruling (OR-LONG-JOBS): agents work long jobs for as long as they need; the
// Dojo must not "panic every 15 minutes because an agent isn't responding". This file
// drives the ENGINE'S REAL TURN ENTRY (`runV2Turn`) across real 15-minute checkpoints, on
// the real migration chain, with a scripted provider, and reads the RECORDS the platform
// keeps — message rows, chat broadcasts, the turn record, the work row, the task log —
// never the model's prose.
//
// The three witnesses, each RED at v3.3.2 (`00a2b34d`) before the fix:
//   (a) t125: a continuation turn that ends empty after tools was counted as "owing a
//       person" (`ctx.triggerRow !== null`, while the preflight hands `undefined` when
//       nobody waits), so it got a silent retry, an empty-reply steer, and a floor-ghost
//       "your agent returned an empty reply" row in the owner's chat.
//   (b) a parked continuation on a read-only claimed task was moved to "paused, waiting
//       on the owner" by the engine while the engine itself had just queued its
//       continuation — the pause the project manager then rejected as vague.
//   (c) every park wrote an owner-visible "[System: This turn ran for N minutes. Pausing
//       here … (k of 3)]" row and broadcast it to the chat.
//
// The harness block below is the one `integration.test.ts` uses (vi.mock is per file):
// real DB image from the real migration chain, a scripted `callModel`, a scripted tool
// executor, and pass-through spies on the two answered-edge writers.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

// ── Mocks ──
//
// Hoisted via vi.mock, the implementations below replace the real modules
// for the duration of these tests.

const mockDb = { current: null as Database.Database | null };
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

vi.mock('../../model.js', async () => {
  const actual = await vi.importActual<typeof import('../../model.js')>('../../model.js');
  return {
    ...actual,
    callModel: (...args: unknown[]) => callModelSpy(...args),
    getContextWindow: () => 200000,
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
  getAgentRuntime: () => ({ handleMessage: (...args: unknown[]) => handleMessageSpy(...args) }),
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

vi.mock('../../../costs/tracker.js', () => ({
  recordCost: (...args: unknown[]) => recordCostSpy(...args),
}));

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
  sendAlert: vi.fn(),
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

// Router mocks for auto-router fallback tests. Default to a simple stub
// that picks 'fallback-model'; individual tests override via mockImplementation.
// scoreQuery's return mirrors the CURRENT ScoringResult shape (router/scorer.ts:
// scores/rawScore/tier/confidence/latencyMs); router/decide.js decideTier reads
// h.confidence off it and the loop calls decision.confidence.toFixed(3).
const scoreQueryMock = vi.fn(() => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }));
const selectModelMock = vi.fn();
vi.mock('../../../router/scorer.js', () => ({
  scoreQuery: (...args: unknown[]) => scoreQueryMock(...args),
}));
vi.mock('../../../router/selector.js', () => ({
  selectModel: (...args: unknown[]) => selectModelMock(...args),
  logRouterDecision: vi.fn(),
  getSystemModel: () => null,
}));

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
import { continuationContext } from '../../turn-state.js';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { unvalidatedPauseExpr } from '../../../work/tracker-view.js';
import { writeTaskLog } from '../../../tracker/task-log.js';
import { pendingCirclingVerdict } from '../../../tracker/effort-governor.js';
import { engineSources, SERVER_SRC } from './engine-sources.js';
import fs from 'node:fs';
import path from 'node:path';

/** Comments blanked (line structure kept), so a clause over source reads CODE, never prose. */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

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

/** The owner's world: one provider, one model, one agent, the owner's dashboard
 *  conversation and the owner's ask — through the real message writer, which opens the ask. */
function setupTestDb(): Database.Database {
  const db = migratedDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('test-provider', 'Test', 'anthropic', 'api_key')`).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('test-model', 'test-provider', 'Test Model', 'test-1', '["tools","vision"]', 200000, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO agents (id, name, model_id, status, config, classification)
     VALUES ('primary', 'Primary', 'test-model', 'idle', '{}', 'sensei')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-primary', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run();
  insertMessage({
    id: 'msg-user-1', agentId: 'primary', role: 'user',
    content: 'Read every file in the research folder and write me a summary of what they say.',
    turnNumber: 1, channel: 'dashboard', senderId: 'owner', conversationId: 'conv-primary',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
  return db;
}

beforeEach(() => {
  mockDb.current = setupTestDb();
  for (const s of [broadcastSpy, callModelSpy, executeToolSpy, injectAttachmentBlocksSpy, handleMessageSpy,
    onAgentInjuredSpy, recordCostSpy, queueEmbeddingSpy, sendResponseViaIMessageSpy, checkAndCompactSpy,
    enqueueSteerSpy, stampTasksSpy, terminalDeliveryForTurnSpy, pauseDriveWorkWaitingOnOwnerSpy,
    loggerWarnSpy, loggerErrorSpy, removeCapabilitySpy, drainPendingAttachmentsSpy, clearConsumedOneShotFlagsSpy]) {
    s.mockClear();
  }
  callModelSpy.mockReset();
  executeToolSpy.mockReset();
  enforceModelCapabilitiesSpy.mockImplementation(() => ({ useTools: true }));
  isContextOverflowErrorMock.mockImplementation(() => false);
  recordErrorMock.mockImplementation(() => false);
  stoppedAgents.clear();
  recoveryRunStreak.clear();
  doomedPrefillCompactionSpent.clear();
  declaredPatienceHonestFailTurn.clear();
  pendingWakeups.clear();
  turnContinuationCounts.clear();
  continuationContext.clear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── The long job, through the real turn entry ──────────────────────────────────────

const TURN_BUDGET_MS = 15 * 60 * 1000;

/** The engine's clock, moved forward without fake timers (the loop's own timers must keep
 *  running). `turnStartMs` is read through `Date.now`, so an offset applied mid-turn reads
 *  as "this turn has been running that long" and an offset carried into the next turn is
 *  simply later wall-clock. */
function controllableClock(): { jump: (ms: number) => void; restore: () => void } {
  const real = Date.now.bind(Date);
  let offset = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  return { jump: (ms: number) => { offset += ms; }, restore: () => spy.mockRestore() };
}

let toolSeq = 0;

/** One READ-ONLY round (a `file_read`, never an effectful call) that crosses the 15-minute
 *  checkpoint, then whatever the model says next. `narrate` is the working line a model
 *  sends beside its tool call ("still reading…"); `thenSays` is its next reply. The clock
 *  jump lives inside the tool call — the checkpoint is read once per loop head, so the
 *  budget can only be crossed between rounds — and is undone when the turn ends, because
 *  the turn's start is read through `new Date()` and an offset left running would make
 *  the NEXT turn look fifteen minutes old before it had called the model once. */
async function readOnlyTurnAcrossTheCheckpoint(
  opts: { narrate?: string; thenSays?: string; extraMs?: number } = {},
): Promise<void> {
  let call = 0;
  callModelSpy.mockImplementation(async () => {
    call++;
    if (call === 1) {
      toolSeq++;
      return {
        content: opts.narrate ?? '',
        toolCalls: [{ id: `tc-read-${toolSeq}`, name: 'file_read', arguments: { path: `/research/part-${toolSeq}.txt` } }],
        inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      };
    }
    return { content: opts.thenSays ?? '', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
  });
  const clock = controllableClock();
  executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => {
    clock.jump(TURN_BUDGET_MS + 60_000 + (opts.extraMs ?? 0));
    return { toolCallId: toolCall.id, name: toolCall.name, content: 'file body', isError: false };
  });
  try {
    await runV2Turn('primary');
  } finally {
    clock.restore();
  }
}

/** The task the agent claimed for this job, in the drive state, touched just now. */
function seedInFlightTask(id = 'w-long-job'): void {
  const now = Date.now();
  mockDb.current!.prepare(
    `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'primary', 'task', 'owner', 'tracker', ?, 'claimed', 'action', 1, 0,
             'summarise the research folder', ?, ?)`,
  ).run(id, id, now, now);
}

const workState = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

const turnRows = (): Array<{ turn_number: number; exit_reason: string | null; answered: number; effectful_calls: number }> =>
  mockDb.current!.prepare(
    `SELECT turn_number, exit_reason, answered, effectful_calls FROM turns WHERE agent_id = 'primary' ORDER BY turn_number`,
  ).all() as Array<{ turn_number: number; exit_reason: string | null; answered: number; effectful_calls: number }>;

const messageRows = (): Array<{ role: string; content: string; turn_number: number | null }> =>
  mockDb.current!.prepare(
    `SELECT role, content, turn_number FROM messages WHERE agent_id = 'primary' ORDER BY rowid`,
  ).all() as Array<{ role: string; content: string; turn_number: number | null }>;

const chatBroadcasts = (): Array<{ role?: string; content?: string }> =>
  broadcastSpy.mock.calls
    .map((c) => c[0] as { type?: string; message?: { role?: string; content?: string } })
    .filter((e) => e.type === 'chat:message')
    .map((e) => e.message ?? {});

const systemRowsOfTurn = (turn: number): string[] =>
  messageRows().filter((m) => m.role === 'system' && m.turn_number === turn).map((m) => m.content);

const pmPauseQueue = (): number =>
  (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM work w WHERE ${unvalidatedPauseExpr('w')}`).get() as { n: number }).n;

const taskLogFor = (id: string): Array<{ entry_kind: string; to_status: string | null; from_entity: string }> =>
  mockDb.current!.prepare(
    `SELECT kind AS entry_kind, json_extract(payload, '$.to') AS to_status, actor AS from_entity
       FROM work_events WHERE work_id = ? ORDER BY id`,
  ).all(id) as Array<{ entry_kind: string; to_status: string | null; from_entity: string }>;

const emptyReplySteers = (): number =>
  enqueueSteerSpy.mock.calls.filter((c) => (c[1] as { floor?: string }).floor === 'empty-response').length;

/** A turn that does one read-only tool call and then returns NOTHING — no text, no tools. */
async function readsThenSaysNothing(): Promise<number> {
  let call = 0;
  callModelSpy.mockImplementation(async () => {
    call++;
    if (call === 1) {
      return {
        content: '', toolCalls: [{ id: `tc-quiet-${++toolSeq}`, name: 'file_read', arguments: { path: '/research/index.txt' } }],
        inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      };
    }
    return { content: '', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
  });
  executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => (
    { toolCallId: tc.id, name: tc.name, content: 'file body', isError: false }));
  await runV2Turn('primary');
  return call;
}

// ════════════════════════════════════════════════════════════════════════════════
// (c) THE PARK IS HOUSEKEEPING. It still checkpoints, still asks the token math about a
// compaction, still squares the tracker and still queues the continuation — the owner
// simply no longer gets a line in the chat every fifteen minutes about it.
// ════════════════════════════════════════════════════════════════════════════════
describe('t137 (c): a 15-minute park writes nothing to the owner\'s chat', () => {
  it('the park happens (exit `budget`, continuation queued), and it leaves ZERO system rows and ZERO chat broadcasts', async () => {
    seedInFlightTask();
    await readOnlyTurnAcrossTheCheckpoint();

    // Positive control: the turn genuinely parked. A fix that stopped parking is not a fix.
    expect(turnRows()).toEqual([expect.objectContaining({ turn_number: 1, exit_reason: 'budget' })]);
    expect(pendingWakeups.has('primary')).toBe(true);
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);

    // The record, counted: the turn's rows are the job's own rows and nothing else.
    expect(systemRowsOfTurn(1)).toEqual([]);
    expect(messageRows().filter((m) => m.turn_number === 1).map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(chatBroadcasts().filter((m) => m.role === 'system')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// (b) THE ENGINE NEVER PAUSES WORK ITS OWN TURN IS STILL DOING. A turn that parked queued
// its own continuation: the ball is with the agent, not the owner. The project manager's
// "vague pause" reject (#9) had nothing to judge but this engine-made pause.
// ════════════════════════════════════════════════════════════════════════════════
describe('t137 (b): a parked turn never moves its task to "paused, waiting on the owner"', () => {
  it('two parks of a read-only job that spoke to the owner: the task stays claimed, the PM has nothing to reject', async () => {
    seedInFlightTask();
    // The owner's ask turn: a working line beside the first read, then the 15-minute park.
    await readOnlyTurnAcrossTheCheckpoint({ narrate: 'Starting on the research folder now.' });
    expect(workState('w-long-job')).toBe('claimed');
    pendingWakeups.clear();

    // The continuation: same shape again.
    await readOnlyTurnAcrossTheCheckpoint({ narrate: 'Still reading the second half of the folder.' });
    expect(workState('w-long-job')).toBe('claimed');

    // Positive controls: both turns parked, both SPOKE to the owner (answered + delivered),
    // and neither performed an effectful call — every condition of the old pause held.
    const turns = turnRows();
    expect(turns.filter((t) => t.exit_reason === 'budget')).toHaveLength(2);
    expect(turns.every((t) => t.answered === 1 && t.effectful_calls === 0)).toBe(true);
    expect(pauseDriveWorkWaitingOnOwnerSpy).toHaveBeenCalledTimes(2);

    // Nothing for the PM to judge, nothing rejected, nothing reverted, no stalemate.
    expect(pmPauseQueue()).toBe(0);
    const log = taskLogFor('w-long-job');
    expect(log.filter((e) => e.to_status === 'paused')).toEqual([]);
    expect(mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM adjudications WHERE work_id = 'w-long-job'`,
    ).get()).toEqual({ n: 0 });
  });

  it('the OTHER engine continuation (the 75-call tool-loop checkpoint) is not a hand-back either', async () => {
    // Exit is NOT `budget` here: the turn spoke, read 75 files, and the engine scheduled its
    // continuation at the tool-loop cap. The queued-continuation arm is what keeps this claimed.
    seedInFlightTask();
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now() + 5_000, 'w-long-job');
    let call = 0;
    callModelSpy.mockImplementation(async () => {
      call++;
      return {
        content: call === 1 ? 'Starting on the research folder now.' : '',
        toolCalls: [{ id: `tc-loop-${call}`, name: 'file_read', arguments: { path: `/research/file-${call}.txt` } }],
        inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      };
    });
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => (
      { toolCallId: tc.id, name: tc.name, content: `body of ${tc.id}`, isError: false }));
    await runV2Turn('primary');

    const [t] = turnRows();
    expect(t.answered).toBe(1);
    expect(t.effectful_calls).toBe(0);
    expect(t.exit_reason).not.toBe('budget');
    expect(continuationContext.has('primary')).toBe(true);   // the engine queued its continuation
    expect(workState('w-long-job')).toBe('claimed');
  });

  it('CONTROL: a turn that genuinely handed the ball back (answered, did nothing, no park) still pauses, and the owner\'s next word reopens it', async () => {
    // The PHASE-2 T1 adjudication #2 rule is NARROWED, not removed. Same task, same reply,
    // no checkpoint: the agent spoke and stopped, so the work waits on the owner.
    seedInFlightTask();
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now() + 5_000, 'w-long-job');
    callModelSpy.mockResolvedValue({
      content: 'I have read the first half. Do you want the second half summarised too, or only the first?',
      toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });
    await runV2Turn('primary');
    expect(turnRows()).toEqual([expect.objectContaining({ exit_reason: 'answered', answered: 1, effectful_calls: 0 })]);
    expect(workState('w-long-job')).toBe('paused');

    // The owner answers mid-job: the reopen edge still fires.
    insertMessage({
      id: 'msg-user-2', agentId: 'primary', role: 'user', content: 'Both halves, please.',
      turnNumber: 2, channel: 'dashboard', senderId: 'owner', conversationId: 'conv-primary',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    callModelSpy.mockResolvedValue({
      content: 'On it.', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });
    await runV2Turn('primary');
    const reopened = mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'w-long-job' AND kind = 'transition'
         AND json_extract(payload, '$.from') = 'paused' AND json_extract(payload, '$.to') = 'claimed'
         AND json_extract(payload, '$.by') = 'owner'`,
    ).get() as { n: number };
    expect(reopened.n).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// (a) t125 — A CONTINUATION NEVER COUNTS AS OWING A PERSON. The preflight hands the turn
// `waitingConvs[0]?.oldest`: `undefined` when nobody is waiting, never `null`.
// ════════════════════════════════════════════════════════════════════════════════
describe('t137 (a): a continuation that ends quietly after its tools ends quietly', () => {
  it('the parked job\'s continuation reads, returns nothing, and exits `no_reply_intended` — no retry, no steer, no "empty reply" notice', async () => {
    seedInFlightTask();
    // The owner's ask turn speaks (so the ask is served and nobody is left waiting), then parks.
    await readOnlyTurnAcrossTheCheckpoint({ narrate: 'Starting on the research folder now.' });
    // The real preflight shape of the next turn: a C3 continuation with NO waiting conversation,
    // so `triggerRow` is `waitingConvs[0]?.oldest` = undefined.
    expect(continuationContext.has('primary')).toBe(true);
    expect(mockDb.current!.prepare(`SELECT state FROM work WHERE kind = 'ask'`).all()).toEqual([{ state: 'done' }]);
    pendingWakeups.clear();
    enqueueSteerSpy.mockClear();

    const modelCalls = await readsThenSaysNothing();

    expect(modelCalls).toBe(2);
    expect(emptyReplySteers()).toBe(0);
    expect(turnRows()[1]).toEqual(expect.objectContaining({ turn_number: 2, exit_reason: 'no_reply_intended', answered: 0 }));
    expect(systemRowsOfTurn(2)).toEqual([]);
  });

  it('CENSUS: no engine reader compares `triggerRow` against null; the owed-a-person arm reads it by truthiness', () => {
    // Both directions: zero null-comparisons anywhere in the engine corpus (a new one fails
    // here), and the one predicate this fix owns still READS the trigger (deleting the arm
    // instead of repairing it would also pass the first half).
    const offenders: string[] = [];
    let truthy = 0;
    for (const f of engineSources()) {
      const code = stripComments(f.text);
      if (/triggerRow\s*[!=]==?\s*null|null\s*[!=]==?\s*(?:ctx\.)?triggerRow/.test(code)) offenders.push(f.rel);
      if (f.rel.endsWith('post-call-classify/empty-response.ts')) {
        truthy = (code.match(/ctx\.hasUnansweredUser \|\| !!ctx\.triggerRow\)/g) ?? []).length;
      }
    }
    expect(offenders).toEqual([]);
    expect(truthy).toBe(1);
  });

  it('CONTROL: the SAME empty ending on a turn a person IS waiting on still gets the ladder (t125\'s own guarantee stands)', async () => {
    const modelCalls = await readsThenSaysNothing();
    expect(modelCalls).toBeGreaterThan(2);
    expect(emptyReplySteers()).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// NO TOTAL-TIME CAP. The old ladder stopped a job after its third continuation (60
// minutes by default), wrote "running for about 60 minutes … Pausing here" to the owner,
// and handed the job to the PM. A long job now parks and continues for as long as it needs.
// ════════════════════════════════════════════════════════════════════════════════
describe('t137: a long job is never cut off by elapsed time', () => {
  it('five consecutive parks (75+ minutes) each queue the next continuation; nothing is said to anyone', async () => {
    mockDb.current!.prepare(
      `INSERT INTO agents (id, name, model_id, status, config, classification)
       VALUES ('pm', 'PM', 'test-model', 'idle', '{}', 'sensei')`,
    ).run();
    seedInFlightTask();
    for (let i = 1; i <= 5; i++) {
      pendingWakeups.clear();
      // The first turn speaks to the owner and serves the ask; the four after it are continuations.
      await readOnlyTurnAcrossTheCheckpoint(i === 1 ? { narrate: 'Starting on the research folder now.' } : {});
      expect(pendingWakeups.has('primary'), `park ${i} queued its continuation`).toBe(true);
    }
    expect(turnRows().map((t) => t.exit_reason)).toEqual(['budget', 'budget', 'budget', 'budget', 'budget']);
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(5);
    // The only system row is the agent's own working note from the first turn — its own words.
    expect(messageRows().filter((m) => m.role === 'system').map((m) => m.content))
      .toEqual(['[working-note] Starting on the research folder now.']);
    expect(workState('w-long-job')).toBe('claimed');
    // The PM was never handed the job: nothing landed in its inbox. (The PM is present here,
    // so a hand-off WOULD land; the PM-offline arm is the clause below.)
    expect(mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'pm'`).get()).toEqual({ n: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// BACKWARDS LIFECYCLE — what must still hold around a silent park.
// ════════════════════════════════════════════════════════════════════════════════
describe('t137 lifecycle: the park stays honest around stops and stale work', () => {
  it('the PM is offline (no PM agent exists): the job parks and continues exactly the same', async () => {
    seedInFlightTask();
    for (let i = 1; i <= 4; i++) {
      pendingWakeups.clear();
      await readOnlyTurnAcrossTheCheckpoint(i === 1 ? { narrate: 'Starting on the research folder now.' } : {});
      expect(pendingWakeups.has('primary'), `park ${i} queued its continuation`).toBe(true);
    }
    expect(turnRows().map((t) => t.exit_reason)).toEqual(['budget', 'budget', 'budget', 'budget']);
    expect(workState('w-long-job')).toBe('claimed');
  });

  it('the owner presses Stop during the park\'s compaction check: nothing parked, nothing queued (T83 fence)', async () => {
    seedInFlightTask();
    checkAndCompactSpy.mockImplementationOnce(async () => {
      stoppedAgents.add('primary');
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    });
    await readOnlyTurnAcrossTheCheckpoint();
    expect(turnRows()[0].exit_reason).toBe('stop');
    expect(pendingWakeups.has('primary')).toBe(false);
    expect(continuationContext.has('primary')).toBe(false);
    expect(systemRowsOfTurn(1)).toEqual([]);
  });

  it('the close-out gate still arms on a genuinely stale second task on the continuation, and never names the in-flight one', async () => {
    seedInFlightTask();
    await readOnlyTurnAcrossTheCheckpoint({ narrate: 'Starting on the research folder now.' });
    expect(continuationContext.has('primary')).toBe(true);
    pendingWakeups.clear();
    // Planted AFTER the park, so the checkpoint's tracker touch could not have reached it.
    const stale = Date.now() - 40 * 60_000;
    mockDb.current!.prepare(
      `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, opened_at, updated_at)
       VALUES ('w-dangler', 'primary', 'task', 'owner', 'tracker', 'w-dangler', 'claimed',
               'action', 1, 0, 'the abandoned spreadsheet', ?, ?)`,
    ).run(stale, stale);
    callModelSpy.mockResolvedValue({ content: '', toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' });
    await runV2Turn('primary');
    const gate = messageRows().filter((m) => m.content.startsWith('[System: REQUIRED close-out'));
    expect(gate).toHaveLength(1);
    expect(gate[0].content).toContain('the abandoned spreadsheet');
    expect(gate[0].content).not.toContain('summarise the research folder');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// CENSUS — "is the old mechanism gone?", counted in both directions over comment-stripped code.
// ════════════════════════════════════════════════════════════════════════════════════════
const REPO = path.resolve(SERVER_SRC, '..', '..', '..');

/** Every shipped source file under the three packages: no tests, no migrations, no builds. */
function shippedSources(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['__tests__', 'node_modules', 'dist', 'migrations'].includes(e.name)) continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push({ rel: path.relative(REPO, full), code: stripComments(fs.readFileSync(full, 'utf8')) });
      }
    }
  };
  for (const pkg of ['packages/server/src', 'packages/dashboard/src', 'packages/shared/src']) walk(path.join(REPO, pkg));
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 (R-V333-3) — THE 75-CALL CHECKPOINT IS HOUSEKEEPING TOO, AND THE CIRCLING VERDICT IT
// CARRIED NOW REACHES THE AGENT. Same shape as the 15-minute park: nothing in the owner's chat;
// the PM's verdict travels as a rider notice on the events lane (model-visible on the next turn —
// proven against the real assembler in `t137-the-circling-verdict-reaches-the-agent.test.ts`).
// ════════════════════════════════════════════════════════════════════════════════════════
describe('t137 round 2: the 75-call checkpoint writes nothing to the owner and hands the verdict to the agent', () => {
  async function seventyFiveReadsThenTheCap(): Promise<void> {
    let call = 0;
    callModelSpy.mockImplementation(async () => {
      call++;
      return {
        content: call === 1 ? 'Starting on the research folder now.' : '',
        toolCalls: [{ id: `tc-cap-${call}`, name: 'file_read', arguments: { path: `/research/file-${call}.txt` } }],
        inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      };
    });
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => (
      { toolCallId: tc.id, name: tc.name, content: `body of ${tc.id}`, isError: false }));
    await runV2Turn('primary');
  }

  it('no system row, no chat broadcast of one — and the continuation is still scheduled', async () => {
    seedInFlightTask();
    await seventyFiveReadsThenTheCap();
    expect(continuationContext.has('primary')).toBe(true);   // positive control: the cap was reached
    expect(messageRows().filter((m) => m.role === 'system' && !m.content.startsWith('[working-note]')).map((m) => m.content))
      .toEqual([]);
    expect(chatBroadcasts().filter((m) => m.role === 'system' && !(m.content ?? '').startsWith('[working-note]'))).toEqual([]);
  });

  it('a pending circling verdict leaves as a PM-attributed events-lane notice, once, and the sweep sees it delivered', async () => {
    seedInFlightTask();
    writeTaskLog({ taskId: 'w-long-job', fromEntity: 'pm', entryKind: 'effort_review_intervene',
      reason: 'the same three files were re-read with nothing new landing' });
    expect(pendingCirclingVerdict('w-long-job')).not.toBeNull();

    await seventyFiveReadsThenTheCap();

    const rows = mockDb.current!.prepare(
      `SELECT role, lane, origin_intent, content FROM messages WHERE agent_id = 'primary' AND content LIKE '%PM EFFORT REVIEW%'`,
    ).all() as Array<{ role: string; lane: string; origin_intent: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'user', lane: 'events', origin_intent: 'agent_notice' });
    expect(rows[0].content).toContain('AGENT NOTICE from PM');
    expect(rows[0].content).toContain('summarise the research folder');
    expect(pendingCirclingVerdict('w-long-job')).toBeNull();
    expect(chatBroadcasts().some((m) => (m.content ?? '').includes('PM EFFORT REVIEW'))).toBe(false);
  });
});

describe('t137 CENSUS: the park writes nothing, the cap and its setting are gone', () => {
  it('turn-budget.ts writes ZERO message rows and broadcasts nothing — and still checkpoints, squares the tracker and queues the continuation', () => {
    const tb = engineSources().find((f) => f.rel.endsWith('pre-call-gates/turn-budget.ts'));
    expect(tb, 'the turn-budget step moved — re-point this census').toBeTruthy();
    const code = stripComments(tb!.text);
    expect(code.match(/insertMessage(IfAbsent)?\(|insertEngineEvent\w*\(|broadcast\(/g) ?? []).toEqual([]);
    // The other direction: deleting the WHOLE step would pass the half above.
    expect((code.match(/queueSelfWake\(agentId, 'turn-budget-continuation'\)/g) ?? []).length).toBe(1);
    expect((code.match(/noteEngineCheckpoint\(agentId, 'turn-budget'\)/g) ?? []).length).toBe(1);
    expect((code.match(/checkAndCompact\(/g) ?? []).length).toBe(1);
    expect((code.match(/latchEngineCut\(state, 'budget'\)/g) ?? []).length).toBe(1);
  });

  it('the cap and its setting: zero shipped references; only the two migrations that add and drop the column name it', () => {
    const DEAD = /max_unattended_minutes|maxUnattendedMinutes|unattendedBudgetMinutes|continuationCapFor|resolveUnattendedBudget|escalateUnattendedBudgetTripToPM|UNATTENDED_(?:MIN|MAX|STANDARD|DEFAULT)_MINUTES|UNATTENDED_UNCAPPED|\/unattended-budget|unattended-budget\.js|'unattended-budget'/;
    const sources = shippedSources();
    expect(sources.length, 'the walk found the packages').toBeGreaterThan(300);
    expect(sources.filter((f) => DEAD.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(fs.existsSync(path.join(SERVER_SRC, 'agent/unattended-budget.ts'))).toBe(false);

    const migrations = fs.readdirSync(path.join(SERVER_SRC, 'db/migrations'))
      .filter((f) => fs.readFileSync(path.join(SERVER_SRC, 'db/migrations', f), 'utf8')
        .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').includes('max_unattended_minutes'));
    expect(migrations).toEqual(['164_provider_unattended_budget.sql', '186_drop_provider_unattended_budget.sql']);

    // Positive control: the same walk DOES see the sibling the deletion left standing, so a zero
    // above is a fact about the code and not about a walk that read nothing.
    expect(sources.filter((f) => /\/prefill-throughput/.test(f.code)).map((f) => f.rel).sort())
      .toEqual(['packages/dashboard/src/lib/api.ts', 'packages/server/src/gateway/routes/config.ts']);
  });

  it('round 2: BOTH checkpoints hand the circling verdict over through the one door, and neither writes the owner a row', () => {
    const code = (rel: string): string => stripComments(fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8'));
    const tb = code('agent/v2/steps/pre-call-gates/turn-budget.ts');
    const loop = code('agent/v2/loop.ts');
    // The tool-loop checkpoint's block: from the cap test to the continuation's own setTimeout.
    const capBlock = loop.slice(loop.indexOf('loopCount >= MAX_TOOL_LOOPS'), loop.indexOf("getAgentRuntime().handleMessage(agentId, '')"));
    expect(capBlock.length, 'the tool-loop checkpoint moved — re-point this census').toBeGreaterThan(200);
    for (const [name, src] of [['turn-budget', tb], ['tool-loop', capBlock]] as const) {
      expect((src.match(/deliverPendingCirclingVerdict\(agentId\)/g) ?? []).length, `${name} hands the verdict over once`).toBe(1);
      expect(src.match(/insertMessage(IfAbsent)?\(|type: 'chat:message'/g) ?? [], `${name} writes the owner nothing`).toEqual([]);
    }
    expect((capBlock.match(/noteEngineCheckpoint\(agentId, 'tool-loop'\)/g) ?? []).length).toBe(1);
    // The old carrier is gone everywhere it could be called from.
    expect(shippedSources().filter((f) => /pendingCirclingVerdictParkLine/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('the pause has exactly ONE production caller, and that caller passes the continuation fact', () => {
    const callers = shippedSources().flatMap((f) => [...f.code.matchAll(/pauseDriveWorkWaitingOnOwner\(([\s\S]*?)\}\);/g)]
      .filter((m) => !/^\s*agentId: string/.test(m[1]))
      .map((m) => ({ rel: f.rel, args: m[1] })));
    expect(callers.map((c) => c.rel)).toEqual(['packages/server/src/agent/v2/steps/teardown/finalize-record.ts']);
    expect(callers[0].args).toMatch(/queuedOwnContinuation: !isStopFenced\(agentId\)\s*&& \(continuationContext\.has\(agentId\) \|\| toolLoopCapReached\)/);
  });
});
