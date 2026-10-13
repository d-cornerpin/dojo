// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 5 — NO FIXED NUMBER DECIDES HOW MUCH GETS CONDENSED, OR CUTS A WRITER THAT IS WORKING.
//
// OWNER RULING 2026-10-13: "I don't want to put hard limits on the dojo. The dojo should be smart
// enough to know when enough is enough." On a user's box a real summary was refused because a
// 60-second drain clock aborted the writer mid-call. This branch carried the same kind of numbers:
// the turn's out-of-view fold (30 s, 15 s per writer, 2 chunks, 3 writers), the background
// placeholder replacement (3 minutes, 10 per run, 3 attempts), and a 5-minute bench for a writer
// that failed once. Each one either cut a writer that was answering, or left rows as placeholder
// notes that a working writer could have summarised. They are replaced by the real signals:
//   · a writer is ended when its OWN provider's patience says it is not answering (the transport),
//     or by Stop — never by a clock of ours while it works;
//   · the turn's own fold may take as long as the owner already lets the dialed model take to start
//     answering (its provider's declared first-chunk patience), and folds AS MUCH AS IS LEAVING
//     inside that — the rest is placeholders, replaced in the background, which has no clock at all;
//   · a writer that failed, or did not answer within the turn's patience, is not waited on again
//     inside a turn until it has answered once; the background keeps trying it, and its first
//     answer clears that at once.
//
// THE DOORS: the real door (`out-of-view-fold.ts`), the real replacement, the real assembler, a
// migrated DB; the model is scripted per writer, on a fake clock.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
  calls: [] as string[],
  windowNow: 32_000,
  written: 0,
  hung: [] as Array<() => void>,
}));
vi.mock('../../agent/model.js', async () => {
  const { classifyProviderError } = await import('../../agent/provider-error.js');
  return {
    callModel: async (p: { modelId: string; abortSignal?: AbortSignal }) => {
      writers.calls.push(p.modelId);
      const mode = writers.mode[p.modelId] ?? 'ok';
      if (mode === 'hang' || mode.startsWith('slow:')) {
        // 'hang': never answers on its own (its transport's patience is the only thing that would end
        // it). 'slow:N': a writer that WORKS and answers after N ms — unless something cuts it first.
        await new Promise<void>((resolve, reject) => {
          const t = mode === 'hang' ? null : setTimeout(resolve, Number(mode.slice(5)));
          const fail = () => { if (t) clearTimeout(t); reject(new Error('The operation was aborted.')); };
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

import * as door_ from '../out-of-view-fold.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders, replacePlaceholdersInBackground } from '../uncondensed-placeholder.js';
import { backgroundDrains } from '../../agent/shared-state.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t140-no-limits';
const OWN = 'model-t140-own';
const CHEAP = 'model-t140-cheap';
const NEXT = 'model-t140-next';
const FOURTH = 'model-t140-fourth';
/** The patience the agent's own provider declares: how long the owner lets its model take to start
 *  answering (a slow local box declares minutes). Far above the fake clock's drift while the
 *  assembly reads its templates from disk for real. */
const OWN_PATIENCE_MS = 300_000;
const db = (): Database.Database => mockDb.current!;

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
function seedACut(): void {
  for (let t = 1; t <= 14; t++) appendTurn(false);
  appendTurn(true);
}

function seed(): void {
  const prov = db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url, first_chunk_timeout_ms) VALUES (?, ?, 'openai-compatible', 'api_key', ?, ?)");
  prov.run('p-own', 'Own', 'http://localhost:11434/v1', OWN_PATIENCE_MS);
  prov.run('p-cheap', 'Cheap', 'http://localhost:11435/v1', null);
  prov.run('p-next', 'Next', 'http://localhost:11436/v1', null);
  prov.run('p-fourth', 'Fourth', 'http://localhost:11437/v1', null);
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
     VALUES (?, ?, ?, ?, 32000, 4096, '["text","tools"]', 1, ?, ?)`,
  );
  model.run(OWN, 'p-own', 'own', 'Own', 3, 15);
  model.run(CHEAP, 'p-cheap', 'cheap', 'Cheap', 0.1, 0.4);
  model.run(NEXT, 'p-next', 'next', 'Next', 0.2, 0.8);
  model.run(FOURTH, 'p-fourth', 'fourth', 'Fourth', 0.3, 1.2);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, OWN);
}

/** Let real I/O (a module the path loads for the first time) finish before the fake clock moves. */
const realTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Drive a promise to completion on the fake clock, a second at a time. */
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

function door(): Promise<Awaited<ReturnType<typeof assembleContext>>> {
  return onTheClock(door_.assembleWithNothingOutOfViewUnsummarised(AGENT, writers.windowNow, () => assembleContext(AGENT, OWN)));
}

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
const placeholders = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { n: number }).n;
const realSummaries = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind != 'uncondensed'").get(AGENT) as { n: number }).n;
const failingCards = (): number => owner.cards.filter((c) => c.code === 'COMPACTION_FAILING').length;

beforeAll(async () => {
  // The fold path imports these lazily; load them before any clause starts a fake clock, so the
  // clock does not run on while a module is read from disk.
  await import('../../agent/model.js');
  await import('../../tools/tool-docs.js');
  await import('../../agent/provider-error.js');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  turnNo = 0;
  writers.mode = {};
  writers.calls = [];
  writers.windowNow = 32_000;
  writers.written = 0;
  owner.cards.length = 0;
  backgroundDrains.clear();
  __resetBrakesForTests();
  __resetBreakersForTests();
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});
afterEach(() => {
  for (const fail of writers.hung.splice(0)) fail();
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 5 — the turn\'s own fold: no clock of ours cuts a writer that is answering', () => {
  it('every writer needs 20 s — longer than the old 15 s slice, well inside the agent\'s own declared patience: the summary is written in the turn, no placeholder', async () => {
    seedACut();
    writers.mode = { [OWN]: 'slow:20000', [CHEAP]: 'slow:20000', [NEXT]: 'slow:20000', [FOURTH]: 'slow:20000' };
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(placeholders(), 'a real summary, not a placeholder note').toBe(0);
    expect(realSummaries()).toBeGreaterThan(0);
    expect(writers.calls[0], 'the agent\'s own writer wrote it').toBe(OWN);
    expect(failingCards()).toBe(0);
  });

  it('a cut of many leaf chunks is folded in full inside the turn — as much as is leaving, not two chunks', async () => {
    writers.windowNow = 200_000;
    for (let t = 1; t <= 300; t++) appendTurn(false, 60);   // ~600 rows, many leaf chunks
    writers.windowNow = 32_000;
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls.length, 'more than the old two summariser calls').toBeGreaterThan(2);
    expect(placeholders(), 'every leaving row has a real summary').toBe(0);
  });

  it('the first three writers answer badly (empty, 402, empty): the fourth eligible writer writes it inside the turn', async () => {
    seedACut();
    writers.mode = { [OWN]: 'empty', [CHEAP]: '402', [NEXT]: 'empty' };
    // No Settings writer and an own model: own, then (as before t140) the cheapest text models.
    const ctx = await door();
    expect(lostRows(JSON.stringify(ctx.messages))).toEqual([]);
    expect(writers.calls).toContain(FOURTH);
    expect(placeholders(), 'the fourth writer answered; nothing was left to a note').toBe(0);
  });

  it('a writer that does not answer within the turn\'s patience is not waited on again in the next turn; the background keeps trying it, and its first answer brings it back', async () => {
    writers.mode = { [OWN]: 'hang' };
    seedACut();
    await door();
    expect(failingCards(), 'not answering within the turn\'s patience is not a failure card').toBe(0);
    // The next turn cuts again: the turn does not wait on the writer that did not answer.
    writers.calls.length = 0;
    appendTurn(true);
    const ctx2 = await door();
    expect(lostRows(JSON.stringify(ctx2.messages))).toEqual([]);
    expect(writers.calls[0], 'the next turn goes straight to a writer that answers').not.toBe(OWN);
    // The writer comes back: the background tries it first (no waiting period) and it answers.
    writers.mode = {};
    writers.calls.length = 0;
    appendTurn(false);
    writeUncondensedPlaceholders(AGENT, (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ? AND seq < (SELECT MAX(seq) - 40 FROM messages WHERE agent_id = ?)').get(AGENT, AGENT) as { s: number }).s);
    await onTheClock(replaceUncondensedPlaceholders(AGENT));
    expect(writers.calls[0], 'the background tried the agent\'s own writer first').toBe(OWN);
    writers.calls.length = 0;
    appendTurn(true);
    await door();
    expect(writers.calls[0], 'once it answered, the turn uses it again').toBe(OWN);
  });
});

describe('t140 round 5 — the background replacement has no clock and no per-run cap', () => {
  it('a writer that needs 200 s — longer than the old three-minute clock — replaces its placeholder', async () => {
    seedACut();
    const through = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s - 6;
    expect(writeUncondensedPlaceholders(AGENT, through), 'precondition: rows under placeholder notes').toBeGreaterThan(0);
    writers.mode = { [OWN]: 'slow:200000' };
    expect(replacePlaceholdersInBackground(AGENT)).toBe(true);
    for (let t = 0; t < 400 && backgroundDrains.has(AGENT); t++) await vi.advanceTimersByTimeAsync(1_000);
    expect(placeholders(), 'the working writer was not cut; its summary replaced the note').toBe(0);
  });

  it('more than ten placeholder notes are all replaced in one background run', async () => {
    for (let t = 1; t <= 40; t++) appendTurn(false, 30);
    const seqs = (db().prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq').all(AGENT) as Array<{ seq: number }>).map((r) => r.seq);
    // One note per pair of rows: twelve notes.
    for (let i = 1; i <= 12; i++) writeUncondensedPlaceholders(AGENT, seqs[i * 2 - 1]);
    expect(placeholders(), 'precondition: twelve notes').toBe(12);
    expect(replacePlaceholdersInBackground(AGENT)).toBe(true);
    for (let t = 0; t < 60 && backgroundDrains.has(AGENT); t++) await vi.advanceTimersByTimeAsync(1_000);
    expect(placeholders(), 'every note replaced in the one run').toBe(0);
  });
});

describe('t140 round 5 — a writer that failed is used again the moment it answers, not after a waiting period', () => {
  it('the owner\'s one Settings writer failed; it comes back a second later: the background replaces the notes at once', async () => {
    // A Settings writer narrows the list to it and the agent's own provider (R-V333-12): here, one writer.
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', ?)").run(OWN);
    writers.mode = { [OWN]: 'empty' };
    seedACut();
    await door();
    expect(placeholders(), 'precondition: placeholder notes').toBeGreaterThan(0);
    writers.mode = {};
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replacePlaceholdersInBackground(AGENT), 'the background starts with the writers it has').toBe(true);
    for (let t = 0; t < 60 && backgroundDrains.has(AGENT); t++) await vi.advanceTimersByTimeAsync(1_000);
    expect(placeholders(), 'no note left: the writers answered and were used').toBe(0);
  });
});
