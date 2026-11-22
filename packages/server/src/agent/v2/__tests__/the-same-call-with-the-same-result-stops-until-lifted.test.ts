// The one repeat rule, through the real turn entry (`runV2Turn`): the same call bringing back the same
// result stops at the 4th, runs again only after `continue_repeating` with a reason, then stops at 8 and 20.
// The model and the tools are stand-ins; the lift itself runs through the real executor.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-repeat-rule', 'dojo.db'),
  };
});
vi.mock('../../model.js', async () => {
  const actual = await vi.importActual<typeof import('../../model.js')>('../../model.js');
  return { ...actual, callModel: (...a: unknown[]) => callModelSpy(...a), getContextWindow: () => 200000 };
});
vi.mock('../../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../tools/index.js')>('../../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../tool-outcome.js')>('../../tool-outcome.js');
  return {
    ...actual,
    executeTool: async (agentId: string, tc: { id: string; name: string }) => tc.name === 'continue_repeating'
      ? actual.executeTool(agentId, tc as Parameters<typeof actual.executeTool>[1])
      : classifyToolResult({ toolCallId: tc.id, name: tc.name, ...toolSpy(tc) }),
  };
});
vi.mock('../../runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../../memory/assembler.js', () => ({
  assembleContext: async () => ({ systemPrompt: '<system prompt>', messages: [{ role: 'user', content: 'hello' }] }),
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
import { clearPlatformConfigCache } from '../../../config/platform.js';

// Fresh agents per case: the rule's window lives in the process, keyed by agent and turn.
let MAIN = '';
let HELPER = '';
let PM = '';
let run = 0;
const STOPPED = 'the engine has stopped';
const NOT_RUN = 'not run';

type Call = { name: string; arguments: Record<string, unknown> };
const search: Call = { name: 'gmail_search', arguments: { query: 'in:inbox older_than:1y' } };
const lift = (reason = 'each batch archives mail the server already moved'): Call => ({ name: 'continue_repeating', arguments: { reason } });

/** One turn: each entry of `passes` is one model response's calls; then a plain reply ends it. */
async function turn(agentId: string, passes: Array<Call | Call[]>): Promise<string[]> {
  expect((await submitUserMessage(agentId, 'Clear out the old mail.')).ok).toBe(true);
  let pass = 0;
  callModelSpy.mockImplementation(async () => {
    const planned = passes[pass++];
    const toolCalls = planned === undefined ? [] : (Array.isArray(planned) ? planned : [planned]).map((c, i) => ({ id: `c-${pass}-${i}`, ...c }));
    // The first pass says its start line, as the start-line hint asks, so no pass is held for it.
    return { content: toolCalls.length ? (pass === 1 ? 'On it.' : '') : 'Done for now.', toolCalls, inputTokens: 1, outputTokens: 1, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' };
  });
  await runV2Turn(agentId);
  return results(agentId);
}

/** Every tool result the agent has received, in order, read from the persisted tool rows. */
function results(agentId: string): string[] {
  const rows = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'tool' ORDER BY rowid").all(agentId) as Array<{ content: string }>;
  return rows.flatMap((r) => (JSON.parse(r.content) as Array<{ content: string }>).map((b) => b.content));
}
const ran = (name: string): number => toolSpy.mock.calls.filter(([tc]) => (tc as Call).name === name).length;
const times = (n: number, c: Call): Call[] => Array.from({ length: n }, () => c);

beforeEach(() => {
  run += 1;
  [MAIN, HELPER, PM] = ['main', 'helper', 'pm'].map((role) => `agent-${role}-${run}`);
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  for (const id of [MAIN, HELPER, PM]) {
    db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, ?, 'm', 'idle', '{}', 'sensei')`).run(id, id);
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('pm_agent_id', ?)").run(MAIN, PM);
  callModelSpy.mockReset();
  toolSpy.mockReset();
  toolSpy.mockImplementation(() => ({ content: 'No emails found matching that query.', isError: false }));
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the same call with the same result stops until the agent chooses to continue', () => {
  it('stops at the 4th, a plain retry stays stopped, a lift runs it to 8, then to 20', async () => {
    const seen = await turn(MAIN, [
      ...times(4, search), search, lift(), ...times(4, search), search, lift(), ...times(12, search), search,
    ]);
    expect(ran('gmail_search')).toBe(20);
    expect(seen[3]).toContain(STOPPED);
    expect(seen.slice(0, 3).some((r) => r.includes(STOPPED))).toBe(false);
    expect(seen[4]).toContain(NOT_RUN);
    expect(seen[5]).toMatch(/^Continuing/);
    expect(seen[9]).toContain(STOPPED);
    expect(seen[10]).toContain(NOT_RUN);
    expect(seen[23]).toContain(STOPPED);
    expect(seen[24]).toContain(NOT_RUN);
    const lifts = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND content LIKE '%continue_repeating%'").all(MAIN);
    expect(lifts, 'each lift is on the record with its reason').toHaveLength(2);
    expect(JSON.stringify(lifts)).toContain('each batch archives mail');
  });

  it('a result that differs only by its time stamp is the same; one that differs by a count is not', async () => {
    let n = 0;
    toolSpy.mockImplementation(() => ({ content: `Checked at 2026-11-15T10:0${n}:00.000Z (Sat, Nov 15, 10:0${n++} AM): no new mail.`, isError: false }));
    expect((await turn(MAIN, times(4, search)))[3]).toContain(STOPPED);
    let left = 4250;
    toolSpy.mockImplementation(() => ({ content: `Archived 50 messages, ${(left -= 50).toLocaleString('en-US')} left.`, isError: false }));
    const counted = await turn(HELPER, times(8, search));
    expect(counted.some((r) => r.includes(STOPPED) || r.includes(NOT_RUN))).toBe(false);
  });

  it('the same failure four times is stopped the same way, and lifts the same way', async () => {
    toolSpy.mockImplementation(() => ({ content: 'Error: rate limited, try again later.', isError: true }));
    const seen = await turn(MAIN, [...times(4, search), search, lift(), search]);
    expect(seen[3]).toContain(STOPPED);
    expect(seen[4]).toContain(NOT_RUN);
    expect(ran('gmail_search')).toBe(5);
  });

  it('three stopped retries with no lift end the tool phase for the turn', async () => {
    await turn(MAIN, [...times(4, search), ...times(10, search)]);
    expect(ran('gmail_search')).toBe(4);
    const row = mockDb.current!.prepare('SELECT exit_reason FROM turns WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(MAIN) as { exit_reason: string };
    expect(row.exit_reason).toBe('brake');
  });

  it('after the tool phase ends, the main agent can still lift the stop and the call runs; a helper cannot', async () => {
    clearPlatformConfigCache();   // which agent is the main one is read from this case's config
    const seen = await turn(MAIN, [...times(4, search), ...times(3, search), lift(), search]);
    expect(seen.some((r) => /^Continuing/.test(r))).toBe(true);
    expect(ran('gmail_search')).toBe(5);
    toolSpy.mockClear();
    await turn(HELPER, [...times(4, search), ...times(3, search), lift(), search]);
    expect(ran('gmail_search')).toBe(4);
  });

  it('stopped calls retried once each never add up to the end of the tool phase', async () => {
    const calls = [1, 2, 3].map((n): Call => ({ name: 'gmail_search', arguments: { query: `from:shop-${n}` } }));
    await turn(MAIN, [...calls.flatMap((c) => times(5, c)), search]);
    expect(ran('gmail_search')).toBe(13);
  });

  it('the 4th send to one agent is refused whatever it says, lifted the same way, then the 8th; another agent is its own count', async () => {
    let thread = 0;
    toolSpy.mockImplementation(() => ({ content: `[A2A:FYI] Message delivered on thread ${(thread++).toString(16).padStart(8, '0')}.`, isError: false }));
    const ask = (to: string, n: number): Call => ({ name: 'send_to_agent', arguments: { agent: to, intent: 'FYI', message: `status note number ${n}` } });
    const toHelper = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ask(HELPER, n));
    const seen = await turn(MAIN, [...toHelper.slice(0, 4), ask(PM, 1), lift('the helper asked for each part separately'), ...toHelper.slice(4)]);
    const sentTo = (agent: string): number => toolSpy.mock.calls.filter(([tc]) => (tc as Call).arguments.agent === agent).length;
    expect(seen[3], 'the 4th send did not go out').toContain(NOT_RUN);
    expect(seen[4]).not.toContain(NOT_RUN);
    expect(seen[5]).toMatch(/^Continuing/);
    expect(seen[10], 'the 8th send did not go out').toContain(NOT_RUN);
    expect(sentTo(HELPER)).toBe(7);
    expect(sentTo(PM)).toBe(1);
  });

  it('two sends to one agent in each of three turns all go out: sends count within the turn', async () => {
    toolSpy.mockImplementation(() => ({ content: '[A2A:FYI] Message delivered.', isError: false }));
    const note = (n: number): Call => ({ name: 'send_to_agent', arguments: { agent: HELPER, intent: 'FYI', message: `update ${n}` } });
    for (let t = 0; t < 3; t++) await turn(MAIN, [note(2 * t), note(2 * t + 1)]);
    expect(ran('send_to_agent')).toBe(6);
    expect(results(MAIN).some((r) => r.includes(NOT_RUN))).toBe(false);
  });

  it('a call made once a turn, turn after turn, is never stopped', async () => {
    for (let i = 0; i < 6; i++) await turn(MAIN, [search]);
    expect(ran('gmail_search')).toBe(6);
    expect(results(MAIN).some((r) => r.includes(STOPPED))).toBe(false);
  });

  it('two calls alternating with unchanged results are each stopped on their own count', async () => {
    const nested = (label: string): Call => ({ name: 'gmail_search', arguments: { query: 'in:inbox', options: { label, page: 1 } } });
    const seen = await turn(MAIN, [nested('a'), nested('b'), nested('a'), nested('b'), nested('a'), nested('b'), nested('a'), nested('b')]);
    expect(seen[6]).toContain(STOPPED);
    expect(seen[7]).toContain(STOPPED);
    expect(seen.slice(0, 6).some((r) => r.includes(STOPPED))).toBe(false);
  });

  it('parallel calls in one response are counted once each', async () => {
    const seen = await turn(MAIN, [times(3, search), search]);
    expect(seen.slice(0, 3).some((r) => r.includes(STOPPED))).toBe(false);
    expect(seen[3]).toContain(STOPPED);
  });

  it('the lift with nothing stopped changes nothing; with an empty reason it is refused plainly', async () => {
    const seen = await turn(MAIN, [lift('just in case'), lift('   '), ...times(4, search)]);
    expect(seen[0]).toContain('Nothing is stopped');
    expect(seen[1]).toContain('needs a one-line reason');
    expect(seen[5]).toContain(STOPPED);
  });

  it('the main agent, a helper and the project manager all live under the same rule', async () => {
    for (const agentId of [MAIN, HELPER, PM]) {
      const seen = await turn(agentId, [...times(4, search), lift(), search]);
      expect(seen[3], agentId).toContain(STOPPED);
      expect(seen[4], agentId).toMatch(/^Continuing/);
      expect(seen[5], agentId).not.toContain(NOT_RUN);
    }
  });
});
