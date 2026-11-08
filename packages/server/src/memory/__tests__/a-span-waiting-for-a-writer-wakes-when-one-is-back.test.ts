// t268 breaker fix (ORCHESTRATOR RULING after re-review 3, I-1 / I-2) — A SPAN WAITING FOR A WRITER WAKES ONLY WHEN ONE
// IS BACK.
// · I-1: a forced pass with no writer of the agent's order able to run arms no brake (round 5), so the full-context park
//   used to queue its wake at once: the woken turn met the same wall and parked again, the 1,216-wakes shape. The park
//   now waits for its own event: a writer of the order able to run again. Never an immediate wake, never a clock.
// · I-2: nothing retried a writer marked not answering unless a person wrote. Now any successful call to that model
//   (the agent's own turn, another agent's) is the signal, for an agent whose span waits; other agents are untouched.
// · Minor (c): free memory that cannot be read is UNKNOWN, and the small writer is not admitted on an unknown.
// THE DOORS: the real `checkAndCompact`, the real `parkAfterForcedPass` (the forced-pass-then-park sequence of
// `recovery.ts` and `over-budget-assembly.ts`), the real park and its timer wake, the real `recordProviderSuccess` that
// every successful model call reaches (`agent/model.ts`). The writers, Ollama and the runtime's wake are scripted.
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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e, getWSStatus: () => ({}) }));
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
// The park's timer wake starts a run through the runtime: here, the woken turn is the same forced pass and park.
const wakes = vi.hoisted(() => ({ timer: 0, turns: [] as Array<Promise<void>>, turn: null as null | (() => Promise<void>) }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { wakes.timer += 1; if (wakes.turn) wakes.turns.push(wakes.turn()); } }),
}));
const parks = vi.hoisted(() => [] as Array<{ how?: string; delayMs?: number; after: boolean }>);
vi.mock('../../work/job-continuation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../work/job-continuation.js')>();
  return {
    ...real,
    parkJob: (agentId: string, reason: string, how?: 'drain' | 'timer', delayMs?: number, after?: Promise<unknown>) => {
      parks.push({ how: how ?? 'drain', delayMs, after: after !== undefined });
      return real.parkJob(agentId, reason, how, delayMs, after);
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
import { generateSummary } from '../summarize.js';
import { insertMessage } from '../message-store.js';
import { eligibleSummaryWriters, writerPassedOver, noteSummaryWriterOutcome, noteDidNotAnswerInTurn, __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { __resetBrakesForTests, compactionIsBraked, compactionBrakeMsLeft } from '../compaction-brakes.js';
import { __resetCompactionFailuresForTests } from '../compaction-defect.js';
import { __resetWriterFallbackRoomForTests } from '../writer-fallback-room.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { backgroundDrains, pendingWakeups } from '../../agent/shared-state.js';
import { parkAfterForcedPass, __resetFullContextWaitForTests } from '../../agent/v2/full-context-wait.js';
import { endJobCarry } from '../../work/task-freshness.js';
import { recordProviderSuccess, recordProviderError } from '../../gateway/routes/services.js';
import { checkOllamaHealth } from '../../services/ollama.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const GIB = 1024 ** 3;
const AGENT = 'agent-waits';
const OTHER = 'agent-not-waiting';
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
  wakes.timer = 0; wakes.turns = []; wakes.turn = null; parks.length = 0; logLines.length = 0;
  ollama.psOk = true; ollama.showOk = true;
  backgroundDrains.clear(); pendingWakeups.clear();
  __resetBrakesForTests(); __resetBreakersForTests(); __resetSummaryWriterHealthForTests(); __resetCompactionFailuresForTests(); __resetFullContextWaitForTests();
  __resetWriterFallbackRoomForTests();   // the memory-free outage a prior test left is over; the next unread read is told afresh
  endJobCarry(AGENT); endJobCarry(OTHER);   // the job carry is process memory: a park's timer wake that never fired is spent, so a prior test's woken turn does not start here
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  vi.spyOn(os, 'totalmem').mockImplementation(() => 16 * GIB);
  const prov = db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url, is_validated) VALUES (?, ?, ?, ?, ?, 1)");
  prov.run('ollama-local', 'Ollama', 'ollama', 'none', 'http://localhost:11434');
  prov.run('p-own', 'Own', 'openai-compatible', 'api_key', 'http://localhost:11441/v1');
  prov.run('p-next', 'Next', 'openai-compatible', 'api_key', 'http://localhost:11442/v1');
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?, 4096, ?, 1)`);
  model.run(OWN, 'p-own', 'Own', 'own', '["text","tools"]', 32_000, 3);
  model.run(NEXT, 'p-next', 'Next', 'next', '["text","tools"]', 32_000, 1);
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
async function overBudgetTurn(): Promise<void> {
  const brakedBefore = compactionBrakeMsLeft(AGENT) !== null;
  await checkAndCompact(AGENT, OWN, 8_000, { force: true, inTurn: true, dialedModelId: OWN });
  parkAfterForcedPass(AGENT, 'recovery-over-budget-assembly', brakedBefore);
}
/** The drain serves an immediate wake by running the agent again: each one is counted, and the run is the same turn. */
async function serveImmediateWakes(limit = 20): Promise<number> {
  let n = 0;
  while (pendingWakeups.delete(AGENT) && n < limit) { n += 1; await overBudgetTurn(); }
  return n;
}
const defectErrorLines = (): number => logLines.filter((l) => l.level === 'error' && l.message.startsWith('COMPACTION_DEFECT')).length;

describe('I-1: a span waiting for a writer parks on that writer coming back — never an immediate wake, never a clock', () => {
  it('16 GB, own model down, nobody writing: over a long outage no wake at all; its model answering → exactly one wake, the span summarised once, zero cloud calls', async () => {
    seed();
    wakes.turn = overBudgetTurn;
    await overBudgetTurn();
    expect(await serveImmediateWakes(), 'zero immediate wakes').toBe(0);
    expect(parks, 'one park, waiting on an event: no clock').toEqual([{ how: 'timer', delayMs: undefined, after: true }]);
    expect(compactionIsBraked(AGENT, true), 'a wait, not a brake').toBe(false);

    // A long outage: the own model keeps failing other calls, other models answer, Ollama answers (the small writer
    // still has no room). None of that is the agent's writer coming back.
    for (let i = 0; i < 25; i++) {
      recordProviderError('p-own');
      recordProviderSuccess('p-next', { modelId: NEXT, purpose: 'agent_turn' });
      await checkOllamaHealth('http://localhost:11434');
    }
    await settle(1_300);   // longer than the park's settle second: any wake armed would have fired
    expect(wakes.timer, 'no wake while its writer is down').toBe(0);
    expect(parks.length, 'exactly the one park').toBe(1);
    expect(realSummaries()).toBe(0);

    // The recovery signal: a call to the agent's own model succeeds (another agent's turn on it, say).
    writers.unreachable.clear();
    recordProviderSuccess('p-own', { modelId: OWN, purpose: 'agent_turn' });
    await settle(1_300);
    await Promise.all(wakes.turns);
    expect(wakes.timer, 'exactly one wake').toBe(1);
    expect(realSummaries(), 'the woken pass wrote the span').toBeGreaterThan(0);
    const summaries = realSummaries();
    const ownCalls = writers.calls.filter((m) => m === OWN).length;

    // Once: a further answer wakes nothing — nothing is waiting any more.
    recordProviderSuccess('p-own', { modelId: OWN, purpose: 'agent_turn' });
    await settle(1_300);
    expect(wakes.timer).toBe(1);
    expect(writers.calls.filter((m) => m === OWN).length).toBe(ownCalls);
    expect(realSummaries()).toBe(summaries);
    expect(writers.calls.filter((m) => m !== OWN), 'zero calls to any other model, cloud or the small writer').toEqual([]);
  });

  it('several over-budget turns during one outage (each its own trigger): each parks on the writer, none wakes at once, one error line', async () => {
    seed();
    for (let i = 0; i < 3; i++) await overBudgetTurn();
    expect(await serveImmediateWakes()).toBe(0);
    expect(parks.every((p) => p.how === 'timer' && p.after && p.delayMs === undefined), 'every park waits on the writer').toBe(true);
    expect(parks.length).toBe(3);
    expect(defectErrorLines(), 'the defect is logged once per outage, not once per forced pass').toBe(1);
  });
});

describe('I-2: its model answering re-arms the waiting agent\'s writer — for that agent only, and its ordinary work never parks', () => {
  it('the background fold waits without parking; the agent\'s own turn answering re-arms its writer for it; an agent not waiting stays passed over', async () => {
    seed(); seed(OTHER, 4);
    noteSummaryWriterOutcome(OWN, false);   // its model stopped answering a summary call
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });   // the small writer has no room: the span waits
    const before = writers.calls.length;
    await checkAndCompact(AGENT, OWN, 8_000, { inTheBackground: true });
    expect(writers.calls.length, 'the background fold dials nothing').toBe(before);
    expect(parks, 'and nothing parks the agent\'s work').toEqual([]);
    expect(writerPassedOver(OWN, OTHER), 'precondition: the other agent has the small writer, so its span does not wait').toBe(true);
    expect(eligibleSummaryWriters(OWN, OTHER)).toEqual([WRITER]);

    writers.unreachable.clear();
    recordProviderSuccess('p-own', { modelId: OWN, purpose: 'agent_turn' });   // the agent's own turn answered on its model
    expect(eligibleSummaryWriters(OWN, AGENT), 'its writer gets one more try, for it').toEqual([OWN]);
    expect(writerPassedOver(OWN, OTHER), 'a chat answer re-arms nobody whose span is not waiting (t207)').toBe(true);
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(writers.calls.slice(before), 'its next pass dials its own model, and only it').toEqual(expect.arrayContaining([OWN]));
    expect(writers.calls.slice(before).every((m) => m === OWN)).toBe(true);
    expect(realSummaries(), 'and writes the span').toBeGreaterThan(0);
  });

  it('a summary call that answered at the wire is not the signal (its own outcome says whether it wrote): no two waiting agents wake each other', async () => {
    seed();
    wakes.turn = overBudgetTurn;
    await overBudgetTurn();
    recordProviderSuccess('p-own', { modelId: OWN, purpose: 'memory_summarize' });   // another agent's summary call, empty text
    await settle(1_300);
    expect(wakes.timer).toBe(0);
    expect(parks.length).toBe(1);
  });
});

// Re-review 4, N-1: a re-arm buys ONE try. A summary the in-turn fold's patience cuts (`out-of-view-fold.ts`, which
// then calls `noteDidNotAnswerInTurn`) after a re-arm marks the writer again, so the next turns wait for a new signal.
describe('N-1: a re-arm buys one try — a try cut by the turn\'s patience marks the writer again', () => {
  it('re-armed → one timed-out try → passed over again; the next turns dial nothing until a new signal', async () => {
    seed();
    wakes.turn = overBudgetTurn;
    await overBudgetTurn();                                     // waiting, parked
    recordProviderSuccess('p-own', { modelId: OWN, purpose: 'agent_turn' });   // re-armed for it: one try
    expect(eligibleSummaryWriters(OWN, AGENT)).toEqual([OWN]);
    noteDidNotAnswerInTurn(OWN);                                // that try ran past the turn's patience
    expect(eligibleSummaryWriters(OWN, AGENT), 'the re-arm is spent').toEqual([]);
    await settle(1_300); await Promise.all(wakes.turns);       // the wake the re-arm earned
    const calls = writers.calls.length;
    await overBudgetTurn(); await overBudgetTurn();             // the next turns
    expect(writers.calls.length, 'no re-dial without a new signal').toBe(calls);
    recordProviderSuccess('p-own', { modelId: OWN, purpose: 'agent_turn' });   // a new signal
    expect(eligibleSummaryWriters(OWN, AGENT)).toEqual([OWN]);
  });
});

describe('minor (c): free memory that cannot be read is UNKNOWN — the small writer is not admitted', () => {
  it('a failed /api/ps on a 32 GB box (where it would fit): refused, not dialled, logged once for the outage', async () => {
    vi.spyOn(os, 'totalmem').mockImplementation(() => 32 * GIB);
    ollama.psOk = false;
    const a = await generateSummary({ content: 'r'.repeat(4_000), depth: 0, targetTokens: 1_000, agentId: AGENT, modelId: WRITER });
    const b = await generateSummary({ content: 'r'.repeat(4_000), depth: 0, targetTokens: 1_000, agentId: OTHER, modelId: WRITER });
    expect(a).toMatchObject({ ok: false, noRoom: true });
    expect(b).toMatchObject({ ok: false, noRoom: true });
    expect(writers.calls, 'never read as "all free"').toEqual([]);
    expect(logLines.filter((l) => /cannot be read/.test(l.message)).length, 'once per outage').toBe(1);

    // Ollama answers again: the read works, and the writer fits.
    ollama.psOk = true;
    await checkOllamaHealth('http://localhost:11434');
    const c = await generateSummary({ content: 'r'.repeat(4_000), depth: 0, targetTokens: 1_000, agentId: AGENT, modelId: WRITER });
    expect(c.ok).toBe(true);
    expect(writers.calls).toEqual([WRITER]);
  });

  it('a failed /api/show for the writer: the same', async () => {
    vi.spyOn(os, 'totalmem').mockImplementation(() => 32 * GIB);
    ollama.showOk = false;
    const a = await generateSummary({ content: 'r'.repeat(4_000), depth: 0, targetTokens: 1_000, agentId: AGENT, modelId: WRITER });
    expect(a).toMatchObject({ ok: false, noRoom: true });
    expect(writers.calls).toEqual([]);
  });
});
