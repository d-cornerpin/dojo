// A waiting writer is asked again when the agent's own model changes (its model, or its router's standard tier), or
// when the owner saves the down model's provider; each waiting agent wakes once, and a change that frees no writer
// wakes none. The doors are the real routes; the writers, Ollama and the runtime's wake are scripted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => {},
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn(), getIMBridgeStatus: vi.fn(), sendIMessage: vi.fn(), startIMBridge: vi.fn() }));
const writers = vi.hoisted(() => ({ calls: [] as string[], unreachable: new Set<string>() }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string }) => {
    writers.calls.push(p.modelId);
    if (writers.unreachable.has(p.modelId)) throw new Error('OpenAI call failed: fetch failed');
    return { content: `Summary by ${p.modelId}: the crew counted the depot and filed the manifests.`, toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => 'ran', getAgentUptime: () => 0 }),
  stopAgent: async () => {},
}));
// A park dates the job's task row; the one clock (not driven here) wakes an agent whose job is due, and each such
// wake is the same forced pass and park, run below by hand.
vi.mock('../../agent/v2/owed.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), armOwedClock: () => undefined }));
const parks = vi.hoisted(() => [] as Array<{ due: 'event' | 'time'; after: boolean }>);
vi.mock('../../work/job-continuation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../work/job-continuation.js')>();
  return {
    ...real,
    parkJob: (agentId: string, reason: string, due: number | 'event', after?: Promise<unknown>) => {
      parks.push({ due: due === 'event' ? 'event' : 'time', after: after !== undefined });
      return real.parkJob(agentId, reason, due, after);
    },
  };
});
interface LogLine { level: string; message: string }
const logLines = vi.hoisted(() => [] as LogLine[]);
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const at = (level: string) => (message: string): void => { logLines.push({ level, message }); };
  return { ...actual, createLogger: () => ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }) };
});

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact } from '../compaction.js';
import { insertMessage } from '../message-store.js';
import { markWaiting, __resetSummaryWriterHealthForTests } from '../writer.js';
import { __resetBrakesForTests, compactionBrakeMsLeft } from '../compaction-brakes.js';
import { __resetCompactionFailuresForTests } from '../compaction-defect.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { backgroundDrains } from '../../agent/shared-state.js';
import { endTurnContext } from '../../agent/turn-context.js';
import { liveTurn } from '../../agent/v2/__tests__/helpers/live-turn.js';
import { parkAfterForcedPass, __resetFullContextWaitForTests } from '../../agent/v2/full-context-wait.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { configRouter } from '../../gateway/routes/config.js';
import { agentsRouter } from '../../gateway/routes/agents.js';
import { routerRouter } from '../../gateway/routes/router.js';

const GIB = 1024 ** 3;
const AGENT = 'agent-waits';
const OTHER = 'agent-also-waits';
const ALT = 'model-alt';     // another cloud model, answering
const OWN = 'model-own';      // the agent's own (cloud) model
const NEXT = 'model-next';    // an enabled cloud model nobody picked for summaries
const WRITER = 'm-writer';
const arch = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144 };
const SIZES = { writer: 3_400_000_000, decision: 2_800_000_000, embedder: 274_302_471 };
const db = (): Database.Database => mockDb.current!;
const ollama = { psOk: true, showOk: true };
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  writers.calls = []; writers.unreachable = new Set([OWN]);
  parks.length = 0; logLines.length = 0;
  ollama.psOk = true; ollama.showOk = true;
  backgroundDrains.clear();
  __resetBrakesForTests(); __resetBreakersForTests(); __resetSummaryWriterHealthForTests(); __resetCompactionFailuresForTests(); __resetFullContextWaitForTests();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  vi.spyOn(os, 'totalmem').mockImplementation(() => 16 * GIB);
  const prov = db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url, is_validated) VALUES (?, ?, ?, ?, ?, 1)");
  prov.run('ollama-local', 'Ollama', 'ollama', 'none', 'http://localhost:11434');
  prov.run('p-own', 'Own', 'openai-compatible', 'api_key', 'http://localhost:11441/v1');
  prov.run('p-next', 'Next', 'openai-compatible', 'api_key', 'http://localhost:11442/v1');
  prov.run('p-alt', 'Alt', 'openai-compatible', 'api_key', 'http://localhost:11443/v1');
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?, 4096, ?, 1)`);
  model.run(OWN, 'p-own', 'Own', 'own', '["text","tools"]', 32_000, 3);
  model.run(NEXT, 'p-next', 'Next', 'next', '["text","tools"]', 32_000, 1);
  model.run(ALT, 'p-alt', 'Alt', 'alt', '["text","tools"]', 32_000, 2);
  model.run(WRITER, 'ollama-local', STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag, '["chat"]', 262_144, 0);
  model.run('m-decision', 'ollama-local', STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag, '["decision"]', 262_144, 0);
  const agent = db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'A worker agent', 'idle', ?, '{}')");
  agent.run(AGENT, OWN); agent.run(OTHER, OWN);
  db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_window', '27648')").run();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const p = new URL(url).pathname;
    if (p === '/api/tags') return Response.json({ models: [
      { name: STANDARD_WRITER_MODEL.tag, size: SIZES.writer }, { name: STANDARD_DECISION_MODEL.tag, size: SIZES.decision },
      { name: 'nomic-embed-text:latest', size: SIZES.embedder },
    ] });
    if (p === '/api/ps') return ollama.psOk ? Response.json({ models: [] }) : new Response('busy', { status: 500 });
    if (p === '/api/show') {
      const name = (JSON.parse(init?.body ?? '{}') as { name?: string; model?: string });
      return ollama.showOk && [STANDARD_WRITER_MODEL.tag, STANDARD_DECISION_MODEL.tag].includes(name.name ?? name.model ?? '') ? Response.json({ model_info: arch }) : new Response('nf', { status: 404 });
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const ROW = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(40);
function seed(agentId = AGENT, turns = 24): void {
  for (let t = 1; t <= turns; t++) {
    insertMessage({ agentId, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] ${ROW}` });
  }
}
const realSummaries = (agentId = AGENT): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind != 'uncondensed'").get(agentId) as { n: number }).n;
/** The turn whose assembly the provider boundary refused: one forced pass, then the park (as `recovery.ts` does). */
let turnNumber = 100;
async function overBudgetTurn(agentId: string): Promise<void> {
  const ask = (db().prepare("SELECT id FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1").get(agentId) as { id: string }).id;
  const bag = liveTurn(agentId, { turnNumber: ++turnNumber, root: { kind: 'ask', id: ask, sourceMessageId: ask } });   // the turn serves the owner's latest message, so its park has a task to date
  try {
    const own = (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string }).model_id;
    const brakedBefore = compactionBrakeMsLeft(agentId) !== null;
    await checkAndCompact(agentId, own, 8_000, { force: true, inTurn: true });
    parkAfterForcedPass(agentId, 'recovery-over-budget-assembly', brakedBefore);
  } finally { endTurnContext(agentId); }
}
const dueNow = (agentId: string): boolean => !!db().prepare("SELECT 1 FROM work WHERE agent_id = ? AND kind = 'task' AND next_attempt_at <= ?").get(agentId, Date.now());
/** Both agents' spans wait: their writer (the own model) not answering, the small writer with no room; each parked. */
async function bothWaiting(): Promise<void> {
  seed(AGENT); seed(OTHER);
  for (const a of [AGENT, OTHER]) markWaiting(a, OWN, '', 'not-answering');
  await overBudgetTurn(AGENT); await overBudgetTurn(OTHER);
  expect(parks.filter((p) => p.due === 'event' && p.after).length, 'precondition: both parked on their writer').toBe(2);
  expect(dueNow(AGENT) || dueNow(OTHER), 'and nothing woke at once').toBe(false);
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** Each agent whose job came due is woken once: the job turn picks its task up and runs the same pass. */
const wakes = { by: {} as Record<string, number> };
async function afterTheWake(): Promise<void> {
  await settle(50);
  wakes.by = {};
  for (const a of [AGENT, OTHER]) {
    if (!dueNow(a)) continue;
    wakes.by[a] = 1;
    db().prepare("UPDATE work SET next_attempt_at = NULL WHERE agent_id = ? AND kind = 'task'").run(a);
    await overBudgetTurn(a);
  }
}

describe('an owner change that can make a writer runnable wakes each waiting agent once', () => {
  // v3.5 field fix 3: deleted with the Summarization setting (owner ruling: there is none): the pick saved in Settings.

  it('a change that frees no writer (the router window: a models change, but no writer of theirs can run) wakes nobody', async () => {
    await bothWaiting();
    expect((await configRouter.request('/settings/router.context_window', json('PUT', { value: '64000' }))).status).toBe(200);
    await afterTheWake();
    expect(wakes.by).toEqual({});
  });

  it('an agent\'s own model changed: that agent wakes once, and its new model writes; the other keeps waiting', async () => {
    await bothWaiting();
    expect((await agentsRouter.request(`/${AGENT}/model`, json('PATCH', { modelId: ALT }))).status).toBe(200);
    await afterTheWake();
    expect(wakes.by).toEqual({ [AGENT]: 1 });
    expect(realSummaries(AGENT)).toBeGreaterThan(0);
    expect(writers.calls.filter((m) => m !== OWN && m !== ALT)).toEqual([]);
  });

  it('a router\'s standard-tier model changed: the auto-routed agent waiting on it wakes once', async () => {
    db().prepare("UPDATE agents SET model_id = 'auto' WHERE id IN (?, ?)").run(AGENT, OTHER);
    db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('standard', ?, 1)").run(OWN);
    await bothWaiting();
    expect((await routerRouter.request('/tiers/standard/models', json('PUT', { models: [{ modelId: ALT, priority: 1 }] }))).status).toBe(200);
    await afterTheWake();
    expect(wakes.by).toEqual({ [AGENT]: 1, [OTHER]: 1 });
    expect(realSummaries(AGENT)).toBeGreaterThan(0);
  });

  // v3.5 field fix 3: deleted with the Summarization setting (owner ruling: there is none): a model enabled that was the pick.

  it('a provider saved (the owner edits the down model\'s provider): its waiting agents wake once for a re-test', async () => {
    await bothWaiting();
    writers.unreachable.clear();
    const res = await configRouter.request('/providers', json('POST', { id: 'p-own', name: 'Own', type: 'openai-compatible', baseUrl: 'http://localhost:11444/v1', authType: 'api_key' }));
    expect(res.status).toBe(200);
    await afterTheWake();
    expect(wakes.by).toEqual({ [AGENT]: 1, [OTHER]: 1 });
    expect(realSummaries(AGENT)).toBeGreaterThan(0);
  });
});
