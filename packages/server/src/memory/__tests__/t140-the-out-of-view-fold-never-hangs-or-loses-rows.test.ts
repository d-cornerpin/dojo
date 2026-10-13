// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 — THE OUT-OF-VIEW FOLD WHEN THE SUMMARY WRITER FAILS (re-review 2 §2, R-V333-10).
//
// The engine's assembly door (`out-of-view-fold.ts`'s `assembleWithNothingOutOfViewUnsummarised`)
// summarises the rows its assembly took out of the view before the turn is dialed. Round 2 made
// that exact; this file is what happens when the model writing the summary does not answer:
//
//   · the door is bounded by the turn's patience (round 5: the dialed model's own declared
//     first-chunk patience — no clock or chunk cap of the door's own) and honours Stop;
//   · a writer that times out (its own transport's patience ran out), answers empty, or answers
//     402 is passed over for the next eligible one, and no turn waits on it again until it has
//     answered (the background keeps trying it);
//   · if every writer fails, each out-of-view row is still REPRESENTED: a deterministic,
//     labelled placeholder note (no model, no outside text verbatim) covers exactly those rows,
//     and a real summary replaces it once a writer answers;
//   · the owner gets ONE card per incident, not per turn, and the 15-minute brake never blocks
//     this fold or the replacement;
//   · round 5: a backlog is folded as far as the turn's patience goes — the rest is placeholders,
//     replaced in the background.
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
  /** Round 5: a 'hang' writer is ended the way its transport ends it — after its own provider's
   *  patience — not by any clock of the fold's. Short here so the clauses run quickly. */
  transportMs: 300,
}));
vi.mock('../../agent/model.js', async () => {
  const { classifyProviderError } = await import('../../agent/provider-error.js');
  return {
    callModel: async (p: { modelId: string; abortSignal?: AbortSignal }) => {
      writers.calls.push(p.modelId);
      const mode = writers.mode[p.modelId] ?? 'ok';
      if (mode === 'hang') {
        return new Promise((_resolve, reject) => {
          const fail = () => { clearTimeout(watchdog); reject(new Error('The operation was aborted.')); };
          // The transport's watchdog: no data within the provider's patience ends the call.
          const watchdog = setTimeout(() => reject(new Error('model first-chunk timeout: no data from provider for too long')), writers.transportMs);
          writers.hung.push(fail);
          if (p.abortSignal?.aborted) fail();
          p.abortSignal?.addEventListener('abort', fail, { once: true });
        });
      }
      if (mode.startsWith('slow:')) {
        // A writer that WORKS, but takes this long: answers unless it is cut first.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, Number(mode.slice(5)));
          const fail = () => { clearTimeout(t); reject(new Error('The operation was aborted.')); };
          writers.hung.push(fail);
          if (p.abortSignal?.aborted) fail();
          p.abortSignal?.addEventListener('abort', fail, { once: true });
        });
        writers.written++;
        return { content: `Summary number ${writers.written}: the crew counted the depot and filed the manifests.`, toolCalls: [], usage: {} };
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
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
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

/** Round 5: the door has no bounds of its own to shorten; a clause that needs the turn's patience to
 *  run out drives it on a fake clock (`onTheClock`). */
const realTurn = (): Promise<void> => new Promise((r) => setImmediate(r));
async function onTheClock<T>(p: Promise<T>, maxMs = 900_000): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let t = 0; t < maxMs && !done; t += 1_000) {
    for (let i = 0; i < 20; i++) await realTurn();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  if (!done) throw new Error('never settled on the clock');
  if (error) throw error;
  return value as T;
}

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
  db().prepare("SELECT id, content FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").all(AGENT) as Array<{ id: string; content: string }>;
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
  writers.transportMs = 300;
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
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 3 — a failing writer is passed over for the next one, within the turn\'s patience', () => {
  for (const mode of ['hang', 'empty', '402'] as Mode[]) {
    it(`the agent's own writer ${mode === 'hang' ? 'times out' : mode === 'empty' ? 'answers empty' : 'answers 402'}: the next writer folds the rows, nothing is lost, the turn returns once the failed writer is over`, async () => {
      seedACut();
      writers.mode[OWN] = mode;
      const started = Date.now();
      const ctx = await door();
      expect(Date.now() - started, 'the door returned after one transport patience at most').toBeLessThan(writers.transportMs + 2_000);
      expect(lostRows(JSON.stringify(ctx.messages)), 'a row out of view with nothing representing it').toEqual([]);
      expect(writers.calls[0]).toBe(OWN);
      expect(writers.calls, 'the next eligible writer was tried').toContain(CHEAP);
      expect(placeholders(), 'a real summary, not a placeholder').toEqual([]);
      expect(failingCards()).toBe(0);
      // …and a writer that FAILED (its own transport gave up, it answered empty, or 402) is not waited
      // on by a turn again until it answers — round 5: no clock decides that — while the background,
      // where nobody waits, keeps trying it in the owner's order.
      expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'a turn does not wait on it again').not.toBe(OWN);
      expect(compaction.resolveSummaryWriterModel(AGENT, OWN, { background: true }), 'the background keeps trying it').toBe(OWN);
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
      expect(Date.now() - started, 'two transport patiences at most (the two writers that hang)').toBeLessThan(2 * writers.transportMs + 2_000);
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
      "SELECT COUNT(*) AS n FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE s.agent_id = ? AND s.kind = 'uncondensed'",
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
    // The writers come back. Round 5: no waiting period — the background tries them at once.
    const ph = await import('../uncondensed-placeholder.js') as unknown as { replaceUncondensedPlaceholders: (a: string) => Promise<number> };
    const replaced = await ph.replaceUncondensedPlaceholders(AGENT);
    expect(replaced).toBeGreaterThan(0);
    expect(placeholders(), 'no placeholder left once a writer answers').toEqual([]);
    const ctx = await assembleContext(AGENT, OWN);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
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
    expect(Date.now() - started, 'Stop ended the fold before the writer\'s own transport would have').toBeLessThan(writers.transportMs);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(failingCards()).toBe(0);
    expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'a stopped call is not a failed writer').toBe(OWN);
  }, 5_000);
});

describe('t140 round 3 (re-aimed round 5) — a backlog is folded as far as the turn\'s patience goes', () => {
  it('300 unsummarised turns, then the window drops to 32K: with writers answering, every leaving chunk is summarised in the turn, nothing lost', async () => {
    writers.windowNow = 200_000;
    for (let t = 1; t <= 300; t++) appendTurn(false, 60);   // ~600 rows, many leaf chunks
    writers.windowNow = 32_000;
    const ctx = await door();
    expect(writers.calls.length, 'as much as is leaving — round 3 capped this at two').toBeGreaterThan(2);
    expect(placeholders(), 'nothing left to a note while the writer answers').toEqual([]);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(failingCards()).toBe(0);
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
    expect(merged("SELECT COUNT(*) AS n FROM summaries s WHERE s.agent_id = ? AND s.kind = 'uncondensed' AND s.id IN (SELECT parent_id FROM summary_parents)"),
      'a placeholder was merged into a parent').toBe(0);
  }, 10_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ROUND 4 (re-review 3: F1–F4, card noise, ruling R-V333-12).
// ════════════════════════════════════════════════════════════════════════════════════════
const coverCounts = (): number[] => (db().prepare(
  `SELECT COUNT(*) AS n FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id
    WHERE s.agent_id = ? GROUP BY sm.message_id HAVING n > 1`,
).all(AGENT) as Array<{ n: number }>).map((r) => r.n);
const placeholderCoveredSeqs = (): number[] => (db().prepare(
  `SELECT m.seq AS seq FROM messages m JOIN summary_messages sm ON sm.message_id = m.id JOIN summaries s ON s.id = sm.summary_id
    WHERE s.agent_id = ? AND s.kind = 'uncondensed'`,
).all(AGENT) as Array<{ seq: number }>).map((r) => r.seq);
const coolAll = async (...ids: string[]) => {
  const h = await import('../summary-writer-health.js') as unknown as { noteSummaryWriterOutcome: (m: string, ok: boolean) => void };
  for (const id of ids) h.noteSummaryWriterOutcome(id, false);
};

describe('t140 round 4 — F1: never two notes for one row', () => {
  it('a background fold that lands on rows the door covered with placeholders while it held the lock: every row ends with exactly one covering summary', async () => {
    // Enough history that rows ABOVE the newest-row floor are cut too: those the routine fold may take.
    for (let t = 1; t <= 40; t++) appendTurn(false);
    appendTurn(true);
    const throughSeq = (await assembleContext(AGENT, OWN)).outOfViewThroughSeq ?? 0;
    expect(throughSeq).toBeGreaterThan(0);
    // A fold of the same rows that holds the lock longer than the turn's patience (round 5: the
    // standing 90 s here), and that the door cannot set aside (not launched by the gate: a manual
    // or recovery compaction's shape).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    writers.mode = { [OWN]: 'slow:120000', [CHEAP]: 'slow:120000', [NEXT]: 'slow:120000' };
    const pressure = compaction.checkAndCompact(AGENT, OWN, 32_000, { leaving: { cause: 'full', throughSeq, rowsLeaving: 40 } });
    await realTurn();
    const ctx = await onTheClock(door());
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    await onTheClock(pressure);
    vi.useRealTimers();
    expect(coverCounts(), 'a row linked to two summaries').toEqual([]);
    writers.mode = {};
    const after = await door();   // the next turn's assembly, through the engine's door
    expect(lostRows(JSON.stringify(after.messages)), 'after the race').toEqual([]);
  }, 10_000);
});

describe('t140 round 4 — F2: placeholder rows reach the vault archive', () => {
  it('an outage of several turns with every writer cooling: every placeholder-covered row is archived', async () => {
    seedACut();
    await coolAll(OWN, CHEAP, NEXT);
    for (let t = 0; t < 4; t++) { await door(); appendTurn(t % 2 === 0); }
    await door();
    const covered = placeholderCoveredSeqs();
    expect(covered.length).toBeGreaterThan(0);
    const { getArchiveHighWaterMark } = await import('../../vault/archive.js');
    const hw = getArchiveHighWaterMark(AGENT) ?? 0;
    expect(covered.filter((s) => s > hw), 'placeholder rows never archived').toEqual([]);
  }, 10_000);
});

describe('t140 round 4 — F3: the six behaviours the round-3 witnesses missed', () => {
  it('R2 (re-aimed round 5): a first writer its own transport gives up on leaves the turn to a fallback that needs 100 ms', async () => {
    writers.mode = { [OWN]: 'hang', [CHEAP]: 'slow:100' };
    seedACut();
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(placeholders(), 'the fallback folded the rows').toEqual([]);
  }, 5_000);

  it('R4 breaker open: a writer whose provider breaker is open is skipped, never dialed', async () => {
    const { recordPermanentFailure } = await import('../../providers/billing-breaker.js');
    recordPermanentFailure('p-own', 'no_balance', '402', AGENT);
    recordPermanentFailure('p-own', 'no_balance', '402', AGENT);
    seedACut();
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls, 'the broken provider was dialed').not.toContain(OWN);
    expect(placeholders(), 'the next writer folded the rows').toEqual([]);
    // And every other path that asks for a writer (the pressure fold, the replacement) skips it too.
    expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'a writer whose provider breaker is open is picked').not.toBe(OWN);
  }, 5_000);

  it('R6 no writer left: placeholders, and the owner is told', async () => {
    await coolAll(OWN, CHEAP, NEXT);
    seedACut();
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls, 'nothing dialed').toEqual([]);
    expect(placeholders().length).toBeGreaterThan(0);
    expect(failingCards()).toBe(1);
  }, 5_000);

  it('R7 Stop after a writer already failed: no card', async () => {
    writers.mode = { [OWN]: 'empty', [CHEAP]: 'hang', [NEXT]: 'hang' };
    seedACut();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 80);
    const ctx = await door(stop.signal);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls[0]).toBe(OWN);
    expect(failingCards(), 'a Stop is not a failure, even after one').toBe(0);
  }, 5_000);

  it('R8 (re-aimed round 5): a lock held past the turn\'s patience by a holder that will not yield does not hold the door', async () => {
    seedACut();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let release!: () => void;
    const held = withLock(`compact:${AGENT}`, () => new Promise<void>((r) => { release = r; }), { ifBusy: 'wait' });
    const started = Date.now();
    const ctx = await onTheClock(door());
    // The turn's patience: the agent's provider declares none, so the transport's standing 90 s.
    expect(Date.now() - started, 'the door returned at the turn\'s patience, not when the holder let go').toBeLessThan(90_000 + 30_000);
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    release();
    await held;
  }, 20_000);

  it('R9 a placeholder whose rows a real summary already covers is dropped, not re-summarised', async () => {
    writers.mode = { [OWN]: 'empty', [CHEAP]: 'empty', [NEXT]: 'empty' };
    seedACut();
    await door();
    const ph = placeholders();
    expect(ph.length).toBeGreaterThan(0);
    // A real leaf over the same rows (the shape a race left behind before round 4).
    const rows = db().prepare('SELECT message_id FROM summary_messages WHERE summary_id = ?').all(ph[0].id) as Array<{ message_id: string }>;
    db().prepare("INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, created_at) VALUES ('sum-real', ?, 0, 'leaf', 'A real summary of those rows.', 8, '2026-01-01', '2026-01-01', ?, datetime('now'))").run(AGENT, rows.length);
    const link = db().prepare("INSERT INTO summary_messages (summary_id, message_id) VALUES ('sum-real', ?)");
    for (const r of rows) link.run(r.message_id);
    writers.mode = {};
    __resetSummaryWriterHealthForTests();
    writers.calls = [];
    const { replaceUncondensedPlaceholders } = await import('../uncondensed-placeholder.js');
    await replaceUncondensedPlaceholders(AGENT);
    expect(placeholders().find((p) => p.id === ph[0].id), 'the covered placeholder is gone').toBeUndefined();
    expect(writers.calls.length, 'one call per OTHER placeholder, none for the covered one').toBe(ph.length - 1);
  }, 6_000);
});

describe('t140 round 4 (re-aimed round 5) — F4: running past the turn\'s patience is not a writer failure', () => {
  it('a writer slower than the turn\'s patience raises no card; the turn does not wait on it again; the background, with no clock, uses it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    writers.mode = { [OWN]: 'slow:120000', [CHEAP]: 'slow:120000', [NEXT]: 'slow:120000' };
    seedACut();
    const ctx = await onTheClock(door());
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(placeholders().length, 'nobody answered inside the turn\'s patience').toBeGreaterThan(0);
    expect(failingCards(), 'slow is not failing').toBe(0);
    expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'a turn does not wait on it again until it answers').not.toBe(OWN);
    const { replaceUncondensedPlaceholders } = await import('../uncondensed-placeholder.js');
    writers.calls = [];
    await onTheClock(replaceUncondensedPlaceholders(AGENT));
    expect(placeholders()).toEqual([]);
    expect(writers.calls[0], 'the background used the agent\'s own writer, and nothing cut it').toBe(OWN);
    expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'it answered: turns use it again').toBe(OWN);
  }, 20_000);
});

describe('t140 round 4 — card noise: one card per incident', () => {
  it('a flaky writer that fails, recovers and fails again within the hour raises ONE card', async () => {
    writers.mode = { [OWN]: 'empty', [CHEAP]: 'empty', [NEXT]: 'empty' };
    seedACut();
    await door();
    expect(failingCards()).toBe(1);
    writers.mode = {};
    __resetSummaryWriterHealthForTests();
    const { replaceUncondensedPlaceholders } = await import('../uncondensed-placeholder.js');
    await replaceUncondensedPlaceholders(AGENT);   // a real recovery: no placeholder left
    expect(placeholders()).toEqual([]);
    writers.mode = { [OWN]: 'empty', [CHEAP]: 'empty', [NEXT]: 'empty' };
    for (let t = 0; t < 14; t++) appendTurn(false);
    appendTurn(true);
    await door();
    expect(placeholders().length).toBeGreaterThan(0);
    expect(failingCards(), 'a second card for the same flaky writer inside the hour').toBe(1);
  }, 10_000);
});

describe('t140 round 4 — R-V333-12: the fallback never widens who sees the conversation', () => {
  it('with a Settings writer: Settings writer, then the agent\'s own model — never a third provider', async () => {
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', ?)").run(NEXT);
    writers.mode = { [NEXT]: 'empty', [OWN]: 'empty', [CHEAP]: 'ok' };
    seedACut();
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls.slice(0, 2)).toEqual([NEXT, OWN]);
    expect(writers.calls, 'the cheapest model on a provider nobody chose was sent the conversation').not.toContain(CHEAP);
    expect(placeholders().length, 'placeholders, not a wider audience').toBeGreaterThan(0);
  }, 5_000);

  it('with NO Settings writer: the agent\'s own model, then (as before) the cheapest eligible text model', async () => {
    writers.mode = { [OWN]: 'empty' };
    seedACut();
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls.slice(0, 2)).toEqual([OWN, CHEAP]);
    expect(placeholders()).toEqual([]);
  }, 5_000);
});

describe('t140 round 4 — F1: the turn sets a routine background fold aside to get the lock in time', () => {
  it('a slow background fold holding the lock is preempted: the door folds UNDER the lock, and the preempted writer is not blamed', async () => {
    for (let t = 1; t <= 40; t++) appendTurn(false);
    appendTurn(true);
    const throughSeq = (await assembleContext(AGENT, OWN)).outOfViewThroughSeq ?? 0;
    writers.mode = { [OWN]: 'slow:1500', [CHEAP]: 'ok' };
    const { registerBackgroundCompaction, releaseBackgroundCompaction } = await import('../uncondensed-placeholder.js');
    const ctl = new AbortController();
    registerBackgroundCompaction(AGENT, ctl);   // what the gate's pressure-fold launcher does
    const background = compaction.checkAndCompact(AGENT, OWN, 32_000, { leaving: { cause: 'full', throughSeq, rowsLeaving: 40 }, abortSignal: ctl.signal })
      .finally(() => releaseBackgroundCompaction(AGENT, ctl));
    await new Promise((r) => setTimeout(r, 20));
    // The background call is in flight on the slow writer; the door's own calls answer at once, so
    // the time below is the time to get the lock (round 5: the door no longer cuts a working writer).
    writers.mode = {};
    const started = Date.now();
    const ctx = await door();
    expect(Date.now() - started, 'the door did not wait out the background writer behind the lock').toBeLessThan(1_500);
    await background;
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(placeholders(), 'the door got the lock in time and wrote real summaries').toEqual([]);
    expect(coverCounts()).toEqual([]);
    expect(compaction.resolveSummaryWriterModel(AGENT, OWN), 'a preempted call is not the writer\'s failure').toBe(OWN);
  }, 8_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ROUND 4, part 2 — A NOTE IS KNOWN BY A COLUMN, NEVER BY ITS TEXT. A model summary (or an imported
// or hand-written memory) can carry any text, including the note's own heading; identity that is
// content can be forged by content. Only `writeUncondensedPlaceholders` marks a row as a note.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('t140 round 4 — a note is identified structurally, never by its heading', () => {
  it('a REAL model summary that happens to start with the heading survives the replacement, untouched and unsuperseded', async () => {
    seedACut();
    const rows = (db().prepare('SELECT id FROM messages WHERE agent_id = ? ORDER BY seq LIMIT 6').all(AGENT) as Array<{ id: string }>).map((r) => r.id);
    const { createLeafSummary } = await import('../dag.js');
    const forged = '[Not yet condensed] is how the crew labelled the unsorted crates; the rest were filed by bay.';
    const real = createLeafSummary(AGENT, forged, 30, rows, '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z');
    const { replaceUncondensedPlaceholders } = await import('../uncondensed-placeholder.js');
    writers.calls = [];
    await replaceUncondensedPlaceholders(AGENT);
    const after = db().prepare('SELECT content FROM summaries WHERE id = ?').get(real.id) as { content: string } | undefined;
    expect(after?.content, 'a real summary was rewritten or deleted because of its words').toBe(forged);
    expect(writers.calls, 'nothing to replace').toEqual([]);
    expect((db().prepare('SELECT COUNT(*) AS n FROM summary_messages WHERE summary_id = ?').get(real.id) as { n: number }).n).toBe(rows.length);
  }, 5_000);

  it('census: no shipped reader identifies a note by its heading text', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const SRC = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full); continue; }
        if (!/\.ts$/.test(e.name)) continue;
        const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        // A READER of the heading: the prefix predicate, a prefix SQL test, or the constant used anywhere
        // but the one place that WRITES the note's text.
        const uses = (code.match(/UNCONDENSED_PLACEHOLDER_HEAD/g) ?? []).length;
        const writes = /export const UNCONDENSED_PLACEHOLDER_HEAD = /.test(code) ? 1 : 0;
        const inText = (code.match(/`\$\{UNCONDENSED_PLACEHOLDER_HEAD\} \$\{n\} message/g) ?? []).length;
        if (uses - writes - inText > 0 || /isUncondensedPlaceholder\(|Not yet condensed%|reservedHeadRefusal/.test(code)) offenders.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
