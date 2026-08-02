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

vi.mock('../../tools.js', async () => {
  const actual = await vi.importActual<typeof import('../../tools.js')>('../../tools.js');
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
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  setLogLevel: vi.fn(),
  setLogBroadcast: vi.fn(),
  readLogEntries: () => [],
}));

// Now import the module under test (after mocks are set up)
import { runV2Turn } from '../loop.js';
import { stoppedAgents, recoveryRunStreak, pendingWakeups } from '../../shared-state.js';
import { currentTurnConversationId } from '../../turn-state.js';
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

    // stoppedAgents should be cleared by the loop
    expect(stoppedAgents.has('primary')).toBe(false);
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
    //   phase 2, explicit pendingNudge injection
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
    // a pendingNudge fires telling the model to switch tactics. If the
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
// `pendingNudge` only when the assembled tail was role='assistant' — and
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

describe('T1: engine steer delivery (the pendingNudge drain)', () => {
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
    // writer: call 1 empty → silent retry; call 2 empty → sets pendingNudge;
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

  it('clears pendingNudge on a successful drain: the steer rides exactly ONE model call, never repeats', async () => {
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
  //     law's live subject is the pendingNudge drain — and the three clauses immediately
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
      seenAtAssembly.push(currentTurnConversationId.get('primary'));
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
