// ════════════════════════════════════════════════════════════════════════════════════════
// t29 P7 (the rest of P3) - A STRONG TECHNIQUE IS INLINED ONLY WHERE THE ROOM HOLDS IT.
//
// The loop's technique injector inlined a matched technique's whole file up to a fixed
// character cap, whatever room the window had left. On a 12K window a 14,000-character
// technique (about 3,500 tokens) took the whole array over the provider boundary's budget
// and the boundary repaired it by dropping lanes (the "60 of 216 cases, 8K-16K windows"
// the t139 round 5 scan counted). The room is a measurement (`memory/technique-room.ts`):
// the injector inlines when the text fits it, and otherwise says to load the technique.
// Fixtures are fictional.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => null,
  queueEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
/** The matcher's semantic score is the one thing faked: it names the fixture technique a STRONG
 *  match. Everything after it — the grant filter, the file read, the frame — is the real door. */
vi.mock('../../agent/v2/classifiers/technique.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/v2/classifiers/technique.js')>()),
  semanticTechniqueMatches: async (_q: string, techniques: Array<{ id: string; name: string }>) =>
    techniques.map((technique) => ({ technique, score: 0.95 })),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createTask } from '../../tracker/schema.js';
import { assembleContext } from '../assembler.js';
import { POST_BUDGET_LANES } from '../lanes.js';
import { contextWindowPolicy, estimateTokens } from '../budget.js';
import { assemblyTokens } from '../assembly-validation.js';
import { injectTechniqueAndGapHints } from '../../agent/v2/steps/assemble/technique-hints.js';

const AGENT = 'agent-whole';
const MODEL = 'model-whole';
const db = (): Database.Database => mockDb.current!;
let techDir = '';

function seed(window: number): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, window);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Wholly', 'idle', ?)")
    .run(AGENT, MODEL);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
}

/** A published technique on disk, the shape the matcher's store reads. */
function publishTechnique(chars: number): void {
  techDir = fs.mkdtempSync(path.join(os.tmpdir(), 't139-technique-'));
  let md = '# Ledger reconciliation\n';
  while (md.length < chars) md += 'Step: compare each bay total with the manifest and note the difference.\n';
  fs.writeFileSync(path.join(techDir, 'TECHNIQUE.md'), md.slice(0, chars));
  db().prepare(
    `INSERT INTO techniques (id, name, description, state, directory_path, enabled)
     VALUES ('tech-ledger', 'Ledger reconciliation', 'Reconcile ledgers', 'published', ?, 1)`,
  ).run(techDir);
}

function longAsk(len: number, tag: string): string {
  const step = 'then reconcile the warehouse ledger against the shipping manifests, bay by bay, ';
  let s = `[${tag}] Please work through this list in order: `;
  while (s.length < len) s += step;
  const tail = ` END-OF-${tag}`;
  return s.slice(0, len - tail.length) + tail;
}

/** Six tasks whose 4,000-char asks were condensed out of the live view, so the list carries
 *  their words — the case where the list wants every token of room it can get. */
function condensedTasks(): void {
  const ids: string[] = [];
  for (const tag of ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']) {
    const id = `msg-${tag.toLowerCase()}`;
    insertMessage({
      id, agentId: AGENT, role: 'user', content: longAsk(4000, tag), turnNumber: 1,
      channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    });
    createTask({
      title: `Ledger ${tag}`, assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'model', sourceMessageId: id, turn: 1, convKey: null },
    });
    ids.push(id);
  }
  db().prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES ('sum-asks', ?, 1, 'leaf', 'The owner asked for six ledger reconciliations.', 12, 6,
             datetime('now'), datetime('now'), datetime('now'))`,
  ).run(AGENT);
  db().prepare("INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', 'sum-asks', 0)")
    .run(AGENT);
  const link = db().prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
  for (const id of ids) link.run('sum-asks', id);
}

let turnNo = 1;
function exchange(): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, answered)
     VALUES (?, ?, 'user', datetime('now'), 0)`,
  ).run(AGENT, turnNo);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', conversationId: 'conv-dash',
    content: `[x${turnNo}] Reconcile the ledgers, please.`, turnNumber: turnNo,
  });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', conversationId: 'conv-dash',
    content: `[x${turnNo}] Starting with bay 1.`, turnNumber: turnNo,
  });
}

const reserveOf = (id: string): number => POST_BUDGET_LANES.find((l) => l.id === id)!.reserveTokens;

beforeEach(() => {
  turnNo = 1;
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  if (techDir) fs.rmSync(techDir, { recursive: true, force: true });
  techDir = '';
});

import { techniqueRoomTokens } from '../technique-room.js';

type Msg = { role: 'user' | 'assistant'; content: string | unknown[] };

/** The array the provider boundary measures, plus the room the injector is handed. */
async function wholeArray(window: number, techniqueChars: number): Promise<{ whole: Msg[]; budget: number; inlined: boolean; pointed: boolean }> {
  seed(window);
  publishTechnique(techniqueChars);
  condensedTasks();
  for (let i = 0; i < 3; i++) exchange();
  const ctx = await assembleContext(AGENT, MODEL);
  const whole: Msg[] = [...(ctx.messages as Msg[])];
  for (const block of [ctx.recallLane, ctx.openCommitmentsLane, ctx.attemptLedgerLane,
    ctx.activeTasksLane, ctx.scratchpadLane, ctx.eventsLane, ctx.integrationStatusLane]) {
    if (block) whole.push({ role: 'user', content: block });
  }
  const room = techniqueRoomTokens(ctx);
  whole.push({ role: 'user', content: 'x'.repeat(4 * reserveOf('lane.loop-tail')) });
  whole.push({ role: 'user', content: 'x'.repeat(4 * reserveOf('lane.deliveries')) });
  await injectTechniqueAndGapHints({ loopCount: 1 } as never, {
    agentId: AGENT, turnCtx: {} as never, lastUserMessageContent: 'Reconcile the ledgers, please.',
    mctx: {} as never, messages: whole as never, roomTokens: room,
  });
  const text = whole.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const policy = contextWindowPolicy(window, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
  return {
    whole, budget: policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt),
    inlined: text.includes('--- TECHNIQUE: Ledger reconciliation ---'),
    pointed: text.includes("use_technique('tech-ledger')"),
  };
}

describe('a strong technique is inlined only where the room holds it', () => {
  it('12K window, a 14,000-character technique: the whole array stays inside the budget and the technique is pointed to, not inlined', async () => {
    const r = await wholeArray(12_000, 14_000);
    expect(r.pointed, 'the premise: the match fired and the agent is told how to load it').toBe(true);
    expect(r.inlined).toBe(false);
    expect(assemblyTokens(r.whole as never), 'within the budget the repair enforces').toBeLessThanOrEqual(r.budget);
  });

  it('control: a 64K window inlines the same technique whole (the room holds it)', async () => {
    const r = await wholeArray(64_000, 14_000);
    expect(r.inlined).toBe(true);
    expect(assemblyTokens(r.whole as never)).toBeLessThanOrEqual(r.budget);
  });

  it('a small technique still inlines on a 12K window (the room, not the window, decides)', async () => {
    const r = await wholeArray(12_000, 500);
    expect(r.inlined).toBe(true);
    expect(assemblyTokens(r.whole as never)).toBeLessThanOrEqual(r.budget);
  });
});
