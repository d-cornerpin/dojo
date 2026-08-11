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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-integration-test', 'dojo.db'),
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
  AgentError: class AgentError extends Error {
    constructor(message: string, public agentId: string, public options?: { code?: string }) {
      super(message);
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
// PHASE-6 GUARD-AUDIT 2026-08-04: `node:fs` / `node:path` / `fileURLToPath` went with the
// hand-rolled engine walk below — the derivation lives in `engine-sources.ts` now.
import { engineText } from './engine-sources.js';
import { runV2Turn } from '../loop.js';
import { stoppedAgents, recoveryRunStreak, pendingWakeups, turnContinuationCounts } from '../../shared-state.js';
import { turnContext } from '../../turn-context.js';
import { recordDelivery } from '../deliveries.js';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { claimAsk, askIdForMessage } from '../../../work/store.js';

// ── Test helpers ──

function setupTestDb(): Database.Database {
  const db = new Database(':memory:');

  // Run the REAL migration chain instead of hand-rolling CREATE TABLE
  // statements. The previous hand-rolled fixture drifted 4+ weeks behind the
  // engine (no conv_key, no inter_agent_messages, no tool_receipts, no
  // open_loops, ...) and every schema addition broke this suite. runMigrations
  // resolves the DB via the mocked getDb(), so point the mock at this
  // instance first.
  mockDb.current = db;
  runMigrations();

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

// The ENGINE'S OWN SOURCE — the driver plus every step package under `agent/v2/steps/`.
// PHASE-6 cuts the driver into step directories one tranche at a time, so a source scan
// pinned to `loop.ts` alone stops seeing its subject the moment that subject moves, and
// it goes QUIET rather than red. Same widening, same reason, as CUT 1's repair to
// `engine-steer.test.ts`; the eight tranches behind this one are covered by construction.
//
// PHASE-6 GUARD-AUDIT 2026-08-04: the corpus is UNCHANGED in reach; what changed is that
// it is no longer derived here. The audit found six guards each hand-rolling this same
// walk, which is six places the definition of "the engine" can drift apart — the same
// silent-drift defect one level up. `engineText()` is that derivation, made once, and it
// is strictly stricter than the copy it replaces: it recurses into step SUB-modules (a
// step is a DIRECTORY under RULING P6-R1) and it THROWS if the driver has moved, where
// this copy would have quietly returned a corpus with no driver in it.
function engineSource(): string {
  return engineText();
}

function getBroadcastEventsByType(type: string): unknown[] {
  return broadcastSpy.mock.calls
    .map((call) => call[0])
    .filter((e: { type?: string }) => e.type === type);
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
  sendResponseViaIMessageSpy.mockClear();
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
  pendingWakeups.clear();
  turnContinuationCounts.clear();
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

  it('PRESERVATION #37: pre-call compaction gate fires WARN at 90%', async () => {
    // Simulate context at 92% utilization
    estimateAssembledTokensMock.mockImplementation(() => ({
      total: 184000, // 92% of 200000
      summaryTokens: 0,
      freshTailTokens: 184000,
      briefTokens: 0,
      freshTailCount: 1,
      summaryCount: 0,
    }));

    callModelSpy.mockResolvedValue({
      content: 'OK',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // chat:error with code CONTEXT_HIGH should fire (warn doesn't block,
    // turn continues normally)
    const errors = getBroadcastEventsByType('chat:error') as Array<{ code?: string }>;
    const contextHigh = errors.find((e) => e.code === 'CONTEXT_HIGH');
    expect(contextHigh).toBeDefined();

    // checkAndCompact NOT called for warn (only for compact/block)
    expect(checkAndCompactSpy).not.toHaveBeenCalled();

    // Turn should still complete normally
    expect(callModelSpy).toHaveBeenCalledTimes(1);
  });

  it('PRESERVATION #37: pre-call compaction gate triggers emergency compact at 96%', async () => {
    estimateAssembledTokensMock.mockImplementation(() => ({
      total: 196000, // 98% of 200000
      summaryTokens: 0,
      freshTailTokens: 196000,
      briefTokens: 0,
      freshTailCount: 1,
      summaryCount: 0,
    }));

    callModelSpy.mockResolvedValue({
      content: 'OK',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // Emergency compaction was forced
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'primary',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ force: true }),
    );

    // Model NOT called this turn, we surrendered after emergency compact
    expect(callModelSpy).not.toHaveBeenCalled();
  });

  it('PRESERVATION #14: auto-continuation fires at MAX_TOOL_LOOPS (75) and schedules a fresh turn', async () => {
    // v2/loop.ts:1282-1320, when the inner tool loop hits MAX_TOOL_LOOPS
    // (=75) without the model deciding to stop, persist a [System: ...]
    // message and self-schedule another handleMessage call. This is the
    // safety valve for long autonomous tasks.
    //
    // Simulate a model that ALWAYS wants another tool call. The loop
    // should run 75 iterations, then trigger auto-continue.
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
      content: 'file body, keep going',
      isError: false,
    }));

    // Use fake timers so the setTimeout(handleMessage, 1000) in the
    // auto-continue path fires within the test.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runV2Turn('primary');
      // Drain the 1s delay before handleMessage('') fires.
      await vi.advanceTimersByTimeAsync(1500);
    } finally {
      vi.useRealTimers();
    }

    // Hit MAX_TOOL_LOOPS exactly (75 model calls inside the loop).
    expect(modelCallCount).toBe(75);

    // The system message documenting the auto-continue was persisted.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/75 tool calls.*Starting a fresh turn/);

    // handleMessage('') was called to continue.
    expect(handleMessageSpy).toHaveBeenCalledWith('primary', '');
  });

  it('PRESERVATION #37: pre-call compaction gate surrenders turn at ≥99%', async () => {
    // The 99% surrender path: persist a [System: …] note explaining the
    // surrender, force checkAndCompact, queue a wakeup, do NOT call the
    // model. The recovery cascade re-runs with compacted context next turn.
    estimateAssembledTokensMock.mockImplementation(() => ({
      total: 199500, // 99.75% of 200000
      summaryTokens: 0,
      freshTailTokens: 199500,
      briefTokens: 0,
      freshTailCount: 1,
      summaryCount: 0,
    }));

    callModelSpy.mockResolvedValue({
      content: 'should not be called',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('primary');

    // Forced compaction was attempted.
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'primary',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ force: true }),
    );

    // Model was NOT called this turn, we surrendered.
    expect(callModelSpy).not.toHaveBeenCalled();

    // A [System: ...] note was persisted explaining the surrender.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/memory is too full|impossibly full|pausing|surrender/i);
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
    const errors = getBroadcastEventsByType('chat:error') as Array<{ code?: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('MODEL_FAILED');

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

  it('PRESERVATION: no-results detector nudges after 2 consecutive empty turns, breaks after a 3rd', async () => {
    // v2/loop.ts:1194-1232, when every tool result in a turn contains
    // "No results found" / "not in memory" for two consecutive iterations,
    // a steer fires telling the model to switch tactics. If the
    // third iteration is STILL all-no-results, the loop breaks with a
    // NO_RESULTS chat:error. This pins both transitions.
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
    executeToolSpy.mockImplementation(async (_agentId, toolCall) => ({
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: `No results found for "${toolCall.arguments.pattern}".`,
      isError: false,
    }));

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

  it('PRESERVATION: the repetition detector nudges once, then breaks with STUCK_REPEATING', async () => {
    // The post-execution gates' first floor (v1 runtime.ts:1622-1634): when the
    // model produces the SAME text AND the SAME tool calls two iterations running
    // it is stuck. The engine nudges ONCE through the steer queue; if the next
    // iteration is identical again it breaks with a STUCK_REPEATING chat:error.
    // The loopDetector catches duplicate TOOL-CALL patterns — this catches
    // duplicate FULL responses, which is why it is a separate floor.
    //
    // PHASE-6 T8: this guard had NO test of its own (`git grep STUCK_REPEATING`
    // over the suite = 0 hits before this clause). It is written here BEFORE the
    // gates are relocated into `agent/v2/steps/post-execution/`, so the
    // requirement is held by a test that passed on the tree the move starts from
    // — non-negotiable #2, the guard converted before its code is touched.
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      // Byte-identical every iteration: same text, same tool name, same arguments.
      // Only the call id varies, and the signature deliberately ignores it.
      return {
        content: 'Let me check that again.',
        toolCalls: [
          { id: `tc-${modelCallCount}`, name: 'history_search', arguments: { pattern: 'same' } },
        ],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      };
    });
    executeToolSpy.mockImplementation(async (_agentId, toolCall) => ({
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: 'Found 3 matching messages: ...',
      isError: false,
    }));

    await runV2Turn('primary');

    // iter 1 records the signature; iter 2 matches it and fires the one-shot nudge,
    // then CONTINUES; iter 3 matches it again with the steer already fired and
    // BREAKS. A fourth call would mean the break never happened.
    expect(modelCallCount).toBe(3);

    const stuckErrors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>).filter(
      (e) => e.code === 'STUCK_REPEATING',
    );
    expect(stuckErrors).toHaveLength(1);

    // Both transitions, not just the terminal one: the nudge fired on iteration 2.
    const nudged = loggerWarnSpy.mock.calls.some((c) =>
      String(c[0]).includes('agent repeating itself, nudging on next iteration'),
    );
    expect(nudged).toBe(true);
  });

  it('PRESERVATION #38: empty after tool calls is a clean end-of-turn (no toast)', async () => {
    // Carve-out from v1 runtime.ts:1167-1171, if the agent already executed
    // tool calls this turn and now returns empty, that's a legitimate end.
    // No retry, no nudge, no toast.
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
        content: '',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 0,
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

    // Two model calls: tool-use then empty end-of-turn. No silent retry.
    expect(modelCallCount).toBe(2);
    const errors = getBroadcastEventsByType('chat:error');
    expect(errors).toHaveLength(0);
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

  it('PHASE 6: rate-limit 429 → injury + RATE_LIMITED code + rate-limit system msg', async () => {
    callModelSpy.mockRejectedValue(new Error('429 Rate limit exceeded'));

    await runV2Turn('primary');

    expect(onAgentInjuredSpy).toHaveBeenCalled();

    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string; severity?: string; retryable?: boolean }>);
    const rateLimited = errors.find((e) => e.code === 'RATE_LIMITED');
    expect(rateLimited).toBeDefined();
    expect(rateLimited?.severity).toBe('warning');
    expect(rateLimited?.retryable).toBe(true);

    // v2.3.19, system message text updated to the spec's plain-English
    // template. Tests assert the agent-facing language, not the old
    // "[Rate limited]" bracket.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system'")
      .all() as Array<{ content: string }>;
    expect(sysMsgs.find((m) => /rate limit error/i.test(m.content) && /retrying automatically/i.test(m.content))).toBeDefined();
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
  "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]";

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
    const carrying = seenByModel.filter((msgs) => indexOfEntry(msgs, EMPTY_RESPONSE_NUDGE) >= 0);
    expect(carrying).toHaveLength(1);
    expect(seenByModel.indexOf(carrying[0])).toBe(2);
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

    // The trigger: a WORK-classified human ask (three action verbs → the multistep
    // heuristic's `definitely_multi`, so no classifier model call is needed).
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

  it('PROVENANCE: the threshold watched here is the engine\'s own declaration', () => {
    // The corpus is the ENGINE'S source — the driver plus every step package — for the
    // reason CUT 1 recorded on `engine-steer.test.ts`: this phase moves the driver's
    // spans into `agent/v2/steps/`, and a scan pinned to one file goes QUIET rather than
    // red when its subject moves out from under it.
    expect(engineSource()).toMatch(
      new RegExp(`const ENGINE_START_ACK_AFTER_MS = ${START_ACK_AFTER_MS};`),
    );
  });

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
// WHAT THE RECAP IS FOR, in the incident's own terms (2026-07-23, the owner's .19
// transcript): a MID-TURN rebuild can evict the model's own in-turn speech while the
// trigger message stays pinned, so every rebuilt context reads as "the user just said
// this and I have not responded" and the model re-acknowledges from scratch — seven
// near-identical apologies in one long turn. The recap is the engine handing over the
// receipts it holds: same turn, this many tool calls, and whether the person has
// already been acknowledged.
//
// THE RECAP IS ALSO THIS TRANCHE'S CROSSING TEST, and it is deliberately split into
// the half that can be DRIVEN and the half that can only be READ.
//   · DRIVEN: the tool-call count comes off `state`, live. Two arms (one round vs
//     two) fail on any relocation that hands the step a stale turn state.
//   · READ: the ack sentence is chosen from three flags, two of which
//     (`deferredDeliveredByAck`, `engineStartAckDeliveredThisTurn`) are mutable
//     locals of the DRIVER that this span reads. Reaching their true arm needs the
//     start-ack steer to have already fired mid-turn, which this fixture cannot
//     stage honestly, so the true arm is held by a source clause over the ENGINE's
//     own corpus instead — stated as such rather than dressed up as behaviour.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 3: the turn-time budget forces a compaction and hands the turn its own receipts', () => {
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
   *
   * `continuationsAlready` is seeded from INSIDE the first tool call on purpose, and the
   * reason is a measured one: preflight deletes the counter for any turn that claims work
   * (`loop.ts:1203` — a turn that picks up fresh work is not a continuation), so a value
   * set before `runV2Turn` would be wiped before the gate ever read it.
   */
  async function runAcrossTheBudget(
    opts: { batch?: number; continuationsAlready?: number } = {},
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
      if (executed === 1 && opts.continuationsAlready !== undefined) {
        turnContinuationCounts.set('primary', opts.continuationsAlready);
      }
      // The budget can only be crossed BETWEEN iterations — the gate is read once per
      // loop head — so the jump rides the LAST tool of the round.
      if (executed === batch) clock.jump(TURN_TIME_BUDGET_MS + 60_000);
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

  it('crossing the budget forces a compaction, recaps the SAME turn, and parks for a continuation', async () => {
    await runAcrossTheBudget();

    // The rebuild really happened — the recap is a consequence of it, not of the clock.
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'primary', expect.any(String), expect.any(Number), expect.objectContaining({ force: true }),
    );

    const r = recaps();
    expect(r).toHaveLength(1);
    // The three things the 2026-07-23 incident needed said, asserted rather than summarised.
    expect(r[0]).toContain('memory was just compacted MID-TURN');
    expect(r[0]).toContain('This is still the SAME turn');
    expect(r[0]).toContain('Do NOT re-introduce yourself, re-acknowledge, or re-apologize');

    // The turn parks rather than dying: the person is told, and a wakeup is queued so
    // the work resumes on a fresh turn.
    const sys = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sys[0].content).toMatch(/This turn ran for \d+ minutes[\s\S]*continuing on a fresh turn \(1 of 3\)/);
    expect(pendingWakeups.has('primary')).toBe(true);
  });

  it('the recap\'s tool-call number is read LIVE off the turn state', async () => {
    // Two arms that differ only in the live turn state make a STALE state visible. A
    // relocation that handed the gate a snapshot taken at turn start would report the same
    // number twice.
    await runAcrossTheBudget({ batch: 1 });
    expect(recaps()[0]).toContain('made 1 tool call(s)');

    enqueueSteerSpy.mockClear();
    checkAndCompactSpy.mockClear();
    pendingWakeups.clear();
    turnContinuationCounts.clear();
    mockDb.current = setupTestDb();

    await runAcrossTheBudget({ batch: 2 });
    expect(recaps()[0]).toContain('made 2 tool call(s)');
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // PHASE-6 T13 — THE COUNT MEANS WHAT ITS OWN SENTENCE SAYS (CUT 3's H1).
  //
  // The recap reads "So far this turn you have made N tool call(s)" and N was
  // `state.toolCalls.length` — the LAST model response's batch, which `callLLM` sets
  // from `result.toolCalls` on every round. On a turn of two rounds of one tool each
  // the sentence said "so far this turn" over the number 1. The single-round arms
  // above could not see it: with one round the batch and the turn total are the same
  // number, which is exactly how the defect survived being tested.
  //
  // A user-facing sentence that misstates its own number is an honesty defect, and the
  // fix is the number, not the wording: the recap exists to hand the model the receipts
  // of what THIS TURN already did (2026-07-23, the seven-apologies transcript), so the
  // turn total is the number the sentence was always asking for. `state
  // .toolCallsExecutedThisTurn` already IS that count — one owner, incremented once per
  // executed call in `steps/execute/post-result.ts`, and bounds-checked by `state.ts`'s
  // own runaway guard. Nothing new was declared to fix this.
  // ══════════════════════════════════════════════════════════════════════════════
  it('THE UNIT: on a MULTI-BATCH turn the recap counts the TURN, not the last batch', async () => {
    // Two rounds of one tool each. The turn made 2 tool calls; the last batch was 1.
    let call = 0;
    callModelSpy.mockImplementation(async () => {
      call++;
      return call <= 2
        ? {
          content: '',
          toolCalls: [{ id: `tc-r${call}`, name: 'file_read', arguments: { path: `/tmp/r${call}.txt` } }],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        }
        : { content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    const clock = controllableClock();
    let executed = 0;
    executeToolSpy.mockImplementation(async (_agentId: string, toolCall: ToolCall) => {
      executed++;
      // Cross the budget only after the SECOND round, so the gate meets a turn whose
      // total (2) and whose last batch (1) are different numbers.
      if (executed === 2) clock.jump(TURN_TIME_BUDGET_MS + 60_000);
      return { toolCallId: toolCall.id, name: toolCall.name, content: 'file body', isError: false };
    });
    try {
      await runV2Turn('primary');
    } finally {
      clock.restore();
    }

    expect(executed).toBe(2);
    const r = recaps();
    expect(r).toHaveLength(1);
    // The sentence and the number are read together, in one assertion, because the
    // defect was precisely that they disagreed.
    expect(r[0]).toContain('So far this turn you have made 2 tool call(s)');
    expect(r[0]).not.toContain('made 1 tool call(s)');
  });

  it('the ack sentence is ABSENT when nobody has acknowledged the person — and the engine reads exactly the three flags that could say otherwise', async () => {
    await runAcrossTheBudget();
    expect(recaps()[0]).not.toContain('ALREADY heard your acknowledgment');

    // The TRUE arm is held here rather than driven, and the corpus is the ENGINE's own
    // source (driver + every step package), so this keeps holding after the tranche moves.
    // Two of the three are mutable locals of the DRIVER that this span only reads; a
    // relocation that dropped them, or replaced one with a constant, fails this clause.
    const cond = engineText().match(/state\.surfacedReplyThisTurn \|\| deferredDeliveredByAck \|\| engineStartAckDeliveredThisTurn/g) ?? [];
    expect(cond).toHaveLength(1);
    expect(engineText()).toContain('ALREADY heard your acknowledgment');
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

  it('past MAX_TURN_AUTO_CONTINUATIONS the turn STOPS instead: no compaction, no recap, and the person is told', async () => {
    await runAcrossTheBudget({ continuationsAlready: 3 });

    expect(checkAndCompactSpy).not.toHaveBeenCalled();
    expect(recaps()).toEqual([]);
    expect(pendingWakeups.has('primary')).toBe(false);
    // The counter is CLEARED at the cap, so a later turn starts the ladder again.
    expect(turnContinuationCounts.has('primary')).toBe(false);
    const sys = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'primary' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sys[0].content).toMatch(/running for about 60 minutes without finishing/);
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
// takes six identical failures plus three refusals; that arm is driven at the unit level
// in `identical-call-brake.test.ts` (the rung's first-ever clauses). What THIS clause has
// to prove is the DRIVER's half — that an exhausted grace ends the turn — so the latch is
// seeded from inside the first tool call, which is this file's own precedent (the
// turn-budget block seeds `turnContinuationCounts` the same way and for the same reason).
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
    // to MAX_TOOL_LOOPS (75), which is what it did before.
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
    // "I texted Michael" with no delivery receipt anywhere. The floor fires as a
    // tripwire, naming the row — and the recovery still happens, because the loop has
    // exited and silence is the worse failure.
    callModelSpy
      .mockResolvedValueOnce({
        content: 'I texted Michael the details.',
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
         VALUES ('d-failed-1', 'primary', ?, 'imessage_send', 'imessage', 'Michael', 'Michael', 'failed')`,
      ).run(t?.turn_number ?? null);
      return { toolCallId: 'tc1', name: 'file_write', content: 'written', isError: false };
    });

    await runV2Turn('primary');

    // IT STILL DELIVERS. This is the whole point of the tripwire shape: the loop has
    // exited, there is no re-entry to correct the model, and silence is the worse
    // failure. A version of this guard that VETOED would pass a "did not double-send"
    // assertion and re-open the defect G-SUP-2 exists to close.
    expect(assistantRows().map((r) => r.content)).toEqual(['I texted Michael the details.']);
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
// ⚠ SWEEP-A TB1 (2026-08-05) — THE SECOND ARM'S DIRECTION WAS REVERSED BY THE OWNER, and
// these clauses are updated rather than deleted because the ABORT-PATH refusal itself is
// untouched. His governing ruling: "the user asks the agent to do something and it does it.
// Period." — an ambiguous or absent answer errs toward SERVING THE ASK AGAIN, never toward
// silence or a parked ticket. `revertAskClaimOnAbort` still refuses to re-arm mid-abort and
// still writes `rearm_refused`, so the fact that the turn acted is recorded exactly as
// before; but at the TURN BOUNDARY the settlement authority (`work/ask-settlement.ts`) now
// adjudicates every ask the turn held, and an ask with no delivery behind it goes back to
// `open` whatever the turn did. The residual the owner accepted, stated out loud: a
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
    const handBack = eventsFor(before.id).find((e) => String(e.payload ?? '').includes('handing the ask back to the waiting set'));
    expect(handBack, 'no hand-back event on the ask').toBeTruthy();
    expect(kinds(before.id)).not.toContain('rearm_refused');
  });

  it('THE REFUSAL IS RECORDED, AND THE TURN BOUNDARY STILL HANDS THE ASK BACK', async () => {
    // One successful send, then the model dies. The abort arm still REFUSES to re-arm and
    // writes `rearm_refused`, so "this turn already acted" stays a fact somebody can find —
    // that half is untouched. What changed is the turn BOUNDARY: the owner ruled on
    // 2026-08-05 that an ask with no answer behind it is served again rather than parked, and
    // no ask may outlive its turn `claimed`. So the row ends `open`, carrying both records.
    let n = 0;
    callModelSpy.mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        return {
          content: '', toolCalls: [{ id: 'tc1', name: 'imessage_send', arguments: { to: 'Michael', text: 'on it' } }] as ToolCall[],
          inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
        };
      }
      throw new Error('provider exploded');
    });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc1', name: 'imessage_send', content: 'sent', isError: false,
    });

    const before = askRow();
    await runV2Turn('primary');

    expect(n).toBe(2);                                   // positive control: it did die on the second call
    expect(kinds(before.id)).toContain('rearm_refused'); // P6b's abort refusal, unchanged
    expect(askRow().state).toBe('open');                 // …and the boundary hands it back anyway
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

  it('FA-M1: the fresh-tail eviction warning fires ONCE PER TURN, not once per iteration', async () => {
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
    expect(contextHighErrors()).toHaveLength(1);
    expect(evictionWarns()).toHaveLength(1);
    // The banner names the count it set aside, pluralised — the user-facing half.
    expect(contextHighErrors()[0].error).toContain('3 oldest recent messages');
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
// PHASE-6 CUT 7 (T7, `execute`) — THE A2A RE-SEND CAP GETS THE FIRST TEST IT HAS
// EVER HAD, GREEN ON THE UNMOVED TREE, BEFORE THE SPAN MOVES.
//
// How it was found, by command rather than by eye:
//   git grep -l A2A_SEND_CAP_PER_RECIPIENT -- 'packages/server/src/*__tests__*'  → nothing
//   git grep -l A2A_SEND_CAP_PER_RECIPIENT   (the whole kit repo)                → nothing
//
// WHY THIS GUARD: the plan names it as one of this tranche's three carried duties
// ("`execute`: once-guard + brake stay at the executor choke point; A2A send cap
// carried"), it is the only one of the three with no test anywhere, and it carries
// its incident at its own site — "observed: 29 send_to_agent calls to one agent in
// a single turn". Non-negotiable #2 in its strict form: the requirement is written
// down before the code is touched.
//
// WHAT THE REQUIREMENT IS, in the guard's own terms: inter-agent replies are
// ASYNCHRONOUS, so an agent that gets no instant answer re-sends the same ask
// REWORDED — which defeats the content-signature dedup, because every rewording is
// a new signature. The cap is per RECIPIENT per TURN, set well above any genuine
// multi-send, and different recipients are independent.
// ════════════════════════════════════════════════════════════════════════════════
describe('PHASE-6 CUT 7: the execute span kept the A2A re-send cap nobody tested', () => {
  /** The rewording defect, exactly: same tool, same recipient, a different body each
   *  time — so the loop detector's signature dedup never sees a repeat. */
  const sendTo = (to: string, n: number): ToolCall =>
    ({ id: `tc-${to}-${n}`, name: 'send_to_agent', arguments: { to_agent: to, message: `ask number ${n} about the report` } } as ToolCall);

  const toolResultBroadcasts = (): string[] =>
    (getBroadcastEventsByType('chat:tool_result') as Array<{ tool?: string; result?: string }>)
      .filter((e) => e.tool === 'send_to_agent')
      .map((e) => String(e.result ?? ''));

  const sendsExecuted = (): number =>
    executeToolSpy.mock.calls.filter((c) => (c[1] as ToolCall)?.name === 'send_to_agent').length;

  function answerAfter(calls: ToolCall[]): void {
    let n = 0;
    callModelSpy.mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        return { content: '', toolCalls: calls, inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
      }
      return { content: 'sent', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    executeToolSpy.mockImplementation(async (_agentId: string, tc: ToolCall) => ({
      toolCallId: tc.id, name: tc.name, content: 'queued', isError: false,
    }));
  }

  it('the SIXTH send to one recipient is refused and never reaches the tool', async () => {
    // The cap is 5 per recipient per turn. Six reworded sends to one agent: five run,
    // the sixth is refused BEFORE execution — no side effect, no provider cost.
    answerAfter([1, 2, 3, 4, 5, 6].map((n) => sendTo('alice', n)));

    await runV2Turn('primary');

    expect(sendsExecuted()).toBe(5);
    const refusals = toolResultBroadcasts().filter((r) => r.includes('already sent'));
    expect(refusals).toHaveLength(1);
    // The refusal names the recipient and the cap, and says WHY re-sending cannot help.
    expect(refusals[0]).toContain('"alice"');
    expect(refusals[0]).toContain('5 messages this turn');
    expect(refusals[0]).toContain('ASYNCHRONOUS');
  });

  it('DIFFERENT RECIPIENTS ARE INDEPENDENT — the cap is per recipient, not per turn', async () => {
    // The clause a per-TURN cap would fail: alice is at her limit, bob has sent nothing,
    // and bob's message must go through. Without this arm, tightening the cap into a
    // per-turn budget would pass the clause above.
    answerAfter([...[1, 2, 3, 4, 5].map((n) => sendTo('alice', n)), sendTo('bob', 1)]);

    await runV2Turn('primary');

    expect(sendsExecuted()).toBe(6);
    expect(toolResultBroadcasts().filter((r) => r.includes('already sent'))).toHaveLength(0);
  });

  it('POSITIVE CONTROL: five sends to one recipient all go through', async () => {
    // Without this arm the first clause passes on a tree that refuses everything.
    answerAfter([1, 2, 3, 4, 5].map((n) => sendTo('alice', n)));

    await runV2Turn('primary');

    expect(sendsExecuted()).toBe(5);
    expect(toolResultBroadcasts().filter((r) => r.includes('already sent'))).toHaveLength(0);
  });

  it('THE REFUSAL IS A RESULT, NOT A TURN-ENDER: the model gets the refusal back and answers', async () => {
    // The cap refuses ONE call; it does not break the loop. On a turn whose
    // counterparty is a person, the agent still owes them an answer, and the engine
    // hands the refusal back as a tool result so the model can end its turn in text.
    answerAfter([1, 2, 3, 4, 5, 6].map((n) => sendTo('alice', n)));

    await runV2Turn('primary');

    expect(callModelSpy).toHaveBeenCalledTimes(2);
    const assistant = mockDb.current!
      .prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1")
      .get() as { content: string } | undefined;
    expect(assistant?.content).toBe('sent');
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
//   git grep -l "You told the user you saved that"         → nothing, either repo
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
//   * a save CLAIM in the terminal text (not merely a failed tool);
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
    expect(steer).toContain('You told the user you saved that');
    expect(steer).toContain('all 2 vault_remember calls this turn');
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
    expect(messagesOfCall(1)).not.toContain('You told the user you saved that');
  });

  it('THE SCOPE ARM: a rejected save with NO claim in the reply is not this floor\'s business', async () => {
    await driveClaimTurn({
      saves: 1,
      accept: () => false,
      texts: ['That did not go through — want me to try again?'],
    });

    expect(callModelSpy).toHaveBeenCalledTimes(2);
    expect(messagesOfCall(1)).not.toContain('You told the user you saved that');
  });

  it('ONE SHOT: the model repeats the claim after the steer and the engine does NOT steer again', async () => {
    // The `steerFired` guard is what stops an unrepentant model spinning the loop on a
    // floor that re-enters. Without it this turn would ping-pong until MAX_TOOL_LOOPS.
    await driveClaimTurn({
      saves: 1,
      accept: () => false,
      texts: ['Saved that for you.', 'I saved it, honestly.', 'Fine — it is not saved.'],
    });

    // The steer is persisted as its own role='system' row (`persistEngineSteer`), so the
    // number of rows IS the number of times the floor fired — a count the prompt text
    // cannot give, because once persisted the steer rides every later assembly.
    const rows = mockDb.current!
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'system' AND content LIKE '%You told the user you saved that%'")
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
// BUG-2 — THE LANE SEPARATION AT THE PRE-TURN CLOSE-OUT GATE.
//
// PHASE-6 T2 (CUT 9) Step 1a: THE GUARD IN THIS SPAN WITH NO TEST ANYWHERE, found by
// command rather than by eye. `git grep -ln BUG-2` over every `__tests__` directory in
// this repo exits 1, and over the WHOLE kit repo exits 1. `git grep -ln "REQUIRED
// close-out"` over every `__tests__` directory exits 1 — no test in either repo drives
// the pre-turn close-out gate at all. The kit names the literal in exactly one place,
// `behavioral/invariants.mjs`'s ENGINE_REFUSAL_SIGNATURES, which is a list used to
// RECOGNISE an engine refusal in a transcript; no scenario asserts this guard.
//
// WHAT IT PROTECTS, in the words of the incident recorded at its own site: armed on a
// conversation turn, the gate "(a) DELETED the agent's just-streamed reply and (b)
// REFUSED the tool calls the agent needed to answer, both silent-drop / blocked-turn
// failures (inv 2, inv 6) on the weak-model floor". Task close-out is Lane 2/3
// machinery; the lane-separation law says it has no business running in the middle of
// a Lane-1 conversation about something else. The mechanism is ONE ternary:
//
//     const danglingRows = triggerRow ? [] : [...inProgressDanglers, ...strandedRows];
//
// The clauses drive `runV2Turn` end to end and read the ENFORCEMENT, not the arming
// flag: a gate that armed but never bit, or bit but never armed, is a different tree
// from the one this guard describes.
// ════════════════════════════════════════════════════════════════════════════════
describe('BUG-2: the pre-turn close-out gate never arms on a turn a human is waiting on', () => {
  /** The engine's own idle window; asserted against its declaration by the provenance
   *  clause below, so a fixture that has drifted off the real threshold fails loudly
   *  instead of quietly seeding a dangler the gate was never going to see. */
  const CLOSE_OUT_IDLE_MINUTES = 10;

  /** A task this agent claimed and has not touched since well before the window — the
   *  exact row shape `(1) Tasks the agent is in_progress on` selects. */
  function seedDangler(id = 'w-dangler'): void {
    const stale = Date.now() - (CLOSE_OUT_IDLE_MINUTES + 20) * 60_000;
    mockDb.current!.prepare(
      `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, opened_at, updated_at)
       VALUES (?, 'primary', 'task', 'owner', 'tracker', ?, 'claimed',
               'action', 1, 0, 'the abandoned one', ?, ?)`,
    ).run(id, id, stale, stale);
  }

  /** The model reaches straight for a NON-tracker tool, then answers. That first call is
   *  what the armed gate refuses and what the disarmed gate must let through. */
  function callsANonTrackerToolThenAnswers(): void {
    const call: ToolCall = { id: 'tc-gate', name: 'get_current_time', arguments: {} };
    callModelSpy
      .mockResolvedValueOnce({
        content: '', toolCalls: [call], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      })
      .mockResolvedValue({
        content: 'done', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn',
      });
    executeToolSpy.mockResolvedValue({
      toolCallId: 'tc-gate', name: 'get_current_time', content: '12:00', isError: false,
    });
  }

  const gateRows = (): number => (mockDb.current!.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'primary' AND role = 'system'
       AND content LIKE '[System: REQUIRED close-out%'`,
  ).get() as { n: number }).n;

  const refusedCloseOut = (): boolean => executeToolSpy.mock.results.length === 0
    ? broadcastSpy.mock.calls.some((c) => {
      const e = c[0] as { type?: string; result?: string };
      return e.type === 'chat:tool_result' && typeof e.result === 'string'
        && e.result.includes('Refused: engine close-out gate');
    })
    : broadcastSpy.mock.calls.some((c) => {
      const e = c[0] as { type?: string; result?: string };
      return e.type === 'chat:tool_result' && typeof e.result === 'string'
        && e.result.includes('Refused: engine close-out gate');
    });

  it('PROVENANCE: the idle window seeded here is the engine\'s own declaration', () => {
    // Over the ENGINE's source — the driver plus every step package — so this clause
    // follows the code through the cut instead of going quiet when it moves.
    expect(engineSource()).toMatch(
      new RegExp(`const CLOSE_OUT_IDLE_MINUTES = ${CLOSE_OUT_IDLE_MINUTES};`),
    );
  });

  it('POSITIVE CONTROL: on a background turn the gate ARMS and REFUSES the non-tracker call', async () => {
    // Nothing is waiting: the seeded ask is claimed, so this turn has no trigger row and
    // is exactly the Lane 2/3 turn close-out enforcement is FOR. Without this control a
    // green BUG-2 clause below could mean "the gate never fires at all", which is the
    // opposite finding.
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    seedDangler();
    callsANonTrackerToolThenAnswers();

    await runV2Turn('primary');

    expect(gateRows()).toBe(1);
    expect(refusedCloseOut()).toBe(true);
    expect(executeToolSpy).not.toHaveBeenCalled();
  });

  it('BUG-2: the SAME dangler on a turn serving a waiting human neither arms nor refuses', async () => {
    // The only difference from the control is that a person is waiting — the seeded ask
    // is left unclaimed, so the turn picks it up and `triggerRow` is set. The dangler is
    // identical and just as stale. This is the clause a tree without the ternary fails,
    // and the failure it fails on is the recorded one: the reply deleted and the tools
    // the agent needed to answer refused.
    seedDangler();
    callsANonTrackerToolThenAnswers();

    await runV2Turn('primary');

    expect(gateRows()).toBe(0);
    expect(refusedCloseOut()).toBe(false);
    // And the tool the agent needed in order to answer actually RAN.
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    expect((executeToolSpy.mock.calls[0][1] as ToolCall).name).toBe('get_current_time');
  });

  it('F2.4: a recent gate row suppresses the duplicate INSERT and STILL arms enforcement', async () => {
    // Queued wakeups re-arm this gate on every attempt (three duplicate inserts observed
    // in 20s). The dedupe skips the redundant row — and the half that is easy to lose is
    // that enforcement is armed ANYWAY, because the arming happens before the row does.
    // A dedupe written as an early return passes the first assertion and fails the second.
    expect(claimAsk(askIdForMessage('msg-user-1'), 'primary').kind).toBe('applied');
    seedDangler();
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
       VALUES ('msg-gate-recent', 'primary', 'system', '[System: REQUIRED close-out, you have abandoned work on the tracker.]', 1,
               (unixepoch('now') * 1000))`,
    ).run();
    callsANonTrackerToolThenAnswers();

    await runV2Turn('primary');

    // No SECOND row: the one that exists is the seeded one.
    expect(gateRows()).toBe(1);
    // …and the gate still bit.
    expect(refusedCloseOut()).toBe(true);
    expect(executeToolSpy).not.toHaveBeenCalled();
  });
});
