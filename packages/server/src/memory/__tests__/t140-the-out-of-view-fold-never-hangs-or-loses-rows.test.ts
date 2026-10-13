// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 — THE OUT-OF-VIEW FOLD WHEN THE SUMMARY WRITER FAILS (re-review 2 §2, R-V333-10).
//
// The engine's assembly door (`out-of-view-fold.ts`'s `assembleWithNothingOutOfViewUnsummarised`)
// summarises the rows its assembly took out of the view before the turn is dialed. Round 2 made
// that exact; this file is what happens when the model writing the summary does not answer:
//
//   · the door has its OWN bound (wall clock, chunk cap) and honours Stop — never a hung turn;
//   · a writer that times out, answers empty, or answers 402 is passed over for the next
//     eligible one, and is not picked again for a few minutes;
//   · if every writer fails, each out-of-view row is still REPRESENTED: a deterministic,
//     labelled placeholder note (no model, no outside text verbatim) covers exactly those rows,
//     and a real summary replaces it once a writer answers;
//   · the owner gets ONE card per incident, not per turn, and the 15-minute brake never blocks
//     this fold or the replacement;
//   · a backlog is capped per turn — the rest is placeholders, replaced in the background.
//
// THE COUNTER is the reviewer's, tightened as asked: after the door, a row is LOST unless its own
// marker is in the dialed view OR a summary covering it is itself in the dialed view.
// THE DOORS: the real assembler, the real door, a migrated DB; only the model is scripted, per
// writer, by mode.
// ════════════════════════════════════════════════════════════════════════════════════════

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
const owner = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string; error?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { type?: string; code?: string }) => { owner.cards.push(e); } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));

type Mode = 'ok' | 'hang' | 'empty' | '402';
const writers = vi.hoisted(() => ({
  mode: {} as Record<string, string>,
  calls: [] as string[],
  windowNow: 32_000,
  written: 0,
  /** Hung calls, so a clause's teardown can end them the way the transport watchdog would. */
  hung: [] as Array<() => void>,
}));
vi.mock('../../agent/model.js', async () => {
  const { classifyProviderError } = await import('../../agent/provider-error.js');
  return {
    callModel: async (p: { modelId: string; abortSignal?: AbortSignal }) => {
      writers.calls.push(p.modelId);
      const mode = writers.mode[p.modelId] ?? 'ok';
      if (mode === 'hang') {
        return new Promise((_resolve, reject) => {
          const fail = () => reject(new Error('The operation was aborted.'));
          writers.hung.push(fail);
          if (p.abortSignal?.aborted) fail();
          p.abortSignal?.addEventListener('abort', fail, { once: true });
        });
      }
      if (mode === 'empty') return { content: '', toolCalls: [], usage: {} };
      if (mode === '402') {
        throw Object.assign(new Error('OpenAI call failed: 402 Payment Required'), {
          provider: classifyProviderError({ status: 402, message: '402 Payment Required' }),
        });
      }
      writers.written++;
      return { content: `Summary number ${writers.written}: the crew counted the depot and filed the manifests.`, toolCalls: [], usage: {} };
    },
    getContextWindow: () => writers.windowNow,
    getModelOutputCap: () => 4096,
    getProviderCeilingTokens: () => null,
  };
});

import * as compaction from '../compaction.js';
import * as door_ from '../out-of-view-fold.js';
import { __resetSummaryWriterHealthForTests, WRITER_COOLDOWN_MS } from '../summary-writer-health.js';
import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { __resetBrakesForTests, noteLowYield } from '../compaction-brakes.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { withLock } from '../../db/with-lock.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t140-writer-down';
/** The agent's own model — the first summary writer (no Settings choice is configured). */
const OWN = 'model-t140-own';
/** Two cheaper writers on two other providers: the fallbacks, cheapest first. */
const CHEAP = 'model-t140-cheap';
const NEXT = 'model-t140-next';
const db = (): Database.Database => mockDb.current!;

/** Short bounds so a clause measures the bound, not the default (round 3 picks the real one). */
const BOUNDS = { wallClockMs: 600, perWriterMs: 200 };
const hooks = door_ as unknown as { __setOutOfViewFoldBoundsForTests?: (b: typeof BOUNDS | null) => void };

const LARGE = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(620);

let turnNo = 0;
function appendTurn(large: boolean, bodyRepeat = 1): void {
  turnNo++;
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${turnNo}] Which bay is the next crate for? ${'Please check the seal. '.repeat(bodyRepeat)}`, turnNumber: turnNo });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo,
    content: `[a${turnNo}] ${large ? LARGE : `Bay four, beside the ramp; the seal is intact. ${'The weight is on the sheet. '.repeat(bodyRepeat)}`}`,
  });
}

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-own','Own','openai-compatible','api_key','http://localhost:11434/v1')").run();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-cheap','Cheap','openai-compatible','api_key','http://localhost:11435/v1')").run();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-next','Next','openai-compatible','api_key','http://localhost:11436/v1')").run();
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
     VALUES (?, ?, ?, ?, 32000, 4096, '["text","tools"]', 1, ?, ?)`,
  );
  model.run(OWN, 'p-own', 'own', 'Own', 3, 15);
  model.run(CHEAP, 'p-cheap', 'cheap', 'Cheap', 0.1, 0.4);
  model.run(NEXT, 'p-next', 'next', 'Next', 0.2, 0.8);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, OWN);
}

/** Fourteen ordinary turns, then a ~12K row: at 32K the assembly cuts ~29 rows out of view. */
function seedACut(): void {
  for (let t = 1; t <= 14; t++) appendTurn(false);
  appendTurn(true);
}

function door(stop?: AbortSignal): ReturnType<typeof assembleContext> {
  const p = (door_.assembleWithNothingOutOfViewUnsummarised as unknown as (
    a: string, w: number, f: () => ReturnType<typeof assembleContext>, o?: { abortSignal?: AbortSignal },
  ) => ReturnType<typeof assembleContext>)(AGENT, writers.windowNow, () => assembleContext(AGENT, OWN), { abortSignal: stop });
  // A door that outlives its clause (a hang the clause timed out on) must not surface later as an
  // unhandled rejection: this worker loads a module that turns one into a process abort.
  p.catch(() => undefined);
  return p;
}

/** Rows neither in the dialed view nor covered by a summary that is itself in the dialed view. */
function lostRows(view: string): string[] {
  const rows = db().prepare('SELECT id, content FROM messages WHERE agent_id = ?').all(AGENT) as Array<{ id: string; content: string }>;
  const cover = db().prepare('SELECT s.content AS content FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE sm.message_id = ?');
  const lost: string[] = [];
  for (const r of rows) {
    const marker = /\[(u|a)\d+\]/.exec(r.content)?.[0];
    if (!marker || view.includes(marker)) continue;
    const covers = cover.all(r.id) as Array<{ content: string }>;
    if (!covers.some((c) => view.includes(c.content.slice(0, 60)))) lost.push(marker);
  }
  return lost;
}

const placeholders = (): Array<{ id: string; content: string }> =>
  db().prepare("SELECT id, content FROM summaries WHERE agent_id = ? AND content LIKE '%not yet condensed%'").all(AGENT) as Array<{ id: string; content: string }>;
const failingCards = (): number => owner.cards.filter((c) => c.code === 'COMPACTION_FAILING').length;

beforeEach(() => {
  turnNo = 0;
  writers.mode = {};
  writers.calls = [];
  writers.windowNow = 32_000;
  writers.written = 0;
  owner.cards.length = 0;
  __resetBrakesForTests();
  __resetBreakersForTests();
  __resetSummaryWriterHealthForTests();
  hooks.__setOutOfViewFoldBoundsForTests?.(BOUNDS);
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});
afterEach(async () => {
  vi.useRealTimers();
  // The transport watchdog's job, done at once: no hung call outlives its clause.
  for (const fail of writers.hung.splice(0)) fail();
  // Nothing may hold this agent's compaction lock into the next clause.
  await Promise.race([withLock(`compact:${AGENT}`, async () => undefined, { ifBusy: 'wait' }), new Promise((r) => setTimeout(r, 3_000))]);
  hooks.__setOutOfViewFoldBoundsForTests?.(null);
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 3 — a failing writer is passed over for the next one, within the door\'s own bound', () => {
  for (const mode of ['hang', 'empty', '402'] as Mode[]) {
    it(`the agent's own writer ${mode === 'hang' ? 'times out' : mode === 'empty' ? 'answers empty' : 'answers 402'}: the next writer folds the rows, nothing is lost, the turn returns within the bound`, async () => {
      seedACut();
      writers.mode[OWN] = mode;
      const started = Date.now();
      const ctx = await door();
      expect(Date.now() - started, 'the door returned within its own bound').toBeLessThan(BOUNDS.wallClockMs + 400);
      expect(lostRows(JSON.stringify(ctx.messages)), 'a row out of view with nothing representing it').toEqual([]);
      expect(writers.calls[0]).toBe(OWN);
      expect(writers.calls, 'the next eligible writer was tried').toContain(CHEAP);
      expect(placeholders(), 'a real summary, not a placeholder').toEqual([]);
      expect(failingCards()).toBe(0);
      // …and the failed writer is not picked first again while it is cooling down.
      expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'an unreachable writer is not picked again and again').not.toBe(OWN);
    }, 5_000);
  }
});

describe('t140 round 3 — every writer down: the rows are still represented, and the owner is told once', () => {
  it('placeholders cover exactly the cut rows, carry no outside text, and ONE card is raised across three failing turns', async () => {
    writers.mode = { [OWN]: 'hang', [CHEAP]: 'empty', [NEXT]: 'hang' };
    seedACut();
    for (let extra = 0; extra < 3; extra++) {
      const started = Date.now();
      const ctx = await door();
      expect(Date.now() - started).toBeLessThan(BOUNDS.wallClockMs + 400);
      expect(lostRows(JSON.stringify(ctx.messages)), `turn ${extra + 1}: a row out of view with nothing representing it`).toEqual([]);
      appendTurn(false);
    }
    const ph = placeholders();
    expect(ph.length).toBeGreaterThan(0);
    for (const p of ph) {
      expect(p.content).toMatch(/\d+ messages? from .+, .*not yet condensed — the originals are kept and searchable/);
      expect(p.content, 'no message body is copied into the note').not.toMatch(/crate|bay|seal|Manifest|\[(u|a)\d+\]/);
    }
    // Exactly the rows the cut took: every placeholder-covered row is out of the live tail.
    const covered = db().prepare(
      "SELECT COUNT(*) AS n FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE s.agent_id = ? AND s.content LIKE '%not yet condensed%'",
    ).get(AGENT) as { n: number };
    expect(covered.n).toBeGreaterThan(0);
    expect(failingCards(), 'one card per incident, not per turn').toBe(1);
  }, 10_000);
});

describe('t140 round 3 — recovery: a real summary replaces the placeholder, and the brake does not stop it', () => {
  it('after every writer failed, a writer answers: the placeholders are replaced by real summaries, even with the 15-minute brake armed', async () => {
    writers.mode = { [OWN]: 'empty', [CHEAP]: 'empty', [NEXT]: 'empty' };
    seedACut();
    await door();
    expect(placeholders().length).toBeGreaterThan(0);
    noteLowYield(AGENT);   // the brake a pressure pass would arm
    writers.mode = {};
    // The writers come back, and the few minutes they are passed over for have gone by.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + WRITER_COOLDOWN_MS + 1_000));
    const ph = await import('../uncondensed-placeholder.js') as unknown as { replaceUncondensedPlaceholders: (a: string) => Promise<number> };
    const replaced = await ph.replaceUncondensedPlaceholders(AGENT);
    expect(replaced).toBeGreaterThan(0);
    expect(placeholders(), 'no placeholder left once a writer answers').toEqual([]);
    const ctx = await assembleContext(AGENT, OWN);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    vi.useRealTimers();
  }, 10_000);
});

describe('t140 round 3 — Stop during the fold', () => {
  it('Stop ends the fold at once; the rows are represented; the writer is not blamed; no card', async () => {
    writers.mode[OWN] = 'hang';
    seedACut();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    const ctx = await door(stop.signal);
    expect(Date.now() - started, 'Stop ended the fold').toBeLessThan(BOUNDS.perWriterMs);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(failingCards()).toBe(0);
    expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'a stopped call is not a failed writer').toBe(OWN);
  }, 5_000);
});

describe('t140 round 3 — a backlog is capped per turn', () => {
  it('300 unsummarised turns, then the window drops to 32K: at most two summariser calls inside the turn, nothing lost', async () => {
    writers.windowNow = 200_000;
    for (let t = 1; t <= 300; t++) appendTurn(false, 60);   // ~600 rows, many leaf chunks
    writers.windowNow = 32_000;
    const started = Date.now();
    const ctx = await door();
    expect(writers.calls.length, 'no 21 serial calls inside one owner turn').toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(BOUNDS.wallClockMs + 2_000);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(failingCards(), 'a capped backlog is not a failure').toBe(0);
  }, 20_000);
});

describe('t140 round 3 — the brake and a busy lock', () => {
  it('the 15-minute brake does not block the out-of-view fold', async () => {
    seedACut();
    noteLowYield(AGENT);
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls.length, 'the fold ran despite the brake').toBeGreaterThan(0);
    expect(placeholders()).toEqual([]);
  }, 5_000);

  it('a compaction holding the lock briefly is WAITED for, then the rows get a real summary', async () => {
    seedACut();
    let release!: () => void;
    const held = withLock(`compact:${AGENT}`, () => new Promise<void>((r) => { release = r; }), { ifBusy: 'wait' });
    setTimeout(() => release(), 100);
    const ctx = await door();
    await held;
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(placeholders(), 'waited for the lock, did not give up').toEqual([]);
    expect(writers.calls.length).toBeGreaterThan(0);
  }, 5_000);
});

describe('t140 round 3 — condensation never merges a placeholder', () => {
  it('a condensation pass under pressure merges the real summaries and leaves every placeholder where its replacement can find it', async () => {
    writers.mode = { [OWN]: 'empty', [CHEAP]: 'empty', [NEXT]: 'empty' };
    seedACut();
    await door();
    expect(placeholders().length).toBeGreaterThan(0);
    writers.mode = {};
    __resetSummaryWriterHealthForTests();
    const { createLeafSummary } = await import('../dag.js');
    for (let i = 0; i < 3; i++) createLeafSummary(AGENT, `Real summary ${i}: the crew counted the depot.`, 40, [], '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
    compaction.rebuildContextItems(AGENT);
    const { condenseUntilFits } = await import('../condense-until-fits.js');
    await condenseUntilFits({
      agentId: AGENT, modelId: CHEAP, minFanout: 2, targetTokens: 500,
      measure: async () => ({ total: 999_999, summaryTokens: 0 }),   // never fits: condense all it may
      rebuild: () => compaction.rebuildContextItems(AGENT),
    });
    const merged = (sql: string) => (db().prepare(sql).get(AGENT) as { n: number }).n;
    expect(merged("SELECT COUNT(*) AS n FROM summaries s WHERE s.agent_id = ? AND s.content LIKE 'Real summary%' AND s.id IN (SELECT parent_id FROM summary_parents)"),
      'precondition: the pass did condense the real summaries').toBeGreaterThan(0);
    expect(merged("SELECT COUNT(*) AS n FROM summaries s WHERE s.agent_id = ? AND s.content LIKE '[Not yet condensed]%' AND s.id IN (SELECT parent_id FROM summary_parents)"),
      'a placeholder was merged into a parent').toBe(0);
  }, 10_000);
});
