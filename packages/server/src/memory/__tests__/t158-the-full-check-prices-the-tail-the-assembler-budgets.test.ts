// ════════════════════════════════════════════════════════════════════════════════════════
// t158 C — THE "VIEW IS FULL" CHECK PRICES THE TAIL THE ASSEMBLER WILL ACTUALLY BUDGET.
//
// Ritual run 6 (S4 L3): one file read was stored at 60,868 tokens. The check priced it at the
// stored cost, said the view was full, and 64 old rows were folded; the real prompt was 53,054
// tokens of a 128,000 window and nothing was leaving the view. The assembler caps every tool
// result at 15,000 tokens BEFORE `budgetFreshTail` spends (`capLargeToolResultStrings`); the dry
// run now applies the same cap, so the trigger and the trim read the same rows. A tail that is
// really full is still full. t194: `liveViewIsFull` is deleted — the gauge (`est.view`) IS the
// assembler's fit, so "full" is its ask over its room; the clauses below read it there.
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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));

const windowNow = { value: 32_000 };
const summariser = { calls: 0 };
vi.mock('../../agent/model.js', () => ({
  callModel: async () => {
    summariser.calls++;
    return { content: 'Earlier the crew counted the depot and filed the long manifests.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => windowNow.value,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { estimateAssembledTokens, leavingFromView } from '../compaction.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { estimateTokens } from '../budget.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t158-cap';
const MODEL = 'model-t158-cap';
const db = (): Database.Database => mockDb.current!;

/** ~61K tokens at the /4 estimator: the file read from the incident. */
const HUGE = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(3200);
/** ~12K tokens: large, but under the assembler's 15K cap, so priced as stored. */
const LARGE = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(620);

let turnNo = 0;
function smallTurn(): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turnNo);
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${turnNo}] Which bay is next?`, turnNumber: turnNo });
  insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo, content: `[a${turnNo}] Bay four, beside the ramp.` });
}
function toolResultTurn(body: string): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turnNo);
  const id = `tc-${turnNo}`;
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo,
    content: JSON.stringify([{ type: 'tool_use', id, name: 'file_read', input: { path: 'manifest.txt' } }]),
  });
  insertMessage({
    agentId: AGENT, role: 'tool', lane: 'owner', turnNumber: turnNo,
    content: JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: body }]),
  });
}

function seed(window: number): void {
  windowNow.value = window;
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:11434/v1')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'local', 'Local', ?, 4096, '["tools"]', 1)`,
  ).run(MODEL, window);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, MODEL);
}

beforeEach(() => {
  turnNo = 0;
  summariser.calls = 0;
  __resetBrakesForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t158 C — the full check reads the rows the assembler will budget', () => {
  it('one 61K tool result among small rows on a 128K window is NOT full, though its stored cost would say so', async () => {
    seed(128_000);
    for (let i = 0; i < 20; i++) smallTurn();
    toolResultTurn(HUGE);
    for (let i = 0; i < 6; i++) smallTurn();
    const est = await estimateAssembledTokens(AGENT, windowNow.value, MODEL);
    const ctx = await assembleContext(AGENT, MODEL);

    // What the old pricing said (stored cost, uncapped): the incident's "full".
    const storedCost = (db().prepare("SELECT SUM(COALESCE(token_count, 0)) AS t FROM messages WHERE role = 'tool'").get() as { t: number }).t
      || estimateTokens(HUGE);
    expect(storedCost, 'the stored row really is far over the 15K cap').toBeGreaterThan(50_000);
    // t200: the control was "priced at est + stored cost, the view reads full". It leaned on the old
    // 15K-token view of this row; the row's view is now its short pointer (the whole is kept), so
    // the control is the bound below instead: a dry run that priced the stored row would fail it.
    expect(est.view.tailTokens + storedCost, 'control: priced at the stored cost the tail is far over the bound below')
      .toBeGreaterThan(25_000);

    // What the assembler budgets: the tool result capped at 15K. The dry run now agrees.
    expect(est.view.tailTokens, 'the dry run prices the capped row, not the stored one').toBeLessThan(25_000);
    expect(est.view.tailTokens, 'a tail that fits is not full').toBeLessThanOrEqual(est.view.tailRoomTokens);
    expect(leavingFromView(AGENT, windowNow.value, est.view), 'and nothing is leaving it').toBeNull();
    expect(ctx.freshTailDropped ?? 0, 'and the assembler indeed set nothing aside').toBe(0);
  });

  it('a tail that is really full (many large rows under the cap) is still full', async () => {
    seed(128_000);
    for (let i = 0; i < 10; i++) { smallTurn(); toolResultTurn(LARGE); }
    const est = await estimateAssembledTokens(AGENT, windowNow.value, MODEL);
    expect(est.view.tailTokens).toBeGreaterThan(100_000);
    expect(est.view.tailTokens).toBeGreaterThan(est.view.tailRoomTokens);
  });
});
