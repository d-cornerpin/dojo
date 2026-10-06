// ════════════════════════════════════════════════════════════════════════════════════════
// D4b — THE SUMMARY WRITER'S BREAKER DOOR, DRIVEN END TO END.
//
// ── THE GAP, MEASURED AT THIS HEAD BEFORE IT WAS TRUSTED ──
// `agent/model.ts` WRAPS every model failure before anybody downstream sees it:
// `OpenAI call failed: <sdkMessage>` (:2738) and `Model call failed: <sdkMessage>` (:3652).
// So the summary writer's catch handed the provider breaker the string
//
//     OpenAI call failed: 402 Payment Required
//
// `failed:` is not one of `statusIsAnchored`'s introducers (`error`/`status`/`code`/`http`…)
// and the wrapped string no longer STARTS with the number, so `classifyProviderErrorText`
// answers class `unknown` with `basis: 'none'`, and both remaining arms of
// `permanentFailureReason` decline — arm 2 wants the number in a status position, arm 3 wants
// the prose to carry the verdict with the digits stripped, and a bare `Payment Required`
// carries no billing word. The breaker therefore never opened on THE INCIDENT'S OWN DOOR: the
// summary writer dialling a provider that had been answering 402 for twenty-seven hours. A
// bare gateway 402 and OpenRouter's "requires more credits" both read TRANSIENT on main.
//
// ── WHY THIS IS ITS OWN FILE ──
// `compaction-has-no-bottom.test.ts` mocks `generateSummary` wholesale, because what it is
// about is the recursion above it. That makes it structurally unable to see this defect: a
// mutant removing the pass-through at `summarize.ts`'s call site left all sixteen of its
// clauses GREEN, which is the wire-clause gap in person — the arithmetic was pinned and the
// APPLICATION was not. So this file mocks one layer lower (the SDK call itself) and drives the
// REAL `generateSummary`, the REAL catch, the REAL `noteSummaryWriterFailure` and the REAL
// breaker. Nothing between the throw and the latch is simulated.
//
// ── CONTENT NOTE ──
// Invented provider and model ids, filler content, no real conversation or person.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-d4b', 'dojo.db'),
  };
});

const frames: Array<{ type: string; code?: string; error?: string }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; code?: string; error?: string }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

/** THE ONE SEAM: the SDK call. Everything above it in this file is the real code path. */
let thrower: () => never = () => { throw new Error('not configured'); };
vi.mock('../../agent/model.js', () => ({
  callModel: async () => thrower(),
}));

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { AgentError } from '../../agent/errors.js';
import { classifyProviderError } from '../../agent/provider-error.js';
import { providerBreaker, mayDialProvider, __resetBreakersForTests } from '../../providers/billing-breaker.js';

const AGENT = 'agent-d4b';
const PROVIDER = 'prov-wrapped-402';
const MODEL = 'm-wrapped-402';

/** Exactly what `agent/model.ts` throws for an OpenAI-path 402 — the wrap AND the facts. */
function wrappedAs(sdkMessage: string, status: number): AgentError {
  const facts = classifyProviderError({ status, message: sdkMessage });
  return new AgentError(`OpenAI call failed: ${sdkMessage}`, AGENT, {
    code: 'MODEL_CALL_FAILED', retryable: false, provider: facts,
  });
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES (?, 'Wrapped', 'openai-compatible', 'api_key')").run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Wrapped 402', 'wrapped/402', '["text"]', 1, 65536, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare("INSERT INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'D4b Box', ?, 'idle', '1970-01-01')")
    .run(AGENT, MODEL);
  frames.length = 0;
  __resetBreakersForTests();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

async function summarise(): Promise<void> {
  await generateSummary({
    content: 'filler conversation body', depth: 0, targetTokens: 500, agentId: AGENT, modelId: MODEL,
  });
}

describe('D4b the summary writer\'s own 402 opens its provider\'s breaker', () => {
  /**
   * THE MUTANT: drop the fourth argument at `summarize.ts`'s `noteSummaryWriterFailure` call
   * (or stop forwarding it inside `noteSummaryWriterFailure`) and this clause goes RED — the
   * breaker stays shut and `mayDialProvider` keeps saying yes to a provider with no money.
   */
  it('⚠ THE DOOR: a WRAPPED 402 reaches the breaker through the real catch and opens it', async () => {
    thrower = () => { throw wrappedAs('402 Payment Required', 402); };

    const first = await summarise();
    expect(first, 'a refusal is never a summary').toBeUndefined();
    expect(providerBreaker(PROVIDER), 'one 402 can race a top-up — it must still be counting').toBeNull();

    await summarise();

    const open = providerBreaker(PROVIDER);
    expect(open, 'the second permanent failure must open it, through the WRAPPED message').toBeTruthy();
    expect(open!.reason).toBe('no_balance');
    expect(mayDialProvider(PROVIDER), 'and a provider with no balance stops being a candidate').toBe(false);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED').length, 'the owner is carded once').toBe(1);
    expect(frames.find(f => f.code === 'QUOTA_EXHAUSTED')!.error).toContain('out of balance');
  });

  it('the same door takes the shapes a real gateway sends, not just the canonical one', async () => {
    // A bare gateway body with no billing prose at all, and OpenRouter's own wording. Both are
    // `unknown` to the prose path once wrapped; both are decided by the SDK's status.
    thrower = () => { throw wrappedAs('402 {"error":{"message":"requires more credits"}}', 402); };
    await summarise();
    await summarise();
    expect(providerBreaker(PROVIDER)?.reason, 'a credit refusal is a billing wall whatever it is worded like')
      .toBe('no_balance');
  });

  it('⚠ THE CONTROL: a transient wrapped failure still opens NOTHING', async () => {
    // Without this row, "the breaker opens" would pass just as well on a door that latches on
    // anything — which is the one failure `billing-breaker.ts`'s own header forbids.
    thrower = () => { throw wrappedAs('503 upstream overloaded, try again', 503); };
    await summarise();
    await summarise();
    await summarise();
    expect(providerBreaker(PROVIDER), 'a bad minute is not a wall').toBeNull();
    expect(mayDialProvider(PROVIDER)).toBe(true);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED'), 'and no card for it').toEqual([]);
  });

  it('⚠ AND A THROW WITH NO FACTS IS UNCHANGED — the prose path, untouched', async () => {
    // The parameter is optional and absent must mean exactly today's behaviour, or this change
    // would be a silent widening of what counts as permanent for every other caller.
    thrower = () => { throw new Error('OpenAI call failed: 402 Payment Required'); };
    await summarise();
    await summarise();
    expect(providerBreaker(PROVIDER), 'the wrapped prose alone still carries no evidence').toBeNull();
  });

  it('⚠ AND THE CALL SITE FORWARDS IT — the wire, asserted on the source shape', () => {
    // The mutant above proves the behaviour; this proves the SHAPE, because the behavioural
    // clause can only see the door through one thrower and a future rewrite could satisfy it
    // while dropping the field for every other. Comments are stripped first: a clause
    // satisfiable by the prose above the call would be testing the comment (G4).
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'summarize.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const call = src.match(/^\s*const permanent = noteSummaryWriterFailure\(.*$/m)?.[0];
    expect(call, '`summarize.ts` must still be the caller of this door').toBeTruthy();
    expect(call, 'and it must hand over the SDK\'s own facts, not only the wrapped prose').toContain('facts');
    const derive = src.match(/^\s*const facts = .*$/m)?.[0];
    expect(derive, 'read off the thrown error\'s `provider` field, which model.ts already attaches')
      .toMatch(/provider/);
  });
});
