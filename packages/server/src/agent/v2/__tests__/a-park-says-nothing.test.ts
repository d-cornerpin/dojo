// ════════════════════════════════════════════════════════════════════════════════
// t159 G (v3.3.3 run 7) — A PARK SAYS NOTHING TO THE OWNER, AND THE FILES IT HELD RIDE THE
// REAL REPLY.
//
// The witness (run 7, S1 variant A): a long job wrote a working file (the file tools queue a
// canvas chip for it, `turn_artifacts` kind `canvas`), then hit the 75-call cap. The cap is a
// PARK — invisible housekeeping, the job continues on a fresh turn — but the turn still fell
// through to finalize, where the show_to_user safety net surfaced the working file to the
// OWNER as "Here's the ledger audit notes." and recorded it as the turn's answer; the ask was
// settled done and handed back. The job was mid-way. The real result came two turns later.
//
// Everything below runs through the engine's real turn entry (`runV2Turn`) on the real
// migration chain with a scripted provider, and reads RECORDS (message rows, chat broadcasts,
// `turn_artifacts.delivered_at`, `turns`, the ask's work row) — never the model's prose.
// The harness block is `t137-long-jobs-are-left-alone.test.ts`'s (vi.mock is per file),
// WITHOUT its pending-attachments mock: the queue is the thing under test.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

// ── Mocks ──
//
// Hoisted via vi.mock, the implementations below replace the real modules
// for the duration of these tests.

const mockDb = { current: null as Database.Database | null };
/** A park dates the job's task row: that due is the continuation. */
const jobParked = (): boolean => !!mockDb.current!.prepare("SELECT 1 FROM work WHERE agent_id = 'primary' AND kind = 'task' AND next_attempt_at IS NOT NULL").get();
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
  stoppedAgents, recoveryRunStreak, pendingWakeups,
  doomedPrefillCompactionSpent, declaredPatienceHonestFailTurn,
} from '../../shared-state.js';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import path from 'node:path';

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
    onAgentInjuredSpy, recordCostSpy, queueEmbeddingSpy, sendIMessageSpy, checkAndCompactSpy,
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
});

import { queueCanvasDoc } from '../../pending-attachments.js';
import { turnParkedTheJob } from '../engine-exit.js';
import { parkJob } from '../../../work/job-continuation.js';
import { endTurnContext } from '../../turn-context.js';
import { liveTurn } from './helpers/live-turn.js';

const TURN_BUDGET_MS = 15 * 60 * 1000;
const FILE = '/uploads/primary/ledger-audit-notes.txt';

const messageRows = (): Array<{ id: string; role: string; content: string; turn_number: number | null; attachments: string | null }> =>
  mockDb.current!.prepare(
    `SELECT id, role, content, turn_number, attachments FROM messages WHERE agent_id = 'primary' ORDER BY rowid`,
  ).all() as never;
/** What the owner can read: assistant rows that are not the model's own tool_use carriers. */
const assistantRows = () => messageRows().filter((m) => m.role === 'assistant' && !m.content.startsWith('[{"type":"tool_use"'));
const artifactRows = (): Array<{ kind: string; path: string | null; delivered_at: string | null }> =>
  mockDb.current!.prepare(`SELECT kind, path, delivered_at FROM turn_artifacts WHERE agent_id = 'primary' ORDER BY rowid`).all() as never;
const turnRows = (): Array<{ turn_number: number; exit_reason: string | null; answered: number; answer_message_id: string | null }> =>
  mockDb.current!.prepare(
    `SELECT turn_number, exit_reason, answered, answer_message_id FROM turns WHERE agent_id = 'primary' ORDER BY turn_number`,
  ).all() as never;
const askState = (): string =>
  (mockDb.current!.prepare(`SELECT state FROM work WHERE kind = 'ask' AND agent_id = 'primary'`).get() as { state: string }).state;
const assistantChatBroadcasts = (): Array<{ content?: string; attachments?: unknown[] }> =>
  broadcastSpy.mock.calls
    .map((c) => c[0] as { type?: string; message?: { role?: string; content?: string; attachments?: unknown[] } })
    .filter((e) => e.type === 'chat:message' && e.message?.role === 'assistant'
      && !(e.message.content ?? '').startsWith('[{"type":"tool_use"'))
    .map((e) => e.message ?? {});

const workingFile = () => ({
  fileId: 'f-ledger', filename: 'ledger-audit-notes.txt', mimeType: 'text/plain', size: 12,
  path: FILE, category: 'text' as const, openInCanvas: true,
});

let toolSeq = 0;

/** The job: `rounds` read-only calls that find nothing (so the job does not move), the second of which
 *  writes the working file (the real queue, exactly as `tools/util.ts` does after a file_write), then `after`. */
function scriptTheJob(opts: { rounds: number; after: { content: string }; onRound?: (round: number) => void }): void {
  let call = 0;
  callModelSpy.mockImplementation(async () => {
    call++;
    if (call <= opts.rounds) {
      return {
        content: '', toolCalls: [{ id: `tc-t159-${++toolSeq}`, name: 'file_read', arguments: { path: `/research/part-${call}.txt` } }],
        inputTokens: 100, outputTokens: 5, stopReason: 'tool_use',
      };
    }
    return { content: opts.after.content, toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
  });
  let round = 0;
  executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => {
    round++;
    if (round === 2) queueCanvasDoc('primary', workingFile());
    opts.onRound?.(round);
    return { toolCallId: tc.id, name: tc.name, content: 'no such file', isError: true };
  });
}

/** Nothing the owner can read has come out of the turn. */
function expectTheOwnerHeardNothing(): void {
  expect(assistantRows()).toEqual([]);
  expect(assistantChatBroadcasts()).toEqual([]);
}

beforeEach(() => { toolSeq = 0; });

// ════════════════════════════════════════════════════════════════════════════════
// (i) A PARKED TURN IS SILENT: a window of steps with no movement
// ════════════════════════════════════════════════════════════════════════════════
describe('t159 G (i): a still window parks the job: nothing reaches the owner, nothing is noted as the answer', () => {
  it('a working file queued before the park stays queued: no owner row, no broadcast, rows undelivered, turn not answered, ask not settled', async () => {
    scriptTheJob({ rounds: 160, after: { content: '' } });   // the checkpoint ends the turn before the model ever speaks
    await runV2Turn('primary');

    // Positive controls: the turn really parked, and the file really was queued.
    expect(jobParked()).toBe(true);
    expect(turnRows()).toEqual([expect.objectContaining({ turn_number: 1, exit_reason: 'iteration_cap' })]);
    expect(artifactRows()).toEqual([expect.objectContaining({ kind: 'canvas', path: FILE })]);

    // The defect, on records.
    expectTheOwnerHeardNothing();
    expect(artifactRows().map((a) => a.delivered_at)).toEqual([null]);
    expect(turnRows()[0].answered).toBe(0);
    expect(turnRows()[0].answer_message_id).toBeNull();
    expect(askState()).not.toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// (i-b) THE OTHER PARK DOOR THAT REACHES FINALIZE: the 15-minute turn budget
// ════════════════════════════════════════════════════════════════════════════════
describe('t159 G (i-b): the 15-minute budget park is silent the same way', () => {
  it('a working file queued before the checkpoint stays queued; the owner hears nothing', async () => {
    const real = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    // Two windows of time pass: the first holds the task's opening, the second holds no movement.
    scriptTheJob({ rounds: 6, after: { content: '' }, onRound: (r) => { if (r === 2 || r === 4) offset += TURN_BUDGET_MS + 60_000; } });
    try {
      await runV2Turn('primary');
    } finally {
      clock.mockRestore();
    }
    expect(turnRows()).toEqual([expect.objectContaining({ exit_reason: 'iteration_cap' })]);   // positive control: it parked
    expect(artifactRows()).toEqual([expect.objectContaining({ kind: 'canvas', path: FILE })]);
    expectTheOwnerHeardNothing();
    expect(artifactRows().map((a) => a.delivered_at)).toEqual([null]);
    expect(turnRows()[0].answered).toBe(0);
    expect(askState()).not.toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// (ii) THE CONTINUATION THAT ENDS THE JOB CARRIES THE FILES WITH ITS REPLY, ONCE
// ════════════════════════════════════════════════════════════════════════════════
describe('t159 G (ii): the turn that really ends the job delivers what the park held back, with its own reply, once', () => {
  it('park, then a continuation that answers: one assistant row, carrying the file; the queue is drained once', async () => {
    scriptTheJob({ rounds: 160, after: { content: '' } });
    await runV2Turn('primary');
    expectTheOwnerHeardNothing();

    broadcastSpy.mockClear();
    callModelSpy.mockReset();
    executeToolSpy.mockReset();
    callModelSpy.mockResolvedValue({
      content: 'The audit is finished: three mismatches, all in March.', toolCalls: [],
      inputTokens: 100, outputTokens: 12, stopReason: 'end_turn',
    });
    await runV2Turn('primary');

    const replies = assistantRows();
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toContain('three mismatches');
    expect(JSON.parse(replies[0].attachments ?? '[]').map((a: { path: string }) => a.path)).toEqual([FILE]);
    expect(assistantChatBroadcasts()).toHaveLength(1);
    const rows = artifactRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered_at).not.toBeNull();
    // Once: the file appears on exactly one row of the whole conversation.
    expect(messageRows().filter((m) => (m.attachments ?? '').includes('ledger-audit-notes.txt'))).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// (iii) A TURN THAT GENUINELY ENDS WITH STRANDED FILES STILL SURFACES THEM, EXACTLY AS BEFORE
// ════════════════════════════════════════════════════════════════════════════════
describe('t159 G (iii): a turn that ends (no park) with queued files and no reply still surfaces them', () => {
  it('the safety net speaks once, with the file, and the turn is answered', async () => {
    scriptTheJob({ rounds: 3, after: { content: '' } });
    await runV2Turn('primary');

    expect(jobParked()).toBe(false);   // positive control: this turn did not park
    const surfaced = assistantRows().filter((m) => (m.attachments ?? '').includes('ledger-audit-notes.txt'));
    expect(surfaced).toHaveLength(1);
    expect(artifactRows().map((a) => a.delivered_at)).not.toContain(null);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// G2 — ONE PARK SIGNAL. `parkJob` is the one door every park goes through; it records on the running
// turn that it parked, and `turnParkedTheJob` reads that and the stop fence and nothing else.
// ════════════════════════════════════════════════════════════════════════════════
describe('t159 G2: turnParkedTheJob reads only what parkJob recorded, and the stop fence', () => {
  it('false until parkJob runs on the turn; true after, by either wait; false for a stop; false on the next turn', () => {
    const serving = (): void => {
      const bag = liveTurn('primary', { turnNumber: 1, root: { kind: 'ask', id: 'msg-user-1', sourceMessageId: 'msg-user-1' } });
    };
    serving();
    expect(turnParkedTheJob('primary')).toBe(false);
    expect(parkJob('primary', 'door-a', Date.now())).toBe(true);
    expect(turnParkedTheJob('primary')).toBe(true);
    stoppedAgents.add('primary');
    expect(turnParkedTheJob('primary'), 'a stop refuses the wake').toBe(false);
    stoppedAgents.clear();
    endTurnContext('primary');
    expect(turnParkedTheJob('primary'), 'no turn, no park').toBe(false);
    serving();
    expect(turnParkedTheJob('primary'), 'a new turn parked nothing').toBe(false);
    expect(parkJob('primary', 'door-b', 'event', Promise.resolve())).toBe(true);   // a wait for an event
    expect(turnParkedTheJob('primary')).toBe(true);
    endTurnContext('primary');
  });
});

// t194 (v3.4 D1, owner decision 7): "EACH PARK DOOR, ON A NON-HUMAN TURN, SAYS NOTHING" drove the context
// gate's two arms (emergency compact at 96-99%, context-full at 99%+). Both are DELETED — a full view is
// condensed and the turn goes on, never parked by the gate — so their three clauses went with them. The
// other park doors are driven above (G (i), G (i-b)); the parkJob caller census above still holds.
