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

import { decide } from '../done/decide.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
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
  getOwnerName: () => 'TestOwner',
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
import { setHold, holdOf } from '../done/hold.js';
import { stoppedAgents, pendingWakeups } from '../../agent/shared-state.js';
import { deliverA2AMessage } from '../../agent/a2a-transport.js';

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
/** The agent's board tasks; `closedToo` includes the ones its request's answer closed. */
const openTasks = (agentId = PRIMARY, closedToo = false): TaskRow[] =>
  mockDb.current!.prepare(
    `SELECT id, title, description, source_message_id, state, root_kind FROM work
      WHERE kind = 'task' AND agent_id = ? AND root_kind IN ('tracker','engine_scaffold','legacy')
        AND (? OR state NOT IN ('done','failed','abandoned')) ORDER BY rowid`,
  ).all(agentId, closedToo ? 1 : 0) as TaskRow[];

/** The helper's final reply through its real tool door, which also hands its job's task in. */
async function helperReplies(threadId: string, payload: string): Promise<{ isError?: boolean; content: string }> {
  const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');
  return toolResultOf(await executeTool('helper', { id: `tc-${threadId}`, name: 'send_to_agent', arguments: { agent: PRIMARY, intent: 'DELIVERABLE', thread_id: threadId, payload } }));
}

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

describe('t139 round 2 (I5) — the floor names its task from ENGINE FACTS, never the message', () => {
  it('the title states the calls the floor counted, the most-used tool and the turn\'s start, and the note invites a rename', async () => {
    ownerSays('msg-ping-i5', 'You there?');
    script([{ toolCalls: imageCalls(9) }, { content: 'Yes, here.' }]);
    await runV2Turn(PRIMARY);

    const row = openTasks(PRIMARY, true)[0];
    expect(row.title).toMatch(/^Multi-step task — 9 calls: image_create \[[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} [AP]M UTC[+-]\d{2}:\d{2}\]$/);
    expect(row.title).not.toMatch(/you there/i);
    const note = mockDb.current!.prepare(
      "SELECT content FROM messages WHERE role = 'system' AND content LIKE '[System] The engine opened tracker task%' ORDER BY seq DESC LIMIT 1",
    ).get() as { content: string };
    expect(note.content).toContain('rename it with work_update(action="edit", title=');
  });
});

describe('t139 — a presence ping is never turned into a task title', () => {
  it('RED at v3.3.2: nine untracked calls on a "You there?" turn do not open a task titled from the ping', async () => {
    ownerSays('msg-ping', 'You there?');
    script([{ toolCalls: imageCalls(9) }, { content: 'Yes, here.' }]);

    await runV2Turn(PRIMARY);

    const rows = openTasks(PRIMARY, true);
    // The floor still tracks the untracked work, and the turn's answer closes it with the request —
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('done');
    expect(rows[0].root_kind).toBe('engine_scaffold');
    // — but nothing about the row is invented from the ping's text.
    expect(rows[0].title).not.toMatch(/you there/i);
    expect(rows[0].description ?? '').not.toMatch(/you there/i);
    // It is LINKED to the row the turn actually served, rather than titled from it.
    expect(rows[0].source_message_id).toBe('msg-ping');
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

  it('short multi-step (the engine floor opens the task): linked, and closed with the request the turn answered', async () => {
    const ask = 'Find three venues near the station, compare their day rates, and email me the cheapest.';
    ownerSays('msg-short', ask);
    script([
      { toolCalls: Array.from({ length: 6 }, (_, k) => call(`ws-${k}`, 'web_search', { query: `venue ${k}` })) },
      { content: 'I have three candidates and am comparing them now.' },
    ]);

    await runV2Turn(PRIMARY);

    const rows = openTasks(PRIMARY, true);
    expect(rows.length).toBe(1);
    expect(rows[0].root_kind).toBe('engine_scaffold');
    expect(rows[0].source_message_id).toBe('msg-short');
    expect([rows[0].state, await taskList()]).toEqual(['done', '']);
  });

  it('background-finishing (image jobs still rendering when the turn ends): the line that closed the request closes its task', async () => {
    const ask = 'Make nine square headshots for the team page, one per person, in the same soft studio style.';
    ownerSays('msg-images', ask);
    script([{ toolCalls: imageCalls(9) }, { content: 'All nine are rendering now; they will drop in as they finish.' }]);

    await runV2Turn(PRIMARY);

    // The turn's line closed the request while the renders run, and the engine's own task ends with it.
    const rows = openTasks(PRIMARY, true);
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-images');
    expect([rows[0].state, (mockDb.current!.prepare("SELECT state FROM work WHERE id = 'ask:msg-images'").get() as { state: string }).state]).toEqual(['done', 'done']);
  });

  it('email-originated (the owner asks on the email channel): linked, and labelled with the email conversation', async () => {
    mockDb.current!.prepare(
      `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
       VALUES ('conv-mail', ?, 'email', 'gmail', 'owner', datetime('now'))`,
    ).run(PRIMARY);
    const ask = 'When you get a minute: pull last month\'s receipts from the shared folder, total them by category, and reply with the table.';
    ownerSays('msg-mail', ask, 'email', 'conv-mail');
    script([
      { toolCalls: [openTask('wo-mail', 'Receipts by category', 'A category total table sent to the owner')] },
      { content: 'Will do — totalling them now.' },
    ]);

    await runV2Turn(PRIMARY);

    const rows = openTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-mail');
    const list = await taskList();
    expect(list).toContain(ask);
    expect(list).toMatch(/Original request \(from [^\n]*email/);
  });

  it('A2A-originated (another agent ASSIGNs the work): the auto-task is linked to the delivered row and shows it byte-for-byte', async () => {
    const payload = 'Please reconcile the two supplier spreadsheets row by row and send me the mismatches as a list.';
    const r = await deliverA2AMessage({
      intent: 'ASSIGN', threadId: 'thread-t139-a2a', requiresResponse: true,
      payload, toAgent: PRIMARY, fromAgent: 'helper',
    });
    expect(r.delivered).toBe(true);

    const rows = openTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe(r.messageId);
    const row = mockDb.current!.prepare('SELECT content FROM messages WHERE id = ?').get(r.messageId!) as { content: string };
    expect(row.content).toContain(payload);
    expect(await taskList()).toContain(row.content);
  });

  it('started on a continuation (the task is opened on the turn after a budget park): linked to the ask that started it', async () => {
    // A budget park dates the request's task (opening one linked to the ask when the turn has none), and the
    // job's next turn is rooted in that ask (its turn record names it), so a task opened there is linked too.
    const ask = longAsk(1200, 'CONTINUED');
    ownerSays('msg-cont', ask);
    // Turn 1 works for longer than the turn budget, so the engine parks it and carries the
    // owner's conversation into a continuation. The clock is moved INSIDE the model call — the
    // same instant a real 16-minute call returns at.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let i = 0;
      callModelSpy.mockImplementation(async () => {
        i++;
        if (i === 1) {
          offset = 16 * 60_000;
          // An EFFECTFUL call (a render started), so the ask stays claimed by this job and the
          // next turn is a continuation of it rather than a fresh serve of the same message.
          return { content: 'On it — starting on the venues now.', toolCalls: [call('ex-c', 'exec', { command: 'echo notes > /tmp/t139-notes.txt' })], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
        }
        return { content: 'unreachable', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
      });
      await runV2Turn(PRIMARY);
      offset = 0;                                             // the next turn starts a fresh turn clock
      parkedDueNow();
      expect(openTasks().map((t) => t.source_message_id), 'the park opened the request\'s own task').toEqual(['msg-cont']);

      // Turn 2: the continuation. The model opens the task here.
      script([
        { toolCalls: [openTask('wo-cont', 'Continued job', 'The continued job, finished')] },
        { content: 'Picking up where I left off.' },
      ]);
      await runV2Turn(PRIMARY);
    } finally {
      nowSpy.mockRestore();
    }

    const turn2 = mockDb.current!.prepare(
      "SELECT source_message_id FROM turns WHERE agent_id = ? AND turn_number = 2",
    ).get(PRIMARY) as { source_message_id: string | null };
    expect(turn2.source_message_id).toBe('msg-cont');
    const rows = openTasks(PRIMARY, true);
    expect(rows.map((t) => t.state), 'the park\'s task closed with the answer; the agent\'s own stays').toEqual(['done', 'claimed']);
    expect(rows.every((t) => t.source_message_id === 'msg-cont'), 'every task of the job is linked to the ask').toBe(true);
    expect(await taskList()).toContain(ask);
  });

  // ROUND 3, R-V333-8 (replaces round 2's classifier rule, which held genuinely answered asks for
  // ever — re-review B1). The rule is keyed on the turn's recorded EXIT, never a classifier and
  // never the prose: when the turn ends with the engine CONTINUING the same work (a queued
  // self-continuation — the 15-minute park, the tool-loop cap, a context rebuild), the opening
  // line it held back ("On it.", text that rode with a tool call) is not the ask's answer, so the
  // ask stays owed for the continuation and closes when the continuation delivers. A turn that
  // genuinely ends settles exactly as before.
  /** A park dated the job's task on the test's jumped clock; on real time it is due now. */
  function parkedDueNow(): void { mockDb.current!.prepare('UPDATE work SET next_attempt_at = ? WHERE next_attempt_at IS NOT NULL').run(Date.now()); }
  const askStateOf = (msgId: string): string =>
    (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(`ask:${msgId}`) as { state: string }).state;

  it('a long job that parks after "On it." keeps the ask owed; the continuation\'s delivery closes it', async () => {
    // A one-verb request the start-ack classifier does not arm on, so "On it." riding with the
    // tool call is HELD BACK (not promoted as a start line) — the shape the t137 reviewer found
    // delivered as the answer at the park.
    ownerSays('msg-parked', 'Research the cheapest venue near the station for forty people.');
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let i = 0;
      callModelSpy.mockImplementation(async () => {
        i++;
        if (i === 1) {
          offset = 16 * 60_000;                         // the call returns past the turn budget
          return { content: 'On it.', toolCalls: [call('ws-p', 'web_search', { query: 'venues' })], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
        }
        return { content: 'unreachable', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
      });
      await runV2Turn(PRIMARY);
    } finally { nowSpy.mockRestore(); }
    const parked = mockDb.current!.prepare(
      'SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = 1',
    ).get(PRIMARY) as { exit_reason: string };
    expect(parked.exit_reason).toBe('iteration_cap');    // the engine continued the work
    expect(askStateOf('msg-parked')).toBe('blocked');    // "On it." was not the answer: the request is held on its job
    parkedDueNow();

    script([{ content: 'Here is the venue comparison: Dock 700, Ferry 640, Elm Hall 850 — Ferry is cheapest.' }]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-parked')).toBe('done');        // the continuation's delivery closes it
  });

  // ROUND 4, R-V333-11 (live evidence, t136 run bmv64ib0rkc #99007): at the 15-minute park the
  // engine re-delivered an EARLIER narration line ("Page 3 found one wrong line. Onward") as a new
  // user-visible bubble — the owner's "filler line every 15 minutes" (#10). On a turn the engine
  // is CONTINUING, the finalize recovery must not turn the held-back line into an answer bubble;
  // the line stays the working-note it already is, and the continuation's answer arrives once.
  it('a parked job never re-delivers its held-back narration as a visible bubble; the real answer arrives once', async () => {
    const line = 'Page 3 found one wrong line. Onward';
    ownerSays('msg-pages', 'Proofread the five report pages for wrong lines.');
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let i = 0;
      callModelSpy.mockImplementation(async () => {
        i++;
        if (i <= 2) {
          if (i === 2) offset = 16 * 60_000;            // the second call returns past the budget
          return { content: line, toolCalls: [call(`fr-${i}`, 'file_read', { path: `/report/page-${i + 2}.txt` })], inputTokens: 100, outputTokens: 5, stopReason: 'tool_use' };
        }
        return { content: 'unreachable', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
      });
      await runV2Turn(PRIMARY);
    } finally { nowSpy.mockRestore(); }
    expect((mockDb.current!.prepare('SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = 1').get(PRIMARY) as { exit_reason: string }).exit_reason).toBe('iteration_cap');
    const visible = (text: string): number => (mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'assistant' AND display_kind = 'agent-text' AND content = ?",
    ).get(PRIMARY, text) as { n: number }).n;
    expect(visible(line)).toBe(0);                       // no bubble made of the narration at the park
    parkedDueNow();

    const answer = 'All five pages checked: two wrong lines, on pages 3 and 5.';
    script([{ content: answer }]);
    await runV2Turn(PRIMARY);
    expect(visible(answer)).toBe(1);                     // the continuation's answer, once
    expect(visible(line)).toBe(0);
    expect(askStateOf('msg-pages')).toBe('done');
  });

  // CONTROLS — re-review B1's four cases: genuinely answered requests settle as they always did.
  it('CONTROL (B1): a lookup answered in text after one read closes on its answer', async () => {
    ownerSays('msg-b1a', 'Look up the population of France and compare it to Germany.');
    script([{ toolCalls: [call('ws-b1', 'web_search', { query: 'population France Germany' })] },
      { content: 'France has about 68 million people; Germany about 84 million.' }]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-b1a')).toBe('done');
  });

  it('CONTROL (B1): a draft written in the bubble closes on the bubble', async () => {
    ownerSays('msg-b1b', 'Draft a two-line thank-you note to the caterer and summarize what we agreed on the menu.');
    script([{ content: 'Thank you for the wonderful spread on Friday — everyone loved it.\nWe agreed: two mains, one vegetarian, dessert platter.' }]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-b1b')).toBe('done');
  });

  it('CONTROL (B1): a yes/no comparison answered in one line closes', async () => {
    ownerSays('msg-b1c', 'Can you check whether 2026 is a leap year and compare it with 2024?');
    script([{ content: 'No — 2026 is not a leap year; 2024 was.' }]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-b1c')).toBe('done');
  });

  it('CONTROL (B1): "create a task" answered with work_open then "Done" closes', async () => {
    ownerSays('msg-b1d', 'Create a task to remind me to call the venue on Friday.');
    script([{ toolCalls: [openTask('wo-b1d', 'Call the venue', 'The owner reminded on Friday')] }, { content: 'Done — the task is on the list.' }]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-b1d')).toBe('done');
  });

  it('CONTROL: a quick question the engine did NOT judge as work closes on its answer, as always', async () => {
    ownerSays('msg-quick', 'What is 15% of 240?');
    script([{ content: '36.' }]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-quick')).toBe('done');
  });

  it('CONTROL: a multi-step request whose turn DID the work (an effectful call) closes as before', async () => {
    const ask = longAsk(900, 'DIDWORK');
    ownerSays('msg-didwork', ask);
    script([
      { content: 'On it.', toolCalls: [call('ce-dw', 'calendar_create_event', { title: 'Venue visit', start: '2026-10-20T10:00:00Z' })] },
      { content: 'Done — the venue list is written up.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(askStateOf('msg-didwork')).toBe('done');
  });

  // ROUND 2, I3 (was RED and handed up in round 1). The task the agent opened for the owner's
  // request was CLOSED at the end of the delegating turn by the strike-0 receipt close, because
  // the ASSIGN sent to the helper counted as a tangible delivery ("via a2a"). An a2a delivery now
  // counts only when it went back to the agent who asked on that thread
  // (`tracker/task-stamps.ts` `composeTurnDeliverySummary`).
  it('delegated, then held while the delegated work runs: the task is linked, open, and shows the words throughout', async () => {
    const ask = 'Get the helper to draft the venue shortlist, then you check it against my calendar and send me the final pick.';
    ownerSays('msg-deleg', ask);
    script([
      { content: 'On it, getting a shortlist first.', toolCalls: [openTask('wo-deleg', 'Venue pick', 'A final venue pick checked against the calendar')] },
      { toolCalls: [call('sa-1', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Draft a venue shortlist of three options with day rates.' })] },
      { content: 'I have asked Helper for a shortlist and will check it against your calendar when it lands.' },
    ]);
    await runV2Turn(PRIMARY);

    // HELD: the ask is owed behind the delegation; the task is open, linked, and on the list.
    const askRow = mockDb.current!.prepare(
      "SELECT state, remaining_children FROM work WHERE id = 'ask:msg-deleg'",
    ).get() as { state: string; remaining_children: number | null };
    expect(askRow.state).toBe('blocked');
    expect(askRow.remaining_children).toBe(1);
    // The task opened for the request became the helper's job: one task, linked, on the list.
    expect(openTasks()).toHaveLength(0);
    const held = openTasks('helper');
    expect(held.length).toBe(1);
    expect(held[0].source_message_id).toBe('msg-deleg');
    expect(await taskList('helper')).toContain(ask);
  });

  it('CONTROL (I3): an A2A-assigned job answered back to its ASSIGNER is still a handover ("via a2a")', async () => {
    const r = await deliverA2AMessage({
      intent: 'ASSIGN', threadId: 'thread-t139-back', requiresResponse: true,
      payload: 'Please list the three cheapest venues near the station.', toAgent: PRIMARY, fromAgent: 'helper',
    });
    expect(r.delivered).toBe(true);
    script([
      { toolCalls: [call('sa-back', 'send_to_agent', { agent: 'Helper', intent: 'DELIVERABLE', thread_id: 'thread-t139-back', payload: 'Dock 700; Ferry 640; Elm Hall 850.' })] },
      { content: '[no-reply]' },
    ]);
    await runV2Turn(PRIMARY);
    const turn = (mockDb.current!.prepare('SELECT MAX(turn_number) AS t FROM turns WHERE agent_id = ?').get(PRIMARY) as { t: number }).t;
    expect(composeTurnDeliverySummary(PRIMARY, turn)).toBe('via a2a');
  });

  it('CONTROL (I3): the delegating turn\'s own ASSIGN is not a handover', async () => {
    ownerSays('msg-deleg-sum', 'Get the helper to draft a venue shortlist and then send me the final pick.');
    script([
      { toolCalls: [call('sa-sum', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Draft a venue shortlist of three options.' })] },
      { content: 'I have asked Helper for a shortlist.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(composeTurnDeliverySummary(PRIMARY, 1)).not.toContain('a2a');
  });

  it('the task the engine floor opened before the agent delegated becomes the helper\'s job: one task, not two', async () => {
    ownerSays('msg-floor-deleg', 'Make me six pictures of the beach, then have the helper plan the day around them.');
    script([
      { toolCalls: imageCalls(6) },
      { content: 'On it.', toolCalls: [call('sa-fd', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Plan the beach day.' })] },
      { content: 'I have asked Helper to plan the day.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(openTasks()).toHaveLength(0);
    const held = openTasks('helper');
    expect(held.map((t) => [t.root_kind, t.source_message_id])).toEqual([['engine_scaffold', 'msg-floor-deleg']]);
  });

  it('delegated to one helper, whose reply the engine relays, with the task opened on the turn that reply woke: linked to the owner\'s ask', async () => {
    const ask = 'Have the helper collect three caterer quotes, then compare them and tell me which one to book.';
    ownerSays('msg-deleg1', ask);
    script([
      { toolCalls: [call('sa-1b', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three caterer quotes for forty people.' })] },
      { content: 'I have asked Helper for the quotes.' },
    ]);
    await runV2Turn(PRIMARY);
    const thread = (mockDb.current!.prepare(
      `SELECT a2a_thread_id AS t FROM messages WHERE source_agent_id = ? AND a2a_intent = 'ASSIGN' ORDER BY rowid DESC LIMIT 1`,
    ).get(PRIMARY) as { t: string }).t;
    const back = await helperReplies(thread, 'Quotes: Alder 1,200; Birch 1,350; Cedar 990 (all for forty people).');
    expect(back.isError, back.content).toBeFalsy();
    script([
      { toolCalls: [openTask('wo-deleg1', 'Caterer recommendation', 'A caterer recommendation sent to the owner')] },
      { content: 'The quotes are in; comparing them now.' },
    ]);
    await runV2Turn(PRIMARY);

    const rows = openTasks().filter((r) => r.title === 'Caterer recommendation');
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-deleg1');
    expect(await taskList()).toContain(ask);
  });

  it('delegated to two helpers, with the task opened when the last result wakes the agent to compile: linked to the owner\'s ask', async () => {
    const ask = 'Have the helper collect caterer quotes and venue quotes separately, then combine them and tell me the cheapest pairing.';
    ownerSays('msg-deleg2', ask);
    script([
      { toolCalls: [
        call('sa-2', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three caterer quotes for forty people.' }),
        call('sa-3', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'Collect three venue quotes for forty people.' }),
      ] },
      { content: 'I have asked Helper for both sets of quotes.' },
    ]);
    await runV2Turn(PRIMARY);
    expect(openTasks().length).toBe(0);

    // Both delegates answer on the threads the delegation opened; the join completes and the
    // owner's ask becomes compile-pending — the wake turn's job is to combine them.
    const threads = (mockDb.current!.prepare(
      `SELECT a2a_thread_id AS t FROM messages WHERE source_agent_id = ? AND a2a_intent = 'ASSIGN' ORDER BY rowid`,
    ).all(PRIMARY) as Array<{ t: string }>).map((r) => r.t);
    expect(threads.length).toBe(2);
    for (const [k, thread] of threads.entries()) {
      const back = await helperReplies(thread, k === 0 ? 'Caterers: Alder 1,200; Birch 1,350; Cedar 990.' : 'Venues: Dock 700; Elm Hall 850; Ferry 640.');
      expect(back.isError, back.content).toBeFalsy();
    }

    // The wake turn: the results are in, and the agent opens the task to finish the job.
    script([
      { toolCalls: [openTask('wo-deleg2', 'Cheapest pairing', 'The cheapest caterer and venue pairing sent to the owner')] },
      { content: 'Both sets are in; combining them now.' },
    ]);
    await runV2Turn(PRIMARY);

    const rows = openTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-deleg2');
    expect(await taskList()).toContain(ask);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// BACKWARDS LIFECYCLE (feature-testing standing order): cancel, supersede, repeat.
// "Ask again days later" needs an aged world (t134's doors) and is LIVE WALK OWED.
// ════════════════════════════════════════════════════════════════════════════════════════

const taskIdTitled = (title: string): string =>
  (mockDb.current!.prepare("SELECT id FROM work WHERE kind = 'task' AND title = ? ORDER BY opened_at DESC LIMIT 1")
    .get(title) as { id: string }).id;

describe('t139 — backwards lifecycle: the list follows the request, never a stale one', () => {
  it('ask -> the owner cancels -> re-ask: the cancelled task leaves the list; the re-ask is linked to ITS row', async () => {
    const ask = 'Draft the newsletter intro, pull three photos from the event folder, and send me the draft.';
    ownerSays('msg-nl-1', ask);
    script([{ toolCalls: [openTask('wo-nl-1', 'Newsletter draft', 'A newsletter draft sent to the owner')] }, { content: 'On it.' }]);
    await runV2Turn(PRIMARY);
    const first = taskIdTitled('Newsletter draft');

    expect(decide({ workId: first, deciderAgentId: null, verdict: 'cancel', reason: 'I will do it myself' }).kind).toBe('decided');   // the owner's own cancel
    expect(openTasks().length).toBe(0);
    expect(await taskList()).not.toContain(ask);

    ownerSays('msg-nl-2', ask);   // the SAME words, a new row
    script([{ toolCalls: [openTask('wo-nl-2', 'Newsletter draft again', 'A newsletter draft sent to the owner')] }, { content: 'Back on it.' }]);
    await runV2Turn(PRIMARY);

    const rows = openTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-nl-2');
    const list = await taskList();
    expect(list.split(ask).length - 1).toBe(1);   // shown once, for the live task only
  });

  it('ask -> superseded by a newer instruction -> query: the list keeps the original words AND the agent\'s recorded change', async () => {
    const ask = 'Make nine square headshots for the team page in the same soft studio style.';
    ownerSays('msg-hs-1', ask);
    script([{ toolCalls: [openTask('wo-hs', 'Team headshots', 'Headshots delivered to the owner')] }, { content: 'Starting.' }]);
    await runV2Turn(PRIMARY);
    const id = taskIdTitled('Team headshots');

    ownerSays('msg-hs-2', 'Change of plan: only four headshots, and make them black and white.');
    script([
      { toolCalls: [call('we-1', 'work_update', { action: 'edit', task_id: id, description: 'Owner changed the job: four headshots, black and white.' })] },
      { content: 'Got it — four, black and white.' },
    ]);
    await runV2Turn(PRIMARY);

    ownerSays('msg-hs-3', 'What are you working on right now?');
    script([{ content: 'The four black-and-white headshots.' }]);
    await runV2Turn(PRIMARY);

    // The task is still the same piece of work, linked to the request that started it. The
    // newer instruction is a newer row of the conversation; what the list carries for it is the
    // change the agent RECORDED on the task — never a guess at which message "won".
    const rows = openTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].source_message_id).toBe('msg-hs-1');
    const list = await taskList();
    expect(list).toContain(ask);
    expect(list).toContain("The task's own description (as last edited):\nOwner changed the job: four headshots, black and white.");
    expect(list).not.toContain('What are you working on right now?');
  });

  it('ask again DAYS later (backdated rows): the new task carries the new row and its own date, never the old job', async () => {
    const ask = 'Make nine square headshots for the team page in the same soft studio style.';
    ownerSays('msg-sept', ask);
    script([{ toolCalls: [openTask('wo-sept', 'Headshots (September)', 'Headshots delivered')] }, { content: 'On it.' }]);
    await runV2Turn(PRIMARY);
    const oldId = taskIdTitled('Headshots (September)');
    expect(decide({ workId: oldId, deciderAgentId: null, verdict: 'cancel', reason: 'delivered by hand' }).kind).toBe('decided');   // the owner's own close
    script([{ content: 'Glad you like them.' }]);
    ownerSays('msg-sept-close', 'Thanks, those are perfect.');
    await runV2Turn(PRIMARY);
    backdate(oldId, 'msg-sept', 21);
    mockDb.current!.prepare("UPDATE messages SET created_at = created_at - ? WHERE id = 'msg-sept-close'").run(21 * 86_400_000);
    const oldAt = (mockDb.current!.prepare("SELECT created_at FROM messages WHERE id = 'msg-sept'").get() as { created_at: number }).created_at;

    ownerSays('msg-oct', ask);   // the same words, three weeks on
    script([{ toolCalls: [openTask('wo-oct', 'Headshots (October)', 'Headshots delivered')] }, { content: 'On it again.' }]);
    await runV2Turn(PRIMARY);

    const rows = openTasks();
    expect(rows.map((r) => r.source_message_id)).toEqual(['msg-oct']);
    const newAt = (mockDb.current!.prepare("SELECT created_at FROM messages WHERE id = 'msg-oct'").get() as { created_at: number }).created_at;
    const list = await taskList();
    expect(list).toContain(renderMessageTimeStamp(newAt)!);
    expect(list).not.toContain(renderMessageTimeStamp(oldAt)!);
    expect(list.split(ask).length - 1).toBe(1);
  });

  it('the same ask repeated verbatim: each task names its own row and its own recorded instant', async () => {
    const ask = 'Collect the quarterly receipts and total them by category.';
    ownerSays('msg-rep-1', ask);
    script([{ toolCalls: [openTask('wo-rep-1', 'Receipts A', 'Category totals sent to the owner')] }, { content: 'On it.' }]);
    await runV2Turn(PRIMARY);
    await new Promise((r) => setTimeout(r, 1100));   // a second row, a later instant
    ownerSays('msg-rep-2', ask);
    script([{ toolCalls: [openTask('wo-rep-2', 'Receipts B', 'Category totals sent to the owner')] }, { content: 'On it again.' }]);
    await runV2Turn(PRIMARY);

    const rows = openTasks();
    expect(rows.map((r) => r.source_message_id).sort()).toEqual(['msg-rep-1', 'msg-rep-2']);
    const list = await taskList();
    const heads = list.match(/Original request \(from [^\n]*\), word for word:/g) ?? [];
    expect(heads.length).toBe(2);
    // Two rows, so two recorded instants — the duplicate is visible as a duplicate, not merged.
    const stamps = mockDb.current!.prepare("SELECT created_at FROM messages WHERE id IN ('msg-rep-1','msg-rep-2')").all() as Array<{ created_at: number }>;
    expect(new Set(stamps.map((x) => x.created_at)).size).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// R-V333-5 — NO AUTOMATIC REOPEN. An owner message never resumes paused work by itself.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Move a work row and its history back in time, so an "old" task is genuinely old on every
 *  clock the engine reads (opened, updated, its events, and the message that started it). */
function backdate(taskId: string, msgId: string, days: number): void {
  const db = mockDb.current!;
  const ms = days * 86_400_000;
  db.prepare('UPDATE work SET opened_at = opened_at - ?, updated_at = updated_at - ? WHERE id = ?').run(ms, ms, taskId);
  db.prepare('UPDATE work_events SET created_at = created_at - ? WHERE work_id = ?').run(ms, taskId);
  db.prepare('UPDATE messages SET created_at = created_at - ? WHERE id = ?').run(ms, msgId);
}

/** The engine's pause, through the same door and with the same words `pauseDriveWorkWaitingOnOwner`
 *  uses. Round 2 narrowed WHEN the engine pauses (never a task opened in the same turn, never on a
 *  turn that served nothing or wrote to the tracker), so these clauses — which are about what
 *  happens to work that IS waiting — put it there directly. */
function parkWaitingOnOwner(taskId: string): void {
  expect(setHold(taskId, 'paused', 'Waiting for a reply to its last message.', 'engine').ok).toBe(true);
}

describe('t139 R-V333-5 — "You there?" never resumes a paused task', () => {
  it('RED at base: an owner message on an agent with a month-old engine-paused task leaves it paused', async () => {
    const ask = 'Make nine square headshots for the team page in the same soft studio style.';
    ownerSays('msg-old-hs', ask);
    script([{ toolCalls: [openTask('wo-old-hs', 'Team headshots', 'Headshots delivered to the owner')] }, { content: 'Starting on them.' }]);
    await runV2Turn(PRIMARY);
    const id = taskIdTitled('Team headshots');
    parkWaitingOnOwner(id);
    expect(holdOf(id)?.kind).toBe('paused');   // parked, waiting on the owner
    backdate(id, 'msg-old-hs', 30);

    ownerSays('msg-ping-2', 'You there?');
    // What the model SEES is the state at the moment it is called — a reopen followed by the
    // turn-end re-pause would look identical afterwards, so the state is read mid-turn.
    const seen: string[] = [];
    callModelSpy.mockImplementation(async () => {
      seen.push(holdOf(id)?.kind ?? 'none');
      return { content: 'Yes, here.', toolCalls: [], inputTokens: 100, outputTokens: 5, stopReason: 'end_turn' };
    });
    await runV2Turn(PRIMARY);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((st) => st === 'paused')).toBe(true);
    expect(holdOf(id)?.kind).toBe('paused');
    // requirement preserved: the waiting task never vanishes — it is on the list, labelled.
    expect(await taskList()).toContain('Team headshots');
  });

  it('when the owner\'s message IS the answer, the agent resumes the task through the tracker', async () => {
    ownerSays('msg-q', 'Draft the newsletter intro and send it to me for a check before it goes out.');
    script([{ toolCalls: [openTask('wo-q', 'Newsletter intro', 'An intro the owner approved')] }, { content: 'Do you want it formal or casual?' }]);
    await runV2Turn(PRIMARY);
    const id = taskIdTitled('Newsletter intro');
    parkWaitingOnOwner(id);
    expect(holdOf(id)?.kind).toBe('paused');

    ownerSays('msg-a', 'Casual, please.');
    script([
      { toolCalls: [call('wu-r', 'work_update', { action: 'status', task_id: id, status: 'in_progress', notes: 'Owner answered: casual.' })] },
      { content: 'Casual it is.' },
    ]);
    await runV2Turn(PRIMARY);
    expect((mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state).toBe('claimed');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE COMPILE LINK'S CONTROLS — it never guesses, and it never re-points a served turn
// ════════════════════════════════════════════════════════════════════════════════════════

/** One owner ask fanned out to two helpers, both pieces delivered: the ask is left
 *  compile-pending, exactly as the engine leaves it. Returns nothing; reads the spine after. */
async function fanOutAndLand(msgId: string, ask: string, tag: string): Promise<void> {
  ownerSays(msgId, ask);
  script([
    { toolCalls: [
      call(`${tag}-a`, 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: `${tag}: collect part one.` }),
      call(`${tag}-b`, 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: `${tag}: collect part two.` }),
    ] },
    { content: `Asked Helper for both parts of ${tag}.` },
  ]);
  await runV2Turn(PRIMARY);
  const threads = (mockDb.current!.prepare(
    `SELECT a2a_thread_id AS t FROM messages WHERE source_agent_id = ? AND a2a_intent = 'ASSIGN' AND content LIKE ? ORDER BY rowid`,
  ).all(PRIMARY, `%${tag}:%`) as Array<{ t: string }>).map((r) => r.t);
  expect(threads.length).toBe(2);
  for (const thread of threads) {
    const back = await deliverA2AMessage({
      intent: 'DELIVERABLE', threadId: thread, requiresResponse: false,
      payload: `${tag} part result.`, toAgent: PRIMARY, fromAgent: 'helper',
    });
    expect(back.delivered).toBe(true);
  }
}

describe('t139 round 2 (hand-up 4) — a delegation joins only the sends of ITS OWN turn', () => {
  it('two delegating turns inside one wall-clock second: the second join holds only its own piece', async () => {
    // The clock is pinned (Date only — timers stay real) so both turns start in the same second,
    // 500 ms apart: the shape a whole-second lower bound cannot tell apart.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-12T15:00:00.100Z'));
      ownerSays('msg-sec-a', 'Have the helper collect caterer quotes and venue quotes, then combine them.');
      script([
        { toolCalls: [
          call('sa-sa', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'SECA: caterer quotes.' }),
          call('sa-sb', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'SECA: venue quotes.' }),
        ] },
        { content: 'Asked Helper for both.' },
      ]);
      await runV2Turn(PRIMARY);
      vi.setSystemTime(Date.parse('2026-10-12T15:00:00.600Z'));
      ownerSays('msg-sec-b', 'Separately, have the helper check the train times for Thursday.');
      script([
        { toolCalls: [call('sa-sc', 'send_to_agent', { agent: 'Helper', intent: 'ASSIGN', payload: 'SECB: train times.' })] },
        { content: 'Asked Helper for the train times.' },
      ]);
      await runV2Turn(PRIMARY);
    } finally { vi.useRealTimers(); }

    const pieces = (askId: string): number => (mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM work WHERE parent_id = ? AND root_kind = 'a2a_thread'",
    ).get(askId) as { n: number }).n;
    expect(pieces('ask:msg-sec-a')).toBe(2);
    expect(pieces('ask:msg-sec-b')).toBe(1);
  });
});

