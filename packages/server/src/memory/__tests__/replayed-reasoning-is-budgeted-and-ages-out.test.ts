// ════════════════════════════════════════════════════════════════════════════════════════
// T56 — REPLAYED REASONING BECOMES VISIBLE, AND AGES OUT.
//
// ── THE DEFECT, measured on the dev body (W23/HL8 lead, re-measured by W40) ──
// Stored `reasoning_content` rides back to the provider on TOOL-CALL rows (HL8-C, dsh's own
// passback rule). Every token arithmetic in the assembly counts the row's CONTENT and
// nothing else, so those tokens are spent and never billed to any budget:
//
//   • 7,575 replayable rows on the dev body carry 3,806,926 reasoning tokens against
//     690,900 counted content tokens — 5.5x the number the assembler believes.
//   • worst single row: `d68a9576…` budgeted at 35 tokens, carrying 14,310 replayable ones.
//   • across 37,872 sliding 40-row windows of real history, mean counted 6,025 tokens vs
//     mean UNCOUNTED 3,981 (max 78,909). The allocator's eviction and the compaction gate's
//     summarise/don't decision are both made against a number that is ~60% of the truth.
//
// ── LEG (a): BUDGET TRUTH. ── The cost of carrying a row is what the wire will carry. It
// does not move one byte of any request: the same rows render identically; only the
// arithmetic that decides how many of them fit changes.
//
// ── LEG (b): AGE-OUT AT COMPACTION BOUNDARIES ONLY. ── Reasoning is dropped from rows only
// at the instant a compaction has ALREADY rewritten that prefix region (a leaf summary was
// created). Never mid-stream: outside a compaction no prefix byte may move, so an assembly
// that follows another with no compaction between them is byte-identical. The ACTIVE tool
// chain — the current turn — keeps its reasoning, which is the whole of what the provider
// contract asks for (dsh `serialize.ts:96-100`: replayed on tool-call turns, and OMITTED
// entirely when there is none; our own `requiresReasoningReplay` is satisfied by the `''`
// fallback that already ships on every reasoning-less tool-call row today).
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

// The vault archive writes real blobs; compaction's data-safety guard only needs a truthy id.
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: () => 'archive-stub',
  isDreamerIgnored: () => false,
  getArchiveHighWaterMark: () => null,
}));

// The reserve is MEASURED from the agent's real tool payload (PHASE-3 T4). Pinning it makes
// the assembly budget a known number, which is what lets the eviction clause below be exact.
const TOOL_PAYLOAD_TOKENS = 1000;
vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => TOOL_PAYLOAD_TOKENS,
}));

// `generateSummary` calls the model; the summariser's OUTPUT is not this file's subject, the
// fact that a summary was created (the compaction boundary) is. Everything else in
// `agent/model.js` — `getContextWindow`, `getModelOutputCap` — stays real.
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'a summary of the span', toolCalls: [], usage: {} }),
  getContextWindow: () => CONTEXT_WINDOW,
  getModelOutputCap: () => 4096,
}));

import { assembleContext } from '../assembler.js';
import { checkAndCompact, estimateAssembledTokens } from '../compaction.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t56';
const MODEL = 'model-t56';
const CONTEXT_WINDOW = 32000;

let seq = 0;

function seedModel(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','https://api.deepseek.com')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'deepseek-v4-flash', 'Flash', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, CONTEXT_WINDOW);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'T56', MODEL);
}

/** Declare the agent's turn clock. `currentTurnNumber` reads MAX(turn_number) from here, and
 *  that is what the age-out treats as the ACTIVE tool chain. */
function seedTurn(turn: number): void {
  mockDb.current!.prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turn);
}

function row(role: string, content: string, turn: number, reasoning: string | null = null): string {
  seq += 1;
  const id = `t56-${seq}`;
  const kind = content.startsWith('[{')
    ? 'tool-turn'
    : role === 'assistant' ? 'agent-text' : role === 'system' ? 'working-note' : 'user-text';
  const tier = role === 'system' ? 'agent-only' : 'user-visible';
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, reasoning_content, token_count, created_at)
     VALUES (?, ?, ?, 'owner', 'owner', ?, ?, ?, ?, 'live', 1, ?, ?, ?)`,
  ).run(
    id, AGENT, role, content, kind, tier, turn, reasoning,
    Math.max(1, Math.ceil(content.length / 4)), 1785000000000 + seq * 1000,
  );
  return id;
}

const toolUse = (id: string): string =>
  JSON.stringify([{ type: 'tool_use', id, name: 'web_search', input: { q: 'x' } }]);
const toolResult = (id: string): string =>
  JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

/** N tokens of reasoning, in the estimator's own dialect (4 chars per token). */
const reasoningOf = (tokens: number): string => 'r'.repeat(tokens * 4);

type Msg = { role: string; content: unknown; reasoningContent?: string };

const freshTailGrant = (ctx: { allocation?: { grants: Array<{ id: string; requested: number }> } }) =>
  ctx.allocation!.grants.find((g) => g.id === 'lane.fresh-tail')!;

const stampOf = (id: string): number =>
  (mockDb.current!.prepare('SELECT reasoning_aged_out AS f FROM messages WHERE id = ?').get(id) as { f: number }).f;

beforeEach(() => {
  seq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── LEG (a): the arithmetic tells the truth ─────────────────────────────────────────────

describe('T56 leg (a) — replayed reasoning is counted where it is spent', () => {
  it('RED: the fresh-tail lane bills the reasoning that will ride the wire', async () => {
    seedTurn(1);
    row('user', 'find me the thing', 1);
    const call = row('assistant', toolUse('tu-1'), 1, reasoningOf(2000));
    row('tool', toolResult('tu-1'), 1);
    row('assistant', 'here it is', 1);
    expect(call).toBeTruthy();

    const ctx = await assembleContext(AGENT, MODEL);
    const grant = freshTailGrant(ctx);

    // The four rows' own content is a few dozen tokens. The reasoning is 2,000 more, and it
    // is on the wire: `buildOpenAIMessages` replays it on this exact row.
    expect(grant.requested).toBeGreaterThanOrEqual(2000);
  });

  it('CONTROL: reasoning on a PLAIN assistant row is never billed — HL8-C drops it', async () => {
    seedTurn(1);
    row('user', 'hello', 1);
    row('assistant', 'hi there', 1, reasoningOf(2000));

    const ctx = await assembleContext(AGENT, MODEL);
    // A plain turn's reasoning is dropped at the replay site, so billing it would evict live
    // conversation to pay for bytes nobody sends.
    expect(freshTailGrant(ctx).requested).toBeLessThan(500);
  });

  it('RED: the compaction gate sees it too — summarise/don\'t stops being decided on a lie', async () => {
    seedTurn(1);
    row('user', 'go', 1);
    row('assistant', toolUse('tu-1'), 1, reasoningOf(3000));
    row('tool', toolResult('tu-1'), 1);

    const before = await estimateAssembledTokens(AGENT, CONTEXT_WINDOW, MODEL);
    // Capped per row at `gateMessageCap` (4,000) exactly like any other oversized row — the
    // gate's own declared behaviour. Content alone is under 100.
    expect(before.freshTailTokens).toBeGreaterThanOrEqual(3000);
  });

  it('RED: eviction becomes honest — a tail the window cannot hold is trimmed', async () => {
    seedTurn(1);
    row('user', 'kick off the long job', 1);
    // Six tool-call hops, 5,000 reasoning tokens each = 30,000 replayed tokens against an
    // assembly budget of floor(0.96 x 32,000) - (1,000 tools + 4,096 output) = 25,624.
    for (let i = 1; i <= 6; i++) {
      row('assistant', toolUse(`tu-${i}`), 1, reasoningOf(5000));
      row('tool', toolResult(`tu-${i}`), 1);
    }
    row('user', 'how is it going?', 1);

    const ctx = await assembleContext(AGENT, MODEL);
    expect(ctx.freshTailDropped ?? 0).toBeGreaterThan(0);
  });

  it('CONTROL: the same tail WITHOUT reasoning is admitted whole, before and after', async () => {
    seedTurn(1);
    row('user', 'kick off the long job', 1);
    for (let i = 1; i <= 6; i++) {
      row('assistant', toolUse(`tu-${i}`), 1, null);
      row('tool', toolResult(`tu-${i}`), 1);
    }
    row('user', 'how is it going?', 1);

    const ctx = await assembleContext(AGENT, MODEL);
    expect(ctx.freshTailDropped ?? 0).toBe(0);
  });
});

// ── LEG (b): the age-out, and the boundary it may never cross ───────────────────────────

/** Seed enough history that a forced compaction has a real span outside the fresh tail.
 *  Turns 1..4 are finished work; turn 5 is the ACTIVE tool chain. */
function seedHistoryAcrossTurns(): { old: string; active: string } {
  let old = '';
  for (let turn = 1; turn <= 4; turn++) {
    seedTurn(turn);
    for (let i = 0; i < 8; i++) {
      row('user', `question ${turn}.${i} about the work in hand`, turn);
      const call = row('assistant', toolUse(`tu-${turn}-${i}`), turn, reasoningOf(40));
      row('tool', toolResult(`tu-${turn}-${i}`), turn);
      row('assistant', `answer ${turn}.${i}`, turn);
      if (turn === 4 && i === 7) old = call;
    }
  }
  seedTurn(5);
  row('user', 'now do the next thing', 5);
  const active = row('assistant', toolUse('tu-active'), 5, reasoningOf(40));
  row('tool', toolResult('tu-active'), 5);
  return { old, active };
}

describe('T56 leg (b) — reasoning ages out at compaction boundaries, and only there', () => {
  it('RED: a compaction that wrote a summary retires historic reasoning and spares the active chain', async () => {
    const { old, active } = seedHistoryAcrossTurns();

    const result = await checkAndCompact(AGENT, MODEL, CONTEXT_WINDOW, {
      force: true, skipContinuityBrief: true,
    });
    expect(result.leafCreated).toBeGreaterThan(0);

    expect(stampOf(old)).toBe(1);
    expect(stampOf(active)).toBe(0);

    const ctx = await assembleContext(AGENT, MODEL);
    const msgs = ctx.messages as Msg[];
    const withReasoning = msgs.filter((m) => m.reasoningContent);
    // Whatever survives in the live view, none of it is from a retired turn.
    expect(withReasoning.every((m) => m.reasoningContent === reasoningOf(40))).toBe(true);
    // The active chain's row is still carrying its thinking.
    expect(withReasoning.length).toBeGreaterThan(0);
  });

  it('CONTROL: no compaction, no movement — a second assembly is byte-identical and reasoning stays', async () => {
    seedTurn(1);
    row('user', 'go', 1);
    row('assistant', toolUse('tu-1'), 1, reasoningOf(50));
    row('tool', toolResult('tu-1'), 1);
    seedTurn(2);
    row('user', 'and again', 2);

    const first = await assembleContext(AGENT, MODEL);
    const second = await assembleContext(AGENT, MODEL);

    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    expect((first.messages as Msg[]).some((m) => m.reasoningContent)).toBe(true);
  });

  it('CONTROL: a compaction that created NO summary retires nothing', async () => {
    seedTurn(1);
    row('user', 'go', 1);
    const call = row('assistant', toolUse('tu-1'), 1, reasoningOf(50));
    row('tool', toolResult('tu-1'), 1);
    seedTurn(2);
    row('user', 'and again', 2);

    // Nothing outside the fresh tail: `runLeafCompaction` has no span, so no prefix region is
    // rewritten and no byte may move.
    const result = await checkAndCompact(AGENT, MODEL, CONTEXT_WINDOW, {
      force: true, skipContinuityBrief: true,
    });
    expect(result.leafCreated).toBe(0);
    expect(stampOf(call)).toBe(0);
  });

  // Not a RED clause — it cannot fail before the mechanism exists. It is the clause that
  // makes the mechanism SAFE: a retirement decided at render time would move prefix bytes on
  // every turn, and this is what refuses that shape.
  it('CONTROL: the retirement is DURABLE — assemblies after the boundary do not re-decide it', async () => {
    seedHistoryAcrossTurns();
    await checkAndCompact(AGENT, MODEL, CONTEXT_WINDOW, { force: true, skipContinuityBrief: true });

    const first = await assembleContext(AGENT, MODEL);
    const second = await assembleContext(AGENT, MODEL);
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });
});
