// ════════════════════════════════════════
// v2 loop integration tests
//
// These tests exercise runV2Turn end-to-end against a mocked callModel
// and broadcast, with a real (in-memory) sqlite DB seeded with minimal
// schema. The goal: catch the class of bugs that unit tests miss —
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
// Hoisted via vi.mock — the implementations below replace the real modules
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

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));

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
  return {
    ...actual,
    executeTool: (...args: unknown[]) => executeToolSpy(...args),
    getFilteredTools: () => [],
  };
});

vi.mock('../../runtime.js', () => ({
  injectAttachmentBlocks: (...args: unknown[]) => injectAttachmentBlocksSpy(...args),
  enforceModelCapabilities: (...args: unknown[]) => enforceModelCapabilitiesSpy(...args),
  getAgentRuntime: () => ({ handleMessage: (...args: unknown[]) => handleMessageSpy(...args) }),
}));

vi.mock('../../pending-attachments.js', () => ({
  drainPendingAttachments: () => drainPendingAttachmentsSpy(),
}));

vi.mock('../../../costs/tracker.js', () => ({
  recordCost: (...args: unknown[]) => recordCostSpy(...args),
}));

vi.mock('../../../memory/embeddings.js', () => ({
  queueEmbedding: (...args: unknown[]) => queueEmbeddingSpy(...args),
}));

vi.mock('../../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false,
  clearIMResponseFlag: vi.fn(),
  sendResponseViaIMessage: (...args: unknown[]) => sendResponseViaIMessageSpy(...args),
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

vi.mock('../../../memory/assembler.js', () => ({
  assembleContext: vi.fn(async () => ({
    systemPrompt: '<system prompt>',
    messages: [{ role: 'user', content: 'hello' }],
  })),
}));

// (config/runtime.js mock removed in Phase 9 Stage 2 — module deleted)

vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'kevin',
  isPMAgent: () => false,
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'kevin',
  getPrimaryAgentName: () => 'Kevin',
  getDreamerAgentId: () => 'dreamer',
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

// Mocks for v2/recovery.ts dynamic imports — these only fire when an error
// reaches the recovery cascade, so they're a no-op in normal-path tests.
vi.mock('../../../healer/injury-recovery.js', () => ({
  onAgentInjured: (...args: unknown[]) => onAgentInjuredSpy(...args),
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
}));

// Router mocks for auto-router fallback tests. Default to a simple stub
// that picks 'fallback-model'; individual tests override via mockImplementation.
const scoreQueryMock = vi.fn(() => ({ tier: 'standard', dimensions: {}, score: 0 }));
const selectModelMock = vi.fn();
vi.mock('../../../router/scorer.js', () => ({
  scoreQuery: (...args: unknown[]) => scoreQueryMock(...args),
}));
vi.mock('../../../router/selector.js', () => ({
  selectModel: (...args: unknown[]) => selectModelMock(...args),
  logRouterDecision: vi.fn(),
}));

// Now import the module under test (after mocks are set up)
import { runV2Turn } from '../loop.js';
import { stoppedAgents, recoveryRunStreak, pendingWakeups } from '../../shared-state.js';

// ── Test helpers ──

function setupTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      config TEXT NOT NULL DEFAULT '{}',
      session_started_at TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}',
      group_id TEXT,
      classification TEXT,
      parent_agent TEXT,
      task_id TEXT,
      last_error TEXT,
      last_error_at TEXT,
      recovery_attempts INTEGER DEFAULT 0,
      dreamer_ignore INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      token_count INTEGER,
      model_id TEXT,
      cost REAL,
      latency_ms INTEGER,
      turn_number INTEGER,
      reasoning_content TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      api_model_id TEXT,
      capabilities TEXT,
      context_window INTEGER,
      input_cost_per_m REAL,
      output_cost_per_m REAL,
      is_enabled INTEGER DEFAULT 0
    );
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      auth_type TEXT
    );
  `);

  // Seed Kevin (primary agent)
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, classification)
    VALUES ('kevin', 'Kevin', 'test-model', 'idle', '{}', 'sensei')
  `).run();
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type)
    VALUES ('test-provider', 'Test', 'anthropic', 'api_key')
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('test-model', 'test-provider', 'Test Model', 'test-1', '["tools","vision"]', 200000, 1)
  `).run();
  // Seed a user message so assembleContext has something to work with
  db.prepare(`
    INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
    VALUES ('msg-user-1', 'kevin', 'user', 'hello kevin', 1, datetime('now'))
  `).run();

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
  scoreQueryMock.mockImplementation(() => ({ tier: 'standard', dimensions: {}, score: 0 }));
  selectModelMock.mockReset();
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

    await runV2Turn('kevin');

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
      .get('kevin') as { status: string };
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

    await runV2Turn('kevin');

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

    await runV2Turn('kevin');

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

    await runV2Turn('kevin');

    const params = callModelSpy.mock.calls[0][0] as { abortSignal?: AbortSignal };
    expect(params.abortSignal).toBeDefined();
    expect(params.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('PRESERVATION #1: TRUE streaming — chunks broadcast immediately', async () => {
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

    await runV2Turn('kevin');

    // Each chunk should have produced a separate chat:chunk broadcast
    // (NOT batched until model finishes — that was v1's bug)
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

    await runV2Turn('kevin');

    // Loop should call model exactly ONCE — complete_task exits before
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

    await runV2Turn('kevin');

    // Same as complete_task — image_create exits without follow-up call.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
  });

  it('PRESERVATION #11 cont: stop signal mid-loop exits cleanly', async () => {
    let callCount = 0;
    callModelSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // After first call, simulate user clicking stop mid-loop
        stoppedAgents.add('kevin');
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

    await runV2Turn('kevin');

    // First call ran, tool ran, stop was set, second iteration's
    // top-of-loop check should exit BEFORE second model call.
    expect(callModelSpy).toHaveBeenCalledTimes(1);

    // Status should be idle
    const agent = mockDb.current!
      .prepare('SELECT status FROM agents WHERE id = ?')
      .get('kevin') as { status: string };
    expect(agent.status).toBe('idle');

    // stoppedAgents should be cleared by the loop
    expect(stoppedAgents.has('kevin')).toBe(false);
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

    await runV2Turn('kevin');

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

    await runV2Turn('kevin');

    // Emergency compaction was forced
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'kevin',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ force: true }),
    );

    // Model NOT called this turn — we surrendered after emergency compact
    expect(callModelSpy).not.toHaveBeenCalled();
  });

  it('PRESERVATION #14: auto-continuation fires at MAX_TOOL_LOOPS (75) and schedules a fresh turn', async () => {
    // v2/loop.ts:1282-1320 — when the inner tool loop hits MAX_TOOL_LOOPS
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
      content: 'file body — keep going',
      isError: false,
    }));

    // Use fake timers so the setTimeout(handleMessage, 1000) in the
    // auto-continue path fires within the test.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runV2Turn('kevin');
      // Drain the 1s delay before handleMessage('') fires.
      await vi.advanceTimersByTimeAsync(1500);
    } finally {
      vi.useRealTimers();
    }

    // Hit MAX_TOOL_LOOPS exactly (75 model calls inside the loop).
    expect(modelCallCount).toBe(75);

    // The system message documenting the auto-continue was persisted.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/75 tool calls.*Starting a fresh turn/);

    // handleMessage('') was called to continue.
    expect(handleMessageSpy).toHaveBeenCalledWith('kevin', '');
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

    await runV2Turn('kevin');

    // Forced compaction was attempted.
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'kevin',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ force: true }),
    );

    // Model was NOT called this turn — we surrendered.
    expect(callModelSpy).not.toHaveBeenCalled();

    // A [System: ...] note was persisted explaining the surrender.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
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

    await runV2Turn('kevin');

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

    await runV2Turn('kevin');

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

    await runV2Turn('kevin');

    expect(queueEmbeddingSpy).toHaveBeenCalled();
    const args = queueEmbeddingSpy.mock.calls[0];
    expect(args[0]).toBe('message');
    expect(args[2]).toBe('kevin');
    expect(args[3]).toBe('meaningful response');
  });

  it('PRESERVATION #38: empty response triggers silent retry, then nudge, then toast', async () => {
    // v1 behavior: 3-phase recovery from empty model responses.
    //   phase 1 — silent retry (no nudge, no toast)
    //   phase 2 — explicit pendingNudge injection
    //   phase 3 — chat:error toast
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

    await runV2Turn('kevin');

    // The model should have been called THREE times:
    //   call 1 — initial empty
    //   call 2 — after silent retry
    //   call 3 — after explicit nudge
    // After the third empty response, the loop breaks with the error toast.
    expect(modelCallCount).toBe(3);

    // Exactly one chat:error event was broadcast on the final empty.
    const errors = getBroadcastEventsByType('chat:error') as Array<{ code?: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('MODEL_FAILED');

    // No assistant message was persisted (all responses were empty).
    const assistantMsgs = mockDb.current!
      .prepare("SELECT * FROM messages WHERE agent_id = 'kevin' AND role = 'assistant'")
      .all();
    expect(assistantMsgs).toHaveLength(0);
  });

  it('PRESERVATION #40: identical assistant response is not double-persisted', async () => {
    // v1 behavior: if the model returns text identical to the most recent
    // assistant message (and no tool calls), break the loop without persisting
    // the duplicate. Catches model stalls and re-trigger races.
    mockDb.current!
      .prepare(
        `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
         VALUES ('msg-prior-assistant', 'kevin', 'assistant', 'Hello back!', 1, datetime('now'))`,
      )
      .run();

    callModelSpy.mockResolvedValue({
      content: 'Hello back!',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('kevin');

    // Still exactly one assistant message — the dup was rejected.
    const assistantMsgs = mockDb.current!
      .prepare("SELECT id FROM messages WHERE agent_id = 'kevin' AND role = 'assistant'")
      .all();
    expect(assistantMsgs).toHaveLength(1);
  });

  it('PRESERVATION #40: tool-bearing turn with identical text IS persisted', async () => {
    // Carve-out: tool calls carry new state, so even if the text matches,
    // the turn must persist (otherwise we'd lose tool_use blocks).
    mockDb.current!
      .prepare(
        `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
         VALUES ('msg-prior-assistant', 'kevin', 'assistant', 'Same text', 1, datetime('now'))`,
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

    await runV2Turn('kevin');

    const assistantMsgs = mockDb.current!
      .prepare("SELECT id FROM messages WHERE agent_id = 'kevin' AND role = 'assistant'")
      .all();
    expect(assistantMsgs.length).toBeGreaterThan(1);
  });

  it('PRESERVATION: no-results detector nudges after 2 consecutive empty turns, breaks after a 3rd', async () => {
    // v2/loop.ts:1194-1232 — when every tool result in a turn contains
    // "No results found" / "not in memory" for two consecutive iterations,
    // a pendingNudge fires telling the model to switch tactics. If the
    // third iteration is STILL all-no-results, the loop breaks with a
    // NO_RESULTS chat:error. This pins both transitions.
    let modelCallCount = 0;
    callModelSpy.mockImplementation(async () => {
      modelCallCount++;
      // Always plan another search — the no-results detector decides
      // when to break, not the model.
      return {
        content: '',
        toolCalls: [
          { id: `tc-${modelCallCount}`, name: 'memory_grep', arguments: { pattern: `term-${modelCallCount}` } },
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

    await runV2Turn('kevin');

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
          { id: `tc-${modelCallCount}`, name: 'memory_grep', arguments: { pattern: `term-${modelCallCount}` } },
        ],
        inputTokens: 100,
        outputTokens: 5,
        stopReason: 'tool_use',
      };
    });
    let toolCallNum = 0;
    executeToolSpy.mockImplementation(async (_agentId, toolCall) => {
      toolCallNum++;
      // Pattern: empty, empty, GOOD, empty — counter goes 1→2-but-reset-by-good→1.
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

    await runV2Turn('kevin');

    // No NO_RESULTS error should have fired — the "good" result reset the counter.
    const noResultsErrors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>).filter(
      (e) => e.code === 'NO_RESULTS',
    );
    expect(noResultsErrors).toHaveLength(0);
  });

  it('PRESERVATION #38: empty after tool calls is a clean end-of-turn (no toast)', async () => {
    // Carve-out from v1 runtime.ts:1167-1171 — if the agent already executed
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

    await runV2Turn('kevin');

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

    await runV2Turn('kevin');

    // Inspect messages in insertion order
    const rows = mockDb.current!
      .prepare("SELECT role FROM messages WHERE agent_id = ? ORDER BY created_at, rowid")
      .all('kevin') as Array<{ role: string }>;
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
  // Phase 6 — v2 owns its own recovery cascade (recovery.ts)
  // ─────────────────────────────────────────────────────────

  it('PHASE 6: recoverable provider 4xx → system note + wakeup, no injury', async () => {
    // A "vision_mismatch" 400 from the provider. The classifier recognizes
    // it as recoverable; recovery persists a [System: …] note and queues
    // a wakeup. The agent is NOT injured — recordError + onAgentInjured
    // should NOT fire.
    callModelSpy.mockRejectedValue(
      new Error('400 The model does not support image input — no endpoints found that support images'),
    );

    await runV2Turn('kevin');

    // No injury side effects.
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();

    // Wakeup was queued so the agent retries.
    expect(pendingWakeups.has('kevin')).toBe(true);

    // System note persisted explaining what failed.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/your last action failed/i);

    // Vision-mismatch self-healing: capability cache invalidated.
    expect(removeCapabilitySpy).toHaveBeenCalledWith('test-model', 'vision');

    // Streak counter incremented.
    expect(recoveryRunStreak.get('kevin')?.count).toBe(1);
    expect(recoveryRunStreak.get('kevin')?.kind).toBe('vision_mismatch');
  });

  it('PHASE 6: tool_format_rejected 400 → system note + wakeup, no injury', async () => {
    // Spec acceptance lists tool_format alongside vision_mismatch as a
    // recoverable provider 4xx. Verifies the recovery path handles it
    // identically: classified by classifyRecoverableProviderError,
    // persisted as a [System: …] note, wakeup queued, no injury.
    callModelSpy.mockRejectedValue(
      new Error('400 tool_use block has invalid input: missing required parameter'),
    );

    await runV2Turn('kevin');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('kevin')).toBe(true);

    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/your last action failed/i);

    expect(recoveryRunStreak.get('kevin')?.kind).toBe('tool_format_rejected');
  });

  it('PHASE 6: 4 consecutive same-kind 4xx → escalates to injury after the 3rd', async () => {
    // Simulate the streak: pre-load the recovery streak Map at 3 (cap),
    // then trigger one more recoverable error. Recovery should give up
    // and fall through to recordInjury.
    recoveryRunStreak.set('kevin', { kind: 'vision_mismatch', count: 3 });
    callModelSpy.mockRejectedValue(
      new Error('400 The model does not support image input — no endpoints found that support images'),
    );

    await runV2Turn('kevin');

    // After cap, escalates to injury.
    expect(recordErrorMock).toHaveBeenCalledWith('kevin');
    expect(onAgentInjuredSpy).toHaveBeenCalled();

    // Streak was reset (so a future unrelated error starts fresh).
    expect(recoveryRunStreak.has('kevin')).toBe(false);

    // Two system notes were persisted: the give-up note + nothing else
    // (recordInjury doesn't add a system note for non-rate-limit errors).
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system' ORDER BY rowid ASC")
      .all() as Array<{ content: string }>;
    const giveUp = sysMsgs.find((m) => /(?:stopping the recovery loop|auto-recovery is giving up|keeps coming back)/i.test(m.content));
    expect(giveUp).toBeDefined();
  });

  it('PHASE 6: context overflow on non-Dreamer → force compact + wakeup, no injury', async () => {
    isContextOverflowErrorMock.mockImplementation(() => true);
    callModelSpy.mockRejectedValue(
      new Error('400 prompt is too long: 250000 tokens > 200000 maximum'),
    );

    await runV2Turn('kevin');

    // Forced compaction was invoked.
    expect(checkAndCompactSpy).toHaveBeenCalledWith(
      'kevin',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ force: true }),
    );

    // Wakeup queued.
    expect(pendingWakeups.has('kevin')).toBe(true);

    // No injury.
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
  });

  it('PHASE 6: generic non-recoverable error → injury (recordError + healer + chat:error)', async () => {
    callModelSpy.mockRejectedValue(new Error('500 Internal Server Error'));

    await runV2Turn('kevin');

    expect(recordErrorMock).toHaveBeenCalledWith('kevin');
    expect(onAgentInjuredSpy).toHaveBeenCalled();

    // Last error persisted on the agent row.
    const agent = mockDb.current!
      .prepare("SELECT last_error FROM agents WHERE id = 'kevin'")
      .get() as { last_error: string | null };
    expect(agent.last_error).toContain('500');

    // chat:error broadcast with MODEL_FAILED (not RATE_LIMITED).
    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string }>);
    expect(errors.find((e) => e.code === 'MODEL_FAILED')).toBeDefined();
  });

  it('PHASE 6: rate-limit 429 → injury + RATE_LIMITED code + [Rate limited] system msg', async () => {
    callModelSpy.mockRejectedValue(new Error('429 Rate limit exceeded'));

    await runV2Turn('kevin');

    expect(onAgentInjuredSpy).toHaveBeenCalled();

    const errors = (getBroadcastEventsByType('chat:error') as Array<{ code?: string; severity?: string; retryable?: boolean }>);
    const rateLimited = errors.find((e) => e.code === 'RATE_LIMITED');
    expect(rateLimited).toBeDefined();
    expect(rateLimited?.severity).toBe('warning');
    expect(rateLimited?.retryable).toBe(true);

    // [Rate limited] system message persisted.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system'")
      .all() as Array<{ content: string }>;
    expect(sysMsgs.find((m) => m.content.includes('[Rate limited]'))).toBeDefined();
  });

  it('PHASE 6: error-loop trip → status paused, ERROR_LOOP code', async () => {
    // Mock recordError to return true (loop threshold tripped).
    recordErrorMock.mockReturnValue(true);
    callModelSpy.mockRejectedValue(new Error('500 transient'));

    await runV2Turn('kevin');

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
    recoveryRunStreak.set('kevin', { kind: 'vision_mismatch', count: 2 });
    callModelSpy.mockResolvedValue({
      content: 'all done',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 5,
      stopReason: 'end_turn',
    });

    await runV2Turn('kevin');

    expect(recoveryRunStreak.has('kevin')).toBe(false);
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
         VALUES ('msg-dreamer-1', 'dreamer', 'user', 'process batch', 1, datetime('now'))`,
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

    await runV2Turn('kevin');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('kevin')).toBe(true);
    expect(recoveryRunStreak.get('kevin')?.kind).toBe('unsupported_modality');
  });

  it('PHASE 6 audit-gap: malformed_request 400 → system note + wakeup, no injury', async () => {
    callModelSpy.mockRejectedValue(
      new Error('400 invalid_request_error: malformed parameter foo'),
    );

    await runV2Turn('kevin');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('kevin')).toBe(true);
    expect(recoveryRunStreak.get('kevin')?.kind).toBe('malformed_request');
  });

  it('PHASE 6 audit-gap: unsupported_input 404 → system note + wakeup, no injury', async () => {
    callModelSpy.mockRejectedValue(
      new Error('404 No endpoints found that support audio input for this model'),
    );

    await runV2Turn('kevin');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('kevin')).toBe(true);
    expect(recoveryRunStreak.get('kevin')?.kind).toBe('unsupported_input');
  });

  it('PHASE 6 audit-gap: output_truncation thrown as error → system note + wakeup, no injury', async () => {
    // Provider raises (rather than signaling via stopReason='max_tokens').
    // tryOutputTruncationRecovery should detect and recover before injury.
    callModelSpy.mockRejectedValue(
      new Error('max_output_tokens exceeded: response was 9000 tokens, limit 8192'),
    );

    await runV2Turn('kevin');

    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
    expect(pendingWakeups.has('kevin')).toBe(true);

    // System note explains output budget exhaustion.
    const sysMsgs = mockDb.current!
      .prepare("SELECT content FROM messages WHERE agent_id = 'kevin' AND role = 'system' ORDER BY rowid DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0].content).toMatch(/output token limit/i);
  });

  it('PHASE 6 audit-gap: auto-router fallback → tries next model, no injury', async () => {
    // Switch Kevin to auto-routed.
    mockDb.current!.prepare("UPDATE agents SET model_id = 'auto' WHERE id = 'kevin'").run();
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

    await runV2Turn('kevin');

    // Both selectModel calls fired (initial + fallback).
    expect(selectModelMock).toHaveBeenCalledTimes(2);
    // Second call passed the failed model in excludedModels.
    expect(selectModelMock.mock.calls[1][2]).toEqual(['primary-model']);
    // Both model calls fired.
    expect(callModelSpy).toHaveBeenCalledTimes(2);
    // No injury — fallback succeeded.
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(onAgentInjuredSpy).not.toHaveBeenCalled();
  });
});
