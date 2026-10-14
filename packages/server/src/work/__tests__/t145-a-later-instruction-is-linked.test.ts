// ════════════════════════════════════════════════════════════════════════════════════════
// t145 group A — THE STRUCTURAL NEWER-INSTRUCTION LINK (precondition 1 of the pin's deletion).
//
// The "still in force" pin carried the owner's newest long ask into every turn. Its deletion
// leaves one question: when the owner sends a LATER message that changes an open job, where do
// its words live? Not on a guess by text. The record is structural:
//
//     a turn that SERVES a later owner message in the task's own conversation, and updates the
//     open task, writes that link at the tracker tool door; the task list then prints the later
//     message after the original words (or points to it when it is already in view).
//
// DRIVEN through the engine's real turn entry (`runV2Turn`) on a real migrated database with a
// scripted provider and the real tracker tool door; the list is read through the lane builder
// the assembler calls every turn. Fixtures are fictional (G1).
//
// RED-FIRST: committed with each witness marked `it.fails`; the fix commit flips them to `it`.
// ════════════════════════════════════════════════════════════════════════════════════════


import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
import { writeTaskLog } from '../../tracker/task-log.js';
import { estimateTokens } from '../../memory/budget.js';
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

const taskIdTitled = (title: string): string =>
  (mockDb.current!.prepare("SELECT id FROM work WHERE kind = 'task' AND title = ? ORDER BY opened_at DESC LIMIT 1")
    .get(title) as { id: string }).id;

const ASK = longAsk(1500, 'ORIG');
const LATER = 'Change of plan: only four headshots, and make them black and white. LATER-WORDS-END';

/** The original ask, a task opened from it, and the turn finished. */
async function openJob(): Promise<string> {
  ownerSays('msg-1', ASK);
  script([{ toolCalls: [openTask('wo-1', 'Team headshots', 'Headshots delivered to the owner')] }, { content: 'Starting.' }]);
  await runV2Turn(PRIMARY);
  return taskIdTitled('Team headshots');
}

describe('t145 A1 — a later owner message that updates an open task is linked to it', () => {
  it('the task list prints the later message after the original words, word for word', async () => {
    const id = await openJob();
    ownerSays('msg-2', LATER);
    script([
      { toolCalls: [call('we-1', 'work_update', { action: 'edit', task_id: id, description: 'Owner changed the job: four, black and white.' })] },
      { content: 'Got it.' },
    ]);
    await runV2Turn(PRIMARY);

    const list = await taskList();
    expect(list).toContain(ASK);
    expect(list).toContain(LATER);
    expect(list.indexOf(LATER)).toBeGreaterThan(list.indexOf(ASK));
  });

  it('every write door records it: a note, a status change', async () => {
    const id = await openJob();
    ownerSays('msg-2', LATER);
    script([
      { toolCalls: [call('wn-1', 'work_note', { task_id: id, notes: 'Owner narrowed the job.' })] },
      { content: 'Noted.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(await taskList()).toContain(LATER);

    ownerSays('msg-3', 'And please put the file in the shared folder. THIRD-WORDS-END');
    script([
      { toolCalls: [call('wu-1', 'work_update', { action: 'status', task_id: id, status: 'in_progress', priority: 'high', notes: 'Folder noted.' })] },
      { content: 'Done.' },
    ]);
    await runV2Turn(PRIMARY);
    const list = await taskList();
    expect(list).toContain(LATER);
    expect(list).toContain('THIRD-WORDS-END');
    expect(list.indexOf('THIRD-WORDS-END')).toBeGreaterThan(list.indexOf(LATER));
  });

  it('CONTROLS: a later message whose turn does not touch the task, the original ask\'s own turn, and another conversation record nothing', async () => {
    const id = await openJob();
    // (a) a later message whose turn only answers
    ownerSays('msg-2', LATER);
    script([{ content: 'The headshots are in progress.' }]);
    await runV2Turn(PRIMARY);
    expect(await taskList()).not.toContain(LATER);
    // (b) the turn that serves the ORIGINAL ask updating its own task is not a "later" link
    const rows = mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') = 'newer_instruction'",
    ).get(id) as { n: number };
    expect(rows.n).toBe(0);
    // (c) a message in a DIFFERENT conversation (a contact's email) that updates the task
    mockDb.current!.prepare(
      `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name, created_at)
       VALUES ('conv-mail', ?, 'email', 'gmail', 'peer@example.test', 'A Peer', datetime('now'))`,
    ).run(PRIMARY);
    insertMessage({
      id: 'msg-mail', agentId: PRIMARY, role: 'user', content: 'Please also add my colleague to the shots. PEER-WORDS-END',
      turnNumber: 1, channel: 'email', senderId: 'peer@example.test', conversationId: 'conv-mail',
      inboundMeta: JSON.stringify({ channel: 'email', relation: 'contact' }),
    });
    script([
      { toolCalls: [call('wn-2', 'work_note', { task_id: id, notes: 'A peer asked for more.' })] },
      { content: 'Noted.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(await taskList()).not.toContain('PEER-WORDS-END');
  });

  it('CONTROL: the original ask\'s own turn updating its task links nothing', async () => {
    ownerSays('msg-1', ASK);
    script([
      { toolCalls: [openTask('wo-1', 'Team headshots', 'Headshots delivered')] },
      { toolCalls: [call('wn-0', 'work_note', { task_id: 'Team headshots', notes: 'first note' })] },
      { content: 'Starting.' },
    ]);
    await runV2Turn(PRIMARY);
    const id = taskIdTitled('Team headshots');
    const n = mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') = 'newer_instruction'",
    ).get(id) as { n: number };
    expect(n.n).toBe(0);
    // the note really was written (a refused call would make this control prove nothing)
    const wrote = mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND json_extract(payload, '$.note') = 'first note'",
    ).get(id) as { n: number };
    expect(wrote.n).toBe(1);
  });

  it('already in view: the list points to the later message instead of repeating its words', async () => {
    const id = await openJob();
    ownerSays('msg-2', LATER);
    script([
      { toolCalls: [call('wn-1', 'work_note', { task_id: id, notes: 'Owner narrowed the job.' })] },
      { content: 'Noted.' },
    ]);
    await runV2Turn(PRIMARY);
    const view = {
      availableTokens: 100_000,
      emitted: [{ role: 'user', content: LATER }],
      blocks: [], liveRows: [{ id: 'msg-2' }],
    };
    const list = (await buildWorkBoardLane(PRIMARY, view)).activeTasks ?? '';
    expect(list).toContain('it is in the conversation above, message msg-2');
    expect(list).not.toContain('LATER-WORDS-END');
    // the original ask is not in view, so its words are still on the list
    expect(list).toContain(ASK);
  });

  it('survives a reboot: the record is the database\'s, the list is rebuilt from it alone', async () => {
    const id = await openJob();
    ownerSays('msg-2', LATER);
    script([
      { toolCalls: [call('wn-1', 'work_note', { task_id: id, notes: 'Owner narrowed the job.' })] },
      { content: 'Noted.' },
    ]);
    await runV2Turn(PRIMARY);
    // a reboot: every process-memory structure is gone; only the database remains
    stoppedAgents.clear(); pendingWakeups.clear(); turnContinuationCounts.clear();
    const reopened = new Database(mockDb.current!.serialize());
    mockDb.current!.close();
    mockDb.current = reopened;
    expect(await taskList()).toContain(LATER);
  });

  it.fails('many later messages never outgrow the room: the rest collapse into one counted line naming the newest', async () => {
    const id = await openJob();
    for (let i = 0; i < 60; i++) {
      ownerSays(`msg-l${i}`, `Further change number ${i}: ${'detail '.repeat(40)}`);
      writeTaskLog({ taskId: id, fromEntity: 'engine', entryKind: 'newer_instruction', reason: `msg-l${i}` });
    }
    // a small window: the list gets what the loop's own later appends leave of 2,200 tokens
    const list = (await buildWorkBoardLane(PRIMARY, {
      availableTokens: 2200, emitted: [], blocks: [], liveRows: [],
    })).activeTasks ?? '';
    expect(estimateTokens(list)).toBeLessThanOrEqual(2200);
    expect(list).toMatch(/\[\d+ more later messages? sent while this task was open[^\]]*the newest of them is message msg-l\d+; history_get\(id="msg-l\d+"\) returns it\]/);
    // a waiting task prints no later messages (it is not current work): pointer only
    setTrackerStatus(id, 'paused', { by: 'agent', actorId: PRIMARY, reason: 'waiting on the owner to answer the question I asked' });
    const waiting = (await buildWorkBoardLane(PRIMARY)).activeTasks ?? '';
    expect(waiting).not.toContain('Further change number');
  });

  // ── ROUND 2 ───────────────────────────────────────────────────────────────────────────
  it.fails('A-I1: the label says only what is recorded: the turn that answered it touched this task, never "updated"', async () => {
    const id = await openJob();
    ownerSays('msg-2', 'What is the weather like tomorrow? WEATHER-WORDS-END');
    script([
      { toolCalls: [call('wn-w', 'work_note', { task_id: id, notes: 'Progress: 1 of 3 done.' })] },
      { content: 'Mild, around 18.' },
    ]);
    await runV2Turn(PRIMARY);
    const list = await taskList();
    expect(list).toContain('WEATHER-WORDS-END');
    expect(list).toContain('sent while this task was open (the turn that answered it touched this task)');
    expect(list).not.toMatch(/updated this task/);
  });

  it.fails('A-I2: under room pressure the NEWEST owner words get the room first: "use blue" is whole, the older text is what becomes a pointer', async () => {
    ownerSays('msg-big', longAsk(6000, 'BIGASK'));
    script([{ toolCalls: [openTask('wo-big', 'Colour the posters', 'Posters coloured')] }, { content: 'Starting.' }]);
    await runV2Turn(PRIMARY);
    const id = taskIdTitled('Colour the posters');
    ownerSays('msg-blue', 'Actually, use blue. USE-BLUE-END');
    writeTaskLog({ taskId: id, fromEntity: 'engine', entryKind: 'newer_instruction', reason: 'msg-blue' });
    // a tight view: room for roughly a thousand characters of words
    let proved = false;
    for (const available of [1500, 1650, 1800, 1950, 2100, 2300]) {
      const list = (await buildWorkBoardLane(PRIMARY, { availableTokens: available, emitted: [], blocks: [], liveRows: [] })).activeTasks ?? '';
      if (list.includes('history_get(id="msg-big")') && !list.includes('BIGASK-END')) {
        expect(list, `room ${available}: the newest words must be whole`).toContain('Actually, use blue. USE-BLUE-END');
        proved = true;
      }
    }
    expect(proved, 'no tight room cut the original while keeping the list, so the clause proved nothing').toBe(true);
  });
});
