// ════════════════════════════════════════════════════════════════════════════════════════
// t145 group B — THE "STILL IN FORCE" PIN IS GONE, AND A PRESENCE PING IS ANSWERED AS ONE (#7 part 2)
//
// The pin (the "active user directive" block) carried the owner's newest long unanswered ask into every
// turn under a header that said it was "still in force". A long ask whose answer stamp stayed
// NULL (the stale-work analysis §2A: a delegated, parked or background-finishing turn) was
// re-pinned for weeks, and on "You there?" the agent re-ran the finished work. The owner ruled
// the task list the only record of what is current (OR-TRACKER-1); t139 proved every multi-step
// request lands on it, with its words, and t140/t144 proved the words survive condensing.
//
// THE DOORS ARE THE REAL ONES. The owner speaks through `submitUserMessage`, every turn runs
// through `runV2Turn` with the REAL assembler, and the forced condense is the REAL `checkAndCompact`
// the compact route calls (`force: true`). Only the model is scripted, and the scripted model is a
// faithful picture of the failure: it OBEYS whatever block the prompt marks as in force, and
// otherwise answers a presence ping with a presence reply. What the model "saw" is read off the
// arguments the turn handed to `callModel`.
//
// RED-FIRST at the group A head: with the pin in the prompt, both legs make an effectful call.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const executeToolSpy = vi.fn();

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 't141-identity', 'dojo.db'),
  };
});
// The broadcast seam is REAL: it is where a dashboard reply's delivery receipt is written
// (`recordDashboardDelivery`), and without that receipt the owner's ask never closes.
vi.mock('../../agent/model.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/model.js')>('../../agent/model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../agent/tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/tools/index.js')>('../../agent/tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../agent/tool-outcome.js')>('../../agent/tool-outcome.js');
  // THE TRACKER DOOR IS REAL (`work_*` runs production code); every other tool is a canned success.
  return {
    ...actual,
    executeTool: async (...a: unknown[]) => {
      const tc = a[1] as { name?: string } | undefined;
      if (tc?.name?.startsWith('work_')) return (actual.executeTool as (...x: unknown[]) => Promise<unknown>)(...a);
      return classifyToolResult(await executeToolSpy(...a));
    },
    getFilteredTools: () => [],
  };
});
// The note a forced condense writes: the summarizer's own door, answered by script. It names the job
// the way a real note would, so the "folded into a note" leg is a faithful picture of the old failure.
vi.mock('../summarize.js', async (orig) => ({
  ...(await orig<typeof import('../summarize.js')>()),
  generateSummary: async () => ({
    ok: true as const,
    text: 'Earlier in this conversation the owner asked for a three-note job (VENUE-JOB-7731); it was carried out and reported.',
    tokenCount: 30,
  }),
}));
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../agent/pending-attachments.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/pending-attachments.js')>('../../agent/pending-attachments.js');
  return { ...actual, drainPendingAttachments: () => [], drainPendingAttachmentsWithCaptions: async () => [] };
});
vi.mock('../../costs/tracker.js', async () => ({ ...(await vi.importActual<typeof import('../../costs/tracker.js')>('../../costs/tracker.js')), recordCost: vi.fn() }));
vi.mock('../embeddings.js', () => ({
  queueEmbedding: vi.fn(), generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  storeEmbedding: async () => { /* not exercised */ }, refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../vector-search.js', () => ({ vectorSearch: async () => [], hybridSearch: async () => [] }));
vi.mock('../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false, clearIMResponseFlag: vi.fn(), sendResponseViaIMessage: vi.fn(),
  getPendingIMSenderRaw: () => null, stripSystemTags: (s: string) => s,
  // The safe-sender list is read for real (the watcher decides "direct to the agent" from
  // it); only the parse is restated, in the stored JSON shape the settings page writes.
  parseSafeSenders: (raw: string | null) => (raw ? (JSON.parse(raw) as Array<{ address: string }>) : []),
  sendIMessageWithAttachment: vi.fn(), addressesMatch: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
  getInboundSenderFor: () => null, sendAlert: vi.fn(),
  getTurnScopedImRecipient: () => null, getDefaultSender: () => null,
}));
vi.mock('../../config/platform.js', () => ({
  clearPlatformConfigCache: vi.fn(), getSudoPolicyRaw: () => null, getPlatformName: () => 'Dojo',
  getOwnerName: () => 'TestUser', getPrimaryAgentId: () => 'primary', getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm', getPMAgentName: () => 'PM', isPMEnabled: () => false,
  getTrainerAgentId: () => 'trainer', getTrainerAgentName: () => 'Trainer', isTrainerEnabled: () => false,
  getImaginerAgentId: () => 'imaginer', getImaginerAgentName: () => 'Imaginer', isImaginerEnabled: () => false,
  isSetupCompleted: () => true, setPlatformConfig: vi.fn(), getAllPlatformConfig: () => ({}),
  isPrimaryAgent: (id: string) => id === 'primary', isPMAgent: (id: string) => id === 'pm',
  isTrainerAgent: (id: string) => id === 'trainer', isImaginerAgent: (id: string) => id === 'imaginer',
  getHealerAgentId: () => 'healer', getHealerAgentName: () => 'Healer', isHealerAgent: (id: string) => id === 'healer',
  getDreamerAgentId: () => 'dreamer', getDreamerAgentName: () => 'Dreamer', isDreamerAgent: (id: string) => id === 'dreamer',
  HOUSEHOLD_AGENT_IDS_KEY: 'household_agent_ids', getHouseholdAgentIds: () => [],
  isPermanentAgent: (id: string) => id === 'primary' || id === 'dreamer', isSystemServiceAgent: () => false,
  getSystemServiceAgentIds: () => [], getDashboardHiddenAgentIds: () => new Set<string>(), isDashboardHiddenAgent: () => false,
}));
vi.mock('../../agent/spawner.js', () => ({ checkTimeouts: vi.fn() }));
vi.mock('../../healer/injury-recovery.js', () => ({ onAgentInjured: vi.fn(), onAgentRecovered: vi.fn(), rehydrateInjuredAgents: vi.fn() }));
vi.mock('../../vault/maintenance.js', () => ({ isContextOverflowError: () => false, recoverDreamerFromContextOverflow: async () => false }));
vi.mock('../../services/capabilities.js', () => ({ removeCapability: vi.fn(), getModelCapabilities: () => ['tools'] }));
vi.mock('../../services/presence.js', () => ({
  getPresence: () => 'present', maybeForwardToImessage: vi.fn(), isImessageConfigured: () => false,
  isImessageEnabled: () => false, setPresence: vi.fn(),
}));
vi.mock('../../router/scorer.js', () => ({ scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }) }));
vi.mock('../../router/selector.js', () => ({ selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { submitUserMessage } from '../../gateway/routes/chat.js';
import { checkAndCompact } from '../compaction.js';
import { buildWorkBoardLane } from '../work-board-lane.js';
import { assembleContext } from '../assembler.js';
import { POST_BUDGET_LANES } from '../lanes.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { registeredIds } from '../../prompt/registry/registry.js';
import fs from 'node:fs';
import path from 'node:path';

// ── the world ────────────────────────────────────────────────────────────────────────────

const AGENT = 'primary';
/** A small-window model keeps a short fresh tail (24 rows), so the forced condense has rows to fold. */
const SMALL_WINDOW = 16000;
let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  return db;
}

type Wire = { role: string; content: unknown };
const seen: Wire[][] = [];
/** The scripted model's answer to a turn that is NOT obeying a pin: each entry answers one call. */
let script: Array<{ content?: string; tool?: { name: string; arguments: Record<string, unknown> } }> = [];
let toolSeq = 0;
const EFFECTFUL = new Set(['file_write', 'send_email', 'image_create']);

function textOf(m: Wire): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<Record<string, unknown>>).map((b) =>
    b.type === 'text' ? String(b.text) : JSON.stringify(b)).join('\n');
}
const wireText = (call: Wire[]): string => call.map(textOf).join('\n\n');

/** The header the deleted pin printed, spelled in parts so this file is not itself a match for the grep-zero proof. */
const PIN = ['ACTIVE USER', 'DIRECTIVE'].join(' ');

/** The marker inside the finished long ask: the thing a re-run would act on. */
const JOB = 'VENUE-JOB-7731';
const LONG_ASK = `Please do this whole job, in order. ${JOB}: write three notes into the shared folder, `
  + 'one for each of the spring workshop venues on my list, each with the day rate and the catering lines, '
  + 'and when all three are written send me a single message that says they are done and where they are.';

function installModel(): void {
  callModelSpy.mockImplementation(async (params: { messages: Wire[]; purpose?: string }) => {
    if (params.purpose === 'memory_summarize') {
      return { content: `Earlier in this conversation the owner asked for a three-note job (${JOB}); it was carried out and reported.`, toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
    }
    seen.push(JSON.parse(JSON.stringify(params.messages)) as Wire[]);
    // THE FAILURE, FAITHFULLY: a model shown the job inside a block that calls itself "still in
    // force" does the job. Anything else follows the script (a presence ping gets a presence reply).
    const pinned = params.messages.map(textOf).some((t) => t.includes(PIN) && t.includes(JOB));
    const last = params.messages[params.messages.length - 1];
    const alreadyActed = params.messages.some((m) => m.role === 'assistant' && Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_use' && b.name === 'file_write' && JSON.stringify(b.input).includes('resumed')));
    // The failure showed on the presence ping: the pin outshouted the three words under it.
    const pingIsNewest = params.messages.some((m) => m.role === 'user' && textOf(m).includes('You there?'));
    if (pinned && pingIsNewest && !alreadyActed && last) {
      toolSeq += 1;
      return { content: '', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use',
        toolCalls: [{ id: `tc-${toolSeq}`, name: 'file_write', arguments: { path: 'notes/venue-1.md', content: 'resumed the job' } }] };
    }
    const step = script.shift() ?? { content: '[no-reply]' };
    if (step.tool) {
      toolSeq += 1;
      return { content: '', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use',
        toolCalls: [{ id: `tc-${toolSeq}`, name: step.tool.name, arguments: step.tool.arguments }] };
    }
    return { content: step.content ?? '', toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
  });
  executeToolSpy.mockImplementation(async (...a: unknown[]) => {
    const tc = a.find((x) => x && typeof x === 'object' && 'id' in (x as object)) as { id: string; name: string };
    return { toolCallId: tc.id, name: tc.name, content: `ok: ${tc.name} accepted`, isError: false };
  });
}

async function turn(...steps: typeof script): Promise<Wire[][]> {
  const before = seen.length;
  script = steps;
  await runV2Turn(AGENT);
  return seen.slice(before);
}

/** The effectful calls the tool door ran since `from` (an index into the spy's calls). */
const effectfulSince = (from: number): string[] =>
  executeToolSpy.mock.calls.slice(from)
    .map((c) => (c.find((x) => x && typeof x === 'object' && 'name' in (x as object)) as { name: string }).name)
    .filter((n) => EFFECTFUL.has(n));

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  seen.length = 0; script = []; toolSeq = 0;
  callModelSpy.mockReset(); executeToolSpy.mockReset();
  installModel();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

/** The finished long ask: the job done, the answer given — and its answer stamp left NULL. */
async function finishedLongAsk(): Promise<string> {
  const r = await submitUserMessage(AGENT, LONG_ASK);
  expect(r.ok).toBe(true);
  await turn(
    { tool: { name: 'file_write', arguments: { path: 'notes/venue-1.md', content: 'note one' } } },
    { tool: { name: 'file_write', arguments: { path: 'notes/venue-2.md', content: 'note two' } } },
    { tool: { name: 'file_write', arguments: { path: 'notes/venue-3.md', content: 'note three' } } },
    { content: 'All three notes are written, in the shared folder under notes/.' },
  );
  const row = mockDb.current!.prepare(
    "SELECT id, answer_message_id FROM messages WHERE role = 'user' AND content LIKE ? ORDER BY seq LIMIT 1",
  ).get(`%${JOB}%`) as { id: string; answer_message_id: string | null };
  // THE PREMISE (stale-work analysis §2A, step 2): the work is finished and the row's answer stamp
  // is NULL — the real shapes are a delegated, parked or background-finishing turn. None is driven
  // here, so the stamp is cleared on this one row and the test says so: it is a synthetic premise.
  mockDb.current!.prepare('UPDATE messages SET answer_message_id = NULL WHERE id = ?').run(row.id);
  return row.id;
}

/** Newer traffic: short answered exchanges and one long answered ask, so the finished job is buried. */
async function newerTraffic(): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await submitUserMessage(AGENT, `Quick question number ${i}: is room ${i} free on Thursday afternoon for the second workshop session?`);
    await turn({ content: `Room ${i} is free on Thursday afternoon.` });
  }
  await submitUserMessage(AGENT, 'Separately, please remind me about the quarterly tax estimate on the fifteenth, and tell me which account the payment normally leaves from so I can check the balance before then.');
  await turn({ content: 'I will remind you on the fifteenth; the payment leaves from the business checking account.' });
}

describe('t145 B — "You there?" after a finished long ask and newer traffic is answered as presence', () => {
  it('leg (a) the routine drain: no effectful call, a presence reply, and no pin in the prompt', async () => {
    await finishedLongAsk();
    await newerTraffic();
    const mark = executeToolSpy.mock.calls.length;
    await submitUserMessage(AGENT, 'You there?');
    const calls = await turn({ content: 'Yes, I am here.' });
    const all = calls.map(wireText).join('\n');
    expect(effectfulSince(mark), 'the finished job was run again').toEqual([]);
    expect(all).not.toContain(PIN);
    expect(all).not.toContain('still in force');
    const reply = mockDb.current!.prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1").get() as { content: string };
    expect(reply.content).toContain('Yes, I am here.');
  });

  it('leg (b) after a FORCED condense: the job is folded into a note, and still no effectful call', async () => {
    await finishedLongAsk();
    await newerTraffic();
    const out = await checkAndCompact(AGENT, 'm', SMALL_WINDOW, { force: true });
    expect(out.leafCreated + out.condensedCreated, 'the forced condense must really have folded rows').toBeGreaterThan(0);
    const mark = executeToolSpy.mock.calls.length;
    await submitUserMessage(AGENT, 'You there?');
    const calls = await turn({ content: 'Yes, I am here.' });
    expect(effectfulSince(mark), 'the finished job was run again').toEqual([]);
    expect(calls.map(wireText).join('\n')).not.toContain(PIN);
    // the job really is folded: the note carries it, the raw ask is no longer a live row
    expect(calls.map(wireText).join('\n')).toContain('COMPRESSED HISTORY');
    const reply = mockDb.current!.prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1").get() as { content: string };
    expect(reply.content).toContain('Yes, I am here.');
  });
});

describe('t145 B — backwards lifecycle: the owner\'s long ask MID-JOB survives a condense and a reboot on the task list', () => {
  it('the task list carries the ask whole after the rows leave view, and again after a reboot', async () => {
    await submitUserMessage(AGENT, LONG_ASK);
    await turn(
      { tool: { name: 'work_open', arguments: { kind: 'task', title: 'Spring venue notes', description: 'Three venue notes.', goal: 'Three notes written and the owner told' } } },
      { tool: { name: 'file_write', arguments: { path: 'notes/venue-1.md', content: 'note one' } } },
      { content: 'One of three is written; carrying on.' },
    );
    await newerTraffic();
    const out = await checkAndCompact(AGENT, 'm', SMALL_WINDOW, { force: true });
    expect(out.leafCreated, 'the forced condense must really have folded rows').toBeGreaterThan(0);

    const listAfterCondense = (await buildWorkBoardLane(AGENT)).activeTasks ?? '';
    expect(listAfterCondense).toContain(LONG_ASK);

    // A reboot: nothing in process memory survives; the database is all that remains.
    const reopened = new Database(mockDb.current!.serialize());
    mockDb.current!.close();
    mockDb.current = reopened;
    runMigrations();   // the next boot's migration pass over the existing body (an update that adds nothing)
    const listAfterReboot = (await buildWorkBoardLane(AGENT)).activeTasks ?? '';
    expect(listAfterReboot).toContain(LONG_ASK);

    // And it is what the next turn's assembly actually hands the model.
    const ctx = await assembleContext(AGENT, 'm');
    const wire = [...ctx.messages.map((m) => textOf(m as Wire)), ctx.activeTasksLane ?? ''].join('\n');
    expect(wire).toContain(LONG_ASK);
    expect(wire).not.toContain(PIN);
    // the ask is on the list and ONLY there: its raw row left the live conversation
    expect(ctx.messages.map((m) => textOf(m as Wire)).join('\n')).not.toContain(LONG_ASK);
  });
});

describe('t145 B — the pin is deleted, not hidden: no module, no lane, no registry entry, no slot, no field', () => {
  const SRC = path.resolve(__dirname, '..', '..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' || e.name === 'db' ? [] : walk(path.join(dir, e.name)))
      : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []);

  it('the proof the plan names: grep-zero for the pin\'s header, its context field and its reader', () => {
    const parts = [['ACTIVE USER', 'DIRECTIVE'].join(' '), ['directive', 'Lane'].join(''), ['getActive', 'UserDirective'].join('')];
    const hits = walk(SRC).filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return parts.some((x) => text.includes(x));
    });
    expect(hits.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('the module, the lane, the registry entry, the reserve and the slot are all gone', () => {
    expect(fs.existsSync(path.join(SRC, 'memory', ['direc', 'tive.ts'].join('')))).toBe(false);
    expect(POST_BUDGET_LANES.map((l) => l.id)).not.toContain('lane.directive');
    expect(registeredIds()).not.toContain('msg.directive');
    expect(Object.keys(MessageSlot)).not.toContain('ActiveDirectiveTail');
    expect(Object.keys(MessageSlot)).not.toContain('ActiveDirective');
  });
});
