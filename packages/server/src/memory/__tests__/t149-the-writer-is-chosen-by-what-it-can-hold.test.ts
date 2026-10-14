// t149 F4 — THE SUMMARY WRITER IS CHOSEN BY WHAT IT CAN HOLD, AND A DEAD ONE IS PASSED OVER AT ONCE.
//
// Live (walk, L140-5): with no Settings writer the cheapest text model wrote the summaries. On a
// user's box that was a 4,096-window local model: the provider boundary budgeted its call at 0
// tokens ("against a budget of 0") and the pass failed. A 16K Settings writer was handed an 11,184-
// token chunk against a budget of 9,853. And when the cheapest writer was simply unreachable, the
// pass ended with nothing written and armed the 15-minute low-yield brake, so compaction sat
// stalled for a quarter of an hour although another writer was answering.
//
// THE DOORS: the out-of-view door (`out-of-view-fold.ts`) and the real `checkAndCompact` (the
// gate's pressure pass, and its leaving-view pass), on the real migration chain. The model is
// scripted per writer; each dial's size is judged by the same budget formula the provider boundary
// applies (`contextWindowPolicy`, no tools, less the call's own system prompt).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
const owner = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { type?: string; code?: string }) => { owner.cards.push(e); } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

const writers = vi.hoisted(() => ({
  mode: {} as Record<string, string>,
  windows: {} as Record<string, number>,
  calls: [] as Array<{ modelId: string; systemPrompt: string; content: string }>,
  written: 0,
}));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; systemPrompt: string; messages: Array<{ content: string }> }) => {
    writers.calls.push({ modelId: p.modelId, systemPrompt: p.systemPrompt, content: p.messages[0].content });
    const mode = writers.mode[p.modelId] ?? 'ok';
    if (mode === 'unreachable') throw new Error('Ollama call failed: fetch failed');
    writers.written++;
    return { content: `Summary number ${writers.written}: the crew counted the depot and filed the manifests.`, toolCalls: [], usage: {} };
  },
  getContextWindow: (id: string) => writers.windows[id] ?? 32_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { assembleWithNothingOutOfViewUnsummarised } from '../out-of-view-fold.js';
import { checkAndCompact } from '../compaction.js';
import { compactionIsBraked, __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { contextWindowPolicy, estimateTokens } from '../budget.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { backgroundDrains } from '../../agent/shared-state.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t149-writers';
const ROOMY = 'model-t149-roomy';
const TINY = 'model-t149-tiny';       // cheapest by price, 4,096-token window
const SMALL = 'model-t149-16k';       // a 16K window
const DEAD = 'model-t149-dead';       // cheapest by price, unreachable
const db = (): Database.Database => mockDb.current!;

/** The budget the provider boundary gives this writer's tool-less call for its messages. */
const budgetFor = (modelId: string, systemPrompt: string): number =>
  Math.max(0, contextWindowPolicy(writers.windows[modelId] ?? 32_000, { toolPayloadTokens: 0, maxOutputTokens: 4096 }).assemblyBudgetTokens
    - estimateTokens(systemPrompt));

const ROW = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(130);   // ~2.4K tokens
let turnNo = 0;
function appendTurn(rowRepeat = 1): void {
  turnNo++;
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${turnNo}] Which bay is the next crate for?`, turnNumber: turnNo });
  insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo, content: `[a${turnNo}] ${ROW.repeat(rowRepeat)}` });
}
/** A conversation whose older half is far larger than a 16K writer can hold in one call. */
function seedALongCut(): void { for (let t = 1; t <= 24; t++) appendTurn(); }

function seed(): void {
  const prov = db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES (?, ?, 'openai-compatible', 'api_key', ?)");
  for (const [i, id] of ['p-roomy', 'p-tiny', 'p-16k', 'p-dead'].entries()) prov.run(id, id, `http://localhost:1143${i}/v1`);
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
     VALUES (?, ?, ?, ?, ?, 4096, '["text","tools"]', 1, ?, ?)`,
  );
  model.run(ROOMY, 'p-roomy', 'roomy', 'Roomy', 32_000, 0.5, 2);
  model.run(TINY, 'p-tiny', 'tiny', 'Tiny', 4_096, 0, 0);
  model.run(SMALL, 'p-16k', 'small', 'Small', 16_000, 0.1, 0.4);
  model.run(DEAD, 'p-dead', 'dead', 'Dead', 32_000, 0, 0);
  writers.windows = { [ROOMY]: 32_000, [TINY]: 4_096, [SMALL]: 16_000, [DEAD]: 32_000 };
  // An auto-routed agent: no model of its own, so with no Settings writer the cheapest text model writes.
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', 'auto', '{}')").run(AGENT);
}

beforeEach(() => {
  turnNo = 0;
  writers.mode = {}; writers.calls = []; writers.written = 0; owner.cards.length = 0;
  backgroundDrains.clear(); __resetBrakesForTests(); __resetBreakersForTests(); __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const realSummaries = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind != 'uncondensed'").get(AGENT) as { n: number }).n;
const placeholders = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { n: number }).n;
const failingCards = (): number => owner.cards.filter((c) => c.code === 'COMPACTION_FAILING').length;
const door = (window: number): Promise<unknown> =>
  assembleWithNothingOutOfViewUnsummarised(AGENT, window, () => assembleContext(AGENT, ROOMY));

describe('t149 F4 — a writer that cannot hold the input is never dialled', () => {
  it('no Settings writer, the cheapest text model has a 4,096-token window (a budget of 0): it is not dialled, the next one that holds the input writes', async () => {
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(DEAD, SMALL);   // the writers are TINY (cheapest) and ROOMY
    seedALongCut();
    await door(32_000);
    expect(writers.calls.map((c) => c.modelId), 'the writer that can hold nothing was never asked').not.toContain(TINY);
    expect(realSummaries(), 'the rows leaving view were summarised').toBeGreaterThan(0);
    expect(placeholders(), 'no note was left behind').toBe(0);
  });

  it('a 16K Settings writer is handed only what it can hold: every dial fits its own budget, and every row is still summarised', async () => {
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', ?)").run(SMALL);
    seedALongCut();
    await door(16_000);
    expect(writers.calls.length).toBeGreaterThan(0);
    for (const c of writers.calls) {
      expect(c.modelId, 'the owner\'s Settings writer wrote').toBe(SMALL);
      expect(estimateTokens(c.content), `a dial of ${estimateTokens(c.content)} tokens against a budget of ${budgetFor(c.modelId, c.systemPrompt)}`)
        .toBeLessThanOrEqual(budgetFor(c.modelId, c.systemPrompt));
    }
    expect(placeholders(), 'the writer took all of it in pieces it can hold').toBe(0);
  });
});

describe('t149 F4 — a writer that fails is passed over on its first failure, and the next one writes at once', () => {
  it('the gate\'s pressure pass: the cheapest writer is unreachable; the next writes in the SAME pass, and no brake stalls the next one', async () => {
    writers.mode = { [DEAD]: 'unreachable' };
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(TINY, SMALL);   // the writers are DEAD (cheapest) and ROOMY
    seedALongCut();
    const result = await checkAndCompact(AGENT, 'auto', 32_000, { force: true });
    expect(writers.calls[0]?.modelId, 'the cheapest writer was tried first').toBe(DEAD);
    expect(result.leafCreated, 'the next writer wrote in the same pass').toBeGreaterThan(0);
    expect(writers.calls.some((c) => c.modelId === ROOMY)).toBe(true);
    expect(compactionIsBraked(AGENT, true), 'no 15-minute stall while a writer is answering').toBe(false);
    expect(failingCards(), 'no "compaction is failing" card').toBe(0);
  });

  it('the leaving-view pass: the same, and the dead writer is dialled once, not once per chunk', async () => {
    writers.mode = { [DEAD]: 'unreachable' };
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(TINY, SMALL);
    for (let t = 1; t <= 40; t++) appendTurn();   // 80 rows: the 128K window's newest 64 stay, the older 16 leave
    const through = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s - 64;
    const result = await checkAndCompact(AGENT, 'auto', 128_000, { leaving: { cause: 'ceiling', throughSeq: through, rowsLeaving: 30 } });
    expect(writers.calls.filter((c) => c.modelId === DEAD).length, 'passed over on its first failure').toBe(1);
    expect(result.leafCreated).toBeGreaterThan(0);
    expect(compactionIsBraked(AGENT, false)).toBe(false);
    expect(failingCards()).toBe(0);
  });
});

describe('t149 round 4 — the writer is chosen by the REAL input, row by row', () => {
  /** Thirty small turns, then one row far bigger than a 16K writer can hold in a call (but a 32K one can). */
  function aBigRowAmongSmallOnes(repeat: number): string {
    for (let t = 1; t <= 30; t++) appendTurn(0.01);
    turnNo++;
    const id = `big-${repeat}`;
    insertMessage({ id, agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo, content: `[big] ${ROW.repeat(repeat)}` });
    for (let t = 1; t <= 30; t++) appendTurn(0.01);   // so the big row sits outside the newest rows
    return id;
  }
  /** Covered by a REAL summary (a "[Not yet condensed]" note is the platform's honest label, not a summary). */
  const covered = (id: string): boolean =>
    !!db().prepare("SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE sm.message_id = ? AND s.kind != 'uncondensed' LIMIT 1").get(id);
  const labelled = (id: string): boolean =>
    !!db().prepare("SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE sm.message_id = ? AND s.kind = 'uncondensed' LIMIT 1").get(id);

  it.fails('a single row the first writer cannot hold goes to a writer that can, in the same pass: the row is covered, the small writer is not dialled with it', async () => {
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(TINY, DEAD);   // SMALL (cheaper, 16K) is first, ROOMY (32K) second
    const id = aBigRowAmongSmallOnes(5);                                                   // ~12K tokens: more than SMALL's room
    const result = await checkAndCompact(AGENT, 'auto', 8_000, { force: true });
    expect(covered(id), 'the big row was summarised by a real summary, not left or dropped').toBe(true);
    expect(result.leafCreated).toBeGreaterThan(0);
    const bigCalls = writers.calls.filter((c) => c.content.includes('[big]'));
    expect(bigCalls.length).toBeGreaterThan(0);
    expect(bigCalls.every((c) => c.modelId === ROOMY), 'only the writer that holds it was asked').toBe(true);
    expect(compactionIsBraked(AGENT, true), 'no stall behind it').toBe(false);
  });

  it('a row NO writer can hold is never dropped: it stays uncondensed (CONTROL: it holds today too)', async () => {
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(TINY, DEAD);
    const id = aBigRowAmongSmallOnes(14);                                                  // ~34K tokens: more than ROOMY's window holds
    await checkAndCompact(AGENT, 'auto', 8_000, { force: true });
    expect(covered(id), 'the row was NOT summarised away').toBe(false);
    expect(labelled(id), 'the platform\'s own honest label stands for it').toBe(true);
    expect(writers.calls.some((c) => c.content.includes('[big]')), 'no writer was dialled with what it cannot hold').toBe(false);
    expect(
      (db().prepare('SELECT 1 FROM messages WHERE id = ?').get(id)),
      'and the row itself is still there',
    ).toBeTruthy();
  });
});
