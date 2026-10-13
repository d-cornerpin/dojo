// ════════════════════════════════════════════════════════════════════════════════════════
// t139 — EVERY MULTI-STEP REQUEST LANDS ON THE TASK LIST, WITH ITS OWN WORDS (#7 part 1).
//
// THE PROOF OBLIGATION THAT GATES THE PIN'S DELETION (t145). The "still in force" pin carried
// the newest long user request into every turn; the owner ruled the task list is the ONLY
// record of what is current (OR-TRACKER-1). The pin may go only once this is proven, for every
// shape a request can arrive in:
//
//     while the request is unfinished, there is an OPEN task whose `source_message_id` is the
//     row that carried the request, and the task list shows that row's words byte-for-byte.
//
// HOW IT IS DRIVEN. Through the engine's REAL turn entry (`runV2Turn`) on a REAL migrated
// database, with a SCRIPTED provider (`callModel` answers from a script) and the REAL tracker
// tool door (`executeTool` runs `work_*` for real; every other tool returns a canned success).
// The task list is then read through the lane builder the assembler calls every turn. Nothing
// here calls the linking or rendering code directly.
//
// It also owns the #7 C1 witness: a presence ping ("You there?") on a turn that went on to make
// nine untracked calls produced a task TITLED from the ping. The floor no longer titles or
// describes a task from the turn's message text; it links the row and lets the task list show it.
//
// Fixtures are fictional (G1).
//
// RED-FIRST: committed at v3.3.2 with every witness marked `it.fails` (it is RED there); the fix
// commit flips each one to `it`.
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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* observed through the DB */ } }));
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
      if (tc.name.startsWith('work_')) return actual.executeTool(agentId, tc as never);
      return classifyToolResult({ content: `ok: ${tc.name} accepted; it is rendering in the background`, isError: false });
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
import { insertMessage } from '../../memory/message-store.js';
import { buildWorkBoardLane } from '../../memory/work-board-lane.js';
import { stoppedAgents, pendingWakeups, turnContinuationCounts } from '../../agent/shared-state.js';

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
}

/** The owner says something on the dashboard, through the REAL writer (it opens the ask). */
function ownerSays(id: string, content: string): void {
  insertMessage({
    id, agentId: PRIMARY, role: 'user', content, turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
}

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
  stoppedAgents.clear();
  pendingWakeups.clear();
  turnContinuationCounts.clear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// #7 C1 — THE FLOOR NO LONGER TITLES A TASK FROM THE TURN'S MESSAGE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('t139 — a presence ping is never turned into a task title', () => {
  it.fails('RED at v3.3.2: nine untracked calls on a "You there?" turn do not open a task titled from the ping', async () => {
    ownerSays('msg-ping', 'You there?');
    script([{ toolCalls: imageCalls(9) }, { content: 'Yes, here.' }]);

    await runV2Turn(PRIMARY);

    const rows = openTasks();
    // The floor still tracks the untracked work — that requirement is unchanged —
    expect(rows.length).toBe(1);
    expect(rows[0].root_kind).toBe('engine_scaffold');
    // — but nothing about the row is invented from the ping's text.
    expect(rows[0].title).not.toMatch(/you there/i);
    expect(rows[0].description ?? '').not.toMatch(/you there/i);
    // It is LINKED to the row the turn actually served, so what was asked is a fact the task
    // list can show (labelled, dated) rather than a title the engine made up.
    expect(rows[0].source_message_id).toBe('msg-ping');
    expect(await taskList()).toContain('You there?');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE REQUEST SHAPES (t145's gate (a))
// ════════════════════════════════════════════════════════════════════════════════════════

describe('t139 — every multi-step request lands on the task list with its words', () => {
  it('long multi-step (the model opens the task): linked, and the 2,000 characters are on the list byte-for-byte', async () => {
    const ask = longAsk(2000, 'LONG');
    ownerSays('msg-long', ask);
    script([
      { toolCalls: [{ id: 'wo-1', name: 'work_open', arguments: {
        kind: 'task', title: 'Spring workshop venues', description: ask, goal: 'A comparison of venue quotes sent to the owner',
      } }] },
      { content: 'On it — I have opened a task and will work through the venues.' },
    ]);

    await runV2Turn(PRIMARY);

    const rows = openTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-long');
    expect(await taskList()).toContain(ask);
  });
});
