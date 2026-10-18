// ════════════════════════════════════════════════════════════════════════════════════════
// t210 (owner decision 37) — WITHIN ONE TURN THE ARRAY ONLY GROWS.
//
// t206 item 2, re-derived from 221 main-agent receipts: on 128 of ~170 later calls of a turn the
// provider's cached prefix broke exactly where the post-tail block began (task list, events,
// turn context, open commitments, the clock), and the previous call's block was found intact
// further down. The block had MOVED, not changed: the loop rebuilds the whole array on every
// call, so the new tool rows land between the conversation and the block, and ~2.6K tokens
// behind them are billed again on every later call.
//
// The owner's ruling (decision 37): append-only within a turn. A block that changed is sent
// once more BELOW, clearly labelled as replacing the copy above; the older copy stays where it
// was ("label, never hide"), so the cached prefix holds.
//
// Driven through the REAL turn (`runV2Turn`, the real assembler, the real injections); only
// the model and the tools are scripted. What the model "saw" is the array handed to `callModel`.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const executeToolSpy = vi.fn();

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 't210-append', 'dojo.db'),
  };
});
vi.mock('../../../../model.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../model.js')>('../../../../model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../../../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../tools/index.js')>('../../../../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../../../tool-outcome.js')>('../../../../tool-outcome.js');
  return { ...actual, executeTool: async (...a: unknown[]) => classifyToolResult(await executeToolSpy(...a)), getFilteredTools: () => [] };
});
vi.mock('../../../../runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../../../pending-attachments.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../pending-attachments.js')>('../../../../pending-attachments.js');
  return { ...actual, drainPendingAttachments: () => [], drainPendingAttachmentsWithCaptions: async () => [] };
});
vi.mock('../../../../../costs/tracker.js', () => ({ recordCost: vi.fn() }));
vi.mock('../../../../../memory/embeddings.js', () => ({
  queueEmbedding: vi.fn(), generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  storeEmbedding: async () => { /* not exercised */ }, refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../../../../memory/vector-search.js', () => ({ vectorSearch: async () => [], hybridSearch: async () => [] }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false, clearIMResponseFlag: vi.fn(), sendResponseViaIMessage: vi.fn(),
  getPendingIMSenderRaw: () => null, stripSystemTags: (s: string) => s,
  parseSafeSenders: (raw: string | null) => (raw ? (JSON.parse(raw) as Array<{ address: string }>) : []),
  sendIMessageWithAttachment: vi.fn(), addressesMatch: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
  getInboundSenderFor: () => null, sendAlert: vi.fn(),
  getTurnScopedImRecipient: () => null, getDefaultSender: () => null,
}));
vi.mock('../../../../../memory/compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../memory/compaction.js')>('../../../../../memory/compaction.js');
  return {
    ...actual,
    checkAndCompact: () => Promise.resolve({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }),
    estimateAssembledTokens: () => ({ total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0 }),
  };
});
vi.mock('../../../../../config/platform.js', () => ({
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
vi.mock('../../../../spawner.js', () => ({ checkTimeouts: vi.fn() }));
vi.mock('../../../../../healer/injury-recovery.js', () => ({ onAgentInjured: vi.fn(), onAgentRecovered: vi.fn(), rehydrateInjuredAgents: vi.fn() }));
vi.mock('../../../../../vault/maintenance.js', () => ({ isContextOverflowError: () => false, recoverDreamerFromContextOverflow: async () => false }));
vi.mock('../../../../../services/capabilities.js', () => ({ removeCapability: vi.fn(), getModelCapabilities: () => ['tools'] }));
vi.mock('../../../../../services/presence.js', () => ({
  getPresence: () => 'present', maybeForwardToImessage: vi.fn(), isImessageConfigured: () => false,
  isImessageEnabled: () => false, setPresence: vi.fn(),
}));
vi.mock('../../../../../router/scorer.js', () => ({ scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }) }));
vi.mock('../../../../../router/selector.js', () => ({ selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null }));
vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));

import { runV2Turn } from '../../../loop.js';
import { runMigrations } from '../../../../../db/migrations.js';
import { submitUserMessage } from '../../../../../gateway/routes/chat.js';
import { createTask } from '../../../../../tracker/schema.js';

const AGENT = 'primary';
const TASKS_HEAD = '═══ YOUR ACTIVE TASKS';

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
let script: Array<{ content?: string; tool?: { name: string; arguments: Record<string, unknown> } }> = [];
let toolSeq = 0;
/** What a scripted tool does to the world when it runs (a task written, a task closed). */
let onTool: (() => void) | null = null;

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
    if (onTool) { const f = onTool; onTool = null; f(); }
    return { toolCallId: tc.id, name: tc.name, content: `results for ${tc.name}`, isError: false };
  });
}

function textOf(m: Wire): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<Record<string, unknown>>).map((b) => (b.type === 'text' ? String(b.text) : JSON.stringify(b))).join('\n');
}

async function turn(...steps: typeof script): Promise<Wire[][]> {
  const before = seen.length;
  script = steps;
  await runV2Turn(AGENT);
  return seen.slice(before);
}

function task(title: string): string {
  return createTask({
    title, assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'model', sourceMessageId: null, turn: null, convKey: null },
  } as Parameters<typeof createTask>[0]).id;
}

/** Indexes of the messages carrying the task list, in array order. */
const taskListAt = (call: Wire[]): number[] => call.flatMap((m, i) => (textOf(m).includes(TASKS_HEAD) ? [i] : []));

/** A t141 label: one bracket pair, the whole first line, no bracket or quote inside. */
function expectLabelShape(line: string): void {
  expect(line.startsWith('[') && line.endsWith(']'), line).toBe(true);
  expect(line.slice(1, -1), line).not.toMatch(/[[\]"]/);
  expect(line, line).not.toMatch(/[\u0000-\u001f\u007f]/);
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
  onTool = null;
  callModelSpy.mockReset();
  executeToolSpy.mockReset();
  installModel();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('decision 37 — within one turn, the array only grows', () => {
  it('two in-turn calls with no new block content: the second begins with the first, byte for byte', async () => {
    task('Reconcile the PELICAN manifests');
    await submitUserMessage(AGENT, 'Look up the PELICAN schedule and tell me what you find.');
    const calls = await turn(
      { tool: { name: 'web_search', arguments: { query: 'PELICAN schedule' } } },
      { content: 'The PELICAN schedule is on Tuesdays.' },
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const [a, b] = calls;
    expect(b.length).toBeGreaterThan(a.length);
    expect(JSON.stringify(b.slice(0, a.length)), 'the previous call is a byte prefix of the next').toBe(JSON.stringify(a));
    // The unchanged task list is NOT sent again: one copy, where it was.
    expect(taskListAt(b)).toEqual(taskListAt(a));
  });

  it('a task list that changed mid-turn is sent once more BELOW, labelled as replacing the copy above, which stays put', async () => {
    task('Reconcile the PELICAN manifests');
    await submitUserMessage(AGENT, 'Plan the ORCHID shipment and track it.');
    onTool = () => { task('Book the ORCHID freight slot'); };
    const [a, b] = await turn(
      { tool: { name: 'web_search', arguments: { query: 'ORCHID freight' } } },
      { content: 'Booked; tracking it.' },
    );
    expect(JSON.stringify(b.slice(0, a.length)), 'the cached prefix holds').toBe(JSON.stringify(a));
    const before = taskListAt(a);
    const after = taskListAt(b);
    expect(before).toHaveLength(1);
    expect(after, 'the old copy stays, the new copy is added once').toEqual([before[0], expect.any(Number)]);
    expect(after[1]).toBeGreaterThan(a.length - 1);
    const fresh = textOf(b[after[1]]);
    expect(fresh).toContain('Book the ORCHID freight slot');
    expect(textOf(b[after[0]])).not.toContain('Book the ORCHID freight slot');
    const label = fresh.split('\n')[0];
    expect(label).toMatch(/^\[update · /);
    expect(label).toContain('replaces');
    expectLabelShape(label);
  });

  it('a task list that EMPTIED mid-turn: the old copy stays above and a label below says it no longer applies', async () => {
    const id = task('Reconcile the PELICAN manifests');
    await submitUserMessage(AGENT, 'Finish the PELICAN reconciliation.');
    onTool = () => {
      mockDb.current!.prepare("UPDATE work SET state = 'done', closed_at = ? WHERE id = ?").run(Date.now(), id);
    };
    const [a, b] = await turn(
      { tool: { name: 'web_search', arguments: { query: 'PELICAN totals' } } },
      { content: 'Reconciled.' },
    );
    expect(JSON.stringify(b.slice(0, a.length))).toBe(JSON.stringify(a));
    expect(taskListAt(a)).toHaveLength(1);
    const notice = b.slice(a.length).map(textOf).find((t) => t.includes('no longer applies'));
    expect(notice, 'the emptied list is superseded in words').toBeTruthy();
    expectLabelShape(notice!.split('\n')[0]);
    expect(notice!.split('\n')[1]).toContain(TASKS_HEAD);
  });

  it('CONTROL: the next turn starts fresh — one copy of each block and no update labels', async () => {
    task('Reconcile the PELICAN manifests');
    await submitUserMessage(AGENT, 'Look up the PELICAN schedule.');
    onTool = () => { task('Book the ORCHID freight slot'); };
    await turn(
      { tool: { name: 'web_search', arguments: { query: 'PELICAN schedule' } } },
      { content: 'Tuesdays.' },
    );
    await submitUserMessage(AGENT, 'Thanks. Anything else on the board?');
    const [first] = await turn({ content: 'Two tasks are open.' });
    expect(first.map(textOf).join('\n')).not.toContain('[update · ');
    expect(taskListAt(first)).toHaveLength(1);
  });
});
