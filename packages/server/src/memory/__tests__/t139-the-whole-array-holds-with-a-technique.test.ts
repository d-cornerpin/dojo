// ════════════════════════════════════════════════════════════════════════════════════════
// t139 ROUND 6 — THE TASK LIST'S ROOM IS HONEST AGAINST THE WHOLE ARRAY (ruling R-V333-14, M1).
//
// Round 5 gave the list its ladder share plus the content fit's unspent budget. That is right
// only if every OTHER late addition stays inside its own reserve — and two do not: on a small
// (scaled) window the other post-budget blocks are not scaled down, and the loop's
// strong-technique match (`msg.technique-strong`, matched AFTER the assembler returns) is
// unreserved by declaration. The unspent budget used to absorb both; round 5 let the list take
// it first. This file builds the WHOLE array the provider boundary measures — the assembled
// messages, every post-budget block the assembler returns, the loop's own appends at their
// declared reserves, and a strong technique match injected by the loop's REAL injector — on a
// 16K window, and holds it to the validator's own budget (`assembly-validation.ts`): over it,
// the repair would drop summaries and, in the limit, the live conversation.
//
// RED-first: committed at `df98f44c` as `it.fails`. Fixtures are fictional (G1).
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
const WINDOW = 16_000;
const db = (): Database.Database => mockDb.current!;
let techDir = '';

function seed(): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, WINDOW);
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

describe('the whole array — assembly + every late addition + a strong technique — fits the budget', () => {
  it.fails('(RED at df98f44c) 16K window, a strong technique match: the whole array stays within the validator budget, so nothing is repair-dropped', async () => {
    seed();
    publishTechnique(14_000);
    condensedTasks();
    for (let i = 0; i < 3; i++) exchange();

    const ctx = await assembleContext(AGENT, MODEL);
    type Msg = { role: 'user' | 'assistant'; content: string | unknown[] };
    const whole: Msg[] = [...(ctx.messages as Msg[])];
    for (const block of [ctx.recallLane, ctx.openCommitmentsLane, ctx.directiveLane, ctx.attemptLedgerLane,
      ctx.activeTasksLane, ctx.scratchpadLane, ctx.eventsLane, ctx.integrationStatusLane]) {
      if (block) whole.push({ role: 'user', content: block });
    }
    // The loop's own appends that are not built here, at their DECLARED reserves (the most they
    // may be): the turn-context tail and the deliveries block.
    whole.push({ role: 'user', content: 'x'.repeat(4 * reserveOf('lane.loop-tail')) });
    whole.push({ role: 'user', content: 'x'.repeat(4 * reserveOf('lane.deliveries')) });
    // The strong technique match, through the loop's real injector.
    await injectTechniqueAndGapHints({ loopCount: 1 } as never, {
      agentId: AGENT, turnCtx: {} as never, lastUserMessageContent: 'Reconcile the ledgers, please.',
      mctx: {} as never, messages: whole as never,
    });
    expect(whole.some((m) => typeof m.content === 'string' && m.content.includes('--- TECHNIQUE: Ledger reconciliation ---')),
      'the premise: the technique was injected').toBe(true);
    expect(ctx.activeTasksLane, 'the premise: the list is on the array').toBeTruthy();

    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
    const budget = policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt);
    expect(assemblyTokens(whole as never), 'within the budget the repair enforces').toBeLessThanOrEqual(budget);
  });
});
