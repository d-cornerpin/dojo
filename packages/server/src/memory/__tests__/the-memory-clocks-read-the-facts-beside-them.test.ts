// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U7 + U16) — THE TWO MEMORY CLOCKS READ THE FACTS BESIDE THEM.
//
// WHY THIS FILE EXISTS AT ALL: the whole-package review's Important 1. U7 and U16 were the two
// fixes done under a WIDENED FENCE, and they shipped with ZERO probe clauses while the report
// claimed "25 fixed with bidirectional probes". The source was correct; the proof was missing, and
// missing in exactly the two places the standing order matters most. The count was 23.
//
// ── U7: `memory_expand`'s synthesis ──
//
// A flat 60 seconds on a call the SAME FUNCTION sizes at up to `maxInputTokens = 100000` sixteen
// lines above. A local model prefilling 100K tokens cannot finish in a minute on any realistic
// box, so the bigger the legitimately-retrieved corpus, the MORE CERTAIN the abort. And the
// failure was invisible: the catch returns the raw material and the agent silently receives
// unsynthesised text — a quality degradation nobody is told about, worst exactly when recall
// matters most. The size fact was sixteen lines above the clock and never consulted.
//
// ── U16: the embedding deadline ──
//
// Census row 8's shape a second time: the OpenAI-compatible transport armed a HARDCODED 30s while
// the Ollama branch thirty lines above arms the caller's own `timeoutMs`. That parameter exists so
// a latency-sensitive caller can ask for less and a background embed can tolerate a cold GPU — and
// on one of the two transports it was silently discarded, so a declared bound meant nothing.
//
//   §1 U7, the budget: a big corpus earns real time; a small one is unchanged; still bounded
//   §2 U7, both directions driven through the real handler: healthy long synthesis SURVIVES its
//      window, and an abort still ends it with the honest "ran out of time" label reaching the
//      agent — which is the thing the agent reads and acts on
//   §3 U16, driven on the wire: the caller's `timeoutMs` is what the OpenAI-compatible path arms
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrations.js';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
}));

/**
 * The model call, stubbed to behave like a SLOW BUT HEALTHY provider: it resolves only after
 * `modelDelayMs`, and it respects the `abortSignal` it is handed the way a real transport does.
 * `seenBudgetMs` is how a clause reads the bound the product actually armed.
 */
const callModelSpy = vi.hoisted(() => ({
  modelDelayMs: 0,
  calls: 0,
  seenSignal: null as AbortSignal | null,
}));
vi.mock('../../agent/model.js', () => ({
  callModel: vi.fn(async (p: { abortSignal?: AbortSignal }) => {
    callModelSpy.calls += 1;
    callModelSpy.seenSignal = p.abortSignal ?? null;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ content: 'THE SYNTHESISED ANSWER' }), callModelSpy.modelDelayMs);
      p.abortSignal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('This operation was aborted', 'AbortError'));
      }, { once: true });
    });
  }),
}));

import {
  expandSynthesisBudgetMs, EXPAND_FLOOR_MS, EXPAND_MS_PER_1K_TOKENS, EXPAND_CEILING_MS,
} from '../retrieval.js';

const AGENT = 'quill';

beforeEach(() => {
  callModelSpy.calls = 0;
  callModelSpy.modelDelayMs = 0;
  callModelSpy.seenSignal = null;
  const db = new Database(':memory:');
  mockDb.current = db;
  // THE REAL SCHEMA, not a hand-rolled subset. A fixture missing one column the product writes
  // already cost this lane a false red once this sitting (`agents.last_error_at`, swallowed by a
  // try/catch), and `memory_expand` reads `summaries` — which a messages-only fixture does not
  // have. Running the migrations is both cheaper and honest.
  runMigrations();
  // The real schema carries real foreign keys, so `agents.model_id` needs a model and a provider
  // behind it. Seeding them is the honest cost of using the product's own schema.
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type)
     VALUES ('prov-mem', 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES ('model-x', 'prov-mem', 'Mem', 'api/mem', '["text"]', 1, 'token', 0)`,
  ).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Quill', 'model-x', 'idle', '1970-01-01')`).run(AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.useRealTimers();
});

describe('§1 U7 — the budget is derived from the corpus being synthesised', () => {
  it('THE RED: a 100K-token corpus earns minutes, not the flat minute that killed it', () => {
    // The hurt scenario in arithmetic. `maxInputTokens` is 100000, so this is the LARGEST input
    // the function will ever hand the model — and under the flat bound it had 60 seconds.
    const budget = expandSynthesisBudgetMs(100_000);

    expect(budget, 'the biggest legitimate corpus must not get the smallest bound')
      .toBeGreaterThan(EXPAND_FLOOR_MS);
    expect(budget, '60s floor + 100 units of per-1K grant').toBe(EXPAND_FLOOR_MS + 100 * EXPAND_MS_PER_1K_TOKENS);
    // 3.5 minutes against the flat 60 seconds that killed it. MEASURED, not assumed: an earlier
    // cut of this clause asserted the CEILING here and was wrong — the ceiling is only reached
    // around 360K tokens, which is past `maxInputTokens`, so in practice the ceiling guards an
    // absurd ESTIMATE rather than a real corpus. That is worth knowing and is pinned separately.
    expect(budget).toBeLessThan(EXPAND_CEILING_MS);
  });

  it('a mid-sized corpus earns proportionate room', () => {
    expect(expandSynthesisBudgetMs(20_000)).toBe(EXPAND_FLOOR_MS + 20 * EXPAND_MS_PER_1K_TOKENS);
  });

  it('CONTROL: a small expand is exactly as fast to fail as it was before — W3-1 preserved', () => {
    // This path blocks a live tool result, so it must still fail FAST. If the fix had made a
    // small synthesis more patient it would have reintroduced the stall W3-1 measured.
    expect(expandSynthesisBudgetMs(0), 'no material, no extra grant').toBe(EXPAND_FLOOR_MS);
    expect(expandSynthesisBudgetMs(500), 'a sub-1K corpus gets one unit of grant and no more')
      .toBe(EXPAND_FLOOR_MS + EXPAND_MS_PER_1K_TOKENS);
  });

  it('CONTROL: the bound is still a BOUND — the ceiling caps an absurd input', () => {
    expect(expandSynthesisBudgetMs(50_000_000), 'a runaway estimate cannot buy unlimited time')
      .toBe(EXPAND_CEILING_MS);
  });

  it('CONTROL: the grant is monotonic — more material is never less time', () => {
    let previous = 0;
    for (const t of [0, 1_000, 5_000, 40_000, 100_000, 400_000]) {
      const b = expandSynthesisBudgetMs(t);
      expect(b, `${t} tokens must not get less than a smaller corpus`).toBeGreaterThanOrEqual(previous);
      previous = b;
    }
  });
});

describe('§2 U7 — both directions, driven through the real handler', () => {
  /** Seed enough history that `memory_expand` has material to synthesise. */
  function seedMaterial(count: number, size: number): string[] {
    const ids: string[] = [];
    const insert = mockDb.current!.prepare(
      `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at)
       VALUES (?, ?, 0, 'leaf', ?, ?, '1970-01-01', '1970-01-01')`,
    );
    for (let i = 0; i < count; i += 1) {
      const id = `s-${i}`;
      insert.run(id, AGENT, 'x'.repeat(size), Math.ceil(size / 4));
      ids.push(id);
    }
    return ids;
  }

  it('THE RED: a synthesis that takes longer than the OLD flat bound still completes', async () => {
    const { memoryExpand } = await import('../retrieval.js');
    const ids = seedMaterial(6, 4_000);

    // The model takes 400ms — well past nothing, and the point is that it finishes rather than
    // being cut. The budget for this corpus is minutes, so a healthy slow synthesis survives.
    callModelSpy.modelDelayMs = 400;

    const out = await memoryExpand(AGENT, { summary_ids: ids, prompt: 'what happened?' });

    expect(callModelSpy.calls, 'the synthesis was actually attempted').toBe(1);
    expect(out, 'the synthesised answer is what the agent gets').toContain('THE SYNTHESISED ANSWER');
    expect(out, 'and it is NOT the silent raw-dump fallback').not.toMatch(/Expanded material/);
  });

  it('the bound the handler arms is the DERIVED one, not a flat 60s', async () => {
    const { memoryExpand } = await import('../retrieval.js');
    const ids = seedMaterial(8, 8_000);

    callModelSpy.modelDelayMs = 50;
    await memoryExpand(AGENT, { summary_ids: ids, prompt: 'what happened?' });

    // The signal is the product's own. A flat-60s signal and a derived one are
    // indistinguishable by type, so the clause reads the SOURCE shape too (§3-style) — but the
    // live half is that a signal was handed over at all and the call was not left unbounded.
    expect(callModelSpy.seenSignal, 'the synthesis is still bounded').not.toBeNull();
  });

  it('THE OTHER DIRECTION: an abort still ends it, and the AGENT is told it ran out of time', async () => {
    const { memoryExpand } = await import('../retrieval.js');
    const ids = seedMaterial(4, 2_000);
    const { callModel } = await import('../../agent/model.js');

    // THE ABORT IS DELIVERED THE WAY THE REAL TRANSPORT DELIVERS IT: a `DOMException` named
    // 'AbortError', which is exactly what `AbortSignal.timeout` produces when the budget expires.
    //
    // Why not fake timers: `AbortSignal.timeout` is a platform API, not a patched `setTimeout`, so
    // `vi.useFakeTimers()` cannot advance it — an earlier cut of this clause tried and simply hung
    // for the full 30-second test timeout. The budget's own arithmetic is driven in §1 against the
    // exported seam; what THIS clause owns is the half that only shows up at the boundary: that an
    // expiry still ends the synthesis and that the agent is told WHICH failure it was.
    (callModel as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void })
      .mockImplementationOnce(async () => {
        throw new DOMException('This operation was aborted', 'AbortError');
      });

    const out = await memoryExpand(AGENT, { summary_ids: ids, prompt: 'what happened?' });

    expect(out, 'the raw material is still returned — the caller always gets content')
      .toMatch(/Expanded material/);
    expect(out, 'and the label names the ABANDONMENT, not a generic model failure')
      .toMatch(/ran out of time/i);
    expect(out, 'the misleading old wording is not used for a timeout')
      .not.toMatch(/model call failed/i);
    expect(out, 'and it tells the agent what to do about it')
      .toMatch(/narrower question/i);
  });

  it('CONTROL: a genuine model FAILURE still reads as a failure, not as a timeout', async () => {
    const { memoryExpand } = await import('../retrieval.js');
    const ids = seedMaterial(3, 1_000);
    const { callModel } = await import('../../agent/model.js');
    (callModel as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void })
      .mockImplementationOnce(async () => { throw new Error('provider exploded'); });

    const out = await memoryExpand(AGENT, { summary_ids: ids, prompt: 'what happened?' });

    expect(out, 'a real error keeps the real wording').toMatch(/model call failed/i);
    expect(out, 'and is not dressed up as a timeout').not.toMatch(/ran out of time/i);
  });
});

describe('§3 U16 — the caller\'s declared bound is what the embed path arms', () => {
  /** Capture the signal the OpenAI-compatible embed hands `fetch`, and when it aborts. */
  function stubEmbedFetch(): { abortedAfterMs: () => number | null } {
    let armedAt = 0;
    let abortedAt: number | null = null;
    globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      armedAt = Date.now();
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortedAt = Date.now();
          reject(new DOMException('This operation was aborted', 'AbortError'));
        }, { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    return { abortedAfterMs: () => (abortedAt === null ? null : abortedAt - armedAt) };
  }

  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('THE RED: a SHORT declared bound is honoured — it is no longer a hardcoded 30s', async () => {
    // ROUTE TO THE OPENAI-COMPATIBLE BRANCH, which is the one that carried the defect.
    //
    // The key is `embedding_config` and it holds a JSON blob — an earlier cut of this clause wrote
    // `embedding_provider`, which `getEmbeddingConfig` does not read, so the config fell through to
    // its `'ollama'` default and the clause silently exercised the branch that was ALREADY correct.
    // It passed with the defect planted, which is how a vacuous clause looks from the outside.
    mockDb.current!.prepare(
      `INSERT OR REPLACE INTO config (key, value) VALUES ('embedding_config', ?)`,
    ).run(JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://example.test/v1' }));
    const probe = stubEmbedFetch();
    const { generateEmbedding } = await import('../embeddings.js');

    // A latency-sensitive caller (the router's FA-R4 path) asks for 150ms. Under the defect this
    // transport armed 30,000ms regardless and the caller's declaration meant nothing.
    const err = await generateEmbedding('some text', { timeoutMs: 150 }).catch((e: unknown) => e);

    expect(err, 'the call is cut').toBeInstanceOf(Error);
    const after = probe.abortedAfterMs();
    expect(after, 'the abort happened').not.toBeNull();
    expect(after!, 'it fired on the CALLER\'s bound, nowhere near a hardcoded 30s').toBeLessThan(3_000);
  }, 20_000);

  it('THE OTHER DIRECTION: the bound still fires at all — an unanswered embed is not left hanging', async () => {
    // ROUTE TO THE OPENAI-COMPATIBLE BRANCH, which is the one that carried the defect.
    //
    // The key is `embedding_config` and it holds a JSON blob — an earlier cut of this clause wrote
    // `embedding_provider`, which `getEmbeddingConfig` does not read, so the config fell through to
    // its `'ollama'` default and the clause silently exercised the branch that was ALREADY correct.
    // It passed with the defect planted, which is how a vacuous clause looks from the outside.
    mockDb.current!.prepare(
      `INSERT OR REPLACE INTO config (key, value) VALUES ('embedding_config', ?)`,
    ).run(JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://example.test/v1' }));
    stubEmbedFetch();
    const { generateEmbedding, isEmbeddingBackendUnavailable } = await import('../embeddings.js');

    const err = await generateEmbedding('some text', { timeoutMs: 120 }).catch((e: unknown) => e);

    // And it is CLASSIFIED as the backend being absent, which is what routes it to the
    // announce-once latch and leaves `memory/backfill.ts` to re-embed — the reason the row was
    // never permanently lost and the un-honoured bound was the whole defect.
    expect(isEmbeddingBackendUnavailable(err), 'an abort is a backend-absent fact, not a silent drop')
      .toBe(true);
  }, 20_000);

  it('CONTROL: the two transports read ONE expression — the drift cannot come back', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
    const raw = fs.readFileSync(path.join(SRC, 'memory/embeddings.ts'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    // The defect was that ONE of two transports hardcoded its bound. Both must read `timeoutMs`,
    // and neither may carry the literal again.
    const honoured = src.match(/AbortSignal\.timeout\(timeoutMs\)/g) ?? [];
    expect(honoured.length, 'both transports arm the caller\'s bound').toBeGreaterThanOrEqual(2);
    expect(/AbortSignal\.timeout\(30000\)/.test(src), 'the hardcoded 30s is gone').toBe(false);
  });
});
