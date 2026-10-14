// t149 F1 — a task opened on the turn a delegate's reply WAKES is linked to the owner's ask.
//
// The live order (walk evidence): the helper's first reply is a terminal A2A row that wakes the
// agent (`a2a_requires_response = 1`), so the wake turn's own record says `subject_kind =
// 'a2a_thread'`, `subject_id` = the reply's thread. t139's tie only read turns whose subject is
// 'none' (the engine's compile wake), so every task opened on a reply-woken turn was unlinked and
// the task list showed "original request not linked". The tie now also reads the turn's OWN
// subject: when it is a thread that is a piece of one of this agent's asks, the task continues
// that ask. A turn woken by anyone else's message is never tied (#12).
//
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const handleMessageSpy = vi.fn();

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
  return { ...actual, callModel: (...args: unknown[]) => callModelSpy(...args), getContextWindow: () => 200000 };
});
// THE TOOL DOOR: the tracker family runs for real, so the task row, its origin link and the
// engine floor's own scaffold are written by production code. Everything else is a canned
// success — the request shapes below are about WHICH work rows exist, not what an image is.
vi.mock('../../agent/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/tools/index.js')>('../../agent/tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../agent/tool-outcome.js')>('../../agent/tool-outcome.js');
  return {
    ...actual,
    executeTool: async (agentId: string, tc: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (tc.name.startsWith('work_') || tc.name === 'send_to_agent') return actual.executeTool(agentId, tc as never);
      return classifyToolResult({
        toolCallId: tc.id, name: tc.name,
        content: `ok: ${tc.name} accepted; it is rendering in the background`, isError: false,
      } as never);
    },
    getFilteredTools: () => [],
  };
});
// ROUND 3 (re-review): THE HARNESS MAY NEVER ABORT A TURN SILENTLY AGAIN. Round 1's canned tool
// results lacked a name, every turn threw after its first non-tracker call, the recovery path
// swallowed it, and the silent logger hid it — shapes "passed" on aborted turns. Every entry into
// the turn's recovery path is recorded here, and `afterEach` fails the clause that caused one.
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
vi.mock('../../memory/assembler.js', () => ({
  assembleContext: async () => ({
    systemPrompt: '<system prompt>',
    messages: [{ role: 'user', content: 'scripted' }] as Array<Record<string, unknown>>,
  }),
}));
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
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(),
  setLogBroadcast: vi.fn(),
  readLogEntries: () => [],
}));

import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage, insertEngineEvent } from '../../memory/message-store.js';
import { buildWorkBoardLane } from '../../memory/work-board-lane.js';
import { composeTurnDeliverySummary } from '../../tracker/task-stamps.js';
import { renderMessageTimeStamp } from '../../memory/message-stamp.js';
import { setTrackerStatus } from '../tracker-store.js';
import { stoppedAgents, pendingWakeups, turnContinuationCounts } from '../../agent/shared-state.js';
import { continuationContext } from '../../agent/turn-state.js';
import { deliverA2AMessage } from '../../agent/a2a-transport.js';
// The engine's step packages are found through the ONE shared derivation, never by a path
// literal (the guard-corpus census rule).
import { engineFileContaining, engineSources } from '../../agent/v2/__tests__/engine-sources.js';

const PRIMARY = 'primary';

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

function seedWorld(db: Database.Database): void {
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('test-provider', 'Test', 'anthropic', 'api_key')").run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
     VALUES ('test-model', 'test-provider', 'Test Model', 'test-1', '["tools","vision"]', 200000, 1)`,
  ).run();
  db.prepare(
    "INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Primary', 'test-model', 'idle', '{}', 'sensei')",
  ).run(PRIMARY);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(PRIMARY);
  // A second agent: the delegate in the delegated shapes, the sender in the A2A-originated one.
  db.prepare(
    "INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('helper', 'Helper', 'test-model', 'idle', '{}', 'worker')",
  ).run();
}

/** The owner says something, through the REAL writer (it opens the ask). Dashboard by default. */
function ownerSays(id: string, content: string, channel = 'dashboard', conversationId = 'conv-dash'): void {
  insertMessage({
    id, agentId: PRIMARY, role: 'user', content, turnNumber: 1,
    channel, senderId: 'owner', conversationId,
    inboundMeta: JSON.stringify({ channel, relation: 'owner' }),
  });
}

/** A turn's tool call, scripted. */
const call = (id: string, name: string, args: Record<string, unknown>): NonNullable<Step['toolCalls']>[number] =>
  ({ id, name, arguments: args });
const openTask = (id: string, title: string, goal: string): NonNullable<Step['toolCalls']>[number] =>
  call(id, 'work_open', { kind: 'task', title, description: `My plan: ${title}`, goal });

type Step = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };
/** The scripted provider: answers each model call from the script, then ends the turn. */
function script(steps: Step[]): void {
  let i = 0;
  callModelSpy.mockImplementation(async () => {
    const s = steps[i] ?? { content: 'Done.' };
    i++;
    const toolCalls = s.toolCalls ?? [];
    return {
      content: s.content ?? '', toolCalls, inputTokens: 100, outputTokens: 5,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  });
}

const imageCalls = (n: number, prefix = 'img'): Step['toolCalls'] =>
  Array.from({ length: n }, (_, k) => ({
    id: `${prefix}-${k}`, name: 'image_create',
    arguments: { description: `portrait ${k}`, aspect_ratio: '1:1', title: `p${k}` },
  }));

type TaskRow = { id: string; title: string; description: string | null; source_message_id: string | null; state: string; root_kind: string };
const openTasks = (agentId = PRIMARY): TaskRow[] =>
  mockDb.current!.prepare(
    `SELECT id, title, description, source_message_id, state, root_kind FROM work
      WHERE kind = 'task' AND agent_id = ? AND root_kind IN ('tracker','engine_scaffold','legacy')
        AND state NOT IN ('done','failed','abandoned')`,
  ).all(agentId) as TaskRow[];

async function taskList(agentId = PRIMARY): Promise<string> {
  return (await buildWorkBoardLane(agentId)).activeTasks ?? '';
}

/** A fictional long multi-step request of an exact length, with a marker at the very end. */
function longAsk(len: number, tag: string): string {
  const step = 'then gather the venue quotes for the spring workshop, compare catering lines, ';
  let s = `[${tag}] Here is the whole job, in order: `;
  while (s.length < len) s += step;
  const tail = ` END-OF-${tag}`;
  return s.slice(0, len - tail.length) + tail;
}

beforeEach(() => {
  mockDb.current = migratedDb();
  seedWorld(mockDb.current);
  callModelSpy.mockReset();
  handleMessageSpy.mockReset();
  handleMessageSpy.mockImplementation(async () => undefined);
  stoppedAgents.clear();
  pendingWakeups.clear();
  turnContinuationCounts.clear();
});

afterEach(() => {
  const hit = recoveries.splice(0);
  mockDb.current?.close();
  mockDb.current = null;
  expect(hit, 'a driven turn entered the recovery path (it threw); the clause ran on an aborted turn').toEqual([]);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// #7 C1 — THE FLOOR NO LONGER TITLES A TASK FROM THE TURN'S MESSAGE
// ════════════════════════════════════════════════════════════════════════════════════════

const piecesOf = (): Array<{ thread: string }> =>
  (mockDb.current!.prepare(
    `SELECT a2a_thread_id AS thread FROM messages WHERE source_agent_id = ? AND a2a_intent = 'ASSIGN' ORDER BY rowid`,
  ).all(PRIMARY) as Array<{ thread: string }>);

const lastTurn = (): { kind: string | null; subject_kind: string; subject_id: string | null } =>
  mockDb.current!.prepare(
    'SELECT kind, subject_kind, subject_id FROM turns WHERE agent_id = ? ORDER BY turn_number DESC LIMIT 1',
  ).get(PRIMARY) as { kind: string | null; subject_kind: string; subject_id: string | null };

/** The helper hands a result back the way a real helper does: a DELIVERABLE that wakes the agent. */
async function helperReplies(thread: string, payload: string, intent = 'DELIVERABLE'): Promise<void> {
  const back = await deliverA2AMessage({
    intent: intent as 'DELIVERABLE', threadId: thread, requiresResponse: true, payload,
    toAgent: PRIMARY, fromAgent: 'helper',
  });
  expect(back.delivered).toBe(true);
}

describe('t149 F1 — a task opened on the turn a helper\'s reply wakes is linked to the owner\'s ask', () => {
  it('one helper, whose first reply wakes the agent as an a2a_thread turn: the task is linked to the owner\'s ask', async () => {
    const ask = 'Have the helper collect three caterer quotes, then compare them and tell me which one to book.';
    ownerSays('msg-t149-one', ask);
    script([
      { toolCalls: [call('t149-sa1', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three caterer quotes for forty people.' })] },
      { content: 'I have asked Helper for the quotes.' },
    ]);
    await runV2Turn(PRIMARY);
    await helperReplies(piecesOf()[0].thread, 'Quotes: Alder 1,200; Birch 1,350; Cedar 990 (all for forty people).');
    script([
      { toolCalls: [openTask('t149-wo1', 'Caterer recommendation', 'A caterer recommendation sent to the owner')] },
      { content: 'The quotes are in; comparing them now.' },
    ]);
    await runV2Turn(PRIMARY);

    // The turn really was the live shape: woken by the reply, serving its thread.
    const turn = lastTurn();
    expect(turn.subject_kind).toBe('a2a_thread');
    expect(turn.subject_id).toBe(piecesOf()[0].thread);
    const rows = openTasks().filter((r) => r.title === 'Caterer recommendation');
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-t149-one');
    expect(await taskList()).toContain(ask);
  });

  it('two helpers, a task opened on EACH reply\'s wake turn: each is linked to the owner\'s ask', async () => {
    const ask = 'Have the helper collect caterer quotes and venue quotes separately, then combine them and tell me the cheapest pairing.';
    ownerSays('msg-t149-two', ask);
    script([
      { toolCalls: [
        call('t149-sa2', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three caterer quotes for forty people.' }),
        call('t149-sa3', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three venue quotes for forty people.' }),
      ] },
      { content: 'I have asked Helper for both sets of quotes.' },
    ]);
    await runV2Turn(PRIMARY);
    const threads = piecesOf().map((p) => p.thread);
    expect(threads.length).toBe(2);

    await helperReplies(threads[0], 'Caterers: Alder 1,200; Birch 1,350; Cedar 990.', 'ANSWER');
    script([
      { toolCalls: [openTask('t149-wo2', 'Note the caterers', 'The caterer quotes noted for the combine')] },
      { content: 'Caterers noted.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(lastTurn().subject_kind).toBe('a2a_thread');

    await helperReplies(threads[1], 'Venues: Dock 700; Elm Hall 850; Ferry 640.');
    script([
      { toolCalls: [openTask('t149-wo3', 'Combine the quotes', 'The cheapest pairing sent to the owner')] },
      { content: 'Both sets are in; combining them now.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(lastTurn().subject_kind).toBe('a2a_thread');

    for (const title of ['Note the caterers', 'Combine the quotes']) {
      const rows = openTasks().filter((r) => r.title === title);
      expect(rows.length, title).toBe(1);
      expect(rows[0].source_message_id, title).toBe('msg-t149-two');
    }
    expect(await taskList()).toContain(ask);
  });

  it('GUARD (#12): a peer\'s ASSIGN on its own thread while a delegation is open: a task opened on that turn is not linked to the owner\'s ask', async () => {
    ownerSays('msg-t149-peer', 'Have the helper collect three caterer quotes, then compare them and tell me which one to book.');
    script([
      { toolCalls: [call('t149-sa4', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three caterer quotes for forty people.' })] },
      { content: 'I have asked Helper for the quotes.' },
    ]);
    await runV2Turn(PRIMARY);
    const r = await deliverA2AMessage({
      intent: 'ASSIGN', threadId: 'thread-t149-peer', requiresResponse: true,
      payload: 'Unrelated: please tidy the shared drive folder names.', toAgent: PRIMARY, fromAgent: 'helper',
    });
    expect(r.delivered).toBe(true);
    script([
      { toolCalls: [openTask('t149-wo4', 'Drive tidy sub-step', 'Folder names tidied')] },
      { content: 'Tidying.' },
    ]);
    await runV2Turn(PRIMARY);

    const turn = lastTurn();
    expect(turn.kind).toBe('a2a');
    expect(turn.subject_kind).toBe('a2a_thread');
    const rows = openTasks().filter((t) => t.title === 'Drive tidy sub-step');
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).not.toBe('msg-t149-peer');
  });
});
