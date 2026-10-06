// t109 item D — ON A 16K WINDOW THE LIVE CONVERSATION STARVED TO NOTHING.
//
// BACKLOG (2026-10-05, t94 builder, measured — pre-existing), verbatim: *"ON A 16K-TOKEN WINDOW
// THE LIVE CONVERSATION STARVES: the post-budget reserves plus a 2,682-token system prompt leave
// the fresh tail under ~600 tokens and the assembled array collapses to
// `lane.empty-context-fallback` EVERY turn (loudly) — identical pre-t94. Belongs with the
// reserve ladder in `memory/lanes.ts`: either the reserves scale with the window or a
// small-window agent is told plainly it cannot hold a conversation."*
//
// ⚠ RE-MEASURED AT THIS HEAD, AND THE LINE UNDERSTATED IT. §1 below is the reproduction, and its
// arithmetic is the whole diagnosis:
//
//     ack reserve                              71
//     post-budget ladder                   11,074   (15 lanes, each a worst case)
//     ───────────────────────────────────────────
//     the flat ladder                      11,145
//
//     16K window: assembly budget          10,264
//       minus a 2,682-token system prompt   7,582   ← everything the content could have had
//       minus the flat ladder              −3,563   → Math.max(0, …) ⇒ CONTENT BUDGET = 0
//
// So it was not "under ~600 tokens". It was ZERO, on every turn, which is exactly why the array
// collapsed to `lane.empty-context-fallback` ("Continue with your current task.") — the agent
// was answering with no conversation in front of it at all. An 8K box is worse still: the system
// prompt alone overruns the entire assembly budget by 98 tokens, before any reserve.
//
// THE HALF I BUILT, after measuring: THE RESERVES SCALE. `reserveLadderFor` bounds the ladder at
// an equal share of what is left after the system prompt, with a floor derived from the lanes
// that fire unconditionally. The derivation for the share is at the function and is not a tuning
// constant — the appends cannot be spent at all unless the content exists, so they may not
// outbid it.
//
// ⚠ AND THE HALF I DID NOT BUILD, BECAUSE IT IS ALREADY THERE. The line's other option — "a
// small-window agent is told plainly it cannot hold a conversation" — EXISTS:
// `budget.ts`'s `assertSystemPromptFits` throws `SystemPromptTooLargeError` before the assembler
// reaches the reserve ladder, and the message already names the window, the assembly budget, the
// reserve and the three possible repairs. §3 is the clause that keeps that refusal load-bearing;
// building a second, quieter report of the same state would have been duplication.
//
// ⚠ ONE MORE CORRECTION TO THE LINE, AND IT NARROWS THE FIX'S CLAIM. The 11,145-vs-7,582
// arithmetic above is taken on a 1,000-token TOOL PAYLOAD, which is what the t94 fixture that
// found this used (this file carries the same mock so the numbers are comparable). A real 16K box
// with the WHOLE production tool surface has a tool/output reserve of ~14,605, leaving an
// assembly budget of 755 against a ~6,093-token system prompt — so it hits the refusal above and
// never reaches the ladder at all. The scaling therefore fixes the SMALL-WINDOW-WITH-A-MODEST-
// SURFACE case, which is real and reachable, and it is NOT a claim that a 16K box with every tool
// enabled now holds a conversation. That box is refused, loudly, and correctly.
//
// §1 the reproduction, as arithmetic and as an assembled array
// §2 the ladder: scaled where it must be, UNTOUCHED where it need not be (G2)
// §3 the floor, and the state the platform ALREADY refuses
// §4 the wire clause: the assembler may not go back to the flat sum

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
  generateEmbedding: async () => null,
  queueEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
/** The tool payload the backlog line's measurement was taken on, carried verbatim from the t94
 *  clause file's own fixture so the arithmetic here is comparable to the number it reported.
 *  A real 16K box with the WHOLE tool surface (measured here: 14,605 tokens of reserve) never
 *  reaches the reserve ladder at all — `assertSystemPromptFits` throws first, which is the
 *  "told plainly" half the line asked for and which already exists. See §3. */
vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 1000,
}));

/** The assembler's own log is where the squeeze is reported, so it is captured. */
const log = vi.hoisted(() => {
  const calls = { debug: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
  };
});
vi.mock('../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger.js')>()),
  createLogger: () => log.logger,
}));

import {
  POST_BUDGET_RESERVE_TOKENS, SCAFFOLDING_ACK_RESERVE_TOKENS, POST_BUDGET_LANES,
  reserveLadderFor, RESERVE_LADDER_FLOOR_TOKENS, RESERVE_LADDER_SHARE_DENOMINATOR,
} from '../lanes.js';
import { contextWindowPolicy } from '../budget.js';
import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-d';
const MODEL = 'model-d';
const SMALL = 16_000;
const LARGE = 128_000;
/** The system prompt the backlog line measured, carried so the arithmetic is comparable. */
const MEASURED_SYSTEM_PROMPT_TOKENS = 2_682;
const FLAT_LADDER = SCAFFOLDING_ACK_RESERVE_TOKENS + POST_BUDGET_RESERVE_TOKENS;

const db = (): Database.Database => mockDb.current!;

function seedModel(contextWindow: number): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, contextWindow);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Zargo', 'idle', ?)")
    .run(AGENT, MODEL);
}

let turnNo = 0;
function appendTurn(): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, answered)
     VALUES (?, ?, 'user', datetime('now'), 0)`,
  ).run(AGENT, turnNo);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner',
    content: `[t${turnNo}] How many crates are still unlabelled in the back row of the depot?`,
    turnNumber: turnNo,
  });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner',
    content: `[t${turnNo}] Fourteen crates are unlabelled; eleven are in the back row and three `
      + 'sit by the ramp. The row numbers are on the clipboard so the count can be checked by '
      + 'hand, and the labels themselves are in the second drawer.',
    turnNumber: turnNo,
  });
}

beforeEach(() => {
  turnNo = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const k of ['debug', 'info', 'warn', 'error'] as const) log.calls[k].length = 0;
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 THE REPRODUCTION
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the 16K shape, reproduced', () => {
  it('⚠ D: the FLAT ladder takes more than a 16K window has left after its system prompt', () => {
    const policy = contextWindowPolicy(SMALL, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
    const available = policy.assemblyBudgetTokens - MEASURED_SYSTEM_PROMPT_TOKENS;

    // The arithmetic the backlog line reported, re-derived rather than quoted.
    expect(policy.assemblyBudgetTokens, 'floor(0.96 x 16,000) minus the tool/output reserve')
      .toBeLessThan(SMALL);
    expect(available, 'what the content could have had').toBeGreaterThan(0);
    expect(FLAT_LADDER, 'and what the flat ladder asked for instead').toBeGreaterThan(available);
    // ⇒ the pre-t109 content budget, which is what collapsed the array.
    expect(Math.max(0, available - FLAT_LADDER), 'ZERO, not "under ~600"').toBe(0);
  });

  it('⚠ D: on a 16K box the live conversation now reaches the model at all', async () => {
    seedModel(SMALL);
    for (let t = 1; t <= 6; t++) appendTurn();

    const ctx = await assembleContext(AGENT, MODEL);
    const lanes = ctx.allocation?.admittedIds ?? [];
    const text = ctx.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    // The pre-t109 shape: the array IS the fallback and nothing else.
    expect(text, 'the newest exchange reaches the model').toContain('[t6]');
    expect(lanes, 'and the fresh tail is an admitted lane, not a collapsed one')
      .toContain('lane.fresh-tail');
    expect(ctx.messages.length, 'more than the one-message fallback').toBeGreaterThan(1);
  });

  it('and the squeeze is REPORTED, with the numbers that diagnose it', async () => {
    seedModel(SMALL);
    for (let t = 1; t <= 6; t++) appendTurn();
    await assembleContext(AGENT, MODEL);

    const warns = log.calls.warn
      .filter((a) => String(a[0]).includes('Post-budget reserves scaled down'))
      .map((a) => (a[1] ?? {}) as Record<string, number>);
    expect(warns.length, 'said once per assembly, naming the window').toBe(1);
    expect(warns[0].declaredReserveTokens).toBe(FLAT_LADDER);
    expect(warns[0].reservedTokens).toBeLessThan(FLAT_LADDER);
    expect(warns[0].contentBudgetTokens, 'and the content budget is no longer zero')
      .toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 SCALED WHERE IT MUST BE, UNTOUCHED WHERE IT NEED NOT BE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the ladder', () => {
  it('⚠ D, THE OTHER DIRECTION (G2): a large window gets the FULL declared ladder, unchanged', () => {
    const policy = contextWindowPolicy(LARGE, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    const ladder = reserveLadderFor(policy.assemblyBudgetTokens - MEASURED_SYSTEM_PROMPT_TOKENS);
    expect(ladder.offTheTop, 'byte-identical to the pre-t109 answer').toBe(FLAT_LADDER);
    expect(ladder.scaled).toBe(false);
  });

  it('a 128K assembly is byte-identical end to end — no prompt byte moves on a goldens-shaped box', async () => {
    seedModel(LARGE);
    for (let t = 1; t <= 6; t++) appendTurn();
    const ctx = await assembleContext(AGENT, MODEL);
    expect(ctx.allocation?.offTheTopTokens, 'the full ladder, as before').toBe(FLAT_LADDER);
    expect(log.calls.warn.filter((a) => String(a[0]).includes('Post-budget reserves scaled down')))
      .toEqual([]);
    expect(log.calls.error.filter((a) => String(a[0]).includes('cannot hold a conversation')))
      .toEqual([]);
  });

  it('the share is EXACTLY a half, and the scaled ladder never exceeds it', () => {
    expect(RESERVE_LADDER_SHARE_DENOMINATOR).toBe(2);
    for (const available of [500, 2_000, 7_582, 11_000, 22_289, 22_290, 50_000]) {
      const ladder = reserveLadderFor(available);
      const half = Math.floor(available / 2);
      if (ladder.scaled) {
        // Scaled: at the half, or at the floor when the half is below it.
        expect(ladder.offTheTop).toBe(Math.max(RESERVE_LADDER_FLOOR_TOKENS, half));
      } else {
        expect(ladder.offTheTop).toBe(FLAT_LADDER);
        expect(FLAT_LADDER).toBeLessThanOrEqual(half);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 THE FLOOR, AND THE STATE THAT IS NOT THE RESERVES' FAULT
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the floor is derived, and the unholdable window was already told plainly', () => {
  it('the floor is the sum of the lanes that fire unconditionally — derived, not chosen', () => {
    const unconditional = POST_BUDGET_LANES
      .filter((l) => l.id === 'lane.engine-end-of-history' || l.id === 'lane.empty-context-fallback')
      .reduce((t, l) => t + l.reserveTokens, 0);
    expect(RESERVE_LADDER_FLOOR_TOKENS).toBe(SCAFFOLDING_ACK_RESERVE_TOKENS + unconditional);
    // And it is small enough to be a floor rather than a second ladder.
    expect(RESERVE_LADDER_FLOOR_TOKENS).toBeLessThan(FLAT_LADDER / 10);
  });

  it('a non-positive budget falls to the floor rather than to a negative reserve', () => {
    // Unreachable through the assembler (the refusal above fires first), so this is the
    // defensive answer and nothing more: the floor, never a negative or an invented number.
    for (const available of [-98, 0]) {
      const ladder = reserveLadderFor(available);
      expect(ladder.offTheTop).toBe(RESERVE_LADDER_FLOOR_TOKENS);
      expect(ladder.scaled).toBe(true);
    }
  });

  /**
   * ⚠ THE SECOND HALF OF THE BACKLOG LINE WAS ALREADY BUILT, and finding that out is part of
   * this item's answer. The line offered "either the reserves scale with the window OR a
   * small-window agent is told plainly it cannot hold a conversation". The telling EXISTS:
   * `assertSystemPromptFits` throws `SystemPromptTooLargeError` before the assembler reaches
   * the reserve ladder, and the message already names the window, the budget, the reserve and
   * the three repairs. So the honest build was the scaling alone; a second, quieter report of
   * the same state would be duplication, and this clause is what keeps the first one load-
   * bearing instead of building one.
   */
  it('a window that cannot hold its own system prompt is REFUSED, loudly, before any ladder', async () => {
    seedModel(2_000);
    for (let t = 1; t <= 3; t++) appendTurn();

    await expect(assembleContext(AGENT, MODEL)).rejects.toThrow(/does not fit its own budget/);
    await expect(assembleContext(AGENT, MODEL)).rejects.toThrow(/Fix one of the three/);
    // And the reserve ladder never got a say, so it must not have claimed one.
    expect(log.calls.warn.filter((a) => String(a[0]).includes('Post-budget reserves scaled down')))
      .toEqual([]);
  });

  it('THE REAL 16K BOX reaches that refusal, not the ladder — the whole tool surface is the cost', () => {
    // Measured at this HEAD with the production tool surface rather than this file's 1,000-token
    // mock: a 16K window's tool/output reserve is 14,605, leaving an assembly budget of 755
    // against a 6,093-token system prompt. That is the refusal's state, and it is why the
    // ladder's scaled branch is a SMALL-WINDOW-WITH-A-SMALL-SURFACE fix rather than a 16K fix.
    const real = contextWindowPolicy(SMALL, { toolPayloadTokens: 14_000, maxOutputTokens: 2048 });
    expect(real.assemblyBudgetTokens).toBeLessThan(MEASURED_SYSTEM_PROMPT_TOKENS);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 THE WIRE CLAUSE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the assembler may not go back to the flat sum', () => {
  it('the ladder is computed by the policy function and APPLIED, comments stripped', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'assembler.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    expect(src, 'the flat sum is gone from the assembler')
      .not.toMatch(/const offTheTop = SCAFFOLDING_ACK_RESERVE_TOKENS \+ POST_BUDGET_RESERVE_TOKENS/);
    expect(src, 'the ladder is asked for, against what is left after the system prompt')
      .toMatch(/reserveLadderFor\(maxTokens - systemTokens\)/);
    expect(src, 'and its answer is what is taken off the top')
      .toMatch(/const offTheTop = ladder\.offTheTop;/);
    // And the squeeze is reported, which is the only report this change adds.
    expect(src).toMatch(/ladder\.scaled/);
    expect(src, 'the unholdable-window state keeps its existing refusal and gains no second one')
      .toMatch(/assertSystemPromptFits\(systemTokens, policy\)/);
  });
});
