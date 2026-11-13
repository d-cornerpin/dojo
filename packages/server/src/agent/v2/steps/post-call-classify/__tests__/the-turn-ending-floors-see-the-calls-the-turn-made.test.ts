// The turn-ending floors judge the tool calls an earlier pass of the turn made, arguments included.
// Driven through the engine's real turn entry (`runV2Turn`) with the real tools; only the model is scripted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const callModelSpy = vi.fn();

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-floors-see-calls', 'dojo.db'),
  };
});
vi.mock('../../../../model.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../model.js')>('../../../../model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../../../runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../../../../costs/tracker.js', async () => ({ ...(await vi.importActual<typeof import('../../../../../costs/tracker.js')>('../../../../../costs/tracker.js')), recordCost: vi.fn() }));
vi.mock('../../../../../memory/embeddings.js', () => ({
  queueEmbedding: vi.fn(), generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  storeEmbedding: async () => { /* not exercised */ }, refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../../../../memory/vector-search.js', () => ({ vectorSearch: async () => [], hybridSearch: async () => [] }));
vi.mock('../../../../../router/scorer.js', () => ({ scoreQuery: () => ({ tier: 'standard', scores: [], rawScore: 0, confidence: 0.5, latencyMs: 0 }) }));
vi.mock('../../../../../router/selector.js', () => ({ selectModel: vi.fn(), logRouterDecision: vi.fn(), getSystemModel: () => null }));
vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
import { runV2Turn } from '../../../loop.js';
import { runMigrations } from '../../../../../db/migrations.js';
import { submitUserMessage } from '../../../../../gateway/routes/chat.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';

const AGENT = 'agent-desk';
const PROMISE = 'On it. Let me pull up the supplier quotes.';
const PROMISE_STEER = 'was a promise to start';
const NOTE_STEER = 'you just added a note to';

type Call = { name: string; arguments: Record<string, unknown> };
/** One turn: the first pass makes `calls`, the next replies `reply` with no tool; later passes say nothing new. */
async function turn(ask: string, calls: Call[], reply: string): Promise<string[]> {
  expect((await submitUserMessage(AGENT, ask)).ok).toBe(true);
  let pass = 0;
  callModelSpy.mockImplementation(async () => {
    pass++;
    const toolCalls = pass === 1 ? calls.map((c, i) => ({ id: `call-${i}`, ...c })) : [];
    return { content: pass === 1 && calls.length > 0 ? '' : reply, toolCalls, inputTokens: 1, outputTokens: 1, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' };
  });
  await runV2Turn(AGENT);
  return (mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'system'").all(AGENT) as Array<{ content: string }>).map((r) => r.content);
}
const steered = (rows: string[], words: string): number => rows.filter((c) => c.includes(words)).length;

let step = '';
beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Desk', 'm', 'idle', '{}', 'sensei')`).run(AGENT);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  step = openTrackerTask({
    title: 'Compare supplier quotes', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: 1, convKey: null },
  });
  callModelSpy.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the turn-ending floors see the calls the turn made', () => {
  it('a turn that paused a step on the owner\'s word is not told to start', async () => {
    const rows = await turn('Plan the quotes job but do not start yet.', [{
      name: 'work_update',
      arguments: { action: 'status', task_id: step, status: 'paused', notes: 'Waiting for the owner to say go before starting.' },
    }], PROMISE);
    expect((mockDb.current!.prepare('SELECT hold_kind FROM work WHERE id = ?').get(step) as { hold_kind: string }).hold_kind).toBe('paused');
    expect(steered(rows, PROMISE_STEER)).toBe(0);
  });

  it('control: the same promise with nothing behind it is steered once', async () => {
    const rows = await turn('Plan the quotes job.', [], PROMISE);
    expect(steered(rows, PROMISE_STEER)).toBe(1);
  });

  const note = (): Call[] => [{ name: 'work_note', arguments: { task_id: step, notes: 'Two of three quotes are in.' } }];
  it('a note on a working task, then silence, is steered once', async () => {
    // A reply that is only a copied time stamp reaches the person as nothing.
    const rows = await turn('Any progress on the quotes?', note(), '[2026-11-12 10:00]');
    expect(steered(rows, NOTE_STEER)).toBe(1);
  });

  it('a note, then a spoken reply, is not steered', async () => {
    const rows = await turn('Any progress on the quotes?', note(), 'Noted the two quotes that came in.');
    expect(steered(rows, NOTE_STEER)).toBe(0);
  });
});
