// t152 (walks round 2, step 21) — A WRITER'S OWN "TOO LONG" ANSWER IS "NOT THE WRITER FOR THIS INPUT".
//
// Live: a 36,592-character row was handed to a 16K writer. The platform's size guess (4 characters a
// token) said it fitted; the provider counted 19.2K tokens against about 9.8K of room. The guess runs
// low for some text, and no guess is exact. The REAL signal is the provider's own refusal: a writer that
// answers "context length exceeded" was simply not the writer for this input (`tooBig`), the same as one
// the size guard turned away. It is not recorded against the writer (it is healthy), the span is halved
// when it can be, and the next eligible writer that holds the input takes a row that cannot.
// Second, the existing measured-divisor estimator (`estimateRequestTokens`, which the pre-dial fit gate
// already spends) sizes the guard too, so a box that has measured its provider's real ratio stops
// dialling it up front.
//
// THE DOORS: the real `checkAndCompact` and the condensation path, on the real migration chain. The
// provider is scripted: a writer refuses, with a real provider's words, any call over what it truly holds.
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
  /** Characters a writer REALLY holds in one call (its provider counts denser than the platform's guess). */
  realChars: {} as Record<string, number>,
}));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; systemPrompt: string; messages: Array<{ content: string }> }) => {
    writers.calls.push({ modelId: p.modelId, systemPrompt: p.systemPrompt, content: p.messages[0].content });
    const mode = writers.mode[p.modelId] ?? 'ok';
    if (mode === 'unreachable') throw new Error('Ollama call failed: fetch failed');
    const cap = writers.realChars[p.modelId];
    if (cap !== undefined && p.messages[0].content.length > cap) {
      throw new Error(`OpenAI call failed: 400 This endpoint's maximum context length is 16000 tokens. However, you requested about ${Math.ceil(p.messages[0].content.length / 1.9)} tokens. Please reduce the length of the messages or completion.`);
    }
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
import { __resetSummaryWriterHealthForTests, writerPassedOver, refuseWhatTheWriterCannotHold } from '../summary-writer-health.js';
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
  writers.mode = {}; writers.realChars = {}; writers.calls = []; writers.written = 0; owner.cards.length = 0;
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


const covered = (id: string): boolean =>
  !!db().prepare("SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE sm.message_id = ? AND s.kind != 'uncondensed' LIMIT 1").get(id);

function aBigRowAmongSmallOnes(repeat: number): string {
  for (let t = 1; t <= 30; t++) appendTurn(0.01);
  turnNo++;
  const id = `big-${repeat}`;
  insertMessage({ id, agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo, content: `[big] ${ROW.repeat(repeat)}` });
  for (let t = 1; t <= 30; t++) appendTurn(0.01);
  return id;
}

describe('t152 step 21 — the writer\'s own "too long" answer is not a writer failure', () => {
  it('a single row the guess says fits but the writer refuses goes to the next writer that holds it; the refusing writer is NOT passed over', async () => {
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(TINY, DEAD);   // SMALL (16K, cheaper) first, ROOMY second
    writers.realChars[SMALL] = 20_000;                                                      // truly holds ~10K tokens of this text
    const id = aBigRowAmongSmallOnes(3);                                                    // ~7K guessed tokens: the guard lets it through
    expect(estimateTokens(`[big] ${ROW.repeat(3)}`), 'the guard sees room (premise)').toBeLessThan(9_000);
    const result = await checkAndCompact(AGENT, 'auto', 8_000, { force: true });
    expect(covered(id), 'the row was summarised by a real summary').toBe(true);
    expect(result.leafCreated).toBeGreaterThan(0);
    const bigCalls = writers.calls.filter((c) => c.content.includes('[big]'));
    // The span around the row is halved down to the row itself (each of those calls refused by the small
    // writer), then the roomy writer takes the row, once.
    expect(bigCalls.filter((c) => c.modelId === ROOMY), 'taken by the roomy writer once').toHaveLength(1);
    expect(bigCalls[bigCalls.length - 1].modelId, 'and last').toBe(ROOMY);
    expect(bigCalls.slice(0, -1).every((c) => c.modelId === SMALL && c.content.length > 20_000), 'before it, only refused over-long calls to the small writer').toBe(true);
    expect(writerPassedOver(SMALL, AGENT), 'a writer that said "too long" is healthy, not passed over').toBe(false);
    expect(compactionIsBraked(AGENT, true)).toBe(false);
  });

  it('a span of several rows the writer refuses is halved and the SAME writer takes the halves', async () => {
    db().prepare('UPDATE models SET is_enabled = 0 WHERE id IN (?, ?)').run(TINY, DEAD);
    writers.realChars[SMALL] = 12_000;
    seedALongCut();
    await checkAndCompact(AGENT, 'auto', 16_000, { force: true });
    const refused = writers.calls.filter((c) => c.modelId === SMALL && c.content.length > 12_000);
    expect(refused.length, 'premise: the guess let an over-long span through at least once').toBeGreaterThan(0);
    expect(writers.calls.some((c) => c.modelId === SMALL && c.content.length <= 12_000), 'the halves went to the same writer').toBe(true);
    expect(writerPassedOver(SMALL, AGENT), 'and it was never passed over for being asked too much').toBe(false);
  });
});

describe('t152 step 21 — the guard spends the measured divisor the fit gate already spends', () => {
  const content = '[big] ' + ROW.repeat(3);   // 4 chars a token by the constant: fits SMALL
  it('unmeasured: the guard is exactly as before (it holds)', () => {
    expect(refuseWhatTheWriterCannotHold(SMALL, 'Summarise.', content, AGENT)).toBeNull();
  });
  it('a provider measured at about 2 characters a token: the same text is more than the writer holds, and it is not dialled', () => {
    db().prepare('UPDATE providers SET measured_chars_per_token_prose = 1.9 WHERE id = ?').run('p-16k');
    expect(refuseWhatTheWriterCannotHold(SMALL, 'Summarise.', content, AGENT)).toEqual({ ok: false, reason: 'the summary writer cannot hold this input', tooBig: true });
  });
  it('a measured divisor above the constant never loosens the guard (the estimate does not shrink)', () => {
    db().prepare('UPDATE providers SET measured_chars_per_token_prose = 9 WHERE id = ?').run('p-16k');
    const big = '[big] ' + ROW.repeat(6);
    db().prepare('UPDATE providers SET measured_chars_per_token_prose = NULL WHERE id = ?').run('p-16k');
    const unmeasured = refuseWhatTheWriterCannotHold(SMALL, 'Summarise.', big, AGENT);
    db().prepare('UPDATE providers SET measured_chars_per_token_prose = 9 WHERE id = ?').run('p-16k');
    expect(refuseWhatTheWriterCannotHold(SMALL, 'Summarise.', big, AGENT)).toEqual(unmeasured);
  });
});
