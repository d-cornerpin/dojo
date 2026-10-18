// ════════════════════════════════════════════════════════════════════════════════════════
// t173b — EVERY PARK DOOR'S CONTINUATION INHERITS THE JOB'S ORIGIN (t173's gap).
//
// THE MEASURED GAP (run 11, S1 variant B, the dev box's own rows and log, 2026-10-15). A manager that
// is the PM assigned a ledger audit over an A2A thread, so the engine opened NO task for it (the PM's
// ASSIGN never does); the worker opened its own, on its first A2A turn. A later turn (a forced A2A
// retry on another thread) hit the 15-minute budget and parked. Its continuation recorded kind NULL,
// subject `none`, no root, and logged the zero-messages fallback three times; the close-out gate, on
// that same turn, refused its file_read because the audited task was "dangling".
// Why: a park carries the tasks the PARKING turn names (`turnWorkIds`: its served task, its ask, its
// thread's tasks, tasks opened on it). That turn named none (the task was opened on an earlier turn, on
// another thread's turn), so `carryJobWork` had nothing to carry and made no job at all: the wake was a
// plain wake, `runCarriesJob` was false, and t173's origin read (from the job's carried ids) found nothing.
// The fix is at the one seam, `parkJob`: the job's origin is read there, from the work the turn names
// first and from the task the agent is most recently working second, and carried on the job record with
// the ids and asks (it never shields those tasks from the PM or the close-out gate: t143 round 2).
//
// One clause per park door: tool-loop cap, turn budget, both recovery compactions. Every door is driven
// through the engine's real turn entry. (t194: the context gate's two arms, and so its two park doors,
// are DELETED — a full view is condensed, never surrendered — and their three clauses with them.)
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const handleMessageSpy = vi.fn();
const loggerErrorSpy = vi.fn();
/** The size of the world: the model's window and how much a read returns (a clause may shrink the window to force a trim). */
const world = vi.hoisted(() => ({ window: 200000, pad: 20, estimate: 1000, clockPerTool: 0, clockMs: 0 }));

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t139-test', 'dojo.db'),
  };
});
// THE REAL BROADCAST: the websocket is the dashboard's delivery DOOR (`agent/v2/outbound.ts`
// `recordDashboardDelivery` runs inside it), and an ask closes only on a recorded delivery. A
// stubbed broadcast leaves every answered ask open, and the engine then re-serves the oldest
// one — a world no box is ever in. With no client connected the send itself is a no-op.
vi.mock('../../gateway/ws.js', async () => vi.importActual('../../gateway/ws.js'));
vi.mock('../../agent/model.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/model.js')>('../../agent/model.js');
  return { ...actual, callModel: (...args: unknown[]) => callModelSpy(...args), getContextWindow: () => world.window };
});
// THE TOOL DOOR: the tracker family and the A2A send run for real; a read returns a canned page.
vi.mock('../../agent/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/tools/index.js')>('../../agent/tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../agent/tool-outcome.js')>('../../agent/tool-outcome.js');
  return {
    ...actual,
    executeTool: async (agentId: string, tc: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (tc.name.startsWith('work_') || tc.name === 'send_to_agent') return actual.executeTool(agentId, tc as never);
      world.clockMs += world.clockPerTool;   // the budget door: a tool call that takes the turn past its 15 minutes
      return classifyToolResult({
        toolCallId: tc.id, name: tc.name,
        content: `page ${String(tc.arguments.path ?? tc.id)}: ${'ledger line '.repeat(world.pad)}`, isError: false,
      } as never);
    },
    getFilteredTools: () => [],
  };
});
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(),
  enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: (...args: unknown[]) => handleMessageSpy(...args) }),
  clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../agent/pending-attachments.js', () => ({
  drainPendingAttachments: () => [],
  drainPendingAttachmentsWithCaptions: async () => [],
  queuePendingAttachments: vi.fn(),
  queueScreenChip: vi.fn(),
  queueCanvasDoc: vi.fn(),
}));
vi.mock('../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({ queueEmbedding: vi.fn() }));
vi.mock('../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false,
  clearIMResponseFlag: vi.fn(),
  sendResponseViaIMessage: vi.fn(),
  getPendingIMSenderRaw: () => null,
  parseSafeSenders: () => [],
  stripSystemTags: (s: string) => s,
  sendIMessageWithAttachment: vi.fn(),
  addressesMatch: (a: string, b: string) => a === b,
  getInboundSenderFor: () => null,
  sendAlert: vi.fn(),
}));
vi.mock('../../memory/compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../../memory/compaction.js')>('../../memory/compaction.js');
  return {
    ...actual,
    checkAndCompact: () => Promise.resolve({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }),
    estimateAssembledTokens: () => ({
      total: world.estimate, summaryTokens: 0, freshTailTokens: world.estimate, briefTokens: 0, freshTailCount: 1, summaryCount: 0,
    }),
  };
});
// Which door parked: the one definition of "park" is recorded as it runs (it still runs, whole).
const parks: Array<{ reason: string; how: string }> = [];
vi.mock('../job-continuation.js', async () => {
  const actual = await vi.importActual<typeof import('../job-continuation.js')>('../job-continuation.js');
  return { ...actual, parkJob: (...a: Parameters<typeof actual.parkJob>) => { parks.push({ reason: a[1], how: a[2] ?? 'drain' }); return actual.parkJob(...a); } };
});
vi.mock('../../config/platform.js', () => ({
  clearPlatformConfigCache: vi.fn(),
  getSudoPolicyRaw: () => null,
  getPlatformName: () => 'Dojo',
  getOwnerName: () => 'TestOwner',
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
vi.mock('../../agent/spawner.js', () => ({ checkTimeouts: vi.fn() }));
vi.mock('../../healer/injury-recovery.js', () => ({
  onAgentInjured: vi.fn(), onAgentRecovered: vi.fn(), rehydrateInjuredAgents: vi.fn(),
}));
vi.mock('../../vault/maintenance.js', () => ({
  isContextOverflowError: (text: string) => /context_length_exceeded|prompt is too long/i.test(text),   // the provider's own prose
  recoverDreamerFromContextOverflow: async () => false,
}));
vi.mock('../../services/capabilities.js', () => ({
  removeCapability: vi.fn(),
  getModelCapabilities: () => ['tools'],
}));
vi.mock('../../services/presence.js', () => ({
  getPresence: () => 'present',
  maybeForwardToImessage: vi.fn(),
  isImessageConfigured: () => false,
  isImessageEnabled: () => false,
  setPresence: vi.fn(),
}));
vi.mock('../../router/scorer.js', () => ({
  scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }),
}));
vi.mock('../../router/selector.js', () => ({
  selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => loggerErrorSpy(...a) }),
  setLogLevel: vi.fn(),
  setLogBroadcast: vi.fn(),
  readLogEntries: () => [],
}));


import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage, insertEngineEvent } from '../../memory/message-store.js';
import { stoppedAgents, pendingWakeups, turnContinuationCounts, doomedPrefillCompactionSpent } from '../../agent/shared-state.js';
import { continuationContext } from '../../agent/turn-state.js';
import { deliverA2AMessage } from '../../agent/a2a-transport.js';
import { recordA2AReply } from '../../agent/a2a-replies.js';
import { beginJobRun, endJobRun, endJobCarry, jobCarriedIds } from '../task-freshness.js';
import { jobOrigin } from '../job-origin.js';
import { __resetBrakesForTests } from '../../memory/compaction-brakes.js';
import { AgentError } from '../../agent/errors.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../../agent/stream-patience.js';

const WORKER = 'worker';
const PM = 'pm';
const MANAGER = 'manager';
const THREAD = 'f00dcafe-1111-2222-3333-444455556666';
const OTHER_THREAD = 'cafe0000-aaaa-bbbb-cccc-ddddeeeeffff';
const ASSIGN_TEXT = 'I need a careful audit of a supplier ledger, page by page. Report the closing code and every wrong line.';
const OWNER_ASK = 'Please go through the whole supplier ledger folder and tell me which lines are wrong and the closing code.';
const LABEL = '(the message this work is answering)';
const ZERO_MESSAGES = 'Context assembly produced 0 messages after filtering';
const BUDGET_MS = 15 * 60_000;
let recoveryDoor = false;

// ── THE FIXTURE: the real migration chain, once per worker, restored per clause ──────────
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

beforeEach(() => {
  world.window = 200000; world.pad = 20; world.estimate = 1000; world.clockPerTool = 0; world.clockMs = 0;
  const db = migratedDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('test-provider', 'Test', 'anthropic', 'api_key')").run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('test-model', 'test-provider', 'Test Model', 'test-1', '["tools"]', ?, 1)`,
  ).run(world.window);
  for (const [id, name, cls] of [[WORKER, 'Worker', 'worker'], [PM, 'PM', 'sensei'], [MANAGER, 'Manager', 'sensei']]) {
    db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, ?, 'test-model', 'idle', '{}', ?)").run(id, name, cls);
  }
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(WORKER);
  callModelSpy.mockReset();
  handleMessageSpy.mockReset();
  handleMessageSpy.mockImplementation(async () => undefined);
  loggerErrorSpy.mockReset();
  stoppedAgents.clear();
  pendingWakeups.clear();
  turnContinuationCounts.clear();
  continuationContext.clear();
  doomedPrefillCompactionSpent.clear();
  __resetBrakesForTests();
  parks.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  endJobCarry(WORKER);
  // A harness may never abort a turn silently: a turn that died on an exception is recorded with one of these exits.
  // (A recovery door's turn ends `unknown` or `stream_idle` BY DESIGN: it threw, recovery parked the job.)
  const died = recoveryDoor ? [] : mockDb.current!.prepare("SELECT turn_number, exit_reason FROM turns WHERE exit_reason IN ('unknown', 'provider_error', 'abort', 'terminated')").all();
  recoveryDoor = false;
  mockDb.current?.close();
  mockDb.current = null;
  expect(died, 'a driven turn died (it threw); the clause ran on an aborted turn').toEqual([]);
});

// ── THE SCRIPTED PROVIDER ────────────────────────────────────────────────────────────────
type Step = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };
let callNo = 0;
/** `first` (optional), then `reads` file reads (80 outlasts the 75-call cap), then a closing line. */
function script(opts: { reads: number; first?: Step }): void {
  let i = 0;
  callModelSpy.mockImplementation(async () => {
    i++;
    callNo++;
    const step: Step = i === 1 && opts.first ? opts.first
      : i <= opts.reads ? { toolCalls: [{ id: `rd-${callNo}`, name: 'file_read', arguments: { path: `/ledger/page-${callNo}.txt` } }] }
      : { content: 'Done for now.' };
    const toolCalls = step.toolCalls ?? [];
    return { content: step.content ?? '', toolCalls, inputTokens: 100, outputTokens: 5, stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn' };
  });
}
const openTaskStep: Step = {
  toolCalls: [{ id: 'open-1', name: 'work_open', arguments: { kind: 'task', title: 'Supplier ledger audit', description: 'Read every page', goal: 'Wrong lines and the closing code sent back' } }],
};

type TurnRow = { kind: string | null; subject_kind: string; subject_id: string | null; root_kind: string | null; root_id: string | null; exit_reason: string | null };
const turnRow = (n: number): TurnRow =>
  mockDb.current!.prepare('SELECT kind, subject_kind, subject_id, root_kind, root_id, exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?').get(WORKER, n) as never;
const lastTurnNumber = (): number =>
  (mockDb.current!.prepare('SELECT MAX(turn_number) AS n FROM turns WHERE agent_id = ?').get(WORKER) as { n: number }).n;
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const zeroMessagesLogged = (): boolean => loggerErrorSpy.mock.calls.some((c) => String(c[0]).startsWith(ZERO_MESSAGES));
const firstView = (from: number): { text: string; messages: Array<{ role: string; content: unknown }> } => {
  const params = callModelSpy.mock.calls[from]?.[0] as { messages?: Array<{ role: string; content: unknown }> } | undefined;
  const messages = params?.messages ?? [];
  return { text: JSON.stringify(messages), messages };
};

// ── THE JOB, as run 11 had it: the PM's ASSIGN (the engine opens no task for it), the worker opens its own ──
async function pmJob(thread = THREAD, text = ASSIGN_TEXT, title = 'Supplier ledger audit'): Promise<{ taskId: string }> {
  const r = await deliverA2AMessage({
    intent: 'ASSIGN', threadId: thread, requiresResponse: true, payload: text, toAgent: WORKER, fromAgent: PM,
  });
  expect(r.delivered).toBe(true);
  const db = mockDb.current!;
  const before = (db.prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task' AND agent_id = ?").get(WORKER) as { n: number }).n;
  script({ reads: 0, first: { toolCalls: [{ ...openTaskStep.toolCalls![0], arguments: { ...openTaskStep.toolCalls![0].arguments, title } }] } });
  await runV2Turn(WORKER);   // the ASSIGN's own turn: the worker opens its task here (the PM's ASSIGN opened none)
  const tasks = db.prepare("SELECT id, state, a2a_thread_id, source_message_id FROM work WHERE kind = 'task' AND agent_id = ? ORDER BY opened_at DESC, rowid DESC").all(WORKER) as
    Array<{ id: string; state: string; a2a_thread_id: string | null; source_message_id: string | null }>;
  expect(tasks.length, 'premise: the PM\'s ASSIGN opened no task; the worker opened exactly one').toBe(before + 1);
  const task = tasks[0];
  expect(task.a2a_thread_id, 'premise: a task the model opens is tied to no thread by its columns').toBeNull();
  expect(task.state).toBe('claimed');
  const assignId = (db.prepare("SELECT id FROM messages WHERE agent_id = ? AND a2a_intent = 'ASSIGN' AND a2a_thread_id = ?").get(WORKER, thread) as { id: string }).id;
  recordA2AReply({ assignMessageId: assignId, agentId: WORKER, threadId: thread, replyIntent: 'ANSWER' });   // the first reply went out
  return { taskId: task.id };
}

/** A later wake that names no task (a notice with no work referent): the turn that will park the job. */
function anUnrelatedNotice(id: string): void {
  insertEngineEvent({
    id, agentId: WORKER, content: '[SOURCE: AGENT NOTICE from PM] Checking in.', originIntent: 'tracker', turnNumber: null,
    work: null,
  });
}

/** The park's continuation, started the way the runtime starts it: from the wake the park registered. */
async function continuationTurn(): Promise<{ turn: number; firstCall: number }> {
  expect(beginJobRun(WORKER, 'drain') || beginJobRun(WORKER, 'timer'), 'the park registered its own wake, and the run carries the job').toBe(true);
  const firstCall = callModelSpy.mock.calls.length;
  script({ reads: 0 });
  try { await runV2Turn(WORKER); } finally { endJobRun(WORKER); }
  return { turn: lastTurnNumber(), firstCall };
}

/** The assertions every door owes: the continuation is the turn of the job's request. */
async function expectTheContinuationHoldsTheOrigin(parkedTurn: number, door: { reason: string; how: 'drain' | 'timer' }, exit?: string): Promise<void> {
  expect(parks, 'premise: the job was parked by exactly this door').toEqual([door]);
  if (exit) expect(turnRow(parkedTurn).exit_reason, 'premise: the parking turn left by this door').toBe(exit);
  loggerErrorSpy.mockClear();
  const { turn, firstCall } = await continuationTurn();
  const rec = turnRow(turn);
  expect(rec.kind).toBe('a2a');
  expect(rec.subject_kind).toBe('a2a_thread');
  expect(rec.subject_id).toBe(THREAD);
  expect(rec.root_kind).toBe('a2a');
  expect(rec.root_id).toBe(THREAD);
  const { text } = firstView(firstCall);
  expect(zeroMessagesLogged(), 'no zero-messages fallback on the continuation').toBe(false);
  expect(occurrences(text, ASSIGN_TEXT), 'the job\'s request, once').toBe(1);
  expect(jobCarriedIds(WORKER), 'the origin is carried, the held task is NOT shielded (t143 round 2)').toEqual([]);
}

describe('t173b: the run 11 shape — the parking turn names no task, the task was opened earlier', () => {
  it('EVIDENCE: a forced A2A retry on another thread parks at the budget; its continuation is the turn of the ASSIGN\'s thread', async () => {
    await pmJob();
    // The healer-style retry request on ANOTHER thread, unreplied: the next turn is an A2A turn on it.
    const q = await deliverA2AMessage({
      intent: 'QUESTION', threadId: OTHER_THREAD, requiresResponse: true, payload: 'Please retry your task.', toAgent: WORKER, fromAgent: MANAGER,
    });
    expect(q.delivered).toBe(true);
    const clock = Date.now.bind(Date);
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock() + world.clockMs);
    world.clockPerTool = BUDGET_MS + 60_000;
    script({ reads: 5 });
    try { await runV2Turn(WORKER); } finally { dateSpy.mockRestore(); world.clockMs = 0; }   // the next turn must not look fifteen minutes old
    const parked = lastTurnNumber();
    expect(turnRow(parked).subject_id, 'premise: the parking turn served the OTHER thread').not.toBe(THREAD);
    // What the runtime did at that instant on the box: the retry budget spent, a synthetic reply recorded.
    const questionId = (mockDb.current!.prepare("SELECT id FROM messages WHERE agent_id = ? AND a2a_intent = 'QUESTION'").get(WORKER) as { id: string }).id;
    recordA2AReply({ assignMessageId: questionId, agentId: WORKER, threadId: OTHER_THREAD, replyIntent: 'ABANDONED' });
    world.clockPerTool = 0;
    await expectTheContinuationHoldsTheOrigin(parked, { reason: 'turn-budget-continuation', how: 'drain' }, 'budget');
  });
});

describe('t173b: EVERY park door hands the job\'s origin to its continuation', () => {
  it('door 1, the 75-call tool-loop cap (a timer wake)', async () => {
    await pmJob();
    anUnrelatedNotice('notice-loop');
    script({ reads: 80 });
    await runV2Turn(WORKER);
    await expectTheContinuationHoldsTheOrigin(lastTurnNumber(), { reason: 'tool-loop', how: 'timer' }, 'iteration_cap');
  });

  it('door 2, the 15-minute turn budget (the shared wake set)', async () => {
    await pmJob();
    anUnrelatedNotice('notice-budget');
    const clock = Date.now.bind(Date);
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock() + world.clockMs);
    world.clockPerTool = BUDGET_MS + 60_000;
    script({ reads: 5 });
    try { await runV2Turn(WORKER); } finally { dateSpy.mockRestore(); world.clockMs = 0; world.clockPerTool = 0; }   // the next turn must not look fifteen minutes old
    await expectTheContinuationHoldsTheOrigin(lastTurnNumber(), { reason: 'turn-budget-continuation', how: 'drain' }, 'budget');
  });

  it('door 5, error recovery\'s forced compaction after a context overflow', async () => {
    await pmJob();
    anUnrelatedNotice('notice-overflow');
    recoveryDoor = true;
    callModelSpy.mockImplementation(async () => { throw new AgentError('prompt is too long: context_length_exceeded', WORKER, { code: 'CONTEXT_OVERFLOW' }); });
    await runV2Turn(WORKER);
    await expectTheContinuationHoldsTheOrigin(lastTurnNumber(), { reason: 'recovery-forced-compaction', how: 'drain' });
  });

  it('door 6, error recovery\'s compaction after a declared-patience exhaustion', async () => {
    await pmJob();
    anUnrelatedNotice('notice-patience');
    recoveryDoor = true;
    callModelSpy.mockImplementation(async () => {
      throw new AgentError('declared bound exceeded', WORKER, { code: DECLARED_PATIENCE_EXCEEDED_CODE, retryable: false, preDialRefusal: true });
    });
    await runV2Turn(WORKER);
    await expectTheContinuationHoldsTheOrigin(lastTurnNumber(), { reason: 'recovery-doomed-prefill-compaction', how: 'drain' });
  });
});

describe('t173b amendment: the origin a park borrows is never a guess', () => {
  it('an OWNER-ask turn parks while a peer\'s job is claimed: the continuation keeps the owner\'s ask, not the peer\'s thread', async () => {
    await pmJob();   // the agent also holds a claimed job from a peer's ASSIGN
    insertMessage({
      id: 'owner-ask', agentId: WORKER, role: 'user', content: OWNER_ASK, turnNumber: 1,
      channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    script({ reads: 80 });
    await runV2Turn(WORKER);
    const parked = lastTurnNumber();
    expect(turnRow(parked).exit_reason).toBe('iteration_cap');
    expect(parks).toEqual([{ reason: 'tool-loop', how: 'timer' }]);

    expect(beginJobRun(WORKER, 'timer'), 'the park carried the job').toBe(true);
    expect(jobOrigin(WORKER), 'the origin is the owner\'s ask').toEqual({ kind: 'ask', messageId: 'owner-ask' });
    const firstCall = callModelSpy.mock.calls.length;
    script({ reads: 0 });
    try { await runV2Turn(WORKER); } finally { endJobRun(WORKER); }
    const rec = turnRow(lastTurnNumber());
    expect(rec.subject_kind, 'not the peer\'s thread').not.toBe('a2a_thread');
    expect(rec.root_kind).not.toBe('a2a');
    expect(occurrences(firstView(firstCall).text, OWNER_ASK), 'the owner\'s question is in view').toBeGreaterThanOrEqual(1);
  });

  it('TWO claimed tasks from two different requests: a park that serves no person borrows nothing', async () => {
    await pmJob();
    await pmJob(OTHER_THREAD, 'Please also reconcile the second supplier ledger and list its closing code.', 'Second ledger reconciliation');
    anUnrelatedNotice('notice-two');
    script({ reads: 80 });
    await runV2Turn(WORKER);
    expect(turnRow(lastTurnNumber()).exit_reason).toBe('iteration_cap');
    expect(parks).toEqual([{ reason: 'tool-loop', how: 'timer' }]);

    // Nothing was named and nothing was guessed, so no job was registered: the existing behaviour stands.
    expect(beginJobRun(WORKER, 'timer'), 'no job: nothing to continue but a plain wake').toBe(false);
    expect(jobOrigin(WORKER)).toBeNull();
    script({ reads: 0 });
    await runV2Turn(WORKER);
    const rec = turnRow(lastTurnNumber());
    expect(rec.subject_kind).not.toBe('a2a_thread');
    expect(rec.root_kind).toBeNull();
  });

  it('TWO claimed tasks that point at the SAME request are not a guess: the origin is borrowed', async () => {
    await pmJob();
    // A second task the worker opened on the same ASSIGN thread (a later turn on it).
    const db = mockDb.current!;
    const first = db.prepare("SELECT * FROM work WHERE kind = 'task' AND agent_id = ?").get(WORKER) as Record<string, unknown>;
    const cols = Object.keys(first);
    const copy = { ...first, id: 'task-twin', opened_at: (first.opened_at as number) + 1 };
    db.prepare(`INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => copy[c]));
    anUnrelatedNotice('notice-same');
    script({ reads: 80 });
    await runV2Turn(WORKER);
    expect(beginJobRun(WORKER, 'timer')).toBe(true);
    expect(jobOrigin(WORKER)).toMatchObject({ kind: 'a2a', threadId: THREAD });
    endJobRun(WORKER);
  });
});
