// ════════════════════════════════════════════════════════════════════════════════════════
// t173 — A JOB'S CONTINUATION TURN CARRIES THE JOB'S SUBJECT (so its view cannot empty).
//
// THE MEASURED SHAPE (run 10, S1, the dev box's own rows and log, 2026-10-15): a worker was assigned
// a job by another agent over an A2A thread and replied once. A later engine notice about its task
// woke it; that turn read 75 files and hit the tool-loop cap, so `parkJob` queued the job's
// continuation. The continuations (three, one after each cap/budget park) recorded NO kind, subject
// `none` and no root. Their tail was only the previous turn's tool rows, the integrity pass emptied
// it, and the zero-messages guard fired three times in the first calls
// (`Context assembly produced 0 messages after filtering, recovering last user message`): the
// job's own request reached the model unlabelled, from the raw table.
// Why: the served message (`memory/served-ask.ts`) is applied only to a turn whose own kind or
// subject is a2a or owner. A subject-less continuation had neither.
//
// EVERY clause below goes through the real doors: the real A2A delivery (which opens the job's task),
// the engine's real turn entry (`runV2Turn`), the real tool-loop cap and `parkJob`, the real
// assembler. Only the provider is scripted, and the continuation is started the way the runtime
// starts it (`beginJobRun` for the park's own wake, then the turn).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const handleMessageSpy = vi.fn();
const loggerErrorSpy = vi.fn();
/** The size of the world: the model's window and how much a read returns (a clause may shrink the window to force a trim). */
const world = vi.hoisted(() => ({ window: 200000, pad: 20 }));

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
      return classifyToolResult({
        toolCallId: tc.id, name: tc.name,
        content: `page ${String(tc.arguments.path ?? tc.id)}: ${'ledger line '.repeat(world.pad)}`, isError: false,
      } as never);
    },
    getFilteredTools: () => [],
  };
});
// A harness may never abort a turn silently: every entry into the recovery path fails the clause.
const recoveries: string[] = [];
vi.mock('../../agent/v2/steps/teardown/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/v2/steps/teardown/index.js')>('../../agent/v2/steps/teardown/index.js');
  return {
    ...actual,
    runTurnRecovery: (...args: Parameters<typeof actual.runTurnRecovery>) => {
      const err = args[2] as unknown;
      recoveries.push(err instanceof Error ? err.message : String(err));
      return actual.runTurnRecovery(...args);
    },
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
      total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0,
    }),
  };
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
  isContextOverflowError: () => false,
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
import { stoppedAgents, pendingWakeups, turnContinuationCounts } from '../../agent/shared-state.js';
import { continuationContext } from '../../agent/turn-state.js';
import { deliverA2AMessage } from '../../agent/a2a-transport.js';
import { recordA2AReply } from '../../agent/a2a-replies.js';
import { beginJobRun, endJobRun, endJobCarry, jobCarriedIds } from '../task-freshness.js';

const WORKER = 'worker';
const MANAGER = 'manager';
const THREAD = 'f00dcafe-1111-2222-3333-444455556666';
const ASSIGN_TEXT = 'I need a careful audit of a supplier ledger, page by page. Report the closing code and every wrong line.';
const OWNER_ASK = 'Please go through the whole supplier ledger folder and tell me which lines are wrong and the closing code.';
const LABEL = '(the message this work is answering)';
const ZERO_MESSAGES = 'Context assembly produced 0 messages after filtering';

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
  world.window = 200000; world.pad = 20;
  const db = migratedDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('test-provider', 'Test', 'anthropic', 'api_key')").run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('test-model', 'test-provider', 'Test Model', 'test-1', '["tools"]', ?, 1)`,
  ).run(world.window);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'test-model', 'idle', '{}', 'worker')").run(WORKER);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Manager', 'test-model', 'idle', '{}', 'sensei')").run(MANAGER);
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
});

afterEach(() => {
  endJobCarry(WORKER);
  const hit = recoveries.splice(0);
  mockDb.current?.close();
  mockDb.current = null;
  expect(hit, 'a driven turn entered the recovery path (it threw); the clause ran on an aborted turn').toEqual([]);
});

// ── THE SCRIPTED PROVIDER ────────────────────────────────────────────────────────────────
type Step = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };
let callNo = 0;
/** `reads` file reads (the 75-call cap parks a turn that makes them all), then a closing line. */
function script(opts: { reads: number; first?: Step }): void {
  let i = 0;
  callModelSpy.mockImplementation(async () => {
    i++;
    callNo++;
    const step: Step = i === 1 && opts.first ? opts.first
      : i <= opts.reads ? { toolCalls: [{ id: `rd-${callNo}`, name: 'file_read', arguments: { path: `/ledger/page-${callNo}.txt` } }] }
      : { content: 'Done for now.' };
    const toolCalls = step.toolCalls ?? [];
    return {
      content: step.content ?? '', toolCalls, inputTokens: 100, outputTokens: 5,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  });
}

const turnRow = (n: number): { kind: string | null; subject_kind: string; subject_id: string | null; root_kind: string | null; root_id: string | null; exit_reason: string | null } =>
  mockDb.current!.prepare('SELECT kind, subject_kind, subject_id, root_kind, root_id, exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?')
    .get(WORKER, n) as never;
const lastTurnNumber = (): number =>
  (mockDb.current!.prepare('SELECT MAX(turn_number) AS n FROM turns WHERE agent_id = ?').get(WORKER) as { n: number }).n;

const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
const zeroMessagesLogged = (): boolean => loggerErrorSpy.mock.calls.some((c) => String(c[0]).startsWith(ZERO_MESSAGES));
/** What the model was shown on the first call of the turn that just ran (calls from `from` on). */
const firstView = (from: number): { text: string; messages: Array<{ role: string; content: unknown }> } => {
  const params = callModelSpy.mock.calls[from]?.[0] as { messages?: Array<{ role: string; content: unknown }> } | undefined;
  const messages = params?.messages ?? [];
  return { text: JSON.stringify(messages), messages };
};

// ── THE JOB: a manager's ASSIGN over a thread (the real delivery opens the job's task), one reply sent ──
async function assignedJob(): Promise<{ taskId: string; assignId: string }> {
  const r = await deliverA2AMessage({
    intent: 'ASSIGN', threadId: THREAD, requiresResponse: true, payload: ASSIGN_TEXT, toAgent: WORKER, fromAgent: MANAGER,
  });
  expect(r.delivered).toBe(true);
  const db = mockDb.current!;
  const assignId = (db.prepare("SELECT id FROM messages WHERE agent_id = ? AND a2a_intent = 'ASSIGN'").get(WORKER) as { id: string }).id;
  const task = db.prepare('SELECT id FROM work WHERE agent_id = ? AND a2a_thread_id = ?').get(WORKER, THREAD) as { id: string } | undefined;
  expect(task, 'the real ASSIGN delivery opened the job\'s task, tied to the thread').toBeDefined();
  // The worker has answered the ASSIGN once (a first reply sent): it is not an unreplied request any more.
  recordA2AReply({ assignMessageId: assignId, agentId: WORKER, threadId: THREAD, replyIntent: 'ANSWER' });
  return { taskId: task!.id, assignId };
}

/** A later engine notice about the task (the measured wake), and the turn it drives. */
async function noticeTurn(taskId: string, id: string, reads: number): Promise<void> {
  insertEngineEvent({
    id, agentId: WORKER, content: '[SOURCE: AGENT NOTICE from PM] Checking in on the ledger audit: please keep going.',
    originIntent: 'tracker', turnNumber: null, work: { taskId, runId: null, rootKind: null, rootId: null },
  });
  script({ reads });
  await runV2Turn(WORKER);
}

/** The park's continuation, started the way the runtime starts it: from the park's own wake. */
async function continuationTurn(reads: number): Promise<{ turn: number; firstCall: number }> {
  expect(beginJobRun(WORKER, 'timer'), 'the park\'s own wake is owed, and the run carries the job').toBe(true);
  const firstCall = callModelSpy.mock.calls.length;
  script({ reads });
  try { await runV2Turn(WORKER); } finally { endJobRun(WORKER); }
  return { turn: lastTurnNumber(), firstCall };
}

describe('t173 (i): THE MEASURED SHAPE — an engine notice turn parks the job; its continuation serves the job\'s request', () => {
  it.fails('the continuation records the job\'s thread and root; its view holds the labelled ASSIGN, once; no zero-messages fallback', async () => {
    const { taskId, assignId } = await assignedJob();
    await noticeTurn(taskId, 'notice-1', 80);
    const parked = lastTurnNumber();
    expect(turnRow(parked).kind, 'the parking turn is the notice turn, an engine turn').toBe('engine');
    expect(turnRow(parked).exit_reason).toBe('iteration_cap');
    expect(jobCarriedIds(WORKER), 'the park carried the job\'s task').toEqual([taskId]);
    loggerErrorSpy.mockClear();

    const { turn, firstCall } = await continuationTurn(0);
    expect(turn).toBe(parked + 1);

    // The view: the ASSIGN once, labelled as the message this work is answering, leading it.
    const { text, messages } = firstView(firstCall);
    expect(zeroMessagesLogged(), 'no zero-messages fallback on a continuation').toBe(false);
    expect(occurrences(text, ASSIGN_TEXT), 'the request, once').toBe(1);
    expect(occurrences(text, LABEL), 'labelled, once').toBe(1);
    expect(messages[0].role).toBe('user');
    expect(JSON.stringify(messages[0])).toContain(ASSIGN_TEXT);
    expect(text, 'and the rest of the job\'s work is in view, not 7 messages out of 150').toContain('/ledger/page-');
    expect(messages.length).toBeGreaterThan(20);
    // The record names what the turn serves: the job's thread, the ASSIGN's own.
    const rec = turnRow(turn);
    expect(rec.kind).toBe('a2a');
    expect(rec.subject_kind).toBe('a2a_thread');
    expect(rec.subject_id).toBe(THREAD);
    expect(rec.root_kind).toBe('a2a');
    expect(rec.root_id).toBe(THREAD);

    void assignId;
  });
});

describe('t173 (ii): CHAINED parks — every continuation in the chain carries the job\'s origin', () => {
  it.fails('park, park, park: three continuations, each records the thread and each view holds the labelled ASSIGN', async () => {
    const { taskId } = await assignedJob();
    await noticeTurn(taskId, 'notice-chain', 80);
    loggerErrorSpy.mockClear();

    const seen: Array<{ turn: number; rec: ReturnType<typeof turnRow>; text: string; zero: boolean }> = [];
    for (const reads of [80, 80, 0]) {   // the first two park again (the chain), the last one finishes
      loggerErrorSpy.mockClear();
      const { turn, firstCall } = await continuationTurn(reads);
      seen.push({ turn, rec: turnRow(turn), text: firstView(firstCall).text, zero: zeroMessagesLogged() });
    }
    expect(seen.map((s) => s.rec.exit_reason).slice(0, 2), 'the first two continuations parked again').toEqual(['iteration_cap', 'iteration_cap']);
    for (const s of seen) {
      expect(s.rec.subject_kind, `turn ${s.turn}`).toBe('a2a_thread');
      expect(s.rec.subject_id, `turn ${s.turn}`).toBe(THREAD);
      expect(s.rec.root_id, `turn ${s.turn}`).toBe(THREAD);
      expect(s.zero, `turn ${s.turn}: no zero-messages fallback`).toBe(false);
      expect(occurrences(s.text, ASSIGN_TEXT), `turn ${s.turn}: the request, once`).toBe(1);
      expect(occurrences(s.text, LABEL), `turn ${s.turn}: labelled, once`).toBe(1);
    }
  });
});

describe('t173 (iii): an OWNER-asked job — its continuation serves the owner\'s ask the same way', () => {
  it.fails('the owner asked, the ask turn opened the job\'s task; a later notice turn parks it; the continuation shows the ask, labelled', async () => {
    const db = mockDb.current!;
    // A small window and full pages: the 75 reads outgrow it, so the front of the tail (the ask) is trimmed out of view.
    world.window = 40000; world.pad = 300;
    db.prepare("UPDATE models SET context_window = 40000 WHERE id = 'test-model'").run();
    insertMessage({
      id: 'owner-ask', agentId: WORKER, role: 'user', content: OWNER_ASK, turnNumber: 1,
      channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    script({
      reads: 0,
      first: { toolCalls: [{ id: 'open-1', name: 'work_open', arguments: { kind: 'task', title: 'Supplier ledger audit', description: 'Read every page', goal: 'Wrong lines and the closing code sent to the owner' } }] },
    });
    await runV2Turn(WORKER);
    const task = db.prepare("SELECT id, source_message_id FROM work WHERE kind = 'task' AND agent_id = ?").get(WORKER) as { id: string; source_message_id: string | null };
    expect(task.source_message_id, 'the job\'s task is tied to the owner\'s ask').toBe('owner-ask');

    await noticeTurn(task.id, 'notice-owner', 80);
    expect(turnRow(lastTurnNumber()).exit_reason).toBe('iteration_cap');
    loggerErrorSpy.mockClear();

    const { turn, firstCall } = await continuationTurn(0);
    const { text, messages } = firstView(firstCall);
    expect(zeroMessagesLogged(), 'no zero-messages fallback').toBe(false);
    // (A summary may also quote the ask; the served copy is the one wearing the label.)
    expect(occurrences(text, LABEL), 'labelled, once').toBe(1);
    const served = messages.find((m) => JSON.stringify(m).includes(LABEL));
    expect(JSON.stringify(served)).toContain(OWNER_ASK);
    expect(turn).toBeGreaterThan(1);
  });
});

describe('t173 (iv): a turn that is NOT a job\'s continuation is unchanged', () => {
  it('an engine-notice turn keeps its own subject and root (no job in flight)', async () => {
    const { taskId } = await assignedJob();
    insertEngineEvent({
      id: 'notice-plain', agentId: WORKER, content: '[SOURCE: AGENT NOTICE from PM] Checking in.',
      originIntent: 'tracker', turnNumber: null, work: { taskId, runId: null, rootKind: null, rootId: null },
    });
    script({ reads: 0 });
    await runV2Turn(WORKER);
    const rec = turnRow(lastTurnNumber());
    expect(rec.kind).toBe('engine');
    expect(rec.subject_kind).toBe('engine_event');
    expect(rec.subject_id).toBe('notice-plain');
    expect(rec.root_kind).toBe('engine');
  });

  it('a trigger-less wake that carries no job serves nothing: kind null, subject none, no root', async () => {
    await assignedJob();   // an ASSIGN thread exists, replied; but nothing parked, so no job is in flight
    script({ reads: 0 });
    await runV2Turn(WORKER);
    const rec = turnRow(lastTurnNumber());
    expect(rec.kind).toBeNull();
    expect(rec.subject_kind).toBe('none');
    expect(rec.root_kind).toBeNull();
  });

  it('a run NOT launched from the park\'s wake does not inherit the job, even while the job is parked', async () => {
    const { taskId } = await assignedJob();
    await noticeTurn(taskId, 'notice-stolen', 80);
    // No beginJobRun: this is a stray wake, not the park's continuation (t143 round 6).
    script({ reads: 0 });
    await runV2Turn(WORKER);
    const rec = turnRow(lastTurnNumber());
    expect(rec.subject_kind).toBe('none');
    expect(rec.root_kind).toBeNull();
  });
});
