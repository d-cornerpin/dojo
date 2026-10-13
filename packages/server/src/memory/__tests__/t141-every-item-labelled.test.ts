// ════════════════════════════════════════════════════════════════════════════════════════
// t141 — EVERY ITEM LABELLED; NOTHING UNLABELLED OR MISLABELLED (tracker #12, identity half)
//
// The owner's words decide this file: "Why can't it just recognize that the email is from a
// different conversation and not get it conflated with other conversations?" / "The agent
// just needs to be aware of what conversations are what and not confuse them." So every
// clause below asks ONE question of what the model was actually handed — never of an inner
// function: is each thing in its view LABELLED with the conversation it belongs to, and is
// nothing that was visible before hidden now?
//
// THE DOORS ARE THE REAL ONES. The owner speaks through `submitUserMessage` (the chat route's
// own core), the email arrives through the REAL Gmail watcher poll (only the Google HTTP
// call is scripted), every turn runs through `runV2Turn` with the REAL assembler, and the
// only thing scripted is the model. What the model "saw" is read off the arguments the turn
// handed to `callModel` — the exact array a provider would have received.
//
// Witnesses (RED at 00a2b34d, v3.3.2 product):
//   W1  an email wake's searches appear UNLABELLED inside the owner's next dashboard turn;
//   W2  on an email-wake turn the owner's answered asks appear with their answers STRIPPED;
//   W2b on an email-wake turn the email is pinned as "the user's most recent ask";
//   W3  two email threads from one sender share one tail with nothing telling them apart;
//   W4  a handled notice comes back on every owner turn as new, under a "surface it" steer.
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

import { runV2Turn } from '../../agent/v2/loop.js';
import { runMigrations } from '../../db/migrations.js';
import { submitUserMessage } from '../../gateway/routes/chat.js';
import { startGmailWatcher, stopGmailWatcher } from '../../services/gmail-watcher.js';
import { deliverA2AMessage } from '../../agent/a2a-transport.js';
import { tagTurnOutputConversationId, insertEngineEvent } from '../message-store.js';

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
let script: Array<{ content?: string; tool?: { name: string; arguments: Record<string, unknown> } }> = [];
let toolSeq = 0;

function installModel(): void {
  callModelSpy.mockImplementation(async (params: { messages: Wire[] }) => {
    seen.push(JSON.parse(JSON.stringify(params.messages)) as Wire[]);
    const step = script.shift() ?? { content: '[no-reply]' };
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

async function turn(...steps: typeof script): Promise<Wire[][]> {
  const before = seen.length;
  script = steps;
  await runV2Turn(AGENT);
  return seen.slice(before);
}

function setMailbox(kind: 'user' | 'agent', email: string): void {
  googleViews.current = [{
    id: kind, kind, position: 1, email, enabled: true, connected: true,
    services: { gmail: true, calendar: false, drive: false, docs: false, sheets: false, contacts: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}

/** One poll of the REAL watcher, with Google answering `mail`. Fake timers only around the
 *  poll — the turns run on the real clock. */
async function mailArrives(mail: Array<{ id: string; threadId: string; from: string; subject: string; snippet: string }>): Promise<void> {
  googleReadMock.mockImplementation(async (url: string) => {
    if (url.includes('/messages?')) return { ok: true, data: { messages: mail.map((m) => ({ id: m.id, threadId: m.threadId })) } };
    const m = mail.find((x) => url.includes(`/messages/${x.id}`));
    return {
      ok: true,
      data: {
        id: m!.id, threadId: m!.threadId, snippet: m!.snippet, labelIds: ['INBOX'],
        payload: { headers: [{ name: 'From', value: m!.from }, { name: 'Subject', value: m!.subject }, { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' }] },
      },
    };
  });
  // A cursor already exists (the watcher has been running), so this poll notifies.
  const key = googleViews.current[0].id === 'agent' ? 'gmail_last_checked_at' : `gmail_last_checked_at_${googleViews.current[0].id}`;
  mockDb.current!.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, new Date(Date.now() - 60_000).toISOString());
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  try {
    startGmailWatcher();
    await vi.advanceTimersByTimeAsync(10_001);
  } finally {
    stopGmailWatcher();
    vi.useRealTimers();
  }
}

beforeEach(() => {
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
  callModelSpy.mockReset();
  executeToolSpy.mockReset();
  googleReadMock.mockReset();
  installModel();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

// The ZEBRA email: an unauthorized notice into the owner's own inbox. Long enough to be
// "substantive" by the directive pin's 200-char rule — the shape that made it the pin.
const ZEBRA = {
  id: 'gm-zebra-1', threadId: 'th-zebra', from: 'Billing Desk <billing@vendor.example>',
  subject: 'ZEBRA invoice',
  snippet: 'ZEBRA invoice 4471 is attached for the September period. Please review the line items and '
    + 'confirm the purchase order number before the end of the week so we can schedule payment.',
};

/** Turn 1 (the owner's ORCHID ask, one search, one answer) then the ZEBRA email and the
 *  wake it causes (one mail search, then [no-reply]). Returns both turns' model inputs. */
async function orchidThenZebraWake(): Promise<{ t1: Wire[][]; t2: Wire[][] }> {
  setMailbox('user', 'owner.inbox@example.com');
  await submitUserMessage(AGENT, 'Draft a 3-section note about ORCHID and keep the draft in the chat.');
  const t1 = await turn(
    { tool: { name: 'web_search', arguments: { query: 'ORCHID background' } } },
    { content: 'Here is the ORCHID note: one, two, three.' },
  );
  await mailArrives([ZEBRA]);
  const t2 = await turn(
    { tool: { name: 'user_gmail_search', arguments: { query: 'ZEBRA invoice 4471' } } },
    { content: '[no-reply]' },
  );
  return { t1, t2 };
}

describe('t141 witnesses — the email wake and the owner conversation', () => {
  it('W1: the email wake\'s own search is LABELLED in the owner\'s next dashboard turn (not shown as his task)', async () => {
    await orchidThenZebraWake();
    await submitUserMessage(AGENT, 'What have you finished for me today?');
    const t3 = await turn({ content: 'The ORCHID note.' });
    const wire = t3[0];
    const zebraSearch = toolUseMessage(wire, 'ZEBRA invoice 4471');
    // Label, never hide: the row that was visible before is still visible...
    expect(zebraSearch, 'the email wake\'s search must stay visible (label, never hide)').toBeDefined();
    // ...and now it says what it was: the agent's own work on a wake that served no person. The
    // label is a block header — the platform's stamp nearest before the call names its subject.
    const all = wireText(wire);
    expect(labelBefore(all, 'ZEBRA invoice 4471')).toMatch(/background wake/i);
    // Controls: the owner's conversation is headed as HIS, before the email work and again after.
    expect(labelBefore(all, 'Draft a 3-section note about ORCHID')).toMatch(/dashboard conversation with TestUser/);
    expect(labelBefore(all, 'What have you finished for me today?')).toMatch(/dashboard conversation with TestUser/);
  });

  it('W2: on the email-wake turn the owner\'s answered ask is shown WITH its answer (a complete view)', async () => {
    const { t2 } = await orchidThenZebraWake();
    const wire = wireText(t2[0]);
    expect(wire).toContain('Draft a 3-section note about ORCHID');
    expect(wire, 'the answer the agent already gave must be in the wake\'s view').toContain('Here is the ORCHID note: one, two, three.');
  });

  it('W2b: on the email-wake turn the email is never pinned as "the user\'s most recent ask"', async () => {
    const { t2 } = await orchidThenZebraWake();
    const pin = t2[0].map(textOf).find((t) => t.includes('ACTIVE USER DIRECTIVE')) ?? '';
    expect(pin).not.toContain('ZEBRA');
  });

  it('W4: on the owner\'s next turn the handled notice is marked HANDLED and carries no "surface it" steer', async () => {
    await orchidThenZebraWake();
    await submitUserMessage(AGENT, 'Anything new?');
    const t3 = await turn({ content: 'Nothing new.' });
    const events = t3[0].map(textOf).find((t) => t.includes('EVENTS & NOTICES')) ?? '';
    expect(events, 'the notice stays visible').toContain('ZEBRA invoice');
    expect(events).not.toMatch(/surface one to the owner/i);
    const zebraLine = events.split('\n').find((l) => l.includes('ZEBRA invoice')) ?? '';
    expect(zebraLine).toMatch(/\bhandled\b/i);
  });
});

describe('t141 witness — two email threads from one sender', () => {
  it('W3: each thread\'s rows carry their OWN thread label, so one tail never reads as one conversation', async () => {
    setMailbox('agent', 'agent.box@example.com');
    mockDb.current!.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('gmail_approved_senders_agent', ?, datetime('now'))`)
      .run(JSON.stringify([{ address: 'colleague@example.com', name: 'A Colleague' }]));
    await mailArrives([
      { id: 'gm-a', threadId: 'th-alpha', from: 'A Colleague <colleague@example.com>', subject: 'ALPHA budget', snippet: 'Can you check the ALPHA budget?' },
      { id: 'gm-b', threadId: 'th-beta', from: 'A Colleague <colleague@example.com>', subject: 'BETA offsite', snippet: 'Is the BETA offsite still on?' },
    ]);
    const calls = await turn({ content: 'Checked.' });
    const wire = wireText(calls[0]);
    expect(wire, 'thread ALPHA is in view').toContain('Can you check the ALPHA budget?');
    expect(wire, 'thread BETA stays in view (label, never hide)').toContain('Is the BETA offsite still on?');
    // Each row's OWN label names its own thread. Consecutive user rows are merged into one wire
    // message by the integrity pass, so the label is the platform's stamp bracket nearest
    // BEFORE each row's text — never the producer's own [SOURCE …] prose.
    expect(labelBefore(wire, 'Can you check the ALPHA budget?')).toMatch(/ALPHA budget/);
    expect(labelBefore(wire, 'Is the BETA offsite still on?')).toMatch(/BETA offsite/);
  });
});

// ── GREEN: the lane's own guarantees, through the same doors ─────────────────────────────

describe('t141 — every own row is labelled AT BIRTH, never late', () => {
  it('a person turn\'s tool call carries its conversation while the tool is still running; the late stamp then has nothing left to do', async () => {
    await submitUserMessage(AGENT, 'Look up ORCHID for me.');
    const seenMidTurn: Array<{ conversation_id: string | null; subject_kind: string | null }> = [];
    executeToolSpy.mockImplementationOnce(async (...a: unknown[]) => {
      const tc = a.find((x) => x && typeof x === 'object' && 'id' in (x as object)) as { id: string; name: string };
      // Before the turn ends — the late stamp has not run, so anything here was written at INSERT.
      seenMidTurn.push(mockDb.current!.prepare(
        `SELECT conversation_id, subject_kind FROM messages WHERE role = 'assistant' AND content LIKE '%tool_use%' ORDER BY seq DESC LIMIT 1`,
      ).get() as { conversation_id: string | null; subject_kind: string | null });
      return { toolCallId: tc.id, name: tc.name, content: 'ok', isError: false };
    });
    await turn({ tool: { name: 'web_search', arguments: { query: 'ORCHID' } } }, { content: 'Found it.' });
    const conv = (mockDb.current!.prepare(`SELECT id FROM conversations WHERE channel = 'dashboard'`).get() as { id: string }).id;
    expect(seenMidTurn).toEqual([{ conversation_id: conv, subject_kind: 'conv' }]);
    expect(tagTurnOutputConversationId({ agentId: AGENT, turnNumber: 1, conversationId: conv }),
      'the late stamp finds no unlabelled row of a person\'s turn').toBe(0);
    const unlabelled = mockDb.current!.prepare(
      `SELECT count(*) AS n FROM messages WHERE role IN ('assistant','tool') AND subject_kind IS NULL`).get() as { n: number };
    expect(unlabelled.n).toBe(0);
  });

  it('the email wake\'s own rows are born `background`, with no conversation claimed for them', async () => {
    await orchidThenZebraWake();
    const rows = mockDb.current!.prepare(
      `SELECT DISTINCT subject_kind, conversation_id FROM messages WHERE turn_number = 2 AND role IN ('assistant','tool')`).all();
    expect(rows).toEqual([{ subject_kind: 'background', conversation_id: null }]);
  });
});

describe('t141 GREEN — the ORCHID / ZEBRA / PELICAN drive (identity audit §5)', () => {
  it('a peer\'s PELICAN request is worked on its thread, labelled with that thread, and shown — labelled — in the owner\'s view', async () => {
    mockDb.current!.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
                             VALUES ('peer-agent', 'Peer', 'm', 'idle', '{}', 'sensei')`).run();
    const THREAD = '7e1f2a3b-0000-4000-8000-00000000a2a1';
    await orchidThenZebraWake();
    const sent = await deliverA2AMessage({
      intent: 'QUESTION', threadId: THREAD, requiresResponse: true, toAgent: AGENT, fromAgent: 'peer-agent',
      payload: 'Please search mail for PELICAN status and tell me what you find.',
    });
    expect(sent.delivered).toBe(true);
    await turn({ tool: { name: 'user_gmail_search', arguments: { query: 'PELICAN status' } } }, { content: 'done' });
    const a2aOwn = mockDb.current!.prepare(
      `SELECT DISTINCT subject_kind, a2a_thread_id FROM messages WHERE turn_number = 3 AND role IN ('assistant','tool')`).all();
    expect(a2aOwn, 'the agent-thread turn\'s rows carry THEIR thread from birth').toEqual([{ subject_kind: 'a2a_thread', a2a_thread_id: THREAD }]);

    await submitUserMessage(AGENT, 'What time did I ask for the ORCHID note, and what have you finished for me today?');
    const t4 = await turn({ content: 'ORCHID, earlier today.' });
    const all = wireText(t4[0]);
    // (b)/(e) of the drive: nothing about PELICAN is presented as the owner's — it is fenced as the thread's.
    expect(labelBefore(all, 'PELICAN status')).toMatch(/agent thread 7e1f2a3b with Peer/);
    // (c): ZEBRA is in view once, as a HANDLED notice — never as a task.
    const events = t4[0].map(textOf).find((t) => t.includes('EVENTS & NOTICES')) ?? '';
    expect(events.split('\n').filter((l) => l.includes('ZEBRA invoice'))).toHaveLength(1);
    expect(events).toMatch(/• HANDLED \[[^\n]*ZEBRA invoice/);
    // (d): the owner's ORCHID ask is headed with HIS conversation and an instant WITH its zone.
    expect(labelBefore(all, 'Draft a 3-section note about ORCHID')).toMatch(/UTC[+-]\d{2}:\d{2} · dashboard conversation with TestUser\]/);
  });
});

describe('t141 backwards lifecycle — a notice handled, then a new one from the same sender', () => {
  it('the handled notice stays visible as HANDLED and the new one arrives as NEW', async () => {
    await orchidThenZebraWake();
    await mailArrives([{ ...ZEBRA, id: 'gm-zebra-2', subject: 'ZEBRA invoice reminder', snippet: 'A reminder about invoice 4471.' }]);
    await submitUserMessage(AGENT, 'Anything new?');
    const t = await turn({ content: 'One reminder.' });
    const events = t[0].map(textOf).find((x) => x.includes('EVENTS & NOTICES')) ?? '';
    const lines = events.split('\n');
    expect(lines.find((l) => l.includes('"ZEBRA invoice"'))).toMatch(/^• HANDLED /);
    expect(lines.find((l) => l.includes('"ZEBRA invoice reminder"'))).toMatch(/^• NEW /);
  });
});

describe('t141 — every EVENTS item says who it is addressed to, and from whom', () => {
  it('the owner\'s mail notice reads TO THE OWNER; an agent\'s review notice reads TO YOU, from that agent', async () => {
    await orchidThenZebraWake();
    mockDb.current!.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
                             VALUES ('pm-agent', 'Project Lead', 'm', 'idle', '{}', 'sensei')`).run();
    insertEngineEvent({
      agentId: AGENT, content: '[PM EFFORT REVIEW] many calls without advancing; please step back and re-plan.',
      originIntent: 'agent_notice', sourceAgentId: 'pm-agent', work: null,
    });
    await submitUserMessage(AGENT, 'Anything new?');
    const t = await turn({ content: 'Nothing for you.' });
    const lines = (t[0].map(textOf).find((x) => x.includes('EVENTS & NOTICES')) ?? '').split('\n');
    expect(lines.find((l) => l.includes('ZEBRA invoice'))).toMatch(/\[email notice TO THE OWNER, from billing@vendor\.example\]/);
    expect(lines.find((l) => l.includes('PM EFFORT REVIEW') || l.includes('many calls without advancing')))
      .toMatch(/\[TO YOU, from Project Lead: agent_notice\]/);
  });
});
