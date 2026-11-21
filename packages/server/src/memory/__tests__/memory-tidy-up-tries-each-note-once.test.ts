// The memory tidy-up offers each note to the writer once at its depth, and an idle agent then pays nothing.
// A lived-in agent whose writer cannot shrink its notes enough (every merge comes back at 90% of its input) is
// driven through the owner's compact-now and then many turns and idle cycles with no rows leaving the view.
// Only the provider calls are stand-ins (the writer, and the decision model the summary check asks, which fails a
// summary saying PENDING); the gate, the compactor, the writer choice, the keep rule and the check are real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../logger.js', async (orig) => {
  const actual = await orig<typeof import('../../logger.js')>();
  const at = (message: string): void => { logs.push(message); };
  return { ...actual, createLogger: () => ({ debug: at, info: at, warn: at, error: at }) };
});
const mem = vi.hoisted(() => ({ free: Number.MAX_SAFE_INTEGER }));
vi.mock('../../agent/local-model-fit.js', async (orig) => ({ ...(await orig<object>()), freeWriterWindowTokens: async () => mem.free }));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const marks = vi.hoisted(() => ({ fail: false }));
vi.mock('../writer.js', async (orig) => {
  const actual = await orig<typeof import('../writer.js')>();
  return { ...actual, markWaiting: (...a: Parameters<typeof actual.markWaiting>) => (marks.fail ? undefined : actual.markWaiting(...a)) };
});
const writer = vi.hoisted(() => ({ calls: [] as Array<{ modelId: string; content: string; rewrite: boolean }>, ratio: 0.9, ratios: null as number[] | null, empty: false }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; systemPrompt: string; messages: Array<{ content: string }> }) => {
    const content = p.messages[0].content;
    const rewrite = p.systemPrompt.includes('REWRITE:');
    const job = writer.calls.filter((c) => !c.rewrite).length - (rewrite ? 1 : 0);   // a job's rewrite answers like its first
    const ratio = writer.ratios ? writer.ratios[job % writer.ratios.length] : writer.ratio;
    writer.calls.push({ modelId: p.modelId, content, rewrite });
    const text = writer.empty ? '' : `${content.includes('BAD') ? 'PENDING ' : ''}${'w'.repeat(Math.floor(content.length * ratio))}`;
    return { content: text, toolCalls: [], usage: {}, stopReason: 'stop' };
  },
  getContextWindow: () => 128_000,
  getModelOutputCap: () => 8192,
  getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact } from '../compaction.js';
import { createLeafSummary } from '../dag.js';
import { insertMessage } from '../message-store.js';
import { __resetBrakesForTests, LOW_YIELD_BACKOFF_MS } from '../compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { __resetSummaryWriterHealthForTests, clearOn, writerPassedOver } from '../writer.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { condenseForTheDialedModel } from '../../agent/v2/steps/pre-call-gates/context-gates.js';
import { backgroundDrains } from '../../agent/shared-state.js';
import { mergeUntriedNotes } from '../merge-notes.js';

const AGENT = 'agent-lived-in';
const OWN = 'model-own-128k';
const WINDOW = 128_000;
const db = (): Database.Database => mockDb.current!;
const NOTE = (i: number): string => `Note ${i}: the crew counted bay ${i}, filed manifest M-${1000 + i} and logged seal S-${2000 + i}. `.repeat(70);

/** `leaves` leaf notes over old rows (those in `bad` carry what fails the check once merged), optionally one lone deep
 *  note, then a short live tail nothing pushes out. */
function seed(leaves: number, lone?: { depth: number; chars: number }, bad: readonly number[] = []): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-own', 'Own', 'openai-compatible', 'api_key', 'http://127.0.0.1:1/v1')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'p-own', 'own', 'Own', ?, 8192, '["text","tools"]', 1, 0.1, 0.4)`).run(OWN, WINDOW);
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url, is_validated) VALUES ('p-local', 'Local', 'ollama', 'none', 'http://127.0.0.1:11434', 1)").run();
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('model-decision', 'p-local', ?, ?, '[\"decision\"]', 1)").run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES ('model-local-writer', 'p-local', ?, 'Writer', 32000, 4096, '["text"]', 1, 0, 0)`).run(STANDARD_WRITER_MODEL.tag);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Keeper', 'idle', ?, '{}')").run(AGENT, OWN);
  if (lone) {
    const id = createLeafSummary(AGENT, 'x'.repeat(lone.chars), Math.ceil(lone.chars / 4), [row('user', 'old ask'), row('assistant', 'old answer')], day(0), day(0)).id;
    db().prepare('UPDATE summaries SET depth = ?, kind = ? WHERE id = ?').run(lone.depth, 'condensed', id);
  }
  for (let i = 0; i < leaves; i++) addLeaf(i, bad.includes(i) ? `BAD ${NOTE(i)}` : NOTE(i));
  for (let i = 0; i < 6; i++) row(i % 2 === 0 ? 'user' : 'assistant', `live line ${i}`);
}

let turns = 0;
const row = (role: 'user' | 'assistant', content: string): string =>
  insertMessage({ agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, content, turnNumber: ++turns }).id;
const day = (i: number): string => new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString();
/** One more leaf note, the `i`th of this agent's history, over its own two rows. */
function addLeaf(i: number, text: string): string {
  return createLeafSummary(AGENT, text, Math.ceil(text.length / 4), [row('user', `ask ${i}`), row('assistant', `answer ${i}`)], day(i + 1), day(i + 1)).id;
}

/** One model call's routine gate, as a turn runs it, with its background run allowed to land. */
async function turn(aPersonSpoke = false): Promise<void> {
  if (aPersonSpoke) clearOn({ kind: 'person-spoke', agentId: AGENT });
  await condenseForTheDialedModel({ agentId: AGENT, dialedModelId: OWN, contextWindow: WINDOW, writerModelId: OWN });
  while (backgroundDrains.has(AGENT)) await new Promise<void>((r) => setImmediate(r));
}

/** A long quiet stretch: many turns, the brake's whole backoff passing, a person speaking now and then. */
async function idleStretch(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await turn(i % 10 === 0);
    if (i % 10 === 9) {
      vi.setSystemTime(Date.now() + LOW_YIELD_BACKOFF_MS + 1);
      await checkAndCompact(AGENT, OWN, WINDOW, { inTheBackground: true });
    }
  }
}

/** Each merge job (a first answer, not its rewrite) and the note ids it was shown. */
const mergeJobs = (): Array<{ modelId: string; notes: string[] }> => writer.calls.filter((c) => !c.rewrite && c.content.includes('<summary id='))
  .map((c) => ({ modelId: c.modelId, notes: [...c.content.matchAll(/<summary id="([^"]+)"/g)].map((m) => m[1]) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 20, 6, 0, 0));
  writer.calls = []; writer.ratio = 0.9; writer.ratios = null; writer.empty = false; marks.fail = false; mem.free = Number.MAX_SAFE_INTEGER; logs.length = 0; turns = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const { state } = JSON.parse(init?.body ?? '{}') as { state: { summary: string } };
    return Response.json({ answers: { stated_current: { noul: state.summary.includes('PENDING') ? 0.91 : 0.05 } } });
  }));
  mockDb.current = new Database(':memory:');
  runMigrations();
  __resetBrakesForTests(); __resetEstimateCacheForTests(); __resetSummaryWriterHealthForTests();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

/** Top-level notes at `depth`, and the check outcomes recorded. */
const topLevelAt = (depth: number): number => (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND depth = ? AND id NOT IN (SELECT parent_id FROM summary_parents)').get(AGENT, depth) as { n: number }).n;
const restingNotes = (): number => (db().prepare("SELECT COUNT(*) AS n FROM healer_state WHERE scope = 'writer_wait.cannot-hold'").get() as { n: number }).n;
const checksNotKept = (): number => (db().prepare("SELECT COUNT(*) AS n FROM summary_checks WHERE outcome = 'not_kept'").get() as { n: number }).n;

describe('the memory tidy-up tries each note once', () => {
  it('merges that come back at 90% of their input: each note is offered once, to the own model only, and then never again', async () => {
    seed(12, { depth: 3, chars: 36_000 });
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    const jobs = mergeJobs();
    expect(jobs.length, 'non-vacuity: the writer was asked to merge').toBeGreaterThan(0);
    const offers = new Map<string, number>();
    for (const j of jobs) for (const n of j.notes) offers.set(n, (offers.get(n) ?? 0) + 1);
    expect([...offers.values()].filter((n) => n > 1), 'no note is offered twice at its depth').toEqual([]);
    expect(jobs.filter((j) => j.modelId !== OWN), 'a refused merge is not handed to the local writer').toEqual([]);
    expect(writer.calls.length, 'each job is an answer and at most one rewrite').toBeLessThanOrEqual(2 * jobs.length);

    const paid = writer.calls.length;
    await idleStretch();
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(writer.calls.length, 'nothing new left the view: the writer is never called again').toBe(paid);
  });

  it('a lone oversized old note at its own depth starts no run and costs nothing', async () => {
    seed(1, { depth: 4, chars: 40_000 });
    await idleStretch();
    expect(logs.filter((l) => l.startsWith('v2: condensing rows')), 'no turn starts a memory run').toEqual([]);
    expect(writer.calls, 'nothing is paid for it').toEqual([]);
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(writer.calls, 'and even the forced pass dials nothing for it').toEqual([]);
  });

  it('a merge the summary check refuses is passed over: the other notes still merge, and a later run makes no call for it', async () => {
    writer.ratio = 0.35;
    seed(4, { depth: 3, chars: 36_000 }, [0]);
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(checksNotKept(), 'non-vacuity: the check refused the pair holding the bad note').toBe(1);
    expect(topLevelAt(1), 'the other pair merged').toBe(1);
    expect(topLevelAt(0), 'the refused pair stays whole').toBe(2);
    const paid = writer.calls.length;
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(writer.calls.length, 'the refused pair is not dialled again').toBe(paid);
  });

  it('a writer that keeps 0.35 of its input compresses a backlog of twelve leaves', async () => {
    writer.ratio = 0.35;
    seed(12, { depth: 3, chars: 36_000 });
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(topLevelAt(0), 'every leaf was merged').toBe(0);
    expect(topLevelAt(1) + topLevelAt(2), 'into notes a level or more up').toBeGreaterThan(0);
  });

  it('when a refusal cannot be recorded, each pair is still dialled once and the run ends', async () => {
    marks.fail = true;
    seed(12, { depth: 3, chars: 36_000 });
    await checkAndCompact(AGENT, OWN, WINDOW, { force: true });
    expect(mergeJobs().length, 'twelve leaves: six pairs, each note offered once').toBe(6);
  });

  it('steady use, a writer keeping 0.30 to 0.46 of its input, 256 leaves one at a time: one offer each, and a bounded cost per leaf', async () => {
    writer.ratios = [0.30, 0.38, 0.46, 0.34, 0.42];
    seed(0, { depth: 9, chars: 36_000 });
    const plain = 'The crew counted the bays and filed the manifests for the night shift. '.repeat(70);
    for (let i = 0; i < 256; i++) { addLeaf(i, plain); await mergeUntriedNotes(AGENT, OWN); }
    const offers = new Map<string, number>();
    for (const j of mergeJobs()) for (const n of j.notes) offers.set(n, (offers.get(n) ?? 0) + 1);
    expect(restingNotes(), 'non-vacuity: some pairs were refused').toBeGreaterThan(0);
    expect(Math.max(...offers.values()), 'offers of any one note at its depth').toBe(1);
    expect(writer.calls.length / 256, 'writer calls per new leaf').toBeLessThanOrEqual(1);
  });

  it('a note the summary check refuses, then sixteen fresh leaves one at a time: it is never offered again', async () => {
    writer.ratio = 0.35;
    seed(0, { depth: 9, chars: 36_000 });
    addLeaf(0, NOTE(0));
    const bad = addLeaf(1, `BAD ${NOTE(1)}`);
    for (let i = 2; i <= 17; i++) { addLeaf(i, NOTE(i)); await mergeUntriedNotes(AGENT, OWN); }
    expect(checksNotKept(), 'non-vacuity: the check refused it').toBeGreaterThan(0);
    const partners = new Set(mergeJobs().filter((j) => j.notes.includes(bad)).map((j) => j.notes.join()));   // a refused pair is written once more with the check's reasons
    expect(partners.size, 'its one partner').toBe(1);
  });

  it('a merge longer than its two notes is not kept, however much the wrapper around them adds', async () => {
    writer.ratio = 0.35;   // of the wrapped input: more than the two short notes themselves
    seed(0, { depth: 9, chars: 36_000 });
    addLeaf(0, 'The bay count is 14.'); addLeaf(1, 'Seal S-2001 is logged.');
    expect((await mergeUntriedNotes(AGENT, OWN)).created).toBe(0);
    expect(mergeJobs().length, 'non-vacuity: the pair was dialled').toBe(1);
  });

  it('a merge that only comes out too long, with every fact kept, is not written again', async () => {
    seed(0, { depth: 9, chars: 36_000 });
    for (const i of [0, 1]) addLeaf(i, 'The crew counted the bays and filed the manifests for the night shift. '.repeat(70));
    expect((await mergeUntriedNotes(AGENT, OWN)).rested).toBe(2);
    expect(writer.calls.length, 'one answer, no rewrite').toBe(1);
  });

  it('an empty answer marks no note and the writer as not answering, so a later run does not dial it again', async () => {
    writer.empty = true;
    seed(2, { depth: 3, chars: 36_000 });
    expect((await mergeUntriedNotes(AGENT, OWN)).created).toBe(0);
    expect(writer.calls.length, 'non-vacuity: the writer was dialled').toBeGreaterThan(0);
    expect(restingNotes(), 'no note is marked').toBe(0);
    expect(writerPassedOver(OWN, AGENT), 'the writer is marked not answering').toBe(true);
  });

  it('a refusal for the memory free now marks no note, and a later run with memory free merges the same notes', async () => {
    writer.ratio = 0.35;
    seed(2, { depth: 3, chars: 36_000 });
    mem.free = 6_000;   // the prompt fits, the pair does not
    const first = await mergeUntriedNotes(AGENT, 'model-local-writer');
    expect(logs.some((l) => l.startsWith('SUMMARY_REFUSED a fallback summary on the Dojo')), 'non-vacuity: refused for memory').toBe(true);
    expect(first.created).toBe(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM healer_state WHERE scope = 'writer_wait.cannot-hold'").get(), 'no note is marked').toEqual({ n: 0 });
    mem.free = Number.MAX_SAFE_INTEGER;
    expect((await mergeUntriedNotes(AGENT, 'model-local-writer')).created).toBe(1);
  });
});
