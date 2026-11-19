// ════════════════════════════════════════
// v2 loop integration tests
//
// These tests exercise runV2Turn end-to-end against a mocked callModel
// and broadcast, with a real (in-memory) sqlite DB seeded with minimal
// schema. The goal: catch the class of bugs that unit tests miss, 
// "I forgot to wire X into the loop." Each test focuses on a specific
// behavioral preservation contract from PRESERVATION_CHECKLIST.md.
//
// What's mocked vs real:
//   - DB: REAL better-sqlite3 in-memory with minimal schema
//   - callModel: mocked, returns canned ModelCallResult
//   - executeTool: mocked, returns canned tool results
//   - broadcast: spy that captures all events
//   - injectAttachmentBlocks / drainPendingAttachments / etc.: real (we want
//     to verify they're CALLED, so spy on them)
// ════════════════════════════════════════

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
const sendIMessageSpy = vi.fn();
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-integration-test', 'dojo.db'),
  };
});

vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (event: unknown) => broadcastSpy(event),
}));

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
  sendIMessage: (...args: unknown[]) => sendIMessageSpy(...args),
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
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'primary',
  getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
  getTrainerAgentId: () => 'trainer',
  getTrainerAgentName: () => 'Trainer',
  isSetupCompleted: () => true,
  setPlatformConfig: vi.fn(),
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: (id: string) => id === 'pm',
  isTrainerAgent: (id: string) => id === 'trainer',
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
  // t138 r6: recovery.ts words its own pause notice with the owner card's words.
  pausedWords: (agentId: string) => `${agentId} has been paused after repeated errors. Open the Vitals page to investigate, or resume it from its detail page.`,
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
import { runV2Turn } from '../loop.js';
import {
  stoppedAgents, recoveryRunStreak, pendingWakeups,
  doomedPrefillCompactionSpent, declaredPatienceHonestFailTurn,
} from '../../shared-state.js';
import { AgentError } from '../../errors.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../../stream-patience.js';
import { turnContext } from '../../turn-context.js';
// The cross-turn untracked-work debt: turns that park on the turn-time budget never
// answer, so their debt survives the turn. It is module state, and every clause below
// starts from a clean DB — so it starts from a clean debt map too, like the maps beside it.
import { untrackedWorkAcrossTurns } from '../../turn-state.js';
import { currentTurnNumber } from '../turn-record.js';
// T82d (ANSWER-ANYWAY) — the recovery cascade under test directly, for the ONE case
// (engine/A2A/scheduled turns) this file has no existing fixture to drive end-to-end: nothing
// in this suite has ever built a genuine "no waiting human" turn (would need the seeded ask
// closed AND a pending engine event or A2A wake seeded in its place). Calling the cascade
// directly with a hand-built state exercises the SAME real module, against the SAME real
// mocks every other test in this file already relies on, without inventing that fixture.
import { recoverFromError } from '../recovery.js';
import { initState } from '../state.js';
import { recordDelivery } from '../deliveries.js';
import { runMigrations } from '../../../db/migrations.js';
import '../../decision-ask.js';
import { installDecisionModel, scriptDecisions, yes } from '../../__tests__/decision-fake.js';
import { insertMessage } from '../../../memory/message-store.js';
import { UPDATE_LABEL, EMPTIED_LABEL } from '../steps/call-llm/append-only-turn.js';
import {
  claimAsk, askIdForMessage, openAsk, stampClaimingTurn, openDelegationJoin, landPiece,
} from '../../../work/store.js';
// T47's gate arms on a rung the ladder has already spent, so the fixture spends one
// through the ladder's own writer rather than hand-rolling the audit row.
import { JOIN_DRIVE_ENTRY, JOIN_REDRIVE_BOUND, compileSteerText, recordJoinDrive } from '../../../work/join-drive.js';
import { FX, FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';
// HL4 step 2 (2d): the carrier the retired `compaction-recap` steer's model-facing
// requirement re-homes onto. Imported (not mocked) so the re-home clause DRIVES the
// real renderer against the real DB rather than reading its source.

// ── Test helpers ──

// ── THE MIGRATION CHAIN RUNS ONCE PER WORKER, NOT ONCE PER CLAUSE ──────────────────────
// (t112, 2026-10-05) This file is 132 clauses and each one built its fixture by running the
// REAL migration chain. MEASURED on this box: `runMigrations()` on a fresh `:memory:` DB
// costs 191.3ms (10 calls timed), 132 clauses cost 25.7s of the file's 29.4s, and a file
// that runs that long crosses vitest's 60s birpc deadline under full-suite load — which is
// the `[vitest-worker]: Timeout calling "onTaskUpdate"` error that cost three ritual rounds.
//
// The chain still runs — once — and its RESULT is the fixture. SQLite's serialize/deserialize
// pair copies the migrated image byte-for-byte, measured at 0ms per restore. So every clause
// gets the same schema the real chain produces (never a hand-rolled CREATE TABLE, which is
// the drift the note below was written to end), and nothing about what any clause proves
// moves. The restored handle is writable and growable (proven: 20,000 rows inserted into a
// table created after the restore).
let migratedImage: Buffer | null = null;

function migratedDb(): Database.Database {
  if (migratedImage === null) {
    // Run the REAL migration chain instead of hand-rolling CREATE TABLE
    // statements. The previous hand-rolled fixture drifted 4+ weeks behind the
    // engine (no conv_key, no inter_agent_messages, no tool_receipts, no
    // open_loops, ...) and every schema addition broke this suite. runMigrations
    // resolves the DB via the mocked getDb(), so point the mock at this
    // instance first.
    const seed = new Database(':memory:');
    mockDb.current = seed;
    runMigrations();
    migratedImage = seed.serialize();
    seed.close();
  }
  const db = new Database(migratedImage);
  // `foreign_keys` is a PER-CONNECTION pragma, not part of the image: `runMigrations` leaves
  // it ON (migrations.ts:275) and every clause's FK-order seeding below depends on that, so
  // the restored handle re-asserts it rather than inheriting whatever the default happens to
  // be. Proven: a `models` row naming an absent provider raises `FOREIGN KEY constraint failed`.
  db.pragma('foreign_keys = ON');
  return db;
}

/** The backoff a failed turn set on its request has passed: the next run serves it again. */
function backoffPasses(): void {
  mockDb.current!.prepare("UPDATE work SET next_attempt_at = ? WHERE kind = 'ask' AND next_attempt_at IS NOT NULL").run(Date.now() - 1);
}

function setupTestDb(): Database.Database {
  const db = migratedDb();
  mockDb.current = db;

  // Seed in FK order, migrations leave foreign_keys ON:
  // provider → model → agent → message.
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type)
    VALUES ('test-provider', 'Test', 'anthropic', 'api_key')
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('test-model', 'test-provider', 'Test Model', 'test-1', '["tools","vision"]', 200000, 1)
  `).run();
  // Seed the primary agent
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, classification)
    VALUES ('primary', 'Primary', 'test-model', 'idle', '{}', 'sensei')
  `).run();
  // Seed a user message so assembleContext has something to work with.
  //
  // PHASE-2 T3: through the REAL WRITER, not raw SQL. A person's message and the ask it
  // opens are one transaction now, so a hand-rolled INSERT produces a message with no
  // ticket — which is not a shape production can ever be in, and it would have made every
  // "a human is waiting" assertion in this file vacuously false. Same reason this fixture
  // stopped hand-rolling CREATE TABLE: a fixture that drifts from the writer tests nothing.
  //
  // PHASE-2 T6 (C7): the seed also STAMPS ITS CHANNEL. A person's message names the door it
  // came through (OR4, stamped at ingest), and the ticket gate now requires it — three
  // engine paths were writing channel-less `role='user'` rows and each opened an owner ask
  // nobody could ever serve. A fixture without a channel is the shape of one of THOSE, not
  // of a person, and every "a human is waiting" assertion in this file would go vacuously
  // false again. Same class of drift the T3 note above records; same repair.
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-primary', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run();
  insertMessage({
    id: 'msg-user-1', agentId: 'primary', role: 'user', content: 'hello primary', turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-primary',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });

  return db;
}

function getBroadcastEventsByType(type: string): unknown[] {
  return broadcastSpy.mock.calls
    .map((call) => call[0])
    .filter((e: { type?: string }) => e.type === type);
}

// T82d (ANSWER-ANYWAY) — the one class of user-visible engine text that earns default-mode
// (non-wordy) rendering in the owner's dashboard without a further turn to relay it (see
// recovery.ts's own T82d header for the full argument). Hoisted to file scope (fix round 1,
// ALSO (b)) so the PRE-EXISTING "unrelated injury" control below can pin against it too, not
// just the new T82d describe block.
function headsUpMessages(): string[] {
  return getBroadcastEventsByType('chat:message')
    .map((e) => (e as { message?: { content?: string } }).message?.content ?? '')
    .filter((c) => c.startsWith('Dojo:'));
}

beforeEach(() => {
  mockDb.current = setupTestDb();
  broadcastSpy.mockClear();
  callModelSpy.mockClear();
  executeToolSpy.mockClear();
  injectAttachmentBlocksSpy.mockClear();
  handleMessageSpy.mockClear();
  onAgentInjuredSpy.mockClear();
  isContextOverflowErrorMock.mockReset();
  isContextOverflowErrorMock.mockImplementation(() => false);
  recoverDreamerFromContextOverflowSpy.mockClear();
  recoverDreamerFromContextOverflowSpy.mockImplementation(async () => false);
  removeCapabilitySpy.mockClear();
  recordErrorMock.mockReset();
  recordErrorMock.mockImplementation(() => false);
  drainPendingAttachmentsSpy.mockClear();
  drainPendingAttachmentsSpy.mockImplementation(() => []);
  enforceModelCapabilitiesSpy.mockClear();
  enforceModelCapabilitiesSpy.mockImplementation(() => ({ useTools: true }));
  recordCostSpy.mockClear();
  queueEmbeddingSpy.mockClear();
  sendIMessageSpy.mockClear();
  checkAndCompactSpy.mockClear();
  estimateAssembledTokensMock.mockClear();
  estimateAssembledTokensMock.mockImplementation(() => ({
    total: 1000,
    summaryTokens: 0,
    freshTailTokens: 1000,
    briefTokens: 0,
    freshTailCount: 1,
    summaryCount: 0,
  }));
  stoppedAgents.clear();
  recoveryRunStreak.clear();
  doomedPrefillCompactionSpent.clear();
  declaredPatienceHonestFailTurn.clear();
  pendingWakeups.clear();
  untrackedWorkAcrossTurns.clear();
  enqueueSteerSpy.mockClear();
  stampTasksSpy.mockClear();
  terminalDeliveryForTurnSpy.mockClear();
  pauseDriveWorkWaitingOnOwnerSpy.mockClear();
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
  scoreQueryMock.mockClear();
  selectModelMock.mockClear();
  scoreQueryMock.mockImplementation(() => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }));
  selectModelMock.mockReset();
  assembleContextMock.mockClear();
  assembleContextMock.mockImplementation(async () => ({
    systemPrompt: '<system prompt>',
    messages: [{ role: 'user', content: 'hello' }] as Array<Record<string, unknown>>,
  }));
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── Tests ──

describe('runV2Turn integration', () => {
  it('happy path: text-only response → idle', async () => {
    callModelSpy.mockResolvedValue({
      content: 'Hello back!',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // Model was called once
    expect(callModelSpy).toHaveBeenCalledTimes(1);

    // Assistant message persisted
    const messages = mockDb.current!
      .prepare("SELECT * FROM messages WHERE role = 'assistant'")
      .all() as Array<{ content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello back!');

    // chat:chunk done broadcast fired
    const chunks = getBroadcastEventsByType('chat:chunk');
    expect(chunks.some((c: { done?: boolean }) => c.done === true)).toBe(true);

    // Agent ends idle
    const agent = mockDb.current!
      .prepare('SELECT status FROM agents WHERE id = ?')
      .get('primary') as { status: string };
    expect(agent.status).toBe('idle');
  });

  it('PRESERVATION #6: injectAttachmentBlocks IS called during assemble phase', async () => {
    callModelSpy.mockResolvedValue({
      content: 'OK',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // The bug we hit: injectAttachmentBlocks was never called from v2 loop.
    // This test catches it.
    expect(injectAttachmentBlocksSpy).toHaveBeenCalled();
  });

  it('PRESERVATION #36: enforceModelCapabilities IS called before model', async () => {
    callModelSpy.mockResolvedValue({
      content: 'OK',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(enforceModelCapabilitiesSpy).toHaveBeenCalled();
    // Capability enforcement must precede the model call.
    const capCallOrder = enforceModelCapabilitiesSpy.mock.invocationCallOrder[0];
    const modelCallOrder = callModelSpy.mock.invocationCallOrder[0];
    expect(capCallOrder).toBeLessThan(modelCallOrder);
  });

  it('PRESERVATION #11: callModel receives an abortSignal', async () => {
    callModelSpy.mockResolvedValue({
      content: 'OK',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    const params = callModelSpy.mock.calls[0][0] as { abortSignal?: AbortSignal };
    expect(params.abortSignal).toBeDefined();
    expect(params.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('PRESERVATION #1: TRUE streaming, chunks broadcast immediately', async () => {
    // Mock callModel to invoke onChunk multiple times before resolving
    callModelSpy.mockImplementation(async (params: { onChunk?: (c: string) => void }) => {
      const chunks = ['Hel', 'lo ', 'there', '!'];
      for (const c of chunks) {
        params.onChunk?.(c);
      }
      return {
        content: 'Hello there!',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'end_turn',
      };
    });

    await runV2Turn('primary');

    // Each chunk should have produced a separate chat:chunk broadcast
    // (NOT batched until model finishes, that was v1's bug)
    const chunkEvents = getBroadcastEventsByType('chat:chunk') as Array<{ content?: string; done?: boolean }>;
    const streamingChunks = chunkEvents.filter((e) => e.done !== true);
    expect(streamingChunks).toHaveLength(4);
    expect(streamingChunks.map((c) => c.content)).toEqual(['Hel', 'lo ', 'there', '!']);
  });

  it('PRESERVATION #2: complete_task exits the loop', async () => {
    const completeCall: ToolCall = {
      id: 'tc1',
      name: 'complete_task',
      arguments: { status: 'complete', summary: 'done' },
    };
    callModelSpy.mockResolvedValue({
      content: '',
      toolCalls: [completeCall],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'tool_use',
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1',
      name: 'complete_task',
      content: 'task completed',
      isError: false,
    });

    await runV2Turn('primary');

    // Loop should call model exactly ONCE, complete_task exits before
    // a follow-up call.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
  });

  it('PRESERVATION #3: image_create exits the loop (fire-and-forget)', async () => {
    const imageCall: ToolCall = {
      id: 'tc1',
      name: 'image_create',
      arguments: { prompt: 'a cat' },
    };
    callModelSpy.mockResolvedValue({
      content: 'On it, generating now',
      toolCalls: [imageCall],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'tool_use',
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1',
      name: 'image_create',
      content: 'image queued',
      isError: false,
    });

    await runV2Turn('primary');

    // Same as complete_task, image_create exits without follow-up call.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
  });

  it('a generator called with no words beside it gets ONE more model step, and the words land (proof-fix K)', async () => {
    const imageCall: ToolCall = { id: 'tc1', name: 'image_create', arguments: { prompt: 'a kayak' } };
    callModelSpy
      .mockResolvedValueOnce({ content: '', toolCalls: [imageCall], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: "Here's the kayak picture you asked for, it is on the way now.", toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc1', name: 'image_create', content: 'image queued', isError: false });

    await runV2Turn('primary');

    expect(callModelSpy).toHaveBeenCalledTimes(2);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    const rows = mockDb.current!.prepare("SELECT content FROM messages WHERE role = 'assistant'").all() as Array<{ content: string }>;
    expect(rows.some((r) => r.content.includes("Here's the kayak picture you asked for, it is on the way now."))).toBe(true);
  });

  it('the extra step cannot start a second generator and the turn ends after it (proof-fix K)', async () => {
    const imageCall: ToolCall = { id: 'tc1', name: 'image_create', arguments: { prompt: 'a kayak' } };
    const again: ToolCall = { id: 'tc2', name: 'image_create', arguments: { prompt: 'a kayak, again' } };
    callModelSpy
      .mockResolvedValueOnce({ content: '', toolCalls: [imageCall], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: 'On its way.', toolCalls: [again], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' })
      .mockResolvedValue({ content: 'should never be asked for', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc1', name: 'image_create', content: 'image queued', isError: false });

    await runV2Turn('primary');

    expect(callModelSpy).toHaveBeenCalledTimes(2);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
  });

  it('PRESERVATION #11 cont: stop signal mid-loop exits cleanly', async () => {
    let callCount = 0;
    callModelSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // After first call, simulate user clicking stop mid-loop
        stoppedAgents.add('primary');
        return {
          content: '',
          toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: '/x' } }],
          inputTokens: 100,
          outputTokens: 5,
          stopReason: 'tool_use',
        };
      }
      return {
        content: 'Should not reach',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'end_turn',
      };
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1',
      name: 'file_read',
      content: 'file content',
      isError: false,
    });

    await runV2Turn('primary');

    // First call ran, tool ran, stop was set, second iteration's
    // top-of-loop check should exit BEFORE second model call.
    expect(callModelSpy).toHaveBeenCalledTimes(1);

    // Status should be idle
    const agent = mockDb.current!
      .prepare('SELECT status FROM agents WHERE id = ?')
      .get('primary') as { status: string };
    expect(agent.status).toBe('idle');

    // UX-REPAIR T37: the LOOP no longer clears the flag — it honours it and
    // leaves it standing. The clear belongs to the RUN's exit path
    // (`handleMessage`'s `finally` in `runtime.ts`), which is one level above
    // `runV2Turn` and is not on this test's path. That is the whole fix: the
    // end-of-run drains have to be able to see that the user stopped this
    // agent, or they queue a wakeup and restart it 500 ms later.
    expect(stoppedAgents.has('primary')).toBe(true);
  });

  // t194 (v3.4 D1, owner decision 7): PRESERVATION #37's three rungs — WARN + "memory is getting full"
  // toast at 90%, emergency compact and surrender at 96%, surrender at 99% — are DELETED. They measured
  // a private model of the view; a full view is now condensed and the turn goes on. The replacement:
  it('t194: a turn at 92% / 98% / 99.75% of the old gate\'s number proceeds — the model is called, no toast, no forced pass', async () => {
    for (const total of [184000, 196000, 199500]) {
      callModelSpy.mockClear(); checkAndCompactSpy.mockClear();
      estimateAssembledTokensMock.mockImplementation(() => ({
        total, summaryTokens: 0, freshTailTokens: total, briefTokens: 0, freshTailCount: 1, summaryCount: 0,
      }));
      callModelSpy.mockResolvedValue({ content: 'OK', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' });
      await runV2Turn('primary');
      expect(callModelSpy, `at ${total}`).toHaveBeenCalledTimes(1);
      expect(checkAndCompactSpy).not.toHaveBeenCalledWith('primary', expect.any(String), expect.any(Number), expect.objectContaining({ force: true }));
    }
    const errors = getBroadcastEventsByType('chat:error') as Array<{ code?: string }>;
    expect(errors.find((e) => e.code === 'CONTEXT_HIGH'), 'no "memory is getting full" toast').toBeUndefined();
  });

  it('PRESERVATION #14: a job that does not move for a window of 75 steps parks and queues a fresh turn', async () => {
    // A model that ALWAYS wants another tool call, and every call finds nothing: the job never
    // moves, so the window's end (75 steps) is a checkpoint, not a renewal.
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      return {
        content: '',
        toolCalls: [
          { id: `tc-${modelCallCount}`, name: 'file_read', arguments: { path: `/tmp/file_${modelCallCount}.txt` } },
        ],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      };
    });
    executeToolSpy.mockImplementation(async (_agentId, toolCall) => ({
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: 'no such file',
      isError: true,
    }));

    await runV2Turn('primary');

    // The engine opened the work's task in the first window, which is movement; the second has none.
    expect(modelCallCount).toBe(150);
    // The park is invisible housekeeping: no system row for the owner.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'")
      .all() as Array<{ content: string }>;
    expect(sysMsgs.filter((r) => /tool calls.*Starting a fresh turn/.test(r.content))).toEqual([]);
    expect(pendingWakeups.has('primary'), 'the continuation is queued').toBe(true);
  });

  it('PRESERVATION #7: drainPendingAttachments IS called when persisting assistant message', async () => {
    // Mock attachments to be queued
    drainPendingAttachmentsSpy.mockImplementation(() => [
      { fileId: 'f1', filename: 'foo.png', mimeType: 'image/png', size: 100, path: '/tmp/foo.png', category: 'image' },
    ]);

    callModelSpy.mockResolvedValue({
      content: 'Here is the file',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(drainPendingAttachmentsSpy).toHaveBeenCalled();

    // Attachment metadata should be persisted on the assistant message row
    const msg = mockDb.current!
      .prepare("SELECT attachments FROM messages WHERE role = 'assistant' LIMIT 1")
      .get() as { attachments: string | null };
    expect(msg.attachments).toBeTruthy();
    const parsed = JSON.parse(msg.attachments!);
    expect(parsed[0].fileId).toBe('f1');
  });

  it('PRESERVATION #8: cost recording is NOT duplicated by v2 loop', async () => {
    callModelSpy.mockResolvedValue({
      content: 'OK',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // Cost is recorded INSIDE callModel (in model.ts). v2 loop must NOT
    // also call recordCost. recordCostSpy is only fired if v2 loop
    // explicitly calls it (since callModel is mocked here).
    expect(recordCostSpy).not.toHaveBeenCalled();
  });

  it('PRESERVATION: queueEmbedding IS called for assistant text responses', async () => {
    callModelSpy.mockResolvedValue({
      content: 'meaningful response',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(queueEmbeddingSpy).toHaveBeenCalled();
    const args = queueEmbeddingSpy.mock.calls[0];
    expect(args[0]).toBe('message');
    expect(args[2]).toBe('primary');
    expect(args[3]).toBe('meaningful response');
  });

  it('PRESERVATION #38: empty response triggers silent retry, then nudge, then toast', async () => {
    // v1 behavior: 3-phase recovery from empty model responses.
    //   phase 1, silent retry (no nudge, no toast)
    //   phase 2, explicit steer injection
    //   phase 3, chat:error toast
    // v2 used to skip straight to phase 3. This test enforces the full chain.
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      // Always return empty content + no tool calls.
      return {
        content: '',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 0,
        stopReason: 'end_turn',
      };
    });

    await runV2Turn('primary');

    // The model should have been called THREE times:
    //   call 1, initial empty
    //   call 2, after silent retry
    //   call 3, after explicit nudge
    // After the third empty response, the loop breaks with the error toast.
    expect(modelCallCount).toBe(3);

    // Exactly one chat:error event was broadcast on the final empty.
    //
    // ⚠ t125 CHANGED THE CODE, NOT THE COUNT, AND THE REASON IS THIS FIXTURE'S OWN SHAPE:
    // `msg-user-1` is left UNCLAIMED here, so a person is waiting. A waiting person now
    // gets the honest end of the ladder — `FLOOR_GHOSTED`, carrying a DURABLE role='system'
    // row in the platform's voice — instead of `MODEL_FAILED`, which is live-only and left
    // a reloaded page showing a turn that said nothing at all. The nobody-waiting turn still
    // gets exactly the old `MODEL_FAILED` toast and no row; that arm is asserted in
    // `post-call-classify/__tests__/a-turn-that-owes-a-person-never-ends-in-silence.test.ts`.
    const errors = getBroadcastEventsByType('chat:error') as Array<{ code?: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('FLOOR_GHOSTED');
    // The durable half, which a toast never had.
    const ghostRows = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' AND content LIKE '%empty reply%'")
      .all();
    expect(ghostRows).toHaveLength(1);

    // No assistant message was persisted (all responses were empty).
    const assistantMsgs = mockDb.current!
      .prepare("SELECT * FROM messages WHERE agent_id = 'primary' AND role = 'assistant'")
      .all();
    expect(assistantMsgs).toHaveLength(0);
  });

  it('PRESERVATION #40: identical response on a NO-TRIGGER turn is not double-persisted', async () => {
    // Scoped by G-SUP-3 (comms-audit, 1f8b9b4 2026-07-02): the identical-
    // response dedup now fires ONLY on turns with no waiting human (a genuine
    // mid-stall regeneration). Claim the seeded user message so nothing is
    // waiting, then have the model regenerate text identical to the most
    // recent assistant message: break the loop without persisting the dup.
    // PHASE-2 T3: "claimed" is a state on the ask, so the fixture claims the ask. Stamping
    // conv_key here no longer removes anything from the waiting set, and a fixture that
    // kept doing it would have quietly turned this into a WAITING-human turn — testing the
    // opposite of what it says.
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    mockDb.current!
      .prepare(
        `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
         VALUES ('msg-prior-assistant', 'primary', 'assistant', 'Hello back!', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000))`,
      )
      .run();

    callModelSpy.mockResolvedValue({
      content: 'Hello back!',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // The model ran (this is not a vacuous no-turn), but the dup was rejected:
    // still exactly one assistant message.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    const assistantMsgs = mockDb.current!
      .prepare("SELECT id FROM messages WHERE agent_id = 'primary' AND role = 'assistant'")
      .all();
    expect(assistantMsgs).toHaveLength(1);
  });

  it('PRESERVATION #40 / G-SUP-3: identical reply on a USER turn IS delivered (never eaten)', async () => {
    // G-SUP-3 (1f8b9b4 2026-07-02, extended b32f4bb 2026-07-03): never
    // suppress on a turn a human is waiting on. A user re-asking the same
    // thing gets a necessarily near-identical answer ("capital of France?"
    // twice), so with the seeded unanswered user message as the trigger, the
    // identical text persists as a genuine reply.
    mockDb.current!
      .prepare(
        `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
         VALUES ('msg-prior-assistant', 'primary', 'assistant', 'Hello back!', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000))`,
      )
      .run();

    callModelSpy.mockResolvedValue({
      content: 'Hello back!',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    const assistantMsgs = mockDb.current!
      .prepare("SELECT id FROM messages WHERE agent_id = 'primary' AND role = 'assistant'")
      .all();
    expect(assistantMsgs).toHaveLength(2);
  });

  it('PRESERVATION #40: tool-bearing turn with identical text IS persisted', async () => {
    // Carve-out: tool calls carry new state, so even if the text matches,
    // the turn must persist (otherwise we'd lose tool_use blocks).
    mockDb.current!
      .prepare(
        `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
         VALUES ('msg-prior-assistant', 'primary', 'assistant', 'Same text', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000))`,
      )
      .run();

    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      if (modelCallCount === 1) {
        return {
          content: 'Same text',
          toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: '/x' } }],
          inputTokens: 100,
          outputTokens: 5,
          stopReason: 'tool_use',
        };
      }
      return { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1', name: 'file_read', content: 'body', isError: false,
    });

    await runV2Turn('primary');

    const assistantMsgs = mockDb.current!
      .prepare("SELECT id FROM messages WHERE agent_id = 'primary' AND role = 'assistant'")
      .all();
    expect(assistantMsgs.length).toBeGreaterThan(1);
  });

  it('the dead-end floor: different calls that all come back empty or refused steer once, then end the turn', async () => {
    // When every tool result of a pass is empty ("No results found" / "not in memory") or refused
    // ([BLOCKED]) for two passes in a row, a steer fires; two more such passes end the turn with a
    // NO_RESULTS chat:error. Each call differs, so the repeat rule never sees them.
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      // Always plan another search, the no-results detector decides
      // when to break, not the model.
      return {
        content: '',
        toolCalls: [
          { id: `tc-${modelCallCount}`, name: 'history_search', arguments: { pattern: `term-${modelCallCount}` } },
        ],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      };
    });
    executeToolSpy.mockImplementation(async (_agentId, toolCall) => (modelCallCount % 2 === 0
      ? { toolCallId: toolCall.id, name: toolCall.name, content: '[BLOCKED] exec refused: not permitted.', isError: true }
      : { toolCallId: toolCall.id, name: toolCall.name, content: `No results found for "${toolCall.arguments.pattern}".`, isError: false }));

    await runV2Turn('primary');

    // Four model calls (the nudge resets the counter so the post-nudge
    // sequence repeats): iter 1 → counter 1; iter 2 → counter hits 2,
    // nudge fires, counter resets to 0; iter 3 (with nudge) → counter 1;
    // iter 4 → counter hits 2 again, already nudged → break with NO_RESULTS.
    expect(modelCallCount).toBe(4);

    const noResultsErrors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>).filter(
      (e) => e.code === 'NO_RESULTS',
    );
    expect(noResultsErrors).toHaveLength(1);
  });

  it('PRESERVATION: no-results counter resets when a tool returns actual results', async () => {
    // The detector must only fire on CONSECUTIVE all-no-results turns.
    // A single "good" result in between resets the counter.
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      if (modelCallCount > 4) {
        // After 4 tool turns, end normally so the test terminates.
        return { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
      }
      return {
        content: '',
        toolCalls: [
          { id: `tc-${modelCallCount}`, name: 'history_search', arguments: { pattern: `term-${modelCallCount}` } },
        ],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      };
    });
    let toolCallNum = 0;
    executeToolSpy.mockImplementation(async (_agentId, toolCall) => {
      toolCallNum++;
      // Pattern: empty, empty, GOOD, empty, counter goes 1→2-but-reset-by-good→1.
      // The "good" result must reset, so the second 'empty' should leave us at 1, not 2.
      const isGood = toolCallNum === 3;
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: isGood
          ? 'Found 5 matching messages: ...'
          : `No results found for "${toolCall.arguments.pattern}".`,
        isError: false,
      };
    });

    await runV2Turn('primary');

    // No NO_RESULTS error should have fired, the "good" result reset the counter.
    const noResultsErrors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>).filter(
      (e) => e.code === 'NO_RESULTS',
    );
    expect(noResultsErrors).toHaveLength(0);
  });

  it('PRESERVATION #38 (REWRITTEN BY t125): tool calls then empty, with a person waiting, never ends the turn silently', async () => {
    // ════════════════════════════════════════════════════════════════════════════════════
    // ⚠ THIS TEST ASSERTED THE DEFECT, END TO END, AND IT IS THE THIRD ONE THAT DID
    //   (the other two are in `post-call-classify/__tests__/an-answer-in-the-wrong-channel-
    //   is-retried.test.ts`; this one the triage did not find).
    //
    // AS WRITTEN: it drove a real turn on an agent holding a WAITING user message
    // (`msg-user-1`, seeded by this file's fixture), had the model call a tool and then
    // return empty, and asserted "two model calls, no toast — a legitimate end". That is
    // the owner's screenshot pinned as correct behaviour: he asked his PM a question, it
    // ran two `history_search` calls, and the turn ended with nothing on his screen.
    //
    // THE v1 CARVE-OUT IT CITED IS REAL AND IS KEPT — runtime.ts:1167-1171, "the agent did
    // work and has nothing more to say" — but only for the turn it was written about: one
    // where NOBODY IS WAITING. That half cannot be asserted here, and the reason is the
    // finding itself: on a user-driven turn the engine's own convention is `triggerRow` set
    // ⇒ this turn serves a waiting human (`steps/preflight/closeout-gate.ts:106`), so a
    // user turn is never a nobody-owed turn and this fixture cannot honestly make it one.
    // The carve-out is asserted where it is actually reachable, across all seven provider
    // seams, in `post-call-classify/__tests__/a-turn-that-owes-a-person-never-ends-in-
    // silence.test.ts` ("nobody is owed: the not-a-failure exit is byte-identical").
    //
    // What this test now asserts is the shape the owner actually met, end to end, on the
    // default (non-DeepSeek) contract this fixture resolves.
    // ════════════════════════════════════════════════════════════════════════════════════
    const toolCall: ToolCall = { id: 'tc1', name: 'file_read', arguments: { path: '/x' } };
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      if (modelCallCount === 1) {
        return { content: '', toolCalls: [toolCall], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
      }
      return { content: '', toolCalls: [], inputTokens: 100, outputTokens: 0, stopReason: 'end_turn' };
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1', name: 'file_read', content: 'file body', isError: false,
    });

    await runV2Turn('primary');

    // THE MODEL IS ASKED AGAIN rather than left alone: the ladder's silent retry, then its
    // one-shot steer. Four calls (tool-use, empty, retry, post-steer) — bounded, and the
    // same bound every other empty reply in this engine gets. Before t125: two.
    expect(modelCallCount).toBe(4);

    // AND THE PERSON HEARS SOMETHING DURABLE. Not a live-only toast — a role='system' row
    // in the platform's own voice (OR2: never the engine wearing the agent's face), which
    // is still there after a reload. That is the half the owner's screen was missing.
    const notices = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' AND content LIKE '%empty reply%'")
      .all() as Array<{ content: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toMatch(/send it again/i);
    // The platform speaks as the platform: no first-person line standing in for the agent.
    expect(notices[0].content).not.toMatch(/\bI\b/);

    // "THE REPLY STANDS" IS UNTOUCHED: no assistant row was forged for the person. The one
    // assistant row this turn wrote is the tool_use itself, which carries no text — a ghost
    // is by definition a turn with no reply to stand.
    const spoken = (mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'assistant'")
      .all() as Array<{ content: string }>)
      .filter((r) => !r.content.includes('"type":"tool_use"'));
    expect(spoken).toHaveLength(0);
  });

  it('CONVERSATION INVARIANT: no system message between assistant tool_use and tool_result', async () => {
    // This is the bug that the engine ack caused. Verify v2 loop never
    // writes a 'system' role message between the assistant tool_use and
    // its matching tool_result message in the messages table.
    const toolCall: ToolCall = {
      id: 'tc1',
      name: 'file_read',
      arguments: { path: '/x' },
    };
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      if (modelCallCount === 1) {
        return {
          content: 'reading',
          toolCalls: [toolCall],
          inputTokens: 100,
          outputTokens: 5,
          stopReason: 'tool_use',
        };
      }
      return {
        content: 'Done',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'end_turn',
      };
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1',
      name: 'file_read',
      content: 'file body',
      isError: false,
    });

    await runV2Turn('primary');

    // Inspect messages in insertion order
    const rows = mockDb.current!
      .prepare("SELECT role FROM messages WHERE agent_id = ? ORDER BY created_at, rowid")
      .all('primary') as Array<{ role: string }>;
    // Find index of assistant message with tool_use, then verify the next
    // message is the tool result (not a system message in between)
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].role === 'assistant') {
        // If this assistant message had tool_use, the next must be 'tool'.
        // We can't easily check tool_use vs text-only here without parsing
        // content, so assert the broader invariant: no 'system' message
        // ever lands directly between an 'assistant' and a 'tool'.
        if (rows[i + 1].role === 'system') {
          // If next is system, the one after must NOT be tool with the
          // same call id (would be a broken pair).
          // For simplicity in this test, just assert system never breaks
          // an assistant→tool sequence.
          expect(rows[i + 2]?.role).not.toBe('tool');
        }
      }
    }
  });

  // ─────────────────────────────────────────────────────────
  // Phase 6, v2 owns its own recovery cascade (recovery.ts)
  // ─────────────────────────────────────────────────────────

  it('PHASE 6: recoverable provider 4xx → system note + wakeup, no injury', async () => {
    // A "vision_mismatch" 400 from the provider. The classifier recognizes
    // it as recoverable; recovery persists a [System: …] note (per the
    // spec table, vision_mismatch template) and queues a wakeup. The
    // agent is NOT injured, recordError + onAgentInjured should NOT
    // fire. Tier B = no status change.
    callModelSpy.mockRejectedValue(
      new Error('400 The model does not support image input, no endpoints found that support images'),
    );

    await runV2Turn('primary');

    // No injury side effects (Tier B).
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();

    // Wakeup was queued so the agent retries.
    expect(pendingWakeups.has('primary')).toBe(true);

    // System note persisted, sourced from formatTierBNoteForAgent (spec
    // table). For vision_mismatch the body explains the model can't see
    // images and points to Settings.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/can't see images|cannot see images/i);

    // Vision-mismatch self-healing: capability cache invalidated.
    expect(removeCapabilitySpy).toHaveBeenCalledWith('test-model', 'vision');

    // Streak counter incremented; now keyed by (kind, fingerprint) per v2.3.19.
    expect(recoveryRunStreak.get('primary')?.count).toBe(1);
    expect(recoveryRunStreak.get('primary')?.kind).toBe('vision_mismatch');
    expect(recoveryRunStreak.get('primary')?.inputsFingerprint).toBeDefined();
  });

  it('PHASE 6: tool_format_rejected 400 → system note + wakeup, no injury', async () => {
    // tool_format_rejected: same Tier B treatment as vision_mismatch.
    // Asserts the new spec-driven note body sourced from
    // formatTierBNoteForAgent.
    callModelSpy.mockRejectedValue(
      new Error('400 tool_use block has invalid input: missing required parameter'),
    );

    await runV2Turn('primary');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('primary')).toBe(true);

    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    // Either the tool_format_rejected or tool_args_schema_mismatch template
    // is acceptable, both are Tier B and both produce actionable notes
    // about re-issuing the tool call. Classifier ordering decides which
    // fires for any given phrasing.
    expect(sysMsgs[0].content).toMatch(/tool call|Re-call with|Re-issue/i);

    // Streak kind is one of the two acceptable tool-error kinds.
    const kind = recoveryRunStreak.get('primary')?.kind;
    expect(['tool_format_rejected', 'tool_args_schema_mismatch']).toContain(kind);
  });

  it('PHASE 6 (v2.3.19): same kind + same inputs hits MAX → escalates to injury', async () => {
    // v2.3.19 semantics: streak is keyed by (kind, inputsFingerprint).
    // The fingerprint depends on the real turn state, so we let the first
    // call POPULATE the entry, then manually bump count to MAX, then a
    // second identical call trips the cap because both kind and
    // fingerprint match.
    callModelSpy.mockRejectedValue(
      new Error('400 The model does not support image input, no endpoints found that support images'),
    );

    // First run: streak gets created with the real fingerprint at count=1.
    await runV2Turn('primary');
    const entry = recoveryRunStreak.get('primary');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('vision_mismatch');
    // No injury yet (count=1 << MAX).
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();

    // Bump count to MAX so the next identical failure trips the cap.
    const { MAX_INLOOP_RECOVERIES_SAME_INPUTS } = await import('../../shared-state.js');
    recoveryRunStreak.set('primary', {
      ...entry!,
      count: MAX_INLOOP_RECOVERIES_SAME_INPUTS,
    });
    // Clear spies so we measure only the second call's side effects.
    recordErrorMock.mockClear();
    onAgentInjuredSpy.mockClear();

    // Second identical failure, same kind, same fingerprint → escalate.
    backoffPasses();
    await runV2Turn('primary');

    expect(recordErrorMock).toHaveBeenCalledWith('primary');
    expect(onAgentInjuredSpy).toHaveBeenCalled();
    expect(recoveryRunStreak.has('primary')).toBe(false); // reset

    // Give-up note persisted before the injury cascade.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid ASC")
      .all() as Array<{ content: string }>;
    const giveUp = sysMsgs.find((m) =>
      /(tried this recovery|approach and it keeps failing|Healer is being notified)/i.test(m.content),
    );
    expect(giveUp).toBeDefined();
  });

  it('PHASE 6: context overflow on non-Dreamer → force compact + wakeup, no injury', async () => {
    isContextOverflowErrorMock.mockImplementation(() => true);
    callModelSpy.mockRejectedValue(
      new Error('400 prompt is too long: 250000 tokens > 200000 maximum'),
    );

    await runV2Turn('primary');

    // Forced compaction was invoked.
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'primary',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ force: true }),
    );

    // Wakeup queued.
    expect(pendingWakeups.has('primary')).toBe(true);

    // No injury.
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
  });

  describe('T81b — a PRE-DIAL doomed-request refusal', () => {
    const preDialRefusal = (): AgentError => new AgentError(
      "refused before any network dial: ~9999 estimated prompt tokens exceeds the ~100-token "
      + "ceiling this provider's declared 10 tok/s prefill throughput can cover inside its "
      + "declared 40000ms first-chunk patience. Compact the conversation to shrink the prompt, "
      + "or raise this provider's declared patience or prefill throughput.",
      'primary',
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false, preDialRefusal: true },
    );

    it('force-compacts ONCE and retries — no injury', async () => {
      callModelSpy.mockRejectedValue(preDialRefusal());

      await runV2Turn('primary');

      expect(checkAndCompactSpy).toHaveBeenCalledWith(
        'primary',
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({ force: true }),
      );
      expect(pendingWakeups.has('primary')).toBe(true);
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
      expect(recordErrorMock).not.toHaveBeenCalled();
    });

    it('a SECOND pre-dial refusal (the re-estimate is still over the ceiling) is never compacted twice — honest fail', async () => {
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // spends the one attempt
      expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);

      checkAndCompactSpy.mockClear();
      onAgentInjuredSpy.mockClear();
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // still doomed after the one compaction — no dial was ever attempted

      expect(checkAndCompactSpy).not.toHaveBeenCalled();
      expect(onAgentInjuredSpy).toHaveBeenCalledWith(
        'primary',
        expect.stringContaining('refused before any network dial'),
        DECLARED_PATIENCE_EXCEEDED_CODE,
      );
    });

    it('REVIEW ROUND FINDING 1: doomed → compact → an UNRELATED error → doomed again ⇒ compaction IS attempted again', async () => {
      // The bare-boolean first cut of `doomedPrefillCompactionSpent` stayed set across an
      // intervening error-path turn end that had nothing to do with doom (no finalize, no
      // second doomed refusal to consume it) — so a LATER, unrelated doomed request found the
      // marker already "spent" and was denied the one compaction it was entitled to. The fix
      // ties the marker to the specific turn that spent it (`agentId -> turnNumber`), so a turn
      // that is NOT the immediate successor of the one that compacted is a fresh chain.
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // turn N: doomed → compacts, spends the attempt, self-wakes
      expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);

      checkAndCompactSpy.mockClear();
      onAgentInjuredSpy.mockClear();
      // A wholly unrelated failure — same fixture PHASE 6's own "generic injury" case uses —
      // reaching recordInjury, nowhere near the pre-dial-refusal branch (not even an
      // `AgentError`, let alone one carrying the code or the marker).
      callModelSpy.mockRejectedValue(new Error('500 Internal Server Error: something weird'));
      await runV2Turn('primary'); // turn N+1: unrelated to doom entirely
      expect(checkAndCompactSpy).not.toHaveBeenCalled();
      expect(onAgentInjuredSpy).toHaveBeenCalled();

      checkAndCompactSpy.mockClear();
      onAgentInjuredSpy.mockClear();
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // turn N+2: doomed again — NOT the immediate successor of turn N

      // The stale marker from turn N must not block this: it is a fresh chain and earns its
      // own compaction, not an immediate honest-fail.
      expect(checkAndCompactSpy).toHaveBeenCalledWith(
        'primary',
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({ force: true }),
      );
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    });

    // T82b (ANSWER-ANYWAY) DELETED THIS CONTROL'S OLD ASSERTION. Pre-T82b, the identical code
    // from a genuine watchdog timeout (no `preDialRefusal`) skipped this recovery entirely and
    // went straight to the honest fail — "a real dial was attempted and died mid-flight, so
    // compacting and retrying would repeat the exact wall-clock cost that just failed (P3)".
    // That reasoning did not survive T82a: the redial here was never a bare cold re-dial of the
    // SAME prompt, it is "force-compact (to the provider-aware budget, strictly smaller than
    // the threshold that just failed) THEN re-dial" — a materially different, smaller request,
    // not a repeat. A live dial death now gets the identical one-shot compact-and-retry a
    // pre-dial refusal always got; see the dedicated `describe` block below
    // ("T82b — a live timeout routes through the SAME compact-once path") for the full
    // first-occurrence / second-occurrence / shared-marker coverage.
  });

  describe('T82b (ANSWER-ANYWAY) — a live timeout routes through the SAME compact-once path pre-dial refusals use', () => {
    // THE DELETION THIS TASK MAKES: pre-T82b, `v2/recovery.ts` only ran the compact-once
    // discipline for a PRE-DIAL refusal (`error.preDialRefusal === true` — `agent/model.ts`
    // refused to dial at all). A REAL dial that went out and died at the identical declared
    // bound (the watchdog cut it mid-flight, `preDialRefusal` false or absent) fell straight
    // through to `recordInjury` on its FIRST occurrence — "a live timeout is immediately
    // terminal". That is gone: both shapes now share the ONE compact-once path, the ONE
    // `doomedPrefillCompactionSpent` marker, and the ONE spent/adjacency discipline — no new
    // mechanism, no new marker (see `recovery.ts`'s own step-0.5 header for the full argument).
    //
    // FIXTURE (never a code constant): "the box times out on a big prompt, serves a small one
    // fine" — a live dial that dies at the declared patience on a ~60K-token turn, echoing
    // T81b/T82a's own 600s/180tps fixture family.
    const SIXTY_K_BLOB = 'x'.repeat(240_000); // ~60,000 tokens via the platform's /4 estimator
    const liveTimeout = (): AgentError => new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 600000ms); '
      + '~60000 estimated prompt tokens against a declared 600000ms first-chunk patience',
      'primary',
      // `preDialRefusal` intentionally omitted (defaults false): a REAL dial went out and died
      // mid-flight — the shape a watchdog abort produces, never a pre-dial refusal's shape.
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );
    const preDialRefusal = (): AgentError => new AgentError(
      "refused before any network dial: ~9999 estimated prompt tokens exceeds the ~100-token "
      + "ceiling this provider's declared 10 tok/s prefill throughput can cover inside its "
      + "declared 40000ms first-chunk patience.",
      'primary',
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false, preDialRefusal: true },
    );

    it('a live timeout on a 60K turn compacts ONCE, and the retried (materially smaller) assembly lands an answer', async () => {
      // The assembler is asked again on the retried turn (the real `assemble` step, unmocked
      // in production, re-reads the DB after `checkAndCompact` ran for real). Standing in for
      // that here: the canned assembly flips from the oversized blob to a small, DIFFERENT
      // shape the moment `checkAndCompactSpy` has actually been invoked — so the model only
      // ever "serves small": it rejects the big assembly (the box timing out) and succeeds on
      // the compacted one, causally proving the redial is smaller, not merely re-mocked.
      assembleContextMock.mockImplementation(async () => (
        checkAndCompactSpy.mock.calls.length > 0
          ? { systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'compacted, small' }] }
          : { systemPrompt: '<system prompt>', messages: [{ role: 'user', content: SIXTY_K_BLOB }] }
      ));
      callModelSpy.mockImplementation(async (args: unknown) => {
        const { messages } = args as { messages: Array<{ content: unknown }> };
        if (messages.some((m) => m.content === SIXTY_K_BLOB)) throw liveTimeout();
        return { content: 'It is done.', toolCalls: [], inputTokens: 10, outputTokens: 3, stopReason: 'end_turn' };
      });

      await runV2Turn('primary'); // turn N: the 60K assembly dials, dies at patience

      expect(checkAndCompactSpy).toHaveBeenCalledWith(
        'primary',
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({ force: true }),
      );
      expect(pendingWakeups.has('primary')).toBe(true); // not declined — the retry wake fires
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
      expect(recordErrorMock).not.toHaveBeenCalled();

      await runV2Turn('primary'); // turn N+1: the retry — assembly is now the compacted, smaller one

      expect(checkAndCompactSpy).toHaveBeenCalledTimes(1); // exactly ONE compaction across the chain
      expect(callModelSpy).toHaveBeenCalledTimes(2); // exactly 2 dials total
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
      const messages = mockDb.current!
        .prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1")
        .all() as Array<{ content: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('It is done.'); // the answer lands
    });

    it('a SECOND live timeout in the same turn-chain (the one attempt already spent) is never compacted twice — honest fail, exactly 2 dials total', async () => {
      callModelSpy.mockRejectedValue(liveTimeout());
      await runV2Turn('primary'); // turn N: dies at patience, compacts, spends the one attempt, self-wakes
      expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);

      checkAndCompactSpy.mockClear();
      onAgentInjuredSpy.mockClear();
      callModelSpy.mockRejectedValue(liveTimeout()); // the retried dial ALSO dies at patience
      await runV2Turn('primary'); // turn N+1: the retry itself times out again

      expect(checkAndCompactSpy).not.toHaveBeenCalled(); // marker already spent — no second compaction
      expect(callModelSpy).toHaveBeenCalledTimes(2); // exactly 2 dials total across the whole chain
      expect(onAgentInjuredSpy).toHaveBeenCalledWith(
        'primary',
        expect.stringContaining('model first-chunk timeout'),
        DECLARED_PATIENCE_EXCEEDED_CODE,
      );
      expect(declaredPatienceHonestFailTurn.get('primary')).toBe(currentTurnNumber('primary'));
    });

    it('CONTROL (pre-dial path byte-unchanged): a pre-dial refusal still force-compacts once and retries exactly as it did before this task', async () => {
      callModelSpy.mockRejectedValue(preDialRefusal());

      await runV2Turn('primary');

      expect(checkAndCompactSpy).toHaveBeenCalledWith(
        'primary',
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({ force: true }),
      );
      expect(pendingWakeups.has('primary')).toBe(true);
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    });

    it('SHARED-MARKER CONTROL: a pre-dial compaction spends the ONE attempt — a live timeout right after in the same chain is never compacted twice, straight to honest fail', async () => {
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // turn N: pre-dial refusal compacts, spends the ONE shared attempt
      expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);

      checkAndCompactSpy.mockClear();
      onAgentInjuredSpy.mockClear();
      callModelSpy.mockRejectedValue(liveTimeout()); // turn N+1: a REAL dial goes out this time and dies at patience
      await runV2Turn('primary');

      // The marker is SHARED across both shapes, not per-shape — the live timeout finds it
      // already spent by the pre-dial refusal and never gets its own compaction.
      expect(checkAndCompactSpy).not.toHaveBeenCalled();
      expect(onAgentInjuredSpy).toHaveBeenCalledWith(
        'primary',
        expect.stringContaining('model first-chunk timeout'),
        DECLARED_PATIENCE_EXCEEDED_CODE,
      );
    });

    it('CONTROL: a non-patience error code is completely untouched by this task — straight to the ordinary injury path', async () => {
      callModelSpy.mockRejectedValue(new Error('500 Internal Server Error: something weird'));

      await runV2Turn('primary');

      expect(checkAndCompactSpy).not.toHaveBeenCalled();
      expect(onAgentInjuredSpy).toHaveBeenCalled();
    });
  });

  describe('T81c FIX ROUND 1 — the declared-patience-honest-fail marker', () => {
    // CRITICAL finding, review round 1: the first cut read `agents.last_error` — a STRING that
    // survives a `working` transition by design — to decide whether `runtime.ts`'s queued-wakeup
    // restart should decline. Reproduced defect: an agent injured by a declared-patience turn,
    // resumed, then hitting an UNRELATED recovery arm (context-overflow, the pre-dial compaction
    // retry, output-truncation, Tier-B) on the very NEXT turn had its entirely legitimate
    // self-wake silently declined by the STALE phrase still sitting in `last_error` — none of
    // those four arms ever touch that column. This block drives the REAL cascade (not DB
    // seeding) and asserts the marker `runtime.ts` actually consults: set ONLY by `recordInjury`
    // for `DECLARED_PATIENCE_EXCEEDED_CODE` (the honest-fail path with no self-scheduled retry),
    // and left UNSET by every path that queues its own legitimate retry instead.

    const midFlightTimeout = (): AgentError => new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 40000ms); '
      + '~9999 estimated prompt tokens against a declared 40000ms first-chunk patience',
      'primary',
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );
    const preDialRefusal = (): AgentError => new AgentError(
      "refused before any network dial: ~9999 estimated prompt tokens exceeds the ~100-token "
      + "ceiling this provider's declared 10 tok/s prefill throughput can cover inside its "
      + "declared 40000ms first-chunk patience.",
      'primary',
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false, preDialRefusal: true },
    );

    it('a mid-flight declared-patience timeout SETS the marker on the turn that just ended, once the T82b compact-once attempt is spent', async () => {
      // T82b (ANSWER-ANYWAY): a live dial death now gets the SAME one-shot compact-and-retry a
      // pre-dial refusal always got, so the FIRST occurrence no longer reaches the honest fail
      // at all — it compacts and queues a retry instead, same as the block below's own
      // "a SECOND pre-dial refusal ... ALSO sets the marker" shape. The honest fail (and this
      // marker) only fires once that one attempt is spent, on the SECOND occurrence.
      callModelSpy.mockRejectedValue(midFlightTimeout());
      await runV2Turn('primary'); // spends the one compact-and-retry attempt — no injury, no marker yet
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
      expect(declaredPatienceHonestFailTurn.has('primary')).toBe(false);

      callModelSpy.mockRejectedValue(midFlightTimeout());
      await runV2Turn('primary'); // the retry ALSO dies at patience — the one attempt is spent

      expect(onAgentInjuredSpy).toHaveBeenCalled(); // NOW this is the honest-fail path
      expect(declaredPatienceHonestFailTurn.get('primary')).toBe(currentTurnNumber('primary'));
    });

    // T81d FIX ROUND (NO-DOOMED-DIALS review, CRITICAL) — the agent-sdk transport
    // (`agent/model.ts` `callAnthropicSdkModel` / `providers/anthropic-sdk.ts`
    // `callAnthropicViaSdk`) had NO clock at all until T81d, and the first cut of that task
    // gave it a timer without the honest-fail IDENTITY: its own derived-patience abort threw a
    // plain `Error` with no `.code`, which reached this exact `recordInjury` seam classified
    // 'unknown' — never setting this marker — and reopened the GPU livelock through the one
    // transport the whole plan exists to protect. The fix round made `callAnthropicSdkModel`
    // throw the SAME `AgentError` SHAPE (`DECLARED_PATIENCE_EXCEEDED_CODE`, `retryable: false`)
    // the other two transports already built — this is `callModelSpy` standing in for THAT
    // transport's real catch-block output (proven for real, driven through `callModel`, in
    // `agent/__tests__/the-agent-sdk-transport-honours-declared-patience.test.ts` §D), and
    // proving the downstream reaction is identical regardless of which transport produced it.
    it('T81d: the agent-sdk transport\'s own declared-patience shape ALSO sets the marker — recordInjury does not care which transport produced the code', async () => {
      const agentSdkShape = (): AgentError => new AgentError(
        'model first-chunk timeout: no data from provider for too long (elapsed 640000ms); '
        + '~10 estimated prompt tokens against a declared 600000ms first-chunk patience',
        'primary',
        { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
      );
      // T82b: the FIRST occurrence, from ANY transport, now compacts and retries — see the
      // mid-flight test above for the full rationale. This test's own point (the marker is
      // transport-agnostic) is proven on the SECOND occurrence, once that attempt is spent.
      callModelSpy.mockRejectedValue(agentSdkShape());
      await runV2Turn('primary');
      expect(declaredPatienceHonestFailTurn.has('primary')).toBe(false);

      callModelSpy.mockRejectedValue(agentSdkShape());
      await runV2Turn('primary');

      expect(onAgentInjuredSpy).toHaveBeenCalled();
      expect(declaredPatienceHonestFailTurn.get('primary')).toBe(currentTurnNumber('primary'));
    });

    // T81 FIX WAVE (NO-DOOMED-DIALS final review, Important I1) — the SAME defect T81d closed
    // for the agent-sdk transport was still open on the Ollama native transport
    // (`agent/model.ts`'s `callOllamaModel`): its own derived-patience `AbortSignal.timeout`
    // trip fell into the generic catch and was wrapped as plain `MODEL_CALL_FAILED`, classified
    // 'network' downstream, never reaching this `recordInjury` seam with the honest-fail code —
    // reopening the identical GPU livelock through the fourth transport. The fix round gave that
    // catch block the SAME own-timer discrimination (`timeoutSignal.aborted &&
    // !params.abortSignal?.aborted`) and the SAME shared decision points
    // (`streamTimeoutCode`/`streamTimeoutPhrase`/`declaredPatienceClause`) the other transports
    // already use — proven for real, driven through `callModel`, in
    // `agent/__tests__/the-third-transport-honours-declared-patience.test.ts` §D. This is
    // `callModelSpy` standing in for that transport's real catch-block output, proving the
    // downstream reaction is identical regardless of which transport produced the code.
    it('T81 fix wave: the ollama transport\'s own declared-patience shape ALSO sets the marker', async () => {
      const ollamaShape = (): AgentError => new AgentError(
        'model first-chunk timeout: no data from provider for too long (elapsed 640000ms); '
        + '~10 estimated prompt tokens against a declared 600000ms first-chunk patience',
        'primary',
        { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
      );
      // T82b: same widening as the agent-sdk case directly above — the FIRST occurrence
      // compacts and retries; the marker only fires once that attempt is spent.
      callModelSpy.mockRejectedValue(ollamaShape());
      await runV2Turn('primary');
      expect(declaredPatienceHonestFailTurn.has('primary')).toBe(false);

      callModelSpy.mockRejectedValue(ollamaShape());
      await runV2Turn('primary');

      expect(onAgentInjuredSpy).toHaveBeenCalled();
      expect(declaredPatienceHonestFailTurn.get('primary')).toBe(currentTurnNumber('primary'));
    });

    it('a SECOND pre-dial refusal (compaction already spent) reaching the honest fail ALSO sets the marker', async () => {
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // spends the one compaction attempt — no injury, no marker yet
      expect(declaredPatienceHonestFailTurn.has('primary')).toBe(false);

      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary'); // still doomed — the honest fail

      expect(onAgentInjuredSpy).toHaveBeenCalled();
      expect(declaredPatienceHonestFailTurn.get('primary')).toBe(currentTurnNumber('primary'));
    });

    it('CONTROL: the FIRST pre-dial refusal (compaction succeeds, retry queued) does NOT set the marker', async () => {
      callModelSpy.mockRejectedValue(preDialRefusal());
      await runV2Turn('primary');

      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
      expect(pendingWakeups.has('primary')).toBe(true); // a real retry IS queued
      expect(declaredPatienceHonestFailTurn.has('primary'), 'a legitimate compaction retry must not be mistaken for a no-retry honest fail').toBe(false);
    });

    it('CONTROL: context-overflow recovery (an UNRELATED arm) does NOT set the marker, even though it also queues a self-wake', async () => {
      isContextOverflowErrorMock.mockImplementation(() => true);
      callModelSpy.mockRejectedValue(new Error('400 prompt is too long: 250000 tokens > 200000 maximum'));

      await runV2Turn('primary');

      expect(checkAndCompactSpy).toHaveBeenCalled();
      expect(pendingWakeups.has('primary')).toBe(true);
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
      expect(declaredPatienceHonestFailTurn.has('primary'), 'this arm never touches last_error either — the OLD check could have wrongly declined a LATER turn').toBe(false);
    });

    it('CONTROL: Tier-B recoverable-provider-4xx recovery does NOT set the marker', async () => {
      callModelSpy.mockRejectedValue(
        new Error('400 The model does not support image input, no endpoints found that support images'),
      );

      await runV2Turn('primary');

      expect(recordErrorMock).not.toHaveBeenCalled();
      expect(pendingWakeups.has('primary')).toBe(true);
      expect(declaredPatienceHonestFailTurn.has('primary')).toBe(false);
    });

    it('CONTROL: a wholly unrelated injury (not declared-patience) reaches recordInjury but does NOT set the marker', async () => {
      callModelSpy.mockRejectedValue(new Error('500 Internal Server Error: something weird'));
      await runV2Turn('primary');

      expect(onAgentInjuredSpy).toHaveBeenCalled(); // this IS an honest fail — just not THIS class
      expect(declaredPatienceHonestFailTurn.has('primary'), 'the marker is gated on the CODE, not on "recordInjury ran"').toBe(false);
      // T82d FIX ROUND 1, ALSO (b): pinned explicitly. `recordInjury`'s NEW Heads-up branch is
      // gated on `code === DECLARED_PATIENCE_EXCEEDED_CODE`; a wholly unrelated injury (no code
      // at all, on a plain `Error`) must fall through to the ORIGINAL generic unclassified path
      // byte-for-byte, never gaining a channel line it didn't have before this task.
      expect(headsUpMessages()).toHaveLength(0);
    });

    it('THE REPRODUCED DEFECT, closed: a stale last_error from an earlier chain no longer blocks an unrelated later recovery arm', async () => {
      // Simulates exactly the reviewer's reproduction: an agent's `last_error` still carries an
      // OLD declared-patience phrase (from some earlier, already-resolved injury this test does
      // not need to replay) while the marker itself is correctly unset (no honest-fail turn is
      // pending). A later, wholly unrelated context-overflow recovery must proceed normally.
      mockDb.current!.prepare("UPDATE agents SET last_error = ? WHERE id = 'primary'").run(
        'model first-chunk timeout: no data from provider for too long (elapsed 40000ms)',
      );
      expect(declaredPatienceHonestFailTurn.has('primary')).toBe(false);

      isContextOverflowErrorMock.mockImplementation(() => true);
      callModelSpy.mockRejectedValue(new Error('400 prompt is too long: 250000 tokens > 200000 maximum'));
      await runV2Turn('primary');

      expect(checkAndCompactSpy).toHaveBeenCalled();
      expect(pendingWakeups.has('primary')).toBe(true);
      expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    });
  });

  describe('T82d (ANSWER-ANYWAY) — OWNER RULING R3: "Silence is never an acceptable failure mode."', () => {
    // The incident this task closes: the owner asked a question, the turn died at declared
    // patience, and he got NOTHING in his own chat — the honest read of what happened went to
    // internal logs and the Healer, never to him. These tests drive the REAL cascade against
    // this file's DEFAULT fixture, which `setupTestDb` already seeds as a genuine human
    // conversation (an unanswered dashboard/owner message) — exactly the shape
    // `isUserFacingTurn` is true for, the same shape every T81b/T82b/T81c test above already
    // runs on.
    const midFlightTimeout = (): AgentError => new AgentError(
      'model first-chunk timeout: no data from provider for too long (elapsed 600000ms); '
      + '~60000 estimated prompt tokens against a declared 600000ms first-chunk patience',
      'primary',
      { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false },
    );

    // `headsUpMessages()` is file-scoped (see its own definition, near `getBroadcastEventsByType`)
    // so the pre-existing T81c "unrelated injury" control above can pin against it too.

    it('CASE 1: the first live patience death posts exactly one plain-voice status line to the channel', async () => {
      callModelSpy.mockRejectedValue(midFlightTimeout());

      await runV2Turn('primary'); // turn N: dies at patience, T82b compacts + self-wakes

      const statusLines = headsUpMessages();
      expect(statusLines).toHaveLength(1);
      expect(statusLines[0]).toMatch(/hit its model's size limit/i);
      expect(statusLines[0]).toMatch(/trimming its context/i);
      expect(statusLines[0]).toMatch(/retrying/i);
    });

    it('CASE 2: once the retry succeeds, the answer is the next thing in the channel — no failure text, no apology spam', async () => {
      // Same causal-proof shape T82b's own "lands an answer" test uses: the model only ever
      // serves small, so the retry succeeding actually proves the redial was smaller, not
      // merely re-mocked.
      assembleContextMock.mockImplementation(async () => (
        checkAndCompactSpy.mock.calls.length > 0
          ? { systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'compacted, small' }] }
          : { systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'the original big ask' }] }
      ));
      callModelSpy.mockImplementation(async (args: unknown) => {
        const { messages } = args as { messages: Array<{ content: unknown }> };
        if (messages.some((m) => m.content === 'the original big ask')) throw midFlightTimeout();
        return { content: 'Here is your answer.', toolCalls: [], inputTokens: 10, outputTokens: 3, stopReason: 'end_turn' };
      });

      await runV2Turn('primary'); // turn N: dies, compacts, self-wakes
      expect(headsUpMessages()).toHaveLength(1); // the one status line from CASE 1

      await runV2Turn('primary'); // turn N+1: the retry, on the smaller assembly, succeeds

      expect(headsUpMessages()).toHaveLength(1); // the retry's success added NOTHING new
      const messages = mockDb.current!
        .prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1")
        .all() as Array<{ content: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Here is your answer.'); // the answer, not a failure note
    });

    it('CASE 3 + DEDUPE PIN: ladder exhaustion replaces silence with exactly one honest failure line naming the ask and the cause — never a second status line', async () => {
      callModelSpy.mockRejectedValue(midFlightTimeout());
      await runV2Turn('primary'); // turn N: first death — status line, compact, self-wake
      expect(headsUpMessages()).toHaveLength(1);

      callModelSpy.mockRejectedValue(midFlightTimeout());
      backoffPasses();
      await runV2Turn('primary'); // turn N+1: the retry ALSO dies at patience — ladder exhaustion

      const allHeadsUp = headsUpMessages();
      // Exactly ONE status line (turn N) plus ONE failure line (turn N+1) — never a third, and
      // never a second status line for the same chain (the dedupe pin: the compact path runs
      // once per chain by the T82b spent marker, and the status line is keyed off that SAME
      // discipline, not a new one).
      expect(allHeadsUp).toHaveLength(2);
      const failureLine = allHeadsUp[1];
      expect(failureLine).toMatch(/couldn't finish answering/i);
      expect(failureLine).toContain('hello primary'); // names the triggering ask, briefly
      expect(failureLine).toMatch(/couldn't process this much context/i); // the plain cause
      expect(failureLine).toMatch(/healer/i); // what happens next
      expect(onAgentInjuredSpy).toHaveBeenCalled(); // internal reporting is unchanged
    });

    it('WORDING: neither the status line nor the failure line leaks engine jargon or the raw error code', async () => {
      callModelSpy.mockRejectedValue(midFlightTimeout());
      await runV2Turn('primary');
      callModelSpy.mockRejectedValue(midFlightTimeout());
      backoffPasses();
      await runV2Turn('primary');

      const allHeadsUp = headsUpMessages();
      expect(allHeadsUp.length).toBe(2);
      for (const line of allHeadsUp) {
        const lower = line.toLowerCase();
        expect(lower).not.toContain('declared_patience_exceeded');
        expect(lower).not.toContain('patience');
        expect(lower).not.toContain('doom');
      }
    });

    it('WORDING (FIX ROUND 1, CRITICAL 1): a routed-channel ask\'s inbound marker never leaks into either Heads-up line', async () => {
      // The reviewer's live reproduction: a routed-channel (iMessage/SMS/Teams/email) trigger's
      // `lastUserMessageContent` carries its own engine-stamped `[SOURCE: IMESSAGE FROM ...]`
      // marker RAW — the human who sent it never wrote that tag and never sees it (the dashboard
      // strips it before rendering their own bubble; `parseInboundChannel` /
      // `stripInboundChannelMarker`, `packages/shared/src/visibility.ts`). Overwrites the
      // seeded trigger's TEXT only (same row, same ticket, same conv_key) so this exercises the
      // REAL wiring from `state.lastUserMessageContent` through `recordInjury` to the
      // honest-fail line, not just `declaredPatienceHonestFailNote` in isolation (that pure-
      // function pin lives in `memory/__tests__/platform-noise.test.ts`).
      mockDb.current!.prepare("UPDATE messages SET content = ? WHERE id = 'msg-user-1'").run(
        '[SOURCE: IMESSAGE FROM John Smith] How did the presentation go?',
      );

      callModelSpy.mockRejectedValue(midFlightTimeout());
      await runV2Turn('primary'); // turn N: first death — status line (no ask quoted, unaffected)
      callModelSpy.mockRejectedValue(midFlightTimeout());
      backoffPasses();
      await runV2Turn('primary'); // turn N+1: ladder exhaustion — the honest-fail line quotes the ask

      const allHeadsUpWithMarker = headsUpMessages();
      expect(allHeadsUpWithMarker.length).toBe(2);
      for (const line of allHeadsUpWithMarker) {
        expect(line).not.toContain('[SOURCE:');
        expect(line).not.toContain('IMESSAGE FROM');
        expect(line).not.toContain('John Smith');
      }
      // The actual ask still reaches the owner — just marker-free, exactly like the bubble the
      // dashboard already renders for this same message.
      expect(allHeadsUpWithMarker[1]).toContain('How did the presentation go?');
    });

    it('CASE 4 (control-pinned): an engine/A2A/scheduled turn gets ZERO channel lines on the identical error — internal reporting is unchanged', async () => {
      // No existing fixture in this file builds a genuine "no waiting human" turn (would need
      // the seeded ask closed AND a pending engine event or A2A wake in its place) — so this
      // drives `recoverFromError` directly with `isUserFacingTurn: false`, the exact value
      // `steps/teardown/index.ts` computes for an engine/A2A/scheduled turn from the SAME
      // established predicate `finalize-record.ts` already uses. Everything else (the real DB,
      // the real cascade, every other mock) is identical to every other test in this file.
      const buildState = (turnNumber: number) => initState({
        agentId: 'primary',
        contextWindow: 200000,
        isAutoRouted: false,
        configuredModelId: 'test-model',
        turnNumber,
        triggeredByIMessage: false,
        triggeredByA2AReplyIntent: null,
        lastUserMessageContent: 'hello primary',
        lastUserMessageId: 'msg-user-1',
        inboundChannel: null,
        inboundContext: null,
      });

      // First occurrence: T82b's compact-once path is turn-kind-agnostic (any doomed request
      // earns its one compaction), so it still engages — but nothing reaches the channel.
      await recoverFromError(buildState(41), midFlightTimeout(), { isUserFacingTurn: false });
      expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);
      expect(headsUpMessages()).toHaveLength(0);

      // Second occurrence, the immediate next turn in the same chain (the marker is now spent)
      // — ladder exhaustion, recordInjury's honest-fail path. STILL zero channel lines; internal
      // reporting (onAgentInjured) is unchanged from today.
      await recoverFromError(buildState(42), midFlightTimeout(), { isUserFacingTurn: false });
      expect(onAgentInjuredSpy).toHaveBeenCalledWith(
        'primary',
        expect.stringContaining('model first-chunk timeout'),
        DECLARED_PATIENCE_EXCEEDED_CODE,
      );
      expect(headsUpMessages()).toHaveLength(0);
    });
  });

  it('PHASE 6 (v2.3.19): auth_invalid 401 → Tier D lock with plain-English banner + system note', async () => {
    // A 401 from the provider is a true platform condition, the user
    // needs to update their API key. Recovery should:
    //   - persist a [System (platform error): …] note for the agent
    //   - set status='error' (Tier D)
    //   - broadcast a chat:error with code='AUTH_INVALID', plain-English
    //     message (no JSON, no provider field dump)
    //   - schedule the Healer
    callModelSpy.mockRejectedValue(new Error('401 Unauthorized: invalid_api_key'));

    await runV2Turn('primary');

    // Healer was scheduled (Tier D does fire Healer, cross-provider,
    // potentially useful for diagnosis even if not auto-fix).
    expect(onAgentInjuredSpy).toHaveBeenCalled();

    // chat:error broadcast with AUTH_INVALID code; message is plain English.
    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string; error?: string }>);
    const authErr = errors.find((e) => e.code === 'AUTH_INVALID');
    expect(authErr).toBeDefined();
    expect(authErr!.error).toMatch(/API key|Settings/i);
    // Hard rule: no JSON or technical detail in user-facing strings.
    expect(authErr!.error).not.toMatch(/[{}]/);
    expect(authErr!.error).not.toMatch(/401|invalid_api_key/);

    // System note persisted for the agent so when it eventually wakes,
    // it has context to apologize to the user.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/platform error|API key/i);
    expect(sysMsgs[0].content).not.toMatch(/[{}]/);
  });

  it('PHASE 6 (v2.3.19): access_denied 403 → Tier D lock with ACCESS_DENIED code', async () => {
    callModelSpy.mockRejectedValue(new Error('403 Forbidden: model access denied'));

    await runV2Turn('primary');

    expect(onAgentInjuredSpy).toHaveBeenCalled();
    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string; error?: string }>);
    const denied = errors.find((e) => e.code === 'ACCESS_DENIED');
    expect(denied).toBeDefined();
    expect(denied!.error).toMatch(/access|Settings/i);
    expect(denied!.error).not.toMatch(/403|Forbidden/);
  });

  it('PHASE 6 (v2.3.19): generic injury still persists a system note (no silent failures)', async () => {
    // Pre-v2.3.19 only rate-limit errors got a chat-visible system note.
    // Now EVERY injury path persists a note so the agent has context on
    // its next session.
    callModelSpy.mockRejectedValue(new Error('500 Internal Server Error: something weird'));

    await runV2Turn('primary');

    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    // The unclassified-error note tells the agent to apologize and end cleanly.
    expect(sysMsgs[0].content).toMatch(/unexpected error|Apologize|Healer/i);
    // No JSON or stack-trace material in the agent-facing note either.
    expect(sysMsgs[0].content).not.toMatch(/[{}]/);
  });

  it('PHASE 6: generic non-recoverable error → injury (recordError + healer + chat:error)', async () => {
    callModelSpy.mockRejectedValue(new Error('500 Internal Server Error'));

    await runV2Turn('primary');

    expect(recordErrorMock).toHaveBeenCalledWith('primary');
    expect(onAgentInjuredSpy).toHaveBeenCalled();

    // Last error persisted on the agent row.
    const agent = mockDb.current!
      .prepare("SELECT last_error FROM agents WHERE id = 'primary'")
      .get() as { last_error: string | null };
    expect(agent.last_error).toContain('500');

    // chat:error broadcast with MODEL_FAILED (not RATE_LIMITED).
    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>);
    expect(errors.find((e) => e.code === 'MODEL_FAILED')).toBeDefined();
  });

  it('PHASE 6: a rate-limit 429 waits for the reset: no injury, no rate-limit note, the ask waits on its own record', async () => {
    callModelSpy.mockRejectedValue(new Error('429 Rate limit exceeded'));

    await runV2Turn('primary');

    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>);
    expect(errors.find((e) => e.code === 'RATE_LIMITED')).toBeUndefined();
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'")
      .all() as Array<{ content: string }>;
    expect(sysMsgs.find((m) => /rate limit/i.test(m.content))).toBeUndefined();
    const ask = mockDb.current!.prepare("SELECT state, next_attempt_at AS due FROM work WHERE kind = 'ask' AND agent_id = 'primary'").get() as { state: string; due: number };
    expect(ask.state).toBe('open');
    expect(ask.due).toBeGreaterThanOrEqual(Date.now() + 59_000);
  });

  it('PHASE 6: error-loop trip → status paused, ERROR_LOOP code', async () => {
    // Mock recordError to return true (loop threshold tripped).
    recordErrorMock.mockReturnValue(true);
    callModelSpy.mockRejectedValue(new Error('500 transient'));

    await runV2Turn('primary');

    // chat:error has ERROR_LOOP code.
    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string; error?: string }>);
    const looped = errors.find((e) => e.code === 'ERROR_LOOP');
    expect(looped).toBeDefined();
    expect(looped?.error).toMatch(/paused/i);

    // recordInjury did NOT call setAgentStatus('error') because recordError
    // returned true (errors.ts owns the paused status). We can't easily
    // assert "didn't call setAgentStatus" without exposing it as a spy,
    // but the chat:error code being ERROR_LOOP is the proxy signal.
  });

  it('PHASE 6: clean turn end clears recovery streak', async () => {
    // Pre-load the streak. After a clean text-only turn, the loop's
    // post-completion path should call recoveryRunStreak.delete(agentId).
    recoveryRunStreak.set('primary', { kind: 'vision_mismatch', count: 2 });
    callModelSpy.mockResolvedValue({
      content: 'all done',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(recoveryRunStreak.has('primary')).toBe(false);
  });

  // ── Round-3 audit gap closures (2026-05-04) ──

  it('PHASE 6 audit-gap: Dreamer success path → batch-resize, no compaction, no injury', async () => {
    // Insert a Dreamer agent into the test DB so runV2Turn finds it.
    mockDb.current!
      .prepare(
        `INSERT INTO agents (id, name, model_id, status, config, classification)
         VALUES ('dreamer', 'Dreamer', 'test-model', 'idle', '{}', 'dreamer')`,
      )
      .run();
    mockDb.current!
      .prepare(
        `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
         VALUES ('msg-dreamer-1', 'dreamer', 'user', 'process batch', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000))`,
      )
      .run();

    isContextOverflowErrorMock.mockImplementation(() => true);
    // Dreamer-specific recovery returns true → recovered without compaction.
    recoverDreamerFromContextOverflowSpy.mockImplementation(async () => true);
    callModelSpy.mockRejectedValue(
      new Error('400 prompt is too long: 250000 tokens > 200000 maximum'),
    );

    await runV2Turn('dreamer');

    // Dreamer batch-resize was attempted.
    expect(recoverDreamerFromContextOverflowSpy).toHaveBeenCalledWith(
      'dreamer',
      expect.stringContaining('prompt is too long'),
    );
    // Compaction was NOT used (the Dreamer path returns early on success).
    expect(checkAndCompactSpy).not.toHaveBeenCalled();
    // No injury fired.
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
  });

  it('PHASE 6 audit-gap: unsupported_modality 400 → system note + wakeup, no injury', async () => {
    callModelSpy.mockRejectedValue(
      new Error('400 modality not supported: audio input rejected'),
    );

    await runV2Turn('primary');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('primary')).toBe(true);
    expect(recoveryRunStreak.get('primary')?.kind).toBe('unsupported_modality');
  });

  it('PHASE 6 audit-gap: malformed_request 400 → system note + wakeup, no injury', async () => {
    callModelSpy.mockRejectedValue(
      new Error('400 invalid_request_error: malformed parameter foo'),
    );

    await runV2Turn('primary');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('primary')).toBe(true);
    expect(recoveryRunStreak.get('primary')?.kind).toBe('malformed_request');
  });

  it('PHASE 6 audit-gap: unsupported_input 404 → system note + wakeup, no injury', async () => {
    callModelSpy.mockRejectedValue(
      new Error('404 No endpoints found that support audio input for this model'),
    );

    await runV2Turn('primary');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('primary')).toBe(true);
    expect(recoveryRunStreak.get('primary')?.kind).toBe('unsupported_input');
  });

  it('PHASE 6 audit-gap: output_truncation thrown as error → system note + wakeup, no injury', async () => {
    // Provider raises (rather than signaling via stopReason='max_tokens').
    // tryOutputTruncationRecovery should detect and recover before injury.
    callModelSpy.mockRejectedValue(
      new Error('max_output_tokens exceeded: response was 9000 tokens, limit 8192'),
    );

    await runV2Turn('primary');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('primary')).toBe(true);

    // System note explains output budget exhaustion.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/output token limit/i);
  });

  it('PHASE 6 audit-gap: auto-router fallback → tries next model, no injury', async () => {
    // Switch the primary agent to auto-routed.
    mockDb.current!.prepare("UPDATE agents SET model_id = 'auto' WHERE id = 'primary'").run();
    // Seed two models in the test DB so selector has something to return.
    mockDb.current!
      .prepare(
        `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
         VALUES ('primary-model', 'test-provider', 'Primary', 'p1', '["tools"]', 200000, 1)`,
      )
      .run();
    mockDb.current!
      .prepare(
        `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
         VALUES ('fallback-model', 'test-provider', 'Fallback', 'f1', '["tools"]', 200000, 1)`,
      )
      .run();

    // First selectModel call (initial pick) returns primary; second (fallback) returns fallback.
    selectModelMock
      .mockReturnValueOnce({ modelId: 'primary-model', tier: 'standard', fallbackUsed: false })
      .mockReturnValueOnce({ modelId: 'fallback-model', tier: 'standard', fallbackUsed: true });

    // First model call throws non-recoverable error; second succeeds.
    callModelSpy
      .mockRejectedValueOnce(new Error('500 primary model died'))
      .mockResolvedValueOnce({
        content: 'recovered via fallback',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'end_turn',
      });

    await runV2Turn('primary');

    // Both selectModel calls fired (initial + fallback).
    expect(selectModelMock).toHaveBeenCalledTimes(2);
    // Second call passed the failed model in excludedModels.
    expect(selectModelMock.mock.calls[1][2]).toEqual(['primary-model']);
    // Both model calls fired.
    expect(callModelSpy).toHaveBeenCalledTimes(2);
    // No injury, fallback succeeded.
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
  });
  // ── P3 once-per-response guard (lanes & lineage, 2026-07-21) ──
  it('P3 once-guard: identical non-idempotent duplicate in ONE response executes once, second gets the structured refusal', async () => {
    const send = (id: string): ToolCall => ({
      id,
      name: 'imessage_send',
      arguments: { recipient: 'contact-a', message: 'the exact same text' },
    });
    callModelSpy
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [send('tc1'), send('tc2')],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      })
      .mockResolvedValue({
        content: 'done',
        toolCalls: [],
        inputTokens: 50,
        outputTokens: 5,
        stopReason: 'end_turn',
      });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1',
      name: 'imessage_send',
      content: 'sent',
      isError: false,
    });

    await runV2Turn('primary');

    // The side effect ran exactly once; the duplicate never reached the executor.
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    const db = mockDb.current!;
    const refusal = db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE role = 'tool' AND content LIKE '%Already executed in this response%'",
    ).get() as { n: number };
    expect(refusal.n).toBeGreaterThanOrEqual(1);
  });

  it('P3 once-guard: two DIFFERENT non-idempotent calls in one response both execute', async () => {
    const mk = (id: string, msg: string): ToolCall => ({
      id,
      name: 'imessage_send',
      arguments: { recipient: 'contact-a', message: msg },
    });
    callModelSpy
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [mk('tc1', 'first message'), mk('tc2', 'second, different message')],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      })
      .mockResolvedValue({
        content: 'done',
        toolCalls: [],
        inputTokens: 50,
        outputTokens: 5,
        stopReason: 'end_turn',
      });
    executeToolSpy.mockImplementation(async (_aid: string, tc: ToolCall) => ({
      toolCallId: tc.id,
      name: tc.name,
      content: 'sent',
      isError: false,
    }));

    await runV2Turn('primary');
    expect(executeToolSpy).toHaveBeenCalledTimes(2);
  });
  // ── P4 turn record (lanes & lineage, 2026-07-21) ──
  it('P4 turn record: a served human turn writes a finalized turns row with outcome=answered and stamps the ask', async () => {
    callModelSpy.mockResolvedValue({
      content: 'Here is your answer.',
      toolCalls: [],
      inputTokens: 50,
      outputTokens: 8,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    const db = mockDb.current!;
    const turn = db.prepare(
      "SELECT kind, subject_kind, exit_reason, answered, answer_message_id, ended_at FROM turns WHERE agent_id = 'primary' ORDER BY turn_number DESC LIMIT 1",
    ).get() as { kind: string; subject_kind: string; exit_reason: string; answered: number; answer_message_id: string | null; ended_at: string | null };
    expect(turn).toBeTruthy();
    expect(turn.kind).toBe('user');
    expect(turn.subject_kind).toBe('conv');
    // PHASE-2 T2: two facts, asserted separately — why it ended, and whether we answered.
    expect(turn.exit_reason).toBe('answered');
    expect(turn.answered).toBe(1);
    expect(turn.answer_message_id).toBeTruthy();
    expect(turn.ended_at).toBeTruthy();

    // Per-ask forward links: the trigger row knows its turn and its answer.
    const ask = db.prepare(
      "SELECT served_by_turn, answer_message_id FROM messages WHERE role = 'user' ORDER BY rowid DESC LIMIT 1",
    ).get() as { served_by_turn: number | null; answer_message_id: string | null };
    expect(ask.served_by_turn).not.toBeNull();
    expect(ask.answer_message_id).toBe(turn.answer_message_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE-1 T1 (2026-07-27): engine steers must actually REACH the model.
//
// Every engine steer written after a tool call was structurally undeliverable
// from 2026-07-10 until this fix. The drain at loop.ts:3518 injected
// the steer only when the assembled tail was role='assistant' — and
// memory/assembler.ts:301 APPENDS a user-role engine line whenever the tail is an
// assistant message, precisely so a trailing assistant turn is never handed to a
// provider. So the tail the drain inspected structurally never was 'assistant':
// it is either that appended user line or a tool-result carrier. The steer was
// written, logged as sent, and the model never saw it (research 22; the kit's
// check-steer-delivery.mjs reproduced it on five independent floor-model drives).
//
// These tests drive the real loop with a tool-result-carrier tail — the exact
// shape a mid-turn steer lands behind — and assert on what `callModel` actually
// received.
// ═══════════════════════════════════════════════════════════════════════════════

const EMPTY_RESPONSE_NUDGE =
  "[System: You returned an empty response. Please respond to TestUser's last message or call a tool to continue your task. If you are finished, say so clearly.]";

/** The assembled shape a mid-turn steer has to survive: … assistant tool_use, tool-result carrier. */
function toolResultTail(): Array<Record<string, unknown>> {
  return [
    { role: 'user', content: 'read the file and tell me what it says' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'file_read', input: { path: '/tmp/x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file body' }] },
  ];
}

describe('T1: engine steer delivery (the steer-queue drain)', () => {
  /** Deep snapshots of every messages array handed to callModel, in call order. */
  let seenByModel: Array<Array<Record<string, unknown>>>;

  function recordingModel(
    impl: (n: number) => Record<string, unknown>,
  ): (args: { messages: unknown }) => Promise<Record<string, unknown>> {
    let n = 0;
    return async (args: { messages: unknown }) => {
      n++;
      // Snapshot: the loop keeps a live reference to this array and mutates it.
      seenByModel.push(JSON.parse(JSON.stringify(args.messages)));
      return impl(n);
    };
  }

  const EMPTY = { content: '', toolCalls: [], inputTokens: 100, outputTokens: 0, stopReason: 'end_turn' };
  const DONE = { content: 'Done.', toolCalls: [], inputTokens: 50, outputTokens: 5, stopReason: 'end_turn' };

  function indexOfEntry(msgs: Array<Record<string, unknown>>, content: string): number {
    return msgs.findIndex((m) => m.content === content);
  }

  beforeEach(() => {
    seenByModel = [];
    assembleContextMock.mockImplementation(async () => ({
      systemPrompt: '<system prompt>',
      messages: toolResultTail(),
    }));
  });

  it('delivers a steer set mid-turn to the NEXT model call even though the assembled tail is a tool-result carrier', async () => {
    // Drive the empty-response recovery chain, which is a real in-loop steer
    // writer: call 1 empty → silent retry; call 2 empty → enqueues the steer;
    // call 3 must CARRY that steer. Before the fix call 3 is byte-for-byte the
    // same array as calls 1 and 2 — the exact "logged as sent, never received"
    // signature the kit instrument measured live.
    callModelSpy.mockImplementation(recordingModel((n) => (n <= 2 ? EMPTY : DONE)));

    await runV2Turn('primary');

    expect(seenByModel.length).toBeGreaterThanOrEqual(3);
    const third = seenByModel[2];
    expect(indexOfEntry(third, EMPTY_RESPONSE_NUDGE)).toBeGreaterThanOrEqual(0);
  });

  it('appends the steer as its OWN user-role message, never folded into another message', async () => {
    callModelSpy.mockImplementation(recordingModel((n) => (n <= 2 ? EMPTY : DONE)));

    await runV2Turn('primary');

    const third = seenByModel[2];
    const at = indexOfEntry(third, EMPTY_RESPONSE_NUDGE);
    expect(at).toBeGreaterThanOrEqual(0);
    // Its own message: exact string content, user role — not appended onto the
    // tool-result carrier's block array, and not merged into a neighbour.
    expect(third[at].role).toBe('user');
    expect(typeof third[at].content).toBe('string');
    expect(third[at].content).toBe(EMPTY_RESPONSE_NUDGE);
  });

  it('keeps alternation legal: the steer lands AFTER the tool results, never between tool_use and tool_result', async () => {
    callModelSpy.mockImplementation(recordingModel((n) => (n <= 2 ? EMPTY : DONE)));

    await runV2Turn('primary');

    const third = seenByModel[2];
    const useAt = third.findIndex(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === 'tool_use'),
    );
    const resultAt = third.findIndex(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result'),
    );
    const steerAt = indexOfEntry(third, EMPTY_RESPONSE_NUDGE);
    expect(useAt).toBeGreaterThanOrEqual(0);
    // The result carrier still IMMEDIATELY follows its tool_use (the conversation
    // invariant at loop.ts:6415 — nothing may be inserted between the pair).
    expect(resultAt).toBe(useAt + 1);
    // And the steer rides behind them, as a fresh user turn.
    expect(steerAt).toBeGreaterThan(resultAt);
  });

  it('marks the entry delivered on a confirmed drain: the steer rides exactly ONE model call, never repeats', async () => {
    // Call 3 carries the steer and then calls a tool, so the loop assembles a
    // FOURTH time. A steer that is delivered but never cleared would ride call 4
    // as well (the engine repeating itself at the model); a steer cleared without
    // being delivered would ride none.
    const toolCall: ToolCall = { id: 'tc1', name: 'file_read', arguments: { path: '/x' } };
    callModelSpy.mockImplementation(
      recordingModel((n) => {
        if (n <= 2) return EMPTY;
        if (n === 3) return { content: 'reading', toolCalls: [toolCall], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
        return DONE;
      }),
    );
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc1', name: 'file_read', content: 'file body', isError: false });

    await runV2Turn('primary');

    expect(seenByModel.length).toBeGreaterThanOrEqual(4);
    // t210 (decision 37): a later call of a turn APPENDS to what the previous call sent, so call 4
    // still SHOWS call 3's steer where it was. "Never repeats" means never SENT AGAIN: the steer is
    // new in exactly one call (call 3), and every later array holds that one copy at the same index.
    const firstAt = seenByModel.findIndex((msgs) => indexOfEntry(msgs, EMPTY_RESPONSE_NUDGE) >= 0);
    expect(firstAt).toBe(2);
    const at = indexOfEntry(seenByModel[2], EMPTY_RESPONSE_NUDGE);
    for (const later of seenByModel.slice(3)) {
      expect(later.filter((m) => m.content === EMPTY_RESPONSE_NUDGE), 'one copy, never re-sent').toHaveLength(1);
      expect(indexOfEntry(later, EMPTY_RESPONSE_NUDGE), 'where it was').toBe(at);
    }
  });

  // ── STRIP (PHASE-3 T7 Step 2, 2026-08-01) — two clauses die with the SETTLED_HINT. ──
  // They were "the hint fires on the first iteration and only the first" and "the hint is
  // NEVER folded into a tool-result carrier". Both named `[Engine hint: respond only to the
  // newest incoming item` literally, and that string no longer exists in the tree: the hint
  // is deleted (scar-tissue ledger — "STRIP. Requirement: a turn acts only on its root;
  // assembly scopes by id, so there is nothing to warn about"). Kept, they would fail on a
  // correct build.
  //
  // requirement preserved, both halves, and the second is the one worth naming:
  //   * the hint's own requirement — see the STRIP note in `loop.ts`: structurally by
  //     `scopeToHumanConversation`, deterministically by the now-WIRED and green
  //     `checks/check-reanswer-ghost.mjs`, behaviourally by `settled-work-stays-settled`.
  //   * THE CARRIER-PURITY LAW — an injection must never push a text block into a tail that
  //     is a pure `tool_result` carrier, because `model.ts sanitizeOrphanToolBlocks` then
  //     treats the paired `tool_use` as orphaned, strips it, and deletes the assistant
  //     message ("agent repeats itself", model.ts:215-223). The hint was the only FOLDER in
  //     the tree (`grep` for the fold expression at this HEAD: one hit, now zero), so the
  //     law's live subject is the steer drain — and the three clauses immediately
  //     above this note hold it there: "appends the steer as its OWN user-role message,
  //     never folded into another message", "keeps alternation legal", and "delivers a steer
  //     mid-turn even though the assembled tail is a tool-result carrier". The law is
  //     therefore pinned on the mechanism that can still break it, not on one that is gone.
});

// ════════════════════════════════════════════════════════════════════════════════════════
// HL3 — MODEL-VISIBLE MEANS LOGGED. The RUNTIME half of the invariant.
//
// dsh's rule, verbatim from their architecture doc: *"Anything that reaches a model request
// must be reconstructable from the log, and a runtime invariant asserts it."* The source
// half lives in `model-visible-means-logged.test.ts` (it catches the next injection before
// it ships); this is the assertion itself, made against a real driven turn.
//
// The vehicle is the empty-response ladder, chosen because it was one of the eight ROW-LESS
// floors the HL3 census found (`task-W26-report.md` section 1A, row 18): call 1 empty ->
// silent retry, call 2 empty -> the steer is enqueued, call 3 CARRIES it. Before the fix
// that steer reached the model and left no trace anywhere in the database — these clauses
// were RED on exactly that, which is the recorded red for HL3.
//
// SCOPE, and it is the plan's own bound: the assertion covers the NON-PREFIX region. Below
// `volatileFrom` sits the assembler's own output, which is a projection of `messages` rows
// by construction (and is mocked here anyway); at and above it sit the loop's injections,
// which are what HL3 is about.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('HL3: model-visible means logged (the runtime invariant, driven)', () => {
  let seenByModel: Array<Array<Record<string, unknown>>>;

  const EMPTY = { content: '', toolCalls: [], inputTokens: 100, outputTokens: 0, stopReason: 'end_turn' };
  const DONE = { content: 'Done.', toolCalls: [], inputTokens: 50, outputTokens: 5, stopReason: 'end_turn' };

  /** The prefix this turn's assembly produced — everything after it is a loop injection. */
  function prefix(): Array<Record<string, unknown>> {
    return toolResultTail();
  }

  beforeEach(() => {
    seenByModel = [];
    assembleContextMock.mockImplementation(async () => ({
      systemPrompt: '<system prompt>',
      messages: prefix(),
    }));
    callModelSpy.mockImplementation(async (args: { messages: unknown }) => {
      seenByModel.push(JSON.parse(JSON.stringify(args.messages)));
      return seenByModel.length <= 2 ? EMPTY : DONE;
    });
  });

  /** Every durable row this agent holds — the "log" the invariant reads. */
  function durableRows(): Array<{ content: string; role: string; turn_number: number | null }> {
    return mockDb.current!
      .prepare('SELECT content, role, turn_number FROM messages WHERE agent_id = ?')
      .all('primary') as Array<{ content: string; role: string; turn_number: number | null }>;
  }

  it('the steer that reached the model is recoverable from a durable row, with its turn number', async () => {
    await runV2Turn('primary');

    // It reached the model: the third call carries it (T1's property, restated here because
    // this clause is meaningless if the steer never actually shipped).
    expect(seenByModel.length).toBeGreaterThanOrEqual(3);
    const carried = seenByModel[2].some((m) => m.content === EMPTY_RESPONSE_NUDGE);
    expect(carried, 'the steer never reached the model — this clause would be vacuous').toBe(true);

    // …and it is IN THE LOG. Byte-identical: a row that paraphrases what the model saw is
    // not a reconstruction of it.
    const rows = durableRows().filter((r) => r.content === EMPTY_RESPONSE_NUDGE);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].turn_number).not.toBeNull();
  });

  it('every non-prefix message the model was handed is derivable from a durable row or a declared lane', async () => {
    await runV2Turn('primary');

    const prefixLen = prefix().length;
    const logged = new Set(durableRows().map((r) => r.content));

    // The lanes that are RENDERINGS of durable state rather than engine-composed directives.
    // Each is a census row (`task-W26-report.md` section 1B) with its source named there; a
    // message matching none of them and holding no row is precisely the failure this clause
    // exists for. They are matched on their opening bytes, which their renderers fix.
    const DERIVED_LANE_OPENERS = [
      '[Turn context]',                         // msg.turn-context
      '[Current time:',                         // msg.current-time
      'RECENT OUTBOUND (engine-verified):',     // engine.recent-outbound
      'RECENTLY ANSWERED in this conversation', // engine.recently-answered
      'OPEN WORK',                              // engine.open-work
      '═══ YOUR DOJO BUG REPORTS',               // engine.report-state — derived from dojo_reports
      'Peers:',                                 // msg.peer-status
      '## Possibly Relevant Techniques',        // msg.technique-weak
      '## Other Techniques That Might Also Apply',
    ];

    const undecidable: string[] = [];
    for (const call of seenByModel) {
      call.slice(prefixLen).forEach((m, i) => {
        // t210 (decision 37): a block re-sent in a turn carries a label line above the SAME lane's
        // render; the census reads what is under the label.
        const raw = m.content;
        const c = typeof raw === 'string' && (raw.startsWith(UPDATE_LABEL) || raw.startsWith(EMPTIED_LABEL)) ? raw.slice(raw.indexOf('\n') + 1) : raw;
        if (typeof c !== 'string') return;           // tool-block carriers ride the prefix
        if (logged.has(c)) return;                   // a durable row holds it verbatim
        if (DERIVED_LANE_OPENERS.some((o) => c.trimStart().startsWith(o))) return;
        undecidable.push(`[+${i}] ${c.slice(0, 120)}`);
      });
    }

    // If this fails: a message reached the model that no row records and no declared lane
    // renders. Either persist it (the fix HL3 asks for) or add it to the census with the
    // durable state it is derived from written down beside it.
    expect(undecidable).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 STRIP-3 — WHICH CONVERSATION IDENTITY THE TURN HANDS ITS CONSUMERS
//
// STRIP-2 enumerated the conv-KEY-passed-as-conversation-ID class tree-wide (13 signatures,
// 21 call sites, 51 SQL bind sites) and found exactly two live members. Both cross a
// function boundary, so no bind-site grep can see them and no type can catch them — both
// values are `string`. These two clauses are the alarm, and both were written RED.
//
//   (a) `loop.ts` handed `recordedAnswerInConversation` a conv KEY ('owner') where its SQL
//       filters `m1.conversation_id = ?` — a UUID column. Measured on the live body: a key
//       matches 0 of 6,975 stamped rows (0 of them non-UUID) where real ids match 954. The
//       call therefore always returned null, `excerpt.length > 0` was always false, and the
//       ghosted-work-ask ladder's SECOND rung — the one that hands the model its own
//       recorded words to restate rather than the engine speaking as the agent (OR2) — has
//       never once fired since the T10I rekey.
//
//   (b) `currentTurnConversationId` was written from the PRE-repair value: the pickup repair
//       (`loop.ts`, "resolved at pickup") reassigns `chosenConversationId` for exactly the
//       trigger rows no producer stamped, and never re-set the map. On such a turn the map
//       said null while the turn genuinely had a conversation, so `scopeToHumanConversation`
//       dropped every conversation-stamped answer the agent had given and the model was
//       shown its own asks with its replies missing. That is dojo 8bc7d7a's re-answer ghost,
//       reachable in production (23.6% of user rows on the dev body carry no conversation).
// ════════════════════════════════════════════════════════════════════════════════════════
describe('STRIP-3: the turn hands down conversation IDENTITY, never a conversation KEY', () => {
  it('(b) a trigger row the producer never stamped still publishes the turn\'s conversation to the assembler', async () => {
    // Take the seeded (already stamped) ask out of the waiting set so the UNSTAMPED row is
    // the trigger. Without this the aggregate's `oldest` is the stamped row and the pickup
    // repair never fires — the test would pass while measuring nothing.
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    insertMessage({
      id: 'msg-unstamped', agentId: 'primary', role: 'user', content: 'did you get my note?',
      turnNumber: 2, channel: 'dashboard', senderId: 'owner', conversationId: null,
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    // POSITIVE CONTROL on the fixture itself: the row really is unstamped going in, so a
    // green below cannot come from a producer having stamped it after all.
    expect(
      (mockDb.current!.prepare('SELECT conversation_id AS c FROM messages WHERE id = ?')
        .get('msg-unstamped') as { c: string | null }).c,
    ).toBeNull();

    // The assembler is mocked in this suite, so the observation point is the map AT ASSEMBLY
    // TIME — the exact expression `memory/assembler.ts` reads. The loop deletes the entry when
    // the agent goes idle, so reading it after the turn would measure nothing.
    const seenAtAssembly: Array<string | null | undefined> = [];
    assembleContextMock.mockImplementation(async () => {
      seenAtAssembly.push(turnContext('primary')?.conversationId);
      return { systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'hello' }] };
    });
    callModelSpy.mockResolvedValue({
      content: 'Yes, got it.', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // The pickup repair ran and stamped the row (the DB half — this half already worked).
    expect(
      (mockDb.current!.prepare('SELECT conversation_id AS c FROM messages WHERE id = ?')
        .get('msg-unstamped') as { c: string | null }).c,
    ).toBe('conv-primary');
    // …and the map the assembler reads carried the SAME identity. This is the half that was
    // broken: null here is the re-answer ghost's own input.
    expect(seenAtAssembly.length).toBeGreaterThan(0);
    expect(seenAtAssembly[0]).toBe('conv-primary');
  });

  it('(a) the ghosted-ask ladder\'s second steer hands the model its own recorded answer', async () => {
    // The recorded answer the second rung is supposed to quote: an answered ask in THIS
    // conversation, written the way the answered edge records one (`answer_message_id`).
    // Raw SQL on purpose — this pair is settled history, not a waiting ask, so it must not
    // open a ticket.
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, turn_number, conversation_id, created_at)
       VALUES ('msg-prior-answer', 'primary', 'assistant', 'The launch is on the 14th; the pricing page is already live.', 1, 'conv-primary', (CAST(strftime('%s','now') AS INTEGER) * 1000) - 60000)`,
    ).run();
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, turn_number, conversation_id, channel, sender_id, answer_message_id, created_at)
       VALUES ('msg-prior-ask', 'primary', 'user', 'when does the launch happen?', 1, 'conv-primary', 'dashboard', 'owner', 'msg-prior-answer', (CAST(strftime('%s','now') AS INTEGER) * 1000) - 61000)`,
    ).run();

    // The trigger: a human ask the decision model judges WORK, not a decline of the earlier reply.
    installDecisionModel(mockDb.current!);
    scriptDecisions((name) => yes(name === 'declined' ? 0.1 : 0.9));
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    insertMessage({
      id: 'msg-work-ask', agentId: 'primary', role: 'user',
      content: 'Draft the launch email and build the pricing page and schedule the announcement.',
      turnNumber: 2, channel: 'dashboard', senderId: 'owner', conversationId: 'conv-primary',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });

    // The model ghosts every time: bare sentinel, no tool calls.
    callModelSpy.mockResolvedValue({
      content: '[no-reply]', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    const messagesOfCall = (i: number): string =>
      JSON.stringify((callModelSpy.mock.calls[i]?.[0] as { messages?: unknown })?.messages ?? []);

    // POSITIVE CONTROL: the ladder was reached and its FIRST rung fired. Without this a
    // green below could mean "the ladder never ran", which is the opposite finding.
    expect(callModelSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(messagesOfCall(1)).toContain('[Engine hint: you ended with [no-reply]');

    // THE CLAUSE: the second rung fires, and it carries the agent's OWN recorded words.
    expect(callModelSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(messagesOfCall(2)).toContain('[Engine record: you again ended with [no-reply]');
    expect(messagesOfCall(2)).toContain('The launch is on the 14th');
    vi.unstubAllGlobals();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T1 — `TurnContext`: the turn owns its facts, and clears them in its
// `finally` rather than as a side effect of the idle status write.
//
// THE DEFECT THESE CLAUSES FAIL ON, AT `8e8106f`. Ten module-level maps held the
// turn's facts; ONE statement deleted all ten; that statement lived inside
// `setAgentStatus(agentId, 'idle')`. The ordinary end-of-turn idle write sits INSIDE
// the main `try`, and the `finally` that finalizes the turn record opens after it —
// so on EVERY turn, not on five edge cases, teardown read facts that had already
// been deleted, and every one of those reads degrades silently through `?.`/`?? null`.
//
// The observable consequences, each its own clause below:
//   * `stampTasksAtTurnFinalize` — THE DECLARED ONE STAMPING POINT — ran with two of
//     its four tie predicates matched against the empty string on every turn
//     (`w.source_message_id = ''`, `w.id = ''`), so a ticket tied to the turn only by
//     the ask it was born from was never stamped.
//   * `terminalDeliveryForTurn` and `turnDeliveredToPerson` ran UNSCOPED where they
//     were written to be scoped to the turn's own conversation, so the receipt behind
//     `result_delivery_id` — and the pause disposition's own gate — could be satisfied
//     by a delivery that went to somebody else.
//
// These clauses observe the ARGUMENT, because that is where the defect is: the queries
// still run, still succeed, and still return a defensible-looking answer.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 T1: the turn owns its facts and clears them in its finally', () => {
  const answerOnce = (text = 'done'): void => {
    callModelSpy.mockResolvedValue({
      content: text, toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });
  };

  it('THE ORDINARY TURN: the one stamping point receives THIS turn\'s root, not null', async () => {
    answerOnce();
    await runV2Turn('primary');

    // POSITIVE CONTROL: teardown reached the stamping point at all. Without this a
    // green below could mean "finalize never ran", which is the opposite finding.
    expect(stampTasksSpy).toHaveBeenCalledTimes(1);
    const input = stampTasksSpy.mock.calls[0][0] as { rootSourceMessageId: string | null; servedTaskId: string | null; convKey: string | null };

    // THE CLAUSE. `rootSourceMessageId` is the ask this turn is serving. It was `null`
    // on every turn the engine has ever run, which made `w.source_message_id = ''` —
    // one of the four ways a ticket ties to its turn — permanently unmatched.
    expect(input.rootSourceMessageId).toBe('msg-user-1');
  });

  it('THE ORDINARY TURN: a ticket tied ONLY by its source message IS stamped', async () => {
    // The end-to-end shape of the clause above, through the real query. This ticket
    // shares no conv_key, no origin_turn and no id with the turn — its only tie is the
    // ask it was born from, which is exactly the tie the null erased.
    const db = mockDb.current!;
    db.prepare(
      `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, source_message_id, opened_at, updated_at)
       VALUES ('w-tied-by-source', 'primary', 'task', 'owner', 'tracker', 'w-tied-by-source', 'claimed',
               'action', 1, 0, 'tied by its ask', 'msg-user-1',
               unixepoch('now')*1000, unixepoch('now')*1000)`,
    ).run();

    answerOnce();
    await runV2Turn('primary');

    // The stamp's durable sink is `work_events` (PHASE-2 T8b moved it off the row's
    // columns), so that is what the clause reads — a test that asserted the legacy
    // columns would go green on a tree where the stamp had been deleted outright.
    const stamped = db.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'activity'`,
    ).all('w-tied-by-source') as Array<{ payload: string }>;
    expect(stamped).toHaveLength(1);
    expect(JSON.parse(stamped[0].payload)).toMatchObject({ turn: 1, outcome: 'answered' });
  });

  it('THE ORDINARY TURN: the terminal-delivery lookup is scoped to the turn\'s own conversation', async () => {
    answerOnce();
    await runV2Turn('primary');

    // POSITIVE CONTROL: the lookup ran from teardown.
    expect(terminalDeliveryForTurnSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // THE CLAUSE: every teardown call names the conversation. `null` here is not a
    // narrower query, it is a WIDER one — `answered-edge.ts` swaps `conversation_id = ?`
    // for `conversation_id IS NOT NULL`, so the receipt behind `result_delivery_id`
    // could be a delivery to a different person on the same turn.
    const conversationArgs = terminalDeliveryForTurnSpy.mock.calls.map((c) => c[2]);
    expect(conversationArgs).toContain('conv-primary');
  });

  it('THE ORDINARY TURN: the pause disposition is told which conversation was served', async () => {
    answerOnce();
    await runV2Turn('primary');

    expect(pauseDriveWorkWaitingOnOwnerSpy).toHaveBeenCalled();
    const opts = pauseDriveWorkWaitingOnOwnerSpy.mock.calls[0][2] as { conversationId?: string | null };
    // THE CLAUSE: the disposition's own gate ("did this turn deliver to the person")
    // and the `evidenceRef` it stamps on the pause both key on this value.
    expect(opts.conversationId).toBe('conv-primary');
  });

  it('A `break` EXIT still reaches teardown with the turn\'s root intact', async () => {
    // The stop-signal break at the top of the loop is one of the five mid-loop `break`
    // exits research 22 named. It calls `setAgentStatus(agentId, 'idle')` and falls
    // through to finalize — so pre-fix it deleted the turn's facts on its way past the
    // very block that reads them, exactly like the ordinary path.
    let callCount = 0;
    callModelSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        stoppedAgents.add('primary');
        return {
          content: '', toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: '/x' } }],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      return { content: 'unreachable', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc1', name: 'file_read', content: 'x', isError: false });

    await runV2Turn('primary');

    expect(callModelSpy).toHaveBeenCalledTimes(1);   // positive control: the break fired
    expect(stampTasksSpy).toHaveBeenCalledTimes(1);  // positive control: teardown ran
    const input = stampTasksSpy.mock.calls[0][0] as { rootSourceMessageId: string | null };
    expect(input.rootSourceMessageId).toBe('msg-user-1');
  });

  it('A `return` EXIT INSIDE THE MAIN `try` RUNS TEARDOWN — and it too must see the root', async () => {
    // ⚠ A CORRECTION TO THIS TASK'S OWN PINNED GROUND. The plan splits the ten idle
    // writes into "5 followed by `break` (reach teardown)" and "4 followed by `return`
    // (never reach teardown)". Two of those four — the stop and preempt returns inside
    // the model call's own catch — sit INSIDE the main `try`, so their `return` runs the
    // `finally`. They belong with the `break` family, not with the exits that need
    // nothing from teardown. Verified with the compiler's own parser, not by eye.
    callModelSpy.mockImplementation(async () => {
      stoppedAgents.add('primary');
      throw new Error('stream aborted');
    });

    await runV2Turn('primary');

    // POSITIVE CONTROL: teardown ran on a path the plan said never reaches it.
    expect(stampTasksSpy).toHaveBeenCalledTimes(1);
    const input = stampTasksSpy.mock.calls[0][0] as { rootSourceMessageId: string | null };
    expect(input.rootSourceMessageId).toBe('msg-user-1');
  });

  it('NO LEAK: a turn that THREW leaves nothing of itself behind', async () => {
    // The mirror defect of the four reads above, and it comes from the same coupling.
    // `setAgentStatus` only clears on `'idle'`, and the recovery cascade sets `'error'`
    // — so a turn that threw left every one of its facts standing for the next turn, or
    // for a PEER, to read. `currentTurnKind` is the one a peer reads by name: an agent
    // whose turn died still answered "yes, mid-conversation with a human" to
    // `send_to_agent`'s busy check, indefinitely.
    callModelSpy.mockImplementation(async () => { throw new Error('provider exploded'); });

    await runV2Turn('primary');

    // POSITIVE CONTROL: the turn really did run far enough to publish its kind.
    expect(callModelSpy).toHaveBeenCalled();
    // THE CLAUSE.
    expect(turnContext('primary')).toBeUndefined();
  });

  it('NO LEAK: a clean turn leaves nothing of itself behind (control for the clause above)', async () => {
    answerOnce();
    await runV2Turn('primary');
    expect(turnContext('primary')).toBeUndefined();
  });

  it('THE SWALLOW BECOMES LOUD: a throwing stamp is recorded, not discarded', async () => {
    // The stamp call was wrapped in `catch { /* stamps are best-effort */ }` — a bare
    // catch with no binding, so a throw from the dynamic import or the call itself left
    // no trace at all. Best-effort is a policy about whether to CONTINUE; it is not a
    // reason to be unable to find out. `stampTasksAtTurnFinalize` already swallows and
    // logs its own internal failures, so this outer catch was the second swallow of one
    // job and the only one that was silent.
    stampTasksSpy.mockImplementationOnce(() => { throw new Error('stamp module exploded'); });
    answerOnce();

    await runV2Turn('primary');

    const warned = loggerWarnSpy.mock.calls.some((c) => String(c[0]).includes('ticket stamps'));
    expect(warned).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// F10 — THE WALL-CLOCK START-ACK TIMER MUST NEVER OUTLIVE ITS TURN.
//
// PHASE-6 T9b, landed BEFORE the teardown span moves (non-negotiable #2: a guard's
// requirement becomes a test before its code is touched). `git grep -l startAckTimer`
// over the whole suite found NOTHING: the clear at the top of the turn's `finally` is
// the only thing standing between a 30-second timer and the turn after it, and no test
// anywhere said so.
//
// WHAT IT PROTECTS. The timer's callback asks `fireStartAckIfOwed` to request a steer
// so the MODEL says "on it" (engine detects, agent speaks — OR2). A timer that survives
// its turn fires against the NEXT turn's state, which is how the double-ack and the
// stray "On it" after an already-sent relay happened; the site's own comment records
// the DB re-check as a race backstop and calls cancelling here "the primary discipline".
//
// WHY IT IS THE TRANCHE'S OWN CLAUSE. This is the ONE mutable driver local the teardown
// span both reads and WRITES (`startAckTimer = null`), so it is the crossing that
// RULING P6-R3(1) migrates to the turn's bag before anything moves. The requirement is
// pinned here first, on the unmoved tree, so the migration and the extraction after it
// are judged against a clause that already passes rather than one written to fit them.
// ════════════════════════════════════════════════════════════════════════════════

describe('F10: the wall-clock start-ack timer never outlives its turn', () => {
  // The threshold the watcher below matches on. Asserted against the engine's own
  // declaration by the provenance clause, so a watcher that has drifted onto the wrong
  // timer fails loudly instead of silently observing nothing.
  const START_ACK_AFTER_MS = 30_000;

  const answerOnce = (text = 'done'): void => {
    callModelSpy.mockResolvedValue({
      content: text, toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });
  };

  interface TimerWatch { armed: unknown[]; cleared: unknown[]; restore: () => void }

  // Watch the GLOBAL timer doors rather than reaching into the loop: the requirement is
  // about a real timer being really cancelled, and a spy on the engine's own helper
  // would pass on a tree where the cancel was deleted.
  function watchStartAckTimer(): TimerWatch {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const armed: unknown[] = [];
    const cleared: unknown[] = [];
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void, ms?: number, ...rest: unknown[]) => {
        const handle = (realSet as (...a: unknown[]) => unknown)(fn, ms, ...rest);
        if (ms === START_ACK_AFTER_MS) armed.push(handle);
        return handle;
      }) as unknown as typeof globalThis.setTimeout,
    );
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(
      ((handle: unknown) => {
        cleared.push(handle);
        (realClear as (...a: unknown[]) => void)(handle);
      }) as unknown as typeof globalThis.clearTimeout,
    );
    return {
      armed,
      cleared,
      restore: () => {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        // Belt and braces: on a tree where the cancel was deleted, do not leave a live
        // 30s timer behind for the rest of the file to trip over.
        for (const h of armed) (realClear as (...a: unknown[]) => void)(h);
      },
    };
  }

  it('a clean turn arms the timer and CANCELS it before it returns', async () => {
    const w = watchStartAckTimer();
    try {
      answerOnce();
      await runV2Turn('primary');
      // POSITIVE CONTROL: the fixture really is a start-ack-armed turn (a human
      // counterparty with a trigger row). Without this the clause below would pass
      // vacuously on any tree where the timer stopped being armed at all.
      expect(w.armed).toHaveLength(1);
      expect(w.cleared).toContain(w.armed[0]);
    } finally {
      w.restore();
    }
  });

  it('a turn that THREW cancels it too — the teardown runs on the error path', async () => {
    // The throw has to land ABOVE the model call's own try/catch to reach the function
    // -level `catch`; `assembleContext` is exactly one of the sites the catch's own
    // comment names. The timer is armed long before assemble, so this is the arm where
    // a missing cancel would leave a live timer on a turn that is already going wrong.
    const w = watchStartAckTimer();
    try {
      assembleContextMock.mockRejectedValueOnce(new Error('assembler exploded'));
      await runV2Turn('primary');
      expect(w.armed).toHaveLength(1);
      expect(w.cleared).toContain(w.armed[0]);
    } finally {
      w.restore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 3 (`preCallGates`) — THE TURN-TIME BUDGET AND ITS MID-TURN RECAP.
//
// WHY THIS LANDS BEFORE ANYTHING MOVES. Non-negotiable #2: a guard's requirement is
// written down as a test before its code is touched. `git grep -l` over the whole
// suite found NO test naming `MAX_TURN_AUTO_CONTINUATIONS`, `TURN_TIME_BUDGET_MS` or
// `compaction-recap` — the entire turn-time-budget branch of `preCallGates`, including
// the recap the PHASE-6 plan names by hand ("mid-turn compaction recap (P47 — the
// seven-apologies defect) asserted"), was untested. These clauses are GREEN on the
// unmoved tree; the tranche moves the code under them.
//
// WHAT THE RECAP WAS FOR, in the incident's own terms (2026-07-23, the owner's .19
// transcript): a MID-TURN rebuild can evict the model's own in-turn speech while the
// trigger message stays pinned, so every rebuilt context reads as "the user just said
// this and I have not responded" and the model re-acknowledges from scratch — seven
// near-identical apologies in one long turn. The recap was the engine handing over the
// receipts it holds: same turn, this many tool calls, and whether the person has
// already been acknowledged.
//
// ⚠ HL4 STEP 2 (2d), 2026-08-15 — THE RECAP IS RETIRED, AND THIS BLOCK IS THE RECORD OF
// WHY. W27's census marked its delivery UNKNOWN and named what would settle it. The
// driven check below settled it: across a real turn over the budget, with every messages
// array the model was handed recorded, the recap's bytes reach NO model request on any
// call. Its carriers were closed by construction — the queue's only drain is the assemble
// step, and the step that files the entry ends the turn before assemble can run again;
// the row it also wrote is role='system', which `tailRender` never emits. The FOUR clauses
// that pinned the recap's own wording are therefore GONE with their subject, and what
// stands in their place are the driven measurement, the RED that keeps an undeliverable
// entry from being filed again, and the two clauses pinning where the requirement went:
// the person's own receipt row (retired, t137), and `sys.compaction-continuity` (deleted, v3.3.3).
//
// The three clauses that were never about the recap — the positive control, the parking
// behaviour and the continuation cap — still guard this branch, the last one inverted by t137
// (OR-LONG-JOBS: no cap, and the park writes no row).
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 3: the turn-time budget auto-continues (compacting only when token math wants it) and hands the turn its own receipts', () => {
  /**
   * Move the engine's clock forward WITHOUT fake timers (the loop's own `setTimeout`
   * paths must keep working). `state.turnStartMs` is captured from `new Date()` during
   * preflight, so a `Date.now` offset applied later reads as "this turn has been
   * running that long".
   */
  function controllableClock(): { jump: (ms: number) => void; restore: () => void } {
    const real = Date.now.bind(Date);
    let offset = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    return { jump: (ms: number) => { offset += ms; }, restore: () => spy.mockRestore() };
  }

  const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;

  /** Recap steer contents, in order. */
  function recaps(): string[] {
    return enqueueSteerSpy.mock.calls
      .map((c) => c[1] as { floor: string; content: string })
      .filter((r) => r.floor === 'compaction-recap')
      .map((r) => r.content);
  }

  /**
   * Run `rounds` tool rounds, cross the turn-time budget between the last round and the
   * next loop head, and let `preCallGates` meet it.
   */
  async function runAcrossTheBudget(
    opts: { batch?: number; extraMs?: number } = {},
  ): Promise<void> {
    const batch = opts.batch ?? 1;
    let call = 0;
    callModelSpy.mockImplementation(async () => {
      call++;
      return call === 1
        ? {
          content: '',
          toolCalls: Array.from({ length: batch }, (_, i) => (
            { id: `tc-${i}`, name: 'file_read', arguments: { path: `/tmp/${i}.txt` } }
          )),
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        }
        : { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    const clock = controllableClock();
    let executed = 0;
    executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => {
      executed++;
      // The budget can only be crossed BETWEEN iterations — the gate is read once per
      // loop head — so the jump rides the LAST tool of the round.
      if (executed === batch) clock.jump(TURN_TIME_BUDGET_MS + 60_000 + (opts.extraMs ?? 0));
      return { toolCallId: toolCall.id, name: toolCall.name, content: 'file body', isError: false };
    });
    try {
      await runV2Turn('primary');
    } finally {
      clock.restore();
    }
  }

  it('POSITIVE CONTROL: a turn that stays inside the budget compacts nothing and recaps nothing', async () => {
    // Without this the clauses below could all pass on a tree where the recap fires
    // unconditionally, which would be a worse defect than not firing at all.
    callModelSpy.mockResolvedValue({
      content: 'OK', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(checkAndCompactSpy).not.toHaveBeenCalled();
    expect(recaps()).toEqual([]);
    expect(pendingWakeups.has('primary')).toBe(false);
  });

  it('crossing the budget ASKS the token math about a compaction, and parks for a continuation', async () => {
    await runAcrossTheBudget();

    // ⚠ T84 (ANSWER-ANYWAY) — THE ONE CHANGE TO THIS CLAUSE, AND IT IS THE FIX'S SUBJECT.
    // This used to read `expect.objectContaining({ force: true })`. `force` bypasses
    // `runCheckAndCompact`'s ENTIRE trigger and all three of its yield guards, which made
    // elapsed wall-clock — on its own — the reason to rebuild a history. On 2026-09-21 that
    // rebuilt a 13,649-token assembly against a 51,300 threshold (27% fill,
    // `needsCompactionByTokens: false` in the engine's own log) and severed a live agent from
    // the half of a two-part ask it still owed. The checkpoint now ASKS instead of telling,
    // and the exact-arity call below is what pins it: a fourth argument of ANY shape fails
    // here. The token path itself is driven end-to-end, against a real database and the real
    // `checkAndCompact`, in
    // `steps/pre-call-gates/__tests__/the-clock-does-not-overrule-the-token-math.test.ts`.
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'primary', expect.any(String), expect.any(Number),
    );

    // The turn parks rather than dying: a wakeup is queued so the work resumes on a fresh
    // turn. t137 (OR-LONG-JOBS): the park is housekeeping — it no longer tells the owner, so
    // it writes no system row at all.
    const sys = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'")
      .all() as Array<{ content: string }>;
    expect(sys).toEqual([]);
    expect(pendingWakeups.has('primary')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // HL4 STEP 2 (2d) — THE THREE CLAUSES THAT PINNED THE RETIRED RECAP'S WORDING, AND
  // WHERE EACH ONE'S REQUIREMENT WENT. Nothing here was dropped silently.
  //
  //   1. "the recap's tool-call number is read LIVE off the turn state" — a CROSSING
  //      test: two arms that differ only in live turn state make a stale snapshot
  //      visible. The property is about the STEP, not about the recap, so it is
  //      re-homed below onto `elapsedMin`, the one live-state number left in this
  //      branch. A step handed a snapshot taken at turn start reports 0 on both arms.
  //   2. "THE UNIT: a MULTI-BATCH turn counts the TURN, not the last batch" (T13, CUT
  //      3's H1) — the number came off `state.toolResults`, the turn's own ledger, and
  //      NOT off `state.toolCalls`, the last response's batch. The number survives the
  //      retirement in the branch's log line, so the requirement is re-homed as a
  //      SOURCE clause over the engine corpus and is stated as such rather than dressed
  //      up as behaviour — the same disposition its sibling clause already used.
  //   3. "the ack sentence is ABSENT / the engine reads exactly the three flags" — its
  //      subject was one clause of the retired string, and it is GONE with it. What the
  //      clause really guarded (two mutable driver locals surviving a relocation) is now
  //      guarded by the compiler instead: `deferredDeliveredByAck` and
  //      `engineStartAckDeliveredThisTurn` were removed from `PreCallGatesContext` in
  //      the same commit, because this step was their only reader here.
  // ══════════════════════════════════════════════════════════════════════════════
  // t137: `elapsedMin` used to surface in the owner's park row; that row is retired, and the
  // number's one carrier now is the operator's log line — so the crossing is read there.
  const parkLogElapsed = (): number[] => loggerWarnSpy.mock.calls
    .filter((c) => c[0] === 'v2 checkpoint window ended, auto-continuing')
    .map((c) => (c[1] as { elapsedMin: number }).elapsedMin);

  it('THE CROSSING TEST: the checkpoint reads LIVE turn state, not a snapshot taken at turn start', async () => {
    await runAcrossTheBudget();
    expect(parkLogElapsed()).toEqual([16]);
    loggerWarnSpy.mockClear();

    enqueueSteerSpy.mockClear();
    checkAndCompactSpy.mockClear();
    pendingWakeups.clear();
    mockDb.current = setupTestDb();

    await runAcrossTheBudget({ extraMs: 19 * 60 * 1000 });
    // A snapshot of `turnStartMs` taken before the loop would make both arms identical.
    expect(parkLogElapsed()).toEqual([35]);
  });

  it('a forced compaction that THROWS produces no recap — the receipts describe a rebuild that happened', async () => {
    checkAndCompactSpy.mockRejectedValueOnce(new Error('summarizer down'));

    await runAcrossTheBudget();

    expect(checkAndCompactSpy).toHaveBeenCalled();
    expect(recaps()).toEqual([]);
    // The turn still parks — the branch is best-effort about the rebuild, never about
    // the continuation.
    expect(pendingWakeups.has('primary')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // HL4 STEP 2 (2d) — THE DRIVEN CHECK THE CENSUS ASKED FOR, AND ITS ANSWER.
  //
  // W27's census left ONE mechanism marked UNKNOWN rather than verdicted: the
  // `compaction-recap` floor enqueues at `turn-budget.ts` and the same step
  // `requestExit`s the turn eleven statements later, so the census could see no path
  // on which the drain runs again — but "I can see no path" is a reading, not a
  // measurement, and the census said so in as many words (§6.1: *"it needs a driven
  // check, not a reading"*).
  //
  // This is that driven check. It runs a REAL turn across the budget and records every
  // messages array the model was handed, for the whole turn, and asks the only question
  // that settles it: did the recap's bytes ever reach a model request?
  //
  // ANSWER, measured: NO — on any call, on any pass. Not because delivery is slow: the
  // steer's ONLY carrier is the queue (`steer-queue.ts`), the queue's ONLY drain is the
  // assemble step (`steer-checkpoint.ts:112-116`), and the step that files this entry
  // ends the turn before assemble can run again. The queue is per-turn state
  // (`state.ts:527` seeds `emptySteerQueue()`), so the continuation turn the checkpoint
  // parks for starts with an empty one. The row the floor also writes is `role='system'`,
  // which `tailRender` (`memory/assembler.ts:1191-1195`) never emits. Both carriers are
  // closed. The recap has never reached a model and structurally cannot.
  //
  // The clause below it is the RED: a floor that cannot be delivered must not be FILED.
  // ══════════════════════════════════════════════════════════════════════════════
  /** Run across the budget while recording every messages array handed to the model. */
  async function runAcrossTheBudgetRecording(): Promise<Array<Array<Record<string, unknown>>>> {
    const seen: Array<Array<Record<string, unknown>>> = [];
    let call = 0;
    const clock = controllableClock();
    callModelSpy.mockImplementation(async (args: { messages: unknown }) => {
      seen.push(JSON.parse(JSON.stringify(args.messages)));
      call++;
      return call === 1
        ? {
          content: '',
          toolCalls: [{ id: 'tc-0', name: 'file_read', arguments: { path: '/tmp/0.txt' } }],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        }
        : { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => {
      clock.jump(TURN_TIME_BUDGET_MS + 60_000);
      return { toolCallId: toolCall.id, name: toolCall.name, content: 'file body', isError: false };
    });
    try {
      await runV2Turn('primary');
    } finally {
      clock.restore();
    }
    return seen;
  }

  it('DRIVEN: the mid-turn recap reaches NO model request, on any call of the turn it is filed in', async () => {
    const seen = await runAcrossTheBudgetRecording();

    // The turn really crossed the budget and really reached the compaction check — without
    // this the clause would pass on a turn where the branch never ran, which proves nothing.
    // (T84: the check is no longer FORCED — same three arguments, no options object. See the
    // branch's own clause above for why.)
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'primary', expect.any(String), expect.any(Number),
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);

    // Every message of every request, across the whole turn.
    const everythingTheModelSaw = seen
      .flat()
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n---\n');
    expect(everythingTheModelSaw).not.toContain('memory was just compacted MID-TURN');
    expect(everythingTheModelSaw).not.toContain('Do NOT re-introduce yourself');
  });

  it('THE RED (HL4 2d): the turn-budget checkpoint files no steer, because a steer filed here can never be delivered', async () => {
    // A floor that cannot reach a model is not a floor; it is a queue entry that exists
    // to be abandoned. HL4's own rule — nothing is deleted without its requirement
    // re-homed — is satisfied where the requirement actually lives and is asserted in
    // the two clauses below this one.
    await runAcrossTheBudget();
    expect(recaps()).toEqual([]);
  });

  it('t137: THE RE-HOME, half 1 is RETIRED — neither arm of the checkpoint writes the person a receipt row', async () => {
    // "Pick up where you left off … do not start over" rode a role='system' row, which the tail
    // renderer never emits: the MODEL never read it, and the owner read it every fifteen
    // minutes (tracker #10). OR-LONG-JOBS makes the park invisible housekeeping. The model's
    // half is the task list (half 2 went with its section in v3.3.3); the operator's half is the log line. Both arms —
    // rebuilt history or not — are driven here and both leave no row.
    checkAndCompactSpy.mockResolvedValueOnce({ leafCreated: 1, condensedCreated: 0, tokensReclaimed: 4000 });
    await runAcrossTheBudget();
    const sysOf = (): unknown[] => mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'").all();
    expect(sysOf()).toEqual([]);
    expect(pendingWakeups.has('primary')).toBe(true);

    pendingWakeups.clear();
    mockDb.current = setupTestDb();
    await runAcrossTheBudget();
    expect(sysOf()).toEqual([]);
    expect(pendingWakeups.has('primary')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T13 — THE SPIN-BRAKE GRACE ACTUALLY CONCLUDES THE TURN (CUT 5's H3).
//
// THE DEFECT, in the driver's own terms. Once the terminal brake ends the tool phase,
// the owner's 2026-07-19 ruling allows a small grace of further model iterations to
// converge to text and THEN concludes the turn. The code wrote
// `advance(state, { phase: 'done' })` inside the loop body — and four statements later
// the driver advanced `phase` into `postCallClassify`. The ONLY production reader of
// `state.phase` is the `while` head, so the write never survived to be read: the
// exhausted grace logged "concluding the turn" on EVERY subsequent iteration and the
// turn ran on to its loop cap. "Concluding the turn" concluded nothing.
//
// This loop's own head comment already names the defect class AND the shape that fixes
// it: `taskClosedWithTextThisTurn` is "a FLAG, which only gets set (never cleared) ...
// so the next loop turn sees it and exits, AFTER the current iteration's close-out has
// already run". The grace needs exactly that property — the ruling's own rider is that
// "the model's text is never suppressed, whatever it has said stands", so the arm must
// NOT break mid-iteration before the round's text is classified and persisted.
//
// The fix therefore reads the LATCH at the loop head. Nothing new was declared: the two
// fields (`toolPhaseEndedBySpinBrake`, `spinBrakeGraceCalls`) already exist on the turn's
// bag and are already monotone — the brake only latches true, the grace only decrements.
//
// WHY THE FLAG IS SET FROM INSIDE A TOOL CALL HERE. Reaching the terminal rung honestly
// takes a stopped call plus three refusals; that arm is driven end to end in
// `the-same-call-with-the-same-result-stops-until-lifted.test.ts`. What THIS clause has
// to prove is the DRIVER's half — that an exhausted grace ends the turn — so the latch is
// seeded from inside the first tool call.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 T13: the spin-brake grace ends the turn instead of announcing that it did', () => {
  it('the turn CONCLUDES when the grace is exhausted, though the model never stops asking for tools', async () => {
    let call = 0;
    // A different path every round, so no identical signature accrues: the thrash gate
    // and the brake's own accounting are held out of this measurement deliberately, and
    // the ONLY thing that can end this turn is the grace.
    callModelSpy.mockImplementation(async () => {
      call++;
      return {
        content: `round ${call} text`,
        toolCalls: [{ id: `tc-${call}`, name: 'file_read', arguments: { path: `/tmp/round-${call}.txt` } }],
        inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      };
    });
    executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => {
      // Latch the terminal brake on the FIRST round, from inside the turn.
      const tc = turnContext('primary');
      if (tc) tc.toolPhaseEndedBySpinBrake = true;
      return { toolCallId: toolCall.id, name: toolCall.name, content: 'file body', isError: false };
    });

    await runV2Turn('primary');

    // Round 1 latches (the grace is read at the TOP of a round, so it first sees the
    // latch on round 2). The grace is 2: rounds 2, 3 and 4 take it 2 -> 1 -> 0 -> -1,
    // and round 4 is the one that concludes. The turn ends there rather than running
    // to the end of a checkpoint window, which is what it did before.
    expect(call).toBe(4);
  });

  it('POSITIVE CONTROL: with the brake NEVER latched the same fixture runs on — the exit is the grace, not the fixture', async () => {
    let call = 0;
    callModelSpy.mockImplementation(async () => {
      call++;
      // End it by hand at round 6, well past the grace's own exit point, so a failure
      // of this control means the turn ended for a reason nobody asked for.
      return call >= 6
        ? { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' }
        : {
          content: `round ${call} text`,
          toolCalls: [{ id: `tc-${call}`, name: 'file_read', arguments: { path: `/tmp/round-${call}.txt` } }],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
    });
    executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => (
      { toolCallId: toolCall.id, name: toolCall.name, content: 'file body', isError: false }
    ));

    await runV2Turn('primary');

    expect(call).toBe(6);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 4 (`finalize`) — G-SUP-2: THE ANSWER THAT RODE WITH A TOOL CALL IS
// RECOVERED, NEVER SILENTLY DROPPED.
//
// WHY THIS LANDS BEFORE ANYTHING MOVES. Non-negotiable #2: a guard's requirement is
// written down as a test before its code is touched. `git grep -lw G-SUP-2` over
// every `__tests__` directory in BOTH repos found NOTHING — the sibling G-SUP-3 has
// clauses (PRESERVATION #40), G-SUP-2 has none, and it is the FIRST block of the
// `finalize` span. These clauses are GREEN on the unmoved tree; the tranche moves
// the code under them.
//
// THE REQUIREMENT, in the guard's own terms (comms-audit). A human is waiting. The
// only user-facing text the turn produced rode in the SAME model response as a tool
// call, so the engine deliberately did NOT show it as a mid-turn bubble (the preamble
// leak G-SUP-2's sibling rule exists to stop) — it REMEMBERED it instead. If the turn
// then ends with no proper tool-less reply, the ask would be answered by silence. So
// finalize recovers the remembered text: persists it as the agent's own assistant row,
// broadcasts it to the dashboard, and hands it to the channel router so it reaches the
// person on the channel they used.
//
// AND THE PART THAT IS EASY TO GET WRONG, held by its own clause: when a real
// tool-less reply DID land, `lastAssistantTextForIM` is set and the recovery is
// skipped — there is no double-reply.
//
// RC-12 ITEM 6 rides here too. The recovery path used to route deferred text WITHOUT
// the claimed-delivery floor, so a false "I sent it" that rode with a tool call went
// straight to the channel. The floor now runs on this path as well — but as a LOUD
// TRIPWIRE, not a veto: the loop has already exited, there is no re-entry to correct
// the model, and a waiting human must not be left in silence. It warns AND delivers.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 4: the deferred answer is recovered at finalize (G-SUP-2)', () => {
  const DEFERRED = 'Your report is ready and saved to the desktop.';

  /**
   * The agent's own SPEECH this turn, oldest first. `content NOT LIKE '[{%'` is the
   * engine's own predicate for "a person could read this" (`startAckRepliedNow`'s
   * query uses it verbatim): a tool_use array is persisted on an `assistant` row too,
   * and counting it as speech would make every clause below read one row high.
   */
  function assistantRows(): Array<{ id: string; content: string }> {
    return mockDb.current!
      .prepare("SELECT id, content FROM messages WHERE role = 'assistant' AND content NOT LIKE '[{%' ORDER BY rowid")
      .all() as Array<{ id: string; content: string }>;
  }

  function broadcastAssistantTexts(): string[] {
    return getBroadcastEventsByType('chat:message')
      .map((e) => (e as { message?: { role?: string; content?: string } }).message)
      .filter((m): m is { role: string; content: string } => m?.role === 'assistant')
      .map((m) => m.content);
  }

  /** One tool round whose response ALSO carries text, then a terminal round with `tail`. */
  async function turnWithTextRidingATool(tail: string): Promise<void> {
    callModelSpy
      .mockResolvedValueOnce({
        content: DEFERRED,
        toolCalls: [{ id: 'tc1', name: 'file_write', arguments: { path: '/tmp/r.md', content: 'x' } }] as ToolCall[],
        inputTokens: 100, outputTokens: 10, stopReason: 'tool_use',
      })
      .mockResolvedValue({
        content: tail,
        toolCalls: [],
        inputTokens: 50, outputTokens: 5, stopReason: 'end_turn',
      });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1', name: 'file_write', content: 'written', isError: false,
    });
    await runV2Turn('primary');
  }

  it('POSITIVE CONTROL: an ordinary tool-less terminal reply is delivered once and nothing is recovered', async () => {
    // The control matters more than usual here: every other clause asserts that a
    // SECOND row appears, and a tree where the engine simply double-posts would pass
    // them all. This one fails on exactly that tree.
    await turnWithTextRidingATool('Here is the summary you asked for.');

    const rows = assistantRows();
    expect(rows.map((r) => r.content)).toEqual(['Here is the summary you asked for.']);
    expect(rows.some((r) => r.content === DEFERRED)).toBe(false);
  });

  it('the turn ends with no tool-less reply → the deferred text IS delivered, as the agent, once', async () => {
    // The weak-model shape this exists for: the answer was paired with the closing
    // tool call, and the model then said nothing at all.
    await turnWithTextRidingATool('');

    const rows = assistantRows();
    expect(rows.map((r) => r.content)).toEqual([DEFERRED]);
    // It reached the dashboard as the agent's own message, not only the DB.
    expect(broadcastAssistantTexts()).toContain(DEFERRED);
  });

  it('the recovered text becomes the turn\'s reply, so the channel router can still route it', async () => {
    // `lastAssistantTextForIM` is what every channel branch below reads. If the
    // recovery persisted a row but left that unset, the person on iMessage/SMS/email
    // would still get silence — the exact failure G-SUP-2 exists to prevent, one
    // layer down. The turn record's answer id is the observable half.
    await turnWithTextRidingATool('');

    const recovered = assistantRows()[0];
    const turn = mockDb.current!
      .prepare('SELECT answered, answer_message_id FROM turns ORDER BY rowid DESC LIMIT 1')
      .get() as { answered: number; answer_message_id: string | null } | undefined;
    expect(turn?.answered).toBe(1);
    expect(turn?.answer_message_id).toBe(recovered.id);
  });

  it('RC-12 item 6: a claimed delivery the ledger contradicts warns LOUDLY and still delivers', async () => {
    // "I texted <name>" with no delivery receipt anywhere. The floor fires as a
    // tripwire, naming the row — and the recovery still happens, because the loop has
    // exited and silence is the worse failure.
    callModelSpy
      .mockResolvedValueOnce({
        content: `I texted ${FX.n9} the details.`,
        toolCalls: [{ id: 'tc1', name: 'file_write', arguments: { path: '/tmp/r.md', content: 'x' } }] as ToolCall[],
        inputTokens: 100, outputTokens: 10, stopReason: 'tool_use',
      })
      .mockResolvedValue({ content: '', toolCalls: [], inputTokens: 50, outputTokens: 5, stopReason: 'end_turn' });
    // ARM B of the floor: a delivery the DOOR ITSELF recorded as failed, this turn,
    // for the person the text names. Written from inside the tool call so it lands on
    // the turn that is actually running rather than on a number guessed up front.
    executeToolSpy.mockImplementation(async () => {
      const t = mockDb.current!
        .prepare("SELECT turn_number FROM turns WHERE agent_id = 'primary' ORDER BY rowid DESC LIMIT 1")
        .get() as { turn_number: number } | undefined;
      mockDb.current!.prepare(
        `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_id, recipient_display, outcome)
         VALUES ('d-failed-1', 'primary', ?, 'imessage_send', 'imessage', '${FX.n9}', '${FX.n9}', 'failed')`,
      ).run(t?.turn_number ?? null);
      return { toolCallId: 'tc1', name: 'file_write', content: 'written', isError: false };
    });

    await runV2Turn('primary');

    // IT STILL DELIVERS. This is the whole point of the tripwire shape: the loop has
    // exited, there is no re-entry to correct the model, and silence is the worse
    // failure. A version of this guard that VETOED would pass a "did not double-send"
    // assertion and re-open the defect G-SUP-2 exists to close.
    expect(assistantRows().map((r) => r.content)).toEqual([`I texted ${FX.n9} the details.`]);
    const fired = loggerWarnSpy.mock.calls.some((c) => String(c[0]).includes('G-SUP-2 recovery: delivered text claims a delivery'));
    expect(fired).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 5, STEP 1a — THE ABORT HAND-BACK (N-1 / P6b-1) GETS THE FIRST
// TEST IT HAS EVER HAD, GREEN ON THE UNMOVED TREE, BEFORE THE `callLLM`
// TRANCHE MOVES ITS TWO CALL SITES.
//
// `git grep -lw revertTriggerStampOnAbort` over every `__tests__` directory in
// BOTH repos returned NOTHING. Its two call sites are inside this tranche's
// span (the fixed-model rethrow and the auto-routed give-up), so the span
// cannot move until the requirement is written down — non-negotiable #2.
//
// The requirement has TWO arms and the second one is the interesting one:
//   • a turn that dies with no answer HANDS THE ASK BACK to the waiting set,
//     because a person who asked is still owed one; and
//   • a turn that already performed a side effect DOES NOT — it holds the ask
//     and records the refusal as a work event, because re-firing would send the
//     email twice. The loop's own words: "a turn that performed a side effect
//     must never re-fire" (07 §2c, ledger P6b-1).
//
// The owner's governing ruling: "the user asks the agent to do something and it does it.
// Period." An ambiguous or absent answer errs toward SERVING THE ASK AGAIN, never toward
// silence or a parked ticket. The abort only marks the turn; at the TURN BOUNDARY the one
// hand-back (`handBackAsk`, `work/ask-settlement.ts`) adjudicates every ask the turn held, and
// an ask with no delivery behind it goes back to `open` whatever the turn did. The residual the owner accepted, stated out loud: a
// non-idempotent call on a turn that then delivered NOTHING can be repeated by the re-serve.
// The structural invariant that makes it necessary: no ask may remain `claimed` by a
// finalized turn — that is the fossil class, 36 stuck rows on this box.
//
// ⚠ AND THE POSITIVE CONTROL NEEDED A REAL RECEIPT. This file mocks `gateway/ws.js`, and the
// real `broadcast` is what calls `recordDashboardDelivery` — so no turn in this harness has
// ever written a `deliveries` row, and "a turn that answered" was indistinguishable from "a
// turn that said something into a void". That did not matter while the ask's fate keyed on
// the model call succeeding; it decides the answer now, because the RECORD decides. The
// control below restores that one production seam for its own turn, which is the honest
// shape: the discriminator is the receipt, not the model's success.
// ════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 5: a turn that dies with no answer hands the ask back — unless it already acted', () => {
  /** The ask the seeded user message opened, and the state the spine holds it in. */
  function askRow(): { id: string; state: string } {
    return mockDb.current!
      .prepare("SELECT id, state FROM work WHERE kind = 'ask' AND agent_id = 'primary' ORDER BY rowid LIMIT 1")
      .get() as { id: string; state: string };
  }

  function eventsFor(workId: string): Array<{ kind: string; payload: string | null }> {
    return mockDb.current!
      .prepare('SELECT kind, payload FROM work_events WHERE work_id = ? ORDER BY rowid')
      .all(workId) as Array<{ kind: string; payload: string | null }>;
  }

  const kinds = (workId: string): string[] => eventsFor(workId).map((e) => e.kind);

  // The receipt seam below is installed per-test, so it must be taken back off per-test:
  // `mockClear` (the file-wide beforeEach) forgets the CALLS and keeps the IMPLEMENTATION,
  // which would silently give the next clause a receipt it is supposed to be missing.
  beforeEach(() => { broadcastSpy.mockReset(); });

  /** The one production seam this file mocks away: `gateway/ws.js:broadcast` is what calls
   *  `recordDashboardDelivery`, so without it a turn's reply leaves no receipt. Restored for
   *  the clause whose whole subject is "did the person actually get an answer". */
  function recordDeliveriesLikeProduction(): void {
    broadcastSpy.mockImplementation((event: unknown) => {
      const e = event as { type?: string; agentId?: string; message?: { id?: string; role?: string } };
      if (e?.type !== 'chat:message' || e.message?.role !== 'assistant' || !e.agentId) return;
      recordDelivery({
        agentId: e.agentId, tool: 'dashboard', channel: 'dashboard', recipientId: 'owner',
        messageId: e.message.id ?? null, outcome: 'delivered',
        conversationId: turnContext(e.agentId)?.root?.conversationId ?? null,
      });
    });
  }

  it('POSITIVE CONTROL: a turn that ANSWERS AND DELIVERS does not hand its ask back', async () => {
    // The control a tree that re-arms unconditionally fails. Same seeded ask, same engine;
    // the difference is that this turn's reply reached the person and left the receipt that
    // proves it. Under one settlement authority that receipt IS the discriminator.
    recordDeliveriesLikeProduction();
    callModelSpy.mockResolvedValue({
      content: 'Here you go.', toolCalls: [] as ToolCall[],
      inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(askRow().state).toBe('done');
    expect(kinds(askRow().id)).not.toContain('rearm_refused');
    const receipt = mockDb.current!.prepare(
      "SELECT result_delivery_id AS d FROM work WHERE id = ?",
    ).get(askRow().id) as { d: string | null };
    expect(receipt.d, 'a closed ask points at the delivery that answered it').toBeTruthy();
  });

  it('NEGATIVE CONTROL: the same successful turn with NO receipt hands the ask back', async () => {
    // The same model call, the same content, and the only difference is that nothing recorded
    // the send. The record decides, not the model: the person is still waiting, so the ask
    // returns to the waiting set rather than being marked served on a promise.
    callModelSpy.mockResolvedValue({
      content: 'Here you go.', toolCalls: [] as ToolCall[],
      inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(askRow().state).toBe('open');
  });

  it('THE HAND-BACK: a model call that gives up returns the ask to the waiting set', async () => {
    // The fixed-model path rethrows every error that is not the stream-idle watchdog,
    // and reverts the claim on its way out. Driven through `runV2Turn` because the
    // guard is a CLOSURE over the turn's own trigger — calling it directly would test
    // a function, not the engine's promise to the person waiting.
    callModelSpy.mockImplementation(async () => { throw new Error('provider exploded'); });

    const before = askRow();

    await runV2Turn('primary');

    // Back in the waiting set — and NOT because it never left it. The revert is a
    // state transition whose `expectedState` is `claimed`, so its own event is the
    // proof that this turn claimed the ask and then gave it back, carrying the
    // engine's reason with it.
    expect(askRow().state).toBe('open');
    const handBack = eventsFor(before.id).find((e) => String(e.payload ?? '').includes('ct0_ask_re_served'));
    expect(handBack, 'no hand-back record on the ask').toBeTruthy();
  });

  it('A TURN THAT ACTED AND THEN DIED: THE TURN BOUNDARY STILL HANDS THE ASK BACK', async () => {
    // One successful send, then the model dies. The owner ruled on 2026-08-05 that an ask with no
    // answer behind it is served again rather than parked, and no ask may outlive its turn `claimed`;
    // the hand-back is the turn boundary's alone, so the row ends `open`.
    let n = 0;
    callModelSpy.mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        return {
          content: '', toolCalls: [{ id: 'tc1', name: 'imessage_send', arguments: { to: FX.n9, text: 'on it' } }] as ToolCall[],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      throw new Error('provider exploded');
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1', name: 'imessage_send', content: 'sent', isError: false,
    });

    await runV2Turn('primary');

    expect(n).toBe(2);                                   // positive control: it did die on the second call
    expect(askRow().state).toBe('open');                 // the boundary hands it back
    // The invariant the reversal exists for: nothing is left claimed by a turn that is over.
    expect(askRow().state).not.toBe('claimed');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 6 (T4, `assemble`) — THE TWO GUARDS IN THIS SPAN THAT HAD NO TEST.
//
// Non-negotiable #2 in its strict form: a guard's requirement is written down
// BEFORE its code is touched. Both clauses below landed GREEN on the UNMOVED
// tree, and both were proven non-vacuous by a planted fault on the guard's own
// condition (recorded in the task report).
//
// How they were found, by command rather than by eye:
//   grep -rl freshTailDropWarned            packages/server/src --include='*.test.ts'  → nothing
//   grep -rl 'zero messages, clean exit'    packages/server/src --include='*.test.ts'  → nothing
//
// WHY THESE TWO AND NOT ANOTHER PAIR:
//   * the fresh-tail eviction warning is a ONE-SHOT LATCH ACROSS ITERATIONS
//     (`freshTailDropWarned`), and this cut migrates that latch off the driver's
//     stack onto the turn's bag. A by-value hand-off would reset it every
//     iteration and the user would get the same "memory is full" banner on every
//     round of a long turn. The clause below is the one a botched carrier fails.
//   * the empty-context clean exit is this span's ONLY loop exit, so it is the
//     exit-request channel's entire subject for this tranche. Preserved from v1
//     (`runtime.ts:1014-1020`) and never asserted anywhere until now.
// ════════════════════════════════════════════════════════════════════════════════

describe('PHASE-6 CUT 6: the assemble span kept two guards nobody tested', () => {
  const contextHighErrors = (): Array<{ code?: string; error?: string }> =>
    (getBroadcastEventsByType('chat:error') as Array<{ code?: string; error?: string }>)
      .filter((e) => e.code === 'CONTEXT_HIGH');

  const evictionWarns = (): unknown[] =>
    loggerWarnSpy.mock.calls.filter((c) => String(c[0]).includes('assembler evicted oldest fresh-tail messages'));

  it('FA-M1: the fresh-tail eviction log line fires ONCE PER TURN, not once per iteration', async () => {
    // Every assembly of this turn reports an eviction — which is the real shape:
    // the window is still full on the next round, so the assembler drops again.
    assembleContextMock.mockImplementation(async () => ({
      systemPrompt: '<system prompt>',
      messages: [{ role: 'user', content: 'hello' }] as Array<Record<string, unknown>>,
      freshTailDropped: 3,
    }));
    // Two iterations: a tool call, then the answer.
    let n = 0;
    callModelSpy.mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        return {
          content: '', toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: 'a.txt' } }] as ToolCall[],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      return { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc1', name: 'file_read', content: 'ok', isError: false });

    await runV2Turn('primary');

    // POSITIVE CONTROL for the latch: the turn really did assemble more than once,
    // so "fired once" is a latch and not an artefact of a single-pass turn.
    expect(assembleContextMock.mock.calls.length).toBeGreaterThan(1);
    // t207 (owner decision 34): setting messages aside is routine; the owner gets no toast for it. The
    // operator log line stays, once per turn (the latch).
    expect(contextHighErrors()).toHaveLength(0);
    expect(evictionWarns()).toHaveLength(1);
  });

  it('FA-M1 control: an assembly that dropped nothing says nothing', async () => {
    // The clause a tree that broadcasts unconditionally fails.
    callModelSpy.mockResolvedValue({
      content: 'Hello back!', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(contextHighErrors()).toHaveLength(0);
    expect(evictionWarns()).toHaveLength(0);
  });

  it('the empty-context clean exit: zero assembled messages ends the turn without calling the model', async () => {
    // Preserved from v1 (`runtime.ts:1014-1020`). An assembler that returns nothing
    // must not be handed to a provider — the turn stops, idle, and says why.
    assembleContextMock.mockImplementation(async () => ({
      systemPrompt: '<system prompt>',
      messages: [] as Array<Record<string, unknown>>,
    }));
    callModelSpy.mockResolvedValue({
      content: 'should never be produced', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(assembleContextMock).toHaveBeenCalled();   // it got as far as assembling
    expect(callModelSpy).not.toHaveBeenCalled();      // and no further
    const agent = mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get('primary') as { status: string };
    expect(agent.status).toBe('idle');
  });

  it('the empty-context control: one assembled message and the model IS called', async () => {
    // Without this arm the clause above passes on a tree where the turn never
    // reaches assembly at all, which is the vacuous way to be green.
    callModelSpy.mockResolvedValue({
      content: 'Hello back!', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    expect(callModelSpy).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 8 (T6, `postCallClassify`) — THE RC-13.2 FAILED-SAVE-CLAIM FLOOR GETS
// THE FIRST TEST IT HAS EVER HAD, GREEN ON THE UNMOVED TREE, BEFORE THE SPAN MOVES.
//
// How it was found, by command rather than by eye. Every floor id declared inside this
// tranche's span was greped for across BOTH repos' test corpora:
//   git grep -l "'failed-save-claim'" -- '…/__tests__/…'   → nothing
//   git grep -l "failed-save-claim"   (the whole kit repo)  → nothing
//   git grep -l "You told TestUser you saved that"         → nothing, either repo
// Of the fifteen floors this span declares, it is the only one with no test, no kit
// scenario and no clause naming its steer text anywhere.
//
// WHAT THE REQUIREMENT IS, in the guard's own terms (`loop.ts`, "RC-13.2
// failed-save-claim floor"): the reply claims something was saved / stored /
// remembered, but every `vault_remember` THIS TURN was REJECTED and nothing was
// stored. That is the agent telling the person a falsehood about its own memory —
// the honesty class this project exists to remove — and the floor catches it BEFORE
// the claim becomes the turn's answer, then re-enters so the model either retries the
// save or says truthfully that it is not saved yet.
//
// THE CONDITION HAS THREE PARTS AND EACH ONE IS A SEPARATE WAY TO BE WRONG:
//   * a terminal reply ending the turn (whatever it says);
//   * `succeeded === 0` — if ANYTHING was stored the claim is true enough and the
//     floor must stay quiet;
//   * `rejected >= 1` — there has to be a rejection to lie about.
// Plus the `steerFired` one-shot, so a model that repeats itself cannot spin the
// engine. Non-negotiable #2 in its strict form: the requirement is written down
// before the code is touched.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 8: the postCallClassify span kept the RC-13.2 save-claim floor nobody tested', () => {
  const remember = (n: number): ToolCall =>
    ({ id: `vr-${n}`, name: 'vault_remember', arguments: { content: `fact ${n}` } } as ToolCall);

  const messagesOfCall = (i: number): string =>
    JSON.stringify((callModelSpy.mock.calls[i]?.[0] as { messages?: unknown })?.messages ?? []);

  /** Drive a turn whose FIRST round calls `vault_remember` and whose later rounds are
   *  plain text. `results` decides which of those saves the vault accepted. */
  const driveClaimTurn = async (opts: {
    saves: number;
    accept: (n: number) => boolean;
    texts: string[];
  }): Promise<void> => {
    let round = 0;
    callModelSpy.mockImplementation(async () => {
      round += 1;
      if (round === 1) {
        return {
          content: '', toolCalls: Array.from({ length: opts.saves }, (_, i) => remember(i + 1)) as ToolCall[],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      return {
        content: opts.texts[round - 2] ?? 'ok', toolCalls: [] as ToolCall[],
        inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
      };
    });
    executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => {
      const n = Number(String(toolCall.id).split('-')[1]);
      return opts.accept(n)
        ? { toolCallId: toolCall.id, name: toolCall.name, content: 'stored', isError: false }
        : { toolCallId: toolCall.id, name: toolCall.name, content: 'REJECTED: needs a subject', isError: true };
    });
    await runV2Turn('primary');
  };

  it('THE FLOOR: every save was rejected and the reply claims one succeeded — the turn re-enters instead of shipping the lie', async () => {
    await driveClaimTurn({
      saves: 2,
      accept: () => false,
      texts: ['Saved that for you.', 'Actually it did not save — the vault rejected it.'],
    });

    // POSITIVE CONTROL: the claim round really happened, so a green below cannot mean
    // "the turn never got there".
    expect(callModelSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // THE CLAUSE: the model is asked a THIRD time, and what it is handed is the floor's
    // steer — with the rejected COUNT in it and both honest ways out named.
    expect(callModelSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    const steer = messagesOfCall(2);
    expect(steer).toContain('All 2 vault_remember calls this turn');
    expect(steer).toContain('were REJECTED and nothing was stored');
    expect(steer).toContain('tell the counterpart truthfully that it is not saved yet');
  });

  it('THE `succeeded === 0` ARM: one save landed, so the claim is not a lie and the floor stays quiet', async () => {
    // The sharp control: there IS a rejection, so a floor that only counted rejections
    // would fire here. Something was stored, so the claim is true enough and the engine
    // has no business interrupting.
    await driveClaimTurn({
      saves: 2,
      accept: (n) => n === 1,
      texts: ['Saved that for you.'],
    });

    expect(callModelSpy).toHaveBeenCalledTimes(2);
    expect(messagesOfCall(1)).not.toContain('vault_remember calls this turn');
  });

  it('ONE SHOT: the model repeats the claim after the steer and the engine does NOT steer again', async () => {
    // The `steerFired` guard is what stops an unrepentant model spinning the loop on a
    // floor that re-enters. Without it this turn would ping-pong until a checkpoint.
    await driveClaimTurn({
      saves: 1,
      accept: () => false,
      texts: ['Saved that for you.', 'I saved it, honestly.', 'Fine — it is not saved.'],
    });

    // The steer is persisted as its own role='system' row (`persistEngineSteer`), so the
    // number of rows IS the number of times the floor fired — a count the prompt text
    // cannot give, because once persisted the steer rides every later assembly.
    const rows = mockDb.current!
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'system' AND content LIKE '%vault_remember call this turn%'")
      .get() as { n: number };
    // POSITIVE CONTROL: it fired at all, so "exactly one" is a latch and not an absence.
    expect(rows.n).toBe(1);
    // …and the model really did get a third and fourth round to repeat itself in.
    expect(callModelSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-6 CUT 8 (T6) — THE SENTENCE THAT LIED, AND THE LATCH THAT DID THE WORK.
//
// The duplicate-final-answer prevention (v2.7.2) ended a turn where the model paired
// `complete_task` with wrap-up text. It set TWO things and said so in its own comment:
//
//     "Force loop exit AFTER this iteration's tool execution. … The next while-loop
//      check sees phase==='done' and exits without calling the model again."
//
// The second sentence is FALSE and has been for as long as the phase machine has
// existed: this block runs inside `postCallClassify`, and the driver's own
// unconditional `advance(state, { phase: 'execute' })` overwrites `phase` four
// statements later, every single time — the block cannot even be reached without tool
// calls, so the `execute` transition always follows it. What actually ends the loop is
// `taskClosedWithTextThisTurn`, a set-only flag the `while` head reads, and
// `steps/step-outcome.ts` already names it as the surviving workaround the exit-request
// channel replaces.
//
// PHASE-6 T13's INBOUND names this class in so many words — "never left as a sentence
// that lies" — and CUT 8 is the cut that touches this instance of it. So the clause
// below pins the MECHANISM (which had no test anywhere: `git grep
// taskClosedWithTextThisTurn` over both repos' test corpora returned nothing) and the
// step contract's own source census is tightened from ONE `phase:` write to ZERO.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 8: a sub-agent that closes with text ends the turn, and the LATCH is what ends it', () => {
  it('complete_task + wrap-up text: the model is not called again', async () => {
    let round = 0;
    callModelSpy.mockImplementation(async () => {
      round += 1;
      if (round === 1) {
        return {
          content: 'All done — the report is filed and the numbers check out.',
          toolCalls: [{ id: 'tc-ct', name: 'complete_task', arguments: { summary: 'done' } }] as ToolCall[],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      return { content: 'a second answer nobody asked for', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => ({
      toolCallId: tc.id, name: tc.name, content: 'completed', isError: false,
    }));

    await runV2Turn('primary');

    // POSITIVE CONTROL: the turn really ran the round that sets the latch.
    expect(callModelSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // THE CLAUSE: exactly one model call. A latch that stopped binding would produce a
    // second answer to the same question, which is the whole defect v2.7.2 fixed.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    // …and the tool still ran: the exit is AFTER this iteration's tool execution, not
    // instead of it.
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: wrap-up text WITHOUT complete_task does not latch the turn shut', async () => {
    // Without this arm the clause above passes on a tree where every tool-bearing turn
    // stops after one round.
    let round = 0;
    callModelSpy.mockImplementation(async () => {
      round += 1;
      if (round === 1) {
        return {
          content: 'All done — the report is filed and the numbers check out.',
          toolCalls: [{ id: 'tc-fr', name: 'file_read', arguments: { path: 'a.txt' } }] as ToolCall[],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      return { content: 'here is the answer', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => ({
      toolCallId: tc.id, name: tc.name, content: 'file body', isError: false,
    }));

    await runV2Turn('primary');

    expect(callModelSpy).toHaveBeenCalledTimes(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 12 T47 — THE SAME LANE SEPARATION, AT THE COMPILE GATE.
//
// The sibling gate. `agent/v2/compile-owed-gate.ts` refuses tool calls outside a closed
// allowed set while the owner is owed a compiled reply the redrive ladder has already
// come back for — round-12 S5, where three steers saying "Do NOT … call any tools first"
// were answered with six tool calls across 12m26s and no reply.
//
// BUG-2: the clauses below are a POSITIVE CONTROL so a green BUG-2 clause cannot mean "the
// gate never fires at all", the BUG-2 clause itself with a human waiting, and the two halves
// of the allowed set that must never be refused.
//
// They drive `runV2Turn` end to end and read the ENFORCEMENT, not the arming flag.
// ════════════════════════════════════════════════════════════════════════════════
describe('BUG-2, inherited: the compile gate never arms on a turn a human is waiting on', () => {
  /** The S5 shape through the product's own writers: an owner ask, two delegated streams,
   *  both back with content, the compile still pending — and one redrive rung already
   *  spent, which is what the gate arms on. */
  function seedOwedCompile(): string {
    const db = mockDb.current!;
    const openedAt = Date.now() - 20 * 60_000;
    db.prepare(
      `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
       VALUES ('conv-join', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
       VALUES ('msg-join', 'primary', 'user', 'plan the trip', 'owner', 'dashboard', 'conv-join', ?, NULL)`,
    ).run(openedAt);
    db.prepare(
      `INSERT INTO agents (id, name, model_id, status, config, classification)
       VALUES ('${FXID.n5}', '${FX.n5}', 'test-model', 'idle', '{}', 'worker')`,
    ).run();
    const askId = openAsk({
      agentId: 'primary', messageId: 'msg-join', conversationId: 'conv-join',
      requesterId: 'owner', openedAt, title: 'plan the trip',
    });
    claimAsk(askId, 'primary');
    stampClaimingTurn(askId, 4900);
    const kids = openDelegationJoin({
      parentWorkId: askId, agentId: 'primary', replyConversationId: 'conv-join',
      ttlAt: Date.now() + 60 * 60_000,
      threads: [
        { threadId: 'join-thread-a', assigneeAgent: FXID.n5, intent: 'ASSIGN' as const, hopCount: 0 },
        { threadId: 'join-thread-b', assigneeAgent: FXID.n5, intent: 'ASSIGN' as const, hopCount: 0 },
      ],
    });
    for (const [i, childId] of kids.entries()) {
      db.prepare(
        `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
         VALUES (?, 'primary', NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
      ).run(`join-piece-${i}`);
      landPiece(childId, {
        deliveryId: `join-piece-${i}`, content: `stream ${i} result`, messageId: null, actorId: FXID.n5,
      });
    }
    recordJoinDrive(askId, JOIN_DRIVE_ENTRY.redrive, {
      attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 4900,
    });
    return askId;
  }

  /** T68b — THE PRECONDITION THE REFUSAL HAS ALWAYS CLAIMED AND NEVER CHECKED.
   *
   *  The gate's refusal tells the model "the pieces are in the steer, quoted verbatim", and it
   *  may now only say that on a turn whose assembly CONFIRMED it (`AssembledContext
   *  .compileOrderIntact`, a substring test on the order's own bytes against the emitted
   *  array). The assembler is mocked in this file — the delivery half is driven for real in
   *  `memory/__tests__/a-compile-order-the-model-can-see` — so here the fixture states the
   *  verdict, and the order's real bytes ride along so the mock cannot drift into asserting a
   *  shape the product does not produce.
   *
   *  The default assembly says nothing, which is the honest default: no compile order was
   *  delivered, so the gate must not claim one was. */
  function theAssemblyConfirmsTheOrderArrived(): void {
    const order = `[Engine] ${compileSteerText({
      total: 2,
      pieces: [
        `Piece 1 (from ${FX.n5}, thread join-thr): "stream 0 result"`,
        `Piece 2 (from ${FX.n5}, thread join-thr): "stream 1 result"`,
      ],
      attempt: 1,
      bound: JOIN_REDRIVE_BOUND,
    })}`;
    assembleContextMock.mockImplementation(async () => ({
      systemPrompt: '<system prompt>',
      messages: [{ role: 'user', content: order }] as Array<Record<string, unknown>>,
      compileOrderIntact: true,
    }));
  }

  /** `load_tool_docs` is not a guess: it is the first call S5's model made instead of
   *  composing, and it is in the CLOSE-OUT gate's allowlist — so a turn that lets it
   *  through is measuring this gate and nothing else. */
  function callsTheToolS5Called(): void {
    const call: ToolCall = { id: 'tc-compile', name: 'load_tool_docs', arguments: { tool: 'work_update' } };
    callModelSpy
      .mockResolvedValueOnce({
        content: '', toolCalls: [call], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      })
      .mockResolvedValue({
        content: 'here is the combined answer', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
      });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc-compile', name: 'load_tool_docs', content: 'schema', isError: false,
    });
  }

  const refusedCompile = (): boolean => broadcastSpy.mock.calls.some((c) => {
    const e = c[0] as { type?: string; result?: string };
    return e.type === 'chat:tool_result' && typeof e.result === 'string'
      && e.result.includes('Refused: engine compile gate');
  });

  it('POSITIVE CONTROL: on a background turn the gate ARMS and REFUSES the call S5 made', async () => {
    // Nothing is waiting: the seeded ask is claimed, so this turn has no trigger row and is
    // exactly the lane class the redrive steers arrive on (S5 turns 4900/4901 `a2a`, 4902
    // engine). Without this control the BUG-2 clause below could mean "the gate never fires".
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    seedOwedCompile();
    theAssemblyConfirmsTheOrderArrived();
    callsTheToolS5Called();

    await runV2Turn('primary');

    expect(refusedCompile()).toBe(true);
    expect(executeToolSpy).not.toHaveBeenCalled();
  });

  it('T68b: the SAME owed compile refuses NOTHING when the order never reached the model', async () => {
    // Identical to the control in every respect but one: no compile order is in front of the
    // model. Before T68b this refused anyway, and told the model "the pieces are in the steer,
    // quoted verbatim" while they were nowhere in its context — the sentence that turned one
    // missing piece into three exhausted 16,384-token output budgets on 2026-08-31.
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    seedOwedCompile();
    callsTheToolS5Called();

    await runV2Turn('primary');

    expect(refusedCompile(), 'the model may go and look for what the platform lost').toBe(false);
    expect(executeToolSpy).toHaveBeenCalled();
  });

  it('BUG-2: the SAME owed compile on a turn serving a waiting human neither arms nor refuses', async () => {
    // The only difference from the control is that a person is waiting — the seeded ask is
    // left unclaimed, so the turn picks it up and `triggerRow` is set. The owed compile is
    // identical. This is the clause a tree without the ternary fails, and the failure it
    // fails on is the recorded one: the reply deleted and the tools the answer needed refused.
    seedOwedCompile();
    callsTheToolS5Called();

    await runV2Turn('primary');

    expect(refusedCompile()).toBe(false);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    expect((executeToolSpy.mock.calls[0][1] as ToolCall).name).toBe('load_tool_docs');
  });

  it('THE ALLOWED SET, HALF ONE: send_to_agent passes — the steer\'s own hand-off exception', async () => {
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    seedOwedCompile();
    const call: ToolCall = { id: 'tc-a2a', name: 'send_to_agent', arguments: { to_agent: FXID.n5, message: 'do you have the result?' } };
    callModelSpy
      .mockResolvedValueOnce({ content: '', toolCalls: [call], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' })
      .mockResolvedValue({ content: `asked ${FXID.n5}`, toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc-a2a', name: 'send_to_agent', content: 'sent', isError: false });

    await runV2Turn('primary');

    expect(refusedCompile()).toBe(false);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
  });

  it('THE ALLOWED SET, HALF TWO: a tracker close-out passes — so a turn armed by BOTH gates '
    + 'can always satisfy both', async () => {
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    seedOwedCompile();
    const call: ToolCall = {
      id: 'tc-tracker', name: 'work_update',
      arguments: { action: 'status', id: 'w-x', status: 'complete', result: 'done' },
    };
    callModelSpy
      .mockResolvedValueOnce({ content: '', toolCalls: [call], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' })
      .mockResolvedValue({ content: 'closed it', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc-tracker', name: 'work_update', content: 'ok', isError: false });

    await runV2Turn('primary');

    expect(refusedCompile()).toBe(false);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
  });

  it('DISARMED BY THE RELAY: with the compile no longer pending, the same turn runs free', async () => {
    // T48's relay settles the ask; `clearJoinCompilePending` is the same disarm one step
    // weaker. Either way the gate re-reads the spine and finds nothing owed.
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    const askId = seedOwedCompile();
    mockDb.current!.prepare('UPDATE work SET compile_pending = 0 WHERE id = ?').run(askId);
    callsTheToolS5Called();

    await runV2Turn('primary');

    expect(refusedCompile()).toBe(false);
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A CONTEXT OVERFLOW NEVER SETS THE OWNER'S MESSAGE ASIDE (owner decision 12), through the real turn: the
// provider refuses a prompt that is too long, recovery forces a pass and parks the job, and the hand-back counts
// nothing and writes no due; the clock leaves the person to the parked continuation.
// ════════════════════════════════════════════════════════════════════════════════
describe('a context overflow never sets the owner\'s message aside, through the real turn', () => {
  const ask = (): { state: string; due: number | null } => mockDb.current!
    .prepare("SELECT state, next_attempt_at AS due FROM work WHERE id = 'ask:msg-user-1'").get() as { state: string; due: number | null };
  const marks = (): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'ask:msg-user-1'
    AND ((kind = 'audit' AND json_extract(payload, '$.marker') = 'ct0_ask_re_served') OR kind = 'floor_ghosted')`).get() as { n: number }).n;
  afterEach(async () => { (await import('../../../work/task-freshness.js')).endJobCarry('primary'); });

  it('six full-context turns leave it owed, uncounted and undated; the clock leaves it to the parked job; it is served when room returns', async () => {
    const { dueOf } = await import('../owed.js');
    isContextOverflowErrorMock.mockImplementation(() => true);
    callModelSpy.mockRejectedValue(new Error('400 prompt is too long: 250000 tokens > 200000 maximum'));
    for (let turn = 1; turn <= 6; turn++) {
      await runV2Turn('primary');
      expect(ask(), `overflow ${turn}`).toEqual({ state: 'open', due: null });
      expect(dueOf('primary').now, `overflow ${turn}: the parked job's continuation serves it`).toBe(false);
    }
    expect(marks(), 'no count and no stand-down record').toBe(0);
    isContextOverflowErrorMock.mockImplementation(() => false);
    callModelSpy.mockReset();
    callModelSpy.mockResolvedValue({ content: 'Here is the summary.', toolCalls: [] as ToolCall[], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' });
    await runV2Turn('primary');
    expect(callModelSpy).toHaveBeenCalled();
    expect(ask().state, 'served again once there is room').not.toBe('blocked');
  });
});

describe('a provider limit after a paid call is counted, through the real turn', () => {
  it('one tool call, then a 429: the request is counted once and waits for the later of the reset and the backoff', async () => {
    let n = 0;
    callModelSpy.mockImplementation(async () => {
      n += 1;
      if (n === 1) return { content: '', toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: '/tmp/x' } }] as ToolCall[], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
      throw new Error('429 Rate limit exceeded');
    });
    executeToolSpy.mockResolvedValue({ toolCallId: 'tc1', name: 'file_read', content: 'ok', isError: false });
    const before = Date.now();
    await runV2Turn('primary');
    expect(n).toBe(2);
    const row = mockDb.current!.prepare("SELECT state, next_attempt_at AS due FROM work WHERE id = 'ask:msg-user-1'").get() as { state: string; due: number };
    expect(row.state).toBe('open');
    expect(row.due).toBeGreaterThanOrEqual(before + 60_000);
    const engine = (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'ask:msg-user-1' AND kind = 'audit'
      AND json_extract(payload, '$.cause') = 'cut'`).get() as { n: number }).n;
    expect(engine).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A STOOD-DOWN REQUEST COMES BACK WHEN THE PERSON WRITES AGAIN, through the real pickup and finalize: the new message's
// turn claims it and settles it; a failed turn stands it down again at once, the owner is not told twice, and a serve of
// another request of the same person lifts nothing.
// ════════════════════════════════════════════════════════════════════════════════
describe('a stood-down request comes back when the person writes again, through the real turn', () => {
  const state = (id: string): string => (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(`ask:${id}`) as { state: string }).state;
  const told = (): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'ask:msg-user-1'
    AND kind = 'floor_ghosted' AND json_extract(payload, '$.floor') = 'request-stood-down'`).get() as { n: number }).n;
  const writesAgain = (id: string): void => { insertMessage({ id, agentId: 'primary', role: 'user', content: 'any news?', channel: 'dashboard',
    senderId: 'owner', conversationId: 'conv-primary', inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) }); };

  it('the new message serves it with one model call; a failure holds it again; another serve lifts nothing', async () => {
    callModelSpy.mockRejectedValue(new Error('500 internal server error'));
    for (let turn = 1; turn <= 6; turn++) { backoffPasses(); await runV2Turn('primary'); }
    expect(state('msg-user-1')).toBe('blocked');
    expect(told()).toBe(1);

    writesAgain('msg-user-2');
    callModelSpy.mockClear();
    await runV2Turn('primary');
    expect(callModelSpy, 'one turn serves both').toHaveBeenCalledTimes(1);
    expect(state('msg-user-1'), 'the failed turn stands it down again at once').toBe('blocked');
    expect(told(), 'told once per request').toBe(1);

    backoffPasses();
    await runV2Turn('primary');
    expect(state('msg-user-2'), 'the backoff serve of the newer request ran').not.toBe('claimed');
    expect(state('msg-user-1'), 'a serve of another request lifts nothing').toBe('blocked');
  });
});
