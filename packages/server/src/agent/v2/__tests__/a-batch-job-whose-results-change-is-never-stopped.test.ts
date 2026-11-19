// The owner's mailbox job, through the real turn entry (`runV2Turn`): the same search, run hundreds of
// times, each time bringing back the next batch, is work. Nothing stops it, nothing steers it, and every
// checkpoint window sees the job moving, so the turn parks and its continuation finishes the job, even
// when the agent's only in-progress task is an unrelated one, so the continuation carries no task.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();
const toolSpy = vi.fn();

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-batch-job', 'dojo.db'),
  };
});
vi.mock('../../model.js', async () => {
  const actual = await vi.importActual<typeof import('../../model.js')>('../../model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../tools/index.js')>('../../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../tool-outcome.js')>('../../tool-outcome.js');
  return { ...actual, executeTool: async (_agentId: string, tc: { id: string; name: string }) => classifyToolResult({ toolCallId: tc.id, name: tc.name, ...toolSpy(tc) }) };
});
vi.mock('../../runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../../memory/assembler.js', () => ({
  assembleContext: async () => ({ systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'hello' }] }),
}));
vi.mock('../../../memory/compaction.js', async () => ({
  ...(await vi.importActual<typeof import('../../../memory/compaction.js')>('../../../memory/compaction.js')),
  checkAndCompact: async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }),
}));
vi.mock('../../../costs/tracker.js', async () => ({ ...(await vi.importActual<typeof import('../../../costs/tracker.js')>('../../../costs/tracker.js')), recordCost: vi.fn() }));
vi.mock('../../../memory/embeddings.js', () => ({
  queueEmbedding: vi.fn(), generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  storeEmbedding: async () => { /* not exercised */ }, refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../../router/scorer.js', () => ({ scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }) }));
vi.mock('../../../router/selector.js', () => ({ selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null }));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
import { runV2Turn } from '../loop.js';
import { runMigrations } from '../../../db/migrations.js';
import { submitUserMessage } from '../../../gateway/routes/chat.js';
import { openTrackerTask } from '../../../work/tracker-store.js';

const AGENT = 'agent-mail';
type Call = { name: string; arguments: Record<string, unknown> };

/** The owner asks, and the model makes `calls`, one per response, across as many turns as the job takes. */
async function turn(calls: Call[]): Promise<string[]> {
  expect((await submitUserMessage(AGENT, 'Archive everything older than a year.')).ok).toBe(true);
  const planned = [...calls];
  let pass = 0;
  callModelSpy.mockImplementation(async () => {
    const call = planned.shift();
    const toolCalls = call ? [{ id: `c-${++pass}`, ...call }] : [];
    return { content: call ? '' : 'All done.', toolCalls, inputTokens: 1, outputTokens: 1, stopReason: call ? 'tool_use' : 'end_turn' };
  });
  await runV2Turn(AGENT);
  return results();
}

/** The job's next turn, as the one clock starts it: served from the job's own task row. */
async function continuation(): Promise<void> {
  await runV2Turn(AGENT);
}
/** A park dates the job's task row. */
const jobParked = (): boolean => !!mockDb.current!.prepare("SELECT 1 FROM work WHERE agent_id = ? AND kind = 'task' AND next_attempt_at IS NOT NULL").get(AGENT);

function results(): string[] {
  const rows = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'tool' ORDER BY rowid").all(AGENT) as Array<{ content: string }>;
  return rows.flatMap((r) => (JSON.parse(r.content) as Array<{ content: string }>).map((b) => b.content));
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Mail', 'm', 'idle', '{}', 'sensei')`).run(AGENT);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  openTrackerTask({   // the main agent's other work, not tied to the owner's ask
    title: 'Renew the car insurance', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: 0, convKey: null },
  });
  callModelSpy.mockReset();
  toolSpy.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a batch job whose results change is never stopped', () => {
  it('300 identical searches, each bringing back the next batch, all run: the turn parks at 200 and its continuation finishes', async () => {
    let batch = 0;
    toolSpy.mockImplementation(() => {
      batch += 1;
      const ids = Array.from({ length: 3 }, (_, i) => `18c${(batch * 7 + i).toString(16).padStart(9, '0')}`).join(', ');
      return { content: `Found 50 messages (ids ${ids}, ...). ${(10_000 - batch * 50).toLocaleString('en-US')} left in the inbox.`, isError: false };
    });
    const search: Call = { name: 'gmail_search', arguments: { query: 'in:inbox older_than:1y', max_results: 50 } };
    await turn(Array.from({ length: 300 }, () => search));
    expect(toolSpy).toHaveBeenCalledTimes(200);
    expect(jobParked(), 'every window moved, so the turn parked its job').toBe(true);
    await continuation();
    expect(toolSpy).toHaveBeenCalledTimes(300);
    expect(results().filter((r) => r.includes('[Engine')), 'no stop, no refusal').toEqual([]);
    const steers = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'system'").all(AGENT);
    expect(steers, 'no steer').toEqual([]);
  });

  it('five searches over five date ranges are five different calls and all run', async () => {
    toolSpy.mockImplementation((tc: Call) => ({ content: `3 messages for ${String(tc.arguments.query)}.`, isError: false }));
    const ranges = ['after:2026/09/08 before:2026/09/11', 'after:2026/09/11 before:2026/09/14', 'after:2026/09/14 before:2026/09/17',
      'after:2026/09/17 before:2026/09/20', 'after:2026/09/20 before:2026/09/23'];
    const seen = await turn(ranges.map((query) => ({ name: 'user_gmail_search', arguments: { query, max_results: 40 } })));
    expect(toolSpy).toHaveBeenCalledTimes(5);
    expect(seen.some((r) => r.includes('[Engine'))).toBe(false);
  });
});
