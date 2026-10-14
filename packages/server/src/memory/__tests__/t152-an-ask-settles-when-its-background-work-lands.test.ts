// ════════════════════════════════════════════════════════════════════════════════════════
// t152 (walks round 2, image shape) — AN ASK THAT WAITS ON BACKGROUND JOBS SETTLES WHEN THEIR RESULT
// REACHES THE OWNER.
//
// Live: seven `image_create` calls for one request. The model called the tool seven times and ended
// its turn (the tool tells it to: the engine posts each image itself). The turn ended with no reply,
// the ask was handed back a few times and then held (`blocked`); the seven images arrived, each a
// delivered bubble labelled with the request; and the ask stayed `blocked` for ever, because the only
// thing that ever closed an ask on a delivery was a delivery recorded by a TURN in the ask's own
// conversation. An image lands with no turn. An unsettled ask is raw material for the "You there?"
// relaunch (tracker #7).
//
// The fix is one settlement moment, `async`, run by the same authority (`settleAsk`): when a background
// job's result is delivered to the owner and NO job for that request is still out (and no delegated work),
// the ask settles on that delivery. Not before: the first of seven images is not the answer.
//
// THE DOORS ARE THE REAL ONES: the owner speaks through `submitUserMessage`, the turn runs through
// `runV2Turn`, the real `image_create` handler dials a scripted image model whose answers the test
// releases one at a time, and the result bubbles go through the real writer, the real broadcast seam
// (delivery receipts) and the real settlement authority.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const executeToolSpy = vi.fn();
const googleReadMock = vi.fn();
const googleViews = { current: [] as Array<Record<string, unknown>> };

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
  return { ...actual, executeTool: async (...a: unknown[]) => classifyToolResult(await executeToolSpy(...a)), getFilteredTools: () => [] };
});
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../agent/pending-attachments.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/pending-attachments.js')>('../../agent/pending-attachments.js');
  return { ...actual, drainPendingAttachments: () => [], drainPendingAttachmentsWithCaptions: async () => [] };
});
vi.mock('../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
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
vi.mock('../compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../compaction.js')>('../compaction.js');
  return {
    ...actual,
    checkAndCompact: () => Promise.resolve({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }),
    estimateAssembledTokens: () => ({ total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0 }),
  };
});
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
// The ONLY scripted half of the mail door: Google's HTTP answers. The watcher's own poll,
// framing, conversation resolution and insert all run for real.
vi.mock('../../google/client.js', () => ({ googleRead: (...a: unknown[]) => googleReadMock(...a) }));
vi.mock('../../google/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../google/auth.js')>('../../google/auth.js');
  return { ...actual, listGoogleAccountViews: () => googleViews.current };
});

// The async media door (fix round 1, I-3): the real `image_create` handler runs; only the image
// model's choice and its HTTP answer are scripted.
vi.mock('../../services/image-gen-model.js', () => ({ getEffectiveImageGenModel: () => ({ modelId: 'm', providerId: 'p' }) }));
const imageGate = vi.hoisted(() => ({ waiting: [] as Array<(r: unknown) => void> }));
vi.mock('../../services/image-generation.js', () => ({
  generateImage: () => new Promise((resolve) => { imageGate.waiting.push(resolve); }),
}));
// The image file itself is not under test: the facade is told every path exists.
vi.mock('../../agent/effects/fs.js', () => ({
  existsSync: () => true, mkdirSync: () => undefined, copyFileSync: () => undefined, statSync: () => ({ size: 2048 }),
  readFileSync: () => Buffer.from(''),
}));

import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { submitUserMessage } from '../../gateway/routes/chat.js';
import { mediaHandlers } from '../../agent/tools/cat/media.js';
import { untrackedWorkAcrossTurns } from '../../agent/turn-state.js';
import { createTask } from '../../tracker/schema.js';
import { transition } from '../../work/store.js';
import { carryJobWork, registerDrainWake, endJobCarry } from '../../work/task-freshness.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { cancelAgentGenerationJobs } from '../../services/generation-jobs.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

const AGENT = 'primary';
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
/** Every model call this test made, as the array the provider would have received. */
const seen: Wire[][] = [];
/** The script: each entry answers one model call, in order. */
let script: Array<{ content?: string; tool?: { name: string; arguments: Record<string, unknown> }; tools?: Array<{ name: string; arguments: Record<string, unknown> }>; fail?: string }> = [];
let toolSeq = 0;
/** Fix round 1 (I-2): something that happens WHILE the next model call is in flight. */
let duringNextCall: (() => void) | null = null;

function installModel(): void {
  callModelSpy.mockImplementation(async (params: { messages: Wire[] }) => {
    seen.push(JSON.parse(JSON.stringify(params.messages)) as Wire[]);
    if (duringNextCall) { const f = duringNextCall; duringNextCall = null; f(); }
    const step = script.shift() ?? { content: '[no-reply]' };
    if (step.fail) throw new Error(step.fail);
    if (step.tools) {   // parallel calls in ONE assistant message, as the walk's seven
      return {
        content: '', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use',
        toolCalls: step.tools.map((t) => ({ id: `tc-${++toolSeq}`, name: t.name, arguments: t.arguments })),
      };
    }
    if (step.tool) {
      toolSeq += 1;
      return {
        content: '', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use',
        toolCalls: [{ id: `tc-${toolSeq}`, name: step.tool.name, arguments: step.tool.arguments }],
      };
    }
    return { content: step.content ?? '', toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
  });
  executeToolSpy.mockImplementation(async (...a: unknown[]) => {
    const tc = a.find((x) => x && typeof x === 'object' && 'id' in (x as object)) as { id: string; name: string };
    return { toolCallId: tc.id, name: tc.name, content: `results for ${JSON.stringify((tc as unknown as { arguments?: unknown }).arguments ?? {})}`, isError: false };
  });
}

/** The text of one wire message, every block flattened (tool blocks as JSON). */
function textOf(m: Wire): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<Record<string, unknown>>).map((b) =>
    b.type === 'text' ? String(b.text) : JSON.stringify(b)).join('\n');
}
function wireText(call: Wire[]): string { return call.map(textOf).join('\n\n'); }

/** The assistant message on the wire that carries a tool_use whose input mentions `needle`. */
function toolUseMessage(call: Wire[], needle: string): Wire | undefined {
  return call.find((m) => m.role === 'assistant' && Array.isArray(m.content)
    && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_use' && JSON.stringify(b.input).includes(needle)));
}

/** The platform's row stamp (`[<instant> · <subject>]`, recognisable by its instant) nearest
 *  before `needle` in `text` — the label of the row that carries `needle`. Empty if none. */
function labelBefore(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) return '';
  const stamps = [...text.slice(0, at).matchAll(/\[[A-Z][a-z]{2} \d{1,2}, \d{4}, [^\]]*?UTC[+-]\d{2}:\d{2}[^\]]*\]/g)];
  return stamps.length ? stamps[stamps.length - 1][0] : '';
}

/** The nearest block HEADER (`[<instant> · <subject>]`) before `needle` — the subject the row
 *  carrying `needle` sits under (a continuing row carries only its instant). */
function headerBefore(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) return '';
  const heads = [...text.slice(0, at).matchAll(/\[[A-Z][a-z]{2} \d{1,2}, \d{4}, [^\]]*?UTC[+-]\d{2}:\d{2} · [^\]]*\]/g)];
  return heads.length ? heads[heads.length - 1][0] : '';
}

async function turn(...steps: typeof script): Promise<Wire[][]> {
  const before = seen.length;
  script = steps;
  await runV2Turn(AGENT);
  return seen.slice(before);
}

beforeEach(() => {
  untrackedWorkAcrossTurns.clear(); endJobCarry(AGENT);   // nothing from an earlier clause carries over
  const db = freshDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  seen.length = 0;
  script = [];
  toolSeq = 0;
  duringNextCall = null;
  callModelSpy.mockReset();
  executeToolSpy.mockReset();
  googleReadMock.mockReset();
  installModel();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const askRow = (): { id: string; state: string; result_delivery_id: string | null; root_id: string } =>
  mockDb.current!.prepare(`SELECT id, state, result_delivery_id, root_id FROM work WHERE kind = 'ask' ORDER BY opened_at DESC LIMIT 1`).get() as never;
const imageCall = { name: 'image_create', arguments: { description: 'a heron at dawn' } };
const imageCalls = (n: number) => ({ tools: Array.from({ length: n }, (_, i) => ({ ...imageCall, arguments: { description: `a heron at dawn ${i}` } })) });
const wireImageCalls = (): void => {
  executeToolSpy.mockImplementation(async (...a: unknown[]) => {
    const tc = a.find((x) => x && typeof x === 'object' && 'id' in (x as object)) as { id: string; name: string; arguments: Record<string, unknown> };
    const out = await (mediaHandlers as Record<string, (c: unknown) => Promise<{ content: string; isError: boolean }>>)
      .image_create({ agentId: AGENT, args: tc.arguments, toolCallId: tc.id });
    return { toolCallId: tc.id, name: tc.name, content: out.content, isError: out.isError };
  });
};
const imageSuccess = { ok: true, filePath: '/tmp/none/heron.png', filename: 'heron.png', mimeType: 'image/png', sizeBytes: 2048, width: 64, height: 64, apiModelId: 'x', providerId: 'p', costUsd: null, inputTokens: 1, outputTokens: 1, latencyMs: 5 };
/** Let the background job IIFEs run: each waits for the agent to be idle, then dials. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
}
/** The jobs dial one after another (each waits for the agent to be idle again): release the n-th when it is dialled. */
async function release(n: number, result: unknown): Promise<void> {
  await until(() => imageGate.waiting.length >= n);
  expect(imageGate.waiting.length, `job ${n} was dialled`).toBeGreaterThanOrEqual(n);
  imageGate.waiting[n - 1](result);
}
const imageBubbles = (): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND attachments IS NOT NULL AND subject_kind = 'delivered'`).get() as { n: number }).n;

describe('t152 — an ask whose request was background jobs settles when the last result reaches the owner', () => {
  it('three images, the turn ends with no reply: the ask is NOT settled by the first or second image, and IS settled by the third, on that delivery', async () => {
    await submitUserMessage(AGENT, 'Make three separate small images: a heron, a kite, an owl.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(3), { content: '[no-reply]' });
    const jobs = (): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM generation_jobs`).get() as { n: number }).n;
    expect(jobs(), 'three jobs were queued by the turn').toBe(3);
    expect(askRow().state, 'premise: the turn ended without answering, so the ask is still owed').not.toBe('done');

    await release(1, imageSuccess);
    await until(() => imageBubbles() === 1);
    expect(imageBubbles()).toBe(1);
    expect(askRow().state, 'one image of three is not the answer').not.toBe('done');
    await release(2, imageSuccess);
    await until(() => imageBubbles() === 2);
    expect(askRow().state, 'two of three is not the answer').not.toBe('done');
    await release(3, imageSuccess);
    await until(() => imageBubbles() === 3 && askRow().state === 'done');
    const ask = askRow();
    expect(ask.state, 'the work it waited on finished and the result reached the owner: the ask settles').toBe('done');
    const receipt = mockDb.current!.prepare(`SELECT d.message_id AS messageId, d.outcome FROM deliveries d WHERE d.id = ?`).get(ask.result_delivery_id) as { messageId: string; outcome: string };
    expect(receipt.outcome).toBe('delivered');
    const bubble = mockDb.current!.prepare(`SELECT attachments, root_id FROM messages WHERE id = ?`).get(receipt.messageId) as { attachments: string | null; root_id: string };
    expect(bubble.attachments, 'the receipt is an image the owner was given').not.toBeNull();
    expect(bubble.root_id).toBe(ask.root_id);
  });

  it('the same after the ask was HELD (the re-serve ladder spent): a late image still settles it', async () => {
    await submitUserMessage(AGENT, 'Make one small image of a heron.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(1), { content: '[no-reply]' });
    await until(() => imageGate.waiting.length === 1);
    // Serve it into the same silence until the ladder stands down (blocked), as the walk did.
    for (let i = 0; i < 5 && askRow().state !== 'blocked'; i++) await turn({ content: '[no-reply]' });
    expect(askRow().state, 'premise: the ask is held').toBe('blocked');
    imageGate.waiting[0](imageSuccess);
    await until(() => askRow().state === 'done');
    expect(askRow().state, 'the held ask settles when its image arrives').toBe('done');
  });

  it('control: an image that FAILED is still a result the owner was told, so it settles too; and a failure does not settle while another image is out', async () => {
    await submitUserMessage(AGENT, 'Make two small images: a heron and a kite.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(2), { content: '[no-reply]' });
    await release(1, { ok: false, code: 'HTTP', error: 'HTTP 500 from the image provider' });
    await until(() => !!mockDb.current!.prepare(`SELECT 1 FROM messages WHERE content LIKE 'I wasn''t able to generate%'`).get());
    expect(askRow().state, 'one failed, one still out: not settled').not.toBe('done');
    await release(2, imageSuccess);
    await until(() => askRow().state === 'done');
    expect(askRow().state).toBe('done');
  });

  it('control: an ask with no background job behind it is untouched by a stranger\'s image (nothing is settled on another request\'s result)', async () => {
    await submitUserMessage(AGENT, 'First question: what is two plus two?');
    const first = askRow();
    await turn({ content: '[no-reply]' });
    mockDb.current!.prepare(`UPDATE work SET state = 'blocked' WHERE id = ?`).run(first.id);
    await submitUserMessage(AGENT, 'Make one small image of a heron.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(1), { content: '[no-reply]' });
    await until(() => imageGate.waiting.length === 1);
    imageGate.waiting[0](imageSuccess);
    await until(() => imageBubbles() === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(mockDb.current!.prepare(`SELECT state FROM work WHERE id = ?`).get(first.id), 'the other request stays as it was').toEqual({ state: 'blocked' });
  });
});


// ════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 (coordinator): the agent may STILL OWE work on the request when its images land, and a
// request whose jobs are out is held, not re-served; a request whose last job was cancelled settles.
// ════════════════════════════════════════════════════════════════════════════════════════
const rowidOf = (messageId: string): number => (mockDb.current!.prepare(`SELECT rowid AS r FROM messages WHERE id = ?`).get(messageId) as { r: number }).r;
const latestImageDelivery = (): string => (mockDb.current!.prepare(
  `SELECT d.id AS id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.attachments IS NOT NULL ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`).get() as { id: string }).id;
const reServes = (): number => (mockDb.current!.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE kind = 'audit' AND json_extract(payload, '$.marker') = 'ct0_ask_re_served'`).get() as { n: number }).n;

describe('t152 round 2 — nothing is settled while the agent still owes work on the request', () => {
  it('images land while a tracker task linked to the request is open: the ask stays open; it settles when the task closes', async () => {
    await submitUserMessage(AGENT, 'Make one small image of a heron, then write a post about it.');
    const ask = askRow();
    createTask({ title: 'Write the heron post', createdBy: AGENT, assignedTo: AGENT, origin: { kind: 'ask', sourceMessageId: ask.root_id, turn: null, convKey: null } });
    const taskId = (mockDb.current!.prepare(`SELECT id FROM work WHERE kind = 'task' AND source_message_id = ?`).get(ask.root_id) as { id: string }).id;
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(1), { content: '[no-reply]' });
    await release(1, imageSuccess);
    await until(() => imageBubbles() === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(askRow().state, 'the image landed but the post is still owed').not.toBe('done');
    const r = transition(taskId, { to: 'done', by: 'pm', claim: 'authoritative', resultDeliveryId: latestImageDelivery(), reason: 'the post was written' });
    expect(r.kind).toBe('applied');
    expect(askRow().state, 'the work ended and the result had reached the owner: it settles').toBe('done');
  });

  it('images land during a parked job that carries the ask: no settle; the continuation\'s finalize settles it', async () => {
    await submitUserMessage(AGENT, 'Make one small image of a heron, then keep working on the post.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(1), { content: '[no-reply]' });
    const ask = askRow();
    mockDb.current!.prepare(`UPDATE work SET state = 'claimed' WHERE id = ?`).run(ask.id);   // the parking turn served it
    carryJobWork(AGENT, [], [ask.root_id]); registerDrainWake(AGENT);
    await release(1, imageSuccess);
    await until(() => imageBubbles() === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(askRow().state, 'a parked job carries the ask: the image does not settle it').toBe('claimed');
    endJobCarry(AGENT);   // the continuation ran and finished its work
    const out = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 99, assembled: [{ workId: ask.id, rowid: rowidOf(ask.root_id) }] });
    expect(out.closed, 'the continuation\'s finalize settles it on the delivered result').toBe(1);
    expect(askRow().state).toBe('done');
  });

  it('images land while a turn serving the ask is running: no settle; that turn\'s finalize settles it', async () => {
    await submitUserMessage(AGENT, 'Make one small image of a heron.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(1), { content: '[no-reply]' });
    const ask = askRow();
    const bag = openTurnContext(AGENT);   // a later turn is serving the ask right now
    bag.turnNumber = 41; bag.root = { kind: 'ask', id: ask.root_id, sourceMessageId: ask.root_id };
    await release(1, imageSuccess);
    await until(() => imageBubbles() === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(askRow().state, 'a turn is serving the ask: the image does not settle it under that turn').not.toBe('done');
    const out = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 41, assembled: [{ workId: ask.id, rowid: rowidOf(ask.root_id) }] });
    endTurnContext(AGENT);
    expect(out.closed, 'at that turn\'s own finalize the delivered result settles it').toBe(1);
    expect(askRow().state).toBe('done');
  });
});

describe('t152 round 2 — a request whose jobs are out is held, not re-served', () => {
  it('the turn that started the jobs ends with no reply: the ask is held at once and no re-serve rung is spent', async () => {
    await submitUserMessage(AGENT, 'Make three small images.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(3), { content: '[no-reply]' });
    expect(askRow().state, 'held: its answer is on the way').toBe('blocked');
    expect(reServes(), 'nothing was handed back to be served again').toBe(0);
  });
});

describe('t152 round 2 — a request whose last job was cancelled', () => {
  const cancelAndRelease = async (): Promise<void> => {
    cancelAgentGenerationJobs(AGENT);
    imageGate.waiting.forEach((w) => w({ ok: false, code: 'STOPPED', error: 'stopped' }));   // let the dialled one unwind
    await new Promise((r) => setTimeout(r, 300));
  };
  it('all jobs cancelled (the owner\'s Stop), nothing delivered: the ask is abandoned as cancelled, not left held for ever', async () => {
    await submitUserMessage(AGENT, 'Make two small images.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(2), { content: '[no-reply]' });
    expect(askRow().state).toBe('blocked');
    await cancelAndRelease();
    expect(askRow().state).toBe('abandoned');
    expect(imageBubbles(), 'nothing was delivered').toBe(0);
  });
  it('one image delivered, the rest cancelled: the ask settles on the delivered image', async () => {
    await submitUserMessage(AGENT, 'Make two small images.');
    wireImageCalls();
    imageGate.waiting.length = 0;
    await turn(imageCalls(2), { content: '[no-reply]' });
    await release(1, imageSuccess);
    await until(() => imageBubbles() === 1);
    await cancelAndRelease();
    expect(askRow().state).toBe('done');
  });
});
