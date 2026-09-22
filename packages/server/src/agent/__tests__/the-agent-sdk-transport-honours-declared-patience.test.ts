// ════════════════════════════════════════════════════════════════════════════════════
// T81d (NO-DOOMED-DIALS) — THE THIRD-OF-THREE-BECOMES-FOURTH TRANSPORT HONOURS DECLARED
// PATIENCE, AND THE PRE-DIAL GATE STOPS BEING INERT ON IT.
//
// Census row 35: "No timeout/AbortSignal found in this codebase at all for this path" —
// `callAnthropicSdkModel` / `providers/anthropic-sdk.ts`'s `callAnthropicViaSdk` had NEITHER a
// bound derived from `resolveStreamPatience` NOR the T81b pre-dial `refuseIfDoomed` gate the
// other two transports already carry. This file proves both are now wired in, in the same two
// tiers `the-third-transport-honours-declared-patience.test.ts` (T79e) uses for the Ollama
// transport:
//
//   §A — THE MECHANISM: `callAnthropicViaSdk` (providers/anthropic-sdk.ts) driven directly,
//        proving a declared `timeoutMs` genuinely cuts a stalled `query()` call and NAMES the
//        cut distinctly (not a silent "operation aborted"), at a real but tiny millisecond
//        scale — no fake timers, no waiting out `resolveTransportTimeouts`'s 300s floor.
//   §B — THE WIRING: the real `callModel` -> `callAnthropicSdkModel` path, proving the derived
//        bound actually reaches `query()`'s options as an `abortController`, or — for a NULL
//        row — that NOTHING is attached at all (R6 byte-preservation: this transport had no
//        clock before today, so "unchanged" means no `abortController` key, not a lifted one).
//   §C — THE PRE-DIAL GATE (T81b review-round parked finding, closed): the SAME
//        `refuseIfDoomed` check the OpenAI-compat and Anthropic-direct transports already
//        honour, now covering this one too. Mirrors
//        `a-doomed-request-refuses-before-dialing.test.ts`'s own RED/GREEN/CONTROL shape.
//
// This transport has no per-chunk watchdog (query()'s async generator gives no bump() hook), so
// — like the Ollama raw-fetch transport — one flat derived ceiling stands in for the LIVE timer
// (no first-chunk/idle split armed in real time).
//
// ── FIX ROUND (CRITICAL, review round) — §D below ──
// The first cut of this task stopped at "the abort is named" (a plain `Error` with prose
// mentioning "declared patience") and its own in-code comment claimed the richer
// `DECLARED_PATIENCE_EXCEEDED_CODE` could not be produced here. Both were wrong, and the
// reviewer traced the exact chain: a plain `Error` classified 'unknown' in `provider-error.ts`,
// `recordInjury` never set `declaredPatienceHonestFailTurn` (it keys on the CODE), T81c's
// restart-decline never fired, and the Healer's 5s blind auto-wake cold-redialled the identical
// unfinishable prompt — reopening the exact GPU livelock this whole plan exists to close,
// through the one transport this task was scoped to protect. §D drives the REAL `callModel`
// dispatch and proves the code now arrives, that `recordInjury`'s downstream reaction still
// fires for this transport's own error shape, and that a genuine SDK failure (never our own
// timer) keeps today's classification.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

// ── The Claude Agent SDK is mocked module-wide. `agentSdk.mode` switches its one async
// generator between "answers immediately" and "stalls until its AbortController fires" —
// every query() call is recorded verbatim so tests can inspect exactly what `options` this
// transport built, which is the whole fact under test in §B. ──
const agentSdk = vi.hoisted(() => ({
  queryCalls: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
  mode: 'answer' as 'answer' | 'stall' | 'stall-after-content' | 'abort-unrelated',
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    agentSdk.queryCalls.push(args);
    if (agentSdk.mode === 'abort-unrelated') {
      // A genuine SDK failure that happens to look like an abort but is NEVER caused by our own
      // `AbortController` — neither by the patience timer nor by T83's external stop signal.
      // It simulates the third way an "aborted"-sounding error can reach the catch, and §D's
      // control proves all three stay distinguishable there.
      return (async function* abortUnrelated() {
        throw new Error('The operation was aborted.');
        // eslint-disable-next-line no-unreachable
        yield undefined as never;
      })();
    }
    if (agentSdk.mode === 'stall' || agentSdk.mode === 'stall-after-content') {
      return (async function* stall() {
        if (agentSdk.mode === 'stall-after-content') {
          // The model DID start answering before the trip — proves the synthetic watchdog's
          // `sawAnyContent` distinction is honest, not a hardcoded first-chunk claim.
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Working on it' }], usage: {} },
          };
        }
        await new Promise<void>((resolve, reject) => {
          const controller = args.options.abortController as AbortController | undefined;
          if (!controller) return; // no bound armed: a stall here would hang forever, as today
          if (controller.signal.aborted) { reject(new Error('The operation was aborted.')); return; }
          controller.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
        });
        // eslint-disable-next-line no-unreachable
        yield undefined as never; // never reached — the promise above only rejects
      })();
    }
    return (async function* answer() {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'It is done.' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      };
    })();
  },
}));

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t81d-agent-sdk-patience');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t81d-agent-sdk-patience', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, PRE_DIAL_REFUSAL_PHRASE, type ModelCallResult } from '../model.js';
import { callAnthropicViaSdk, AgentSdkPatienceExceededError } from '../../providers/anthropic-sdk.js';
import {
  DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE,
  resolveStreamPatience, resolveTransportTimeouts,
} from '../stream-patience.js';
import { AgentError } from '../errors.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t81d-agent-sdk-patience', '.dojo');

// A short throughput/patience pair, scaled for the suite (same reasoning as T81b's own file):
// 40s of usable patience after the 30s transport margin leaves 10s, at 10 tok/s that is a
// 100-token ceiling — small enough that a short user message dials and a long one refuses,
// with no timer ever armed and no real dispatch delay.
const SCALED_PATIENCE_MS = 40_000;
const SCALED_THROUGHPUT_TOK_PER_SEC = 10;
const SHORT_MESSAGE = 'Is it done?'; // ~3 estimated tokens — well under the ceiling
const LONG_MESSAGE = 'x'.repeat(2_000); // ~500 estimated tokens — well over the ceiling

/** Seed an agent-sdk provider whose row declares (or does not declare) patience/throughput. */
const seedAgentSdk = (
  firstChunkTimeoutMs: number | null,
  streamIdleTimeoutMs: number | null,
  prefillTokensPerSec: number | null,
): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES ('claude-sdk', 'Claude Agent SDK', 'anthropic', 'agent-sdk', ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(firstChunkTimeoutMs, streamIdleTimeoutMs, prefillTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-sdk', 'claude-sdk', 'Claude (SDK)', 'sonnet', '["text","tools"]', 200000, 8192, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-sdk', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

/**
 * §D drives the REAL `callModel` chain (DB reads, budget check, dynamic tool-doc imports) BEFORE
 * it ever reaches `callAnthropicViaSdk`'s own `setTimeout` — so the timer this test needs to fire
 * is not yet SCHEDULED at the instant fake timers take over, and `vi.advanceTimersByTimeAsync`
 * cannot discover a timer that gets registered only partway through its own run. Stepping in
 * small increments gives the pending chain a fresh microtask-flush opportunity between each one.
 *
 * MEASURED, not guessed: driven with `console.log` instrumentation before this helper existed,
 * `callModel`'s own pre-dispatch chain (DB reads, `checkBudget`, `sanitizeOrphanToolBlocks`,
 * `validateAtProviderBoundary`, the dynamic `tools/tool-docs.js` import) consumes roughly
 * 250,000–300,000ms of ADVANCED fake time on its own — each `await` hop only progresses one
 * step per `advanceTimersByTimeAsync` call when nothing is yet due to fire — before `query()` is
 * even reached and the derived-patience timer gets scheduled. `MAX_ADVANCE_MS` below is sized
 * with a wide margin over "that overhead, plus the largest derived bound this file declares", so
 * it does not need retuning if either side drifts slightly; the actual bound fired is what §B
 * independently verifies, not the number this loop advances by.
 */
const MAX_ADVANCE_MS = 2_000_000;

async function advanceUntilSettled<T>(promise: Promise<T>, totalMs = MAX_ADVANCE_MS, stepMs = 1_000): Promise<T | unknown> {
  let settled: { value: T } | { error: unknown } | null = null;
  promise.then((value) => { settled = { value }; }, (error) => { settled = { error }; });
  for (let elapsed = 0; elapsed < totalMs && !settled; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!settled) throw new Error(`promise did not settle within ${totalMs}ms of advanced fake time`);
  return 'error' in settled ? (settled as { error: unknown }).error : (settled as { value: T }).value;
}

/**
 * The INVERSE of the helper above, and §B's NULL-row control depends on it: proof that a call
 * does NOT settle however far the clock is pushed. Stepped identically and for the same
 * measured reason — a timer scheduled partway through `callModel`'s own pre-dispatch chain is
 * only discovered by a LATER step — so "it never settled" is a statement about the whole
 * advanced window, not about the instant the chain happened to reach `query()`.
 */
async function settlesWithin(promise: Promise<unknown>, totalMs = MAX_ADVANCE_MS, stepMs = 1_000): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < totalMs && !settled; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return settled;
}

/** Real-time poll — §D's external-abort control needs the dial to have HAPPENED before it cuts it. */
async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise<void>((r) => { setTimeout(r, 5); });
  }
}

const callAgentSdk = (message: string): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-sdk',
  messages: [{ role: 'user', content: message }],
  systemPrompt: 'You are Claude.',
  tools: false,
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  agentSdk.queryCalls = [];
  agentSdk.mode = 'answer';
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════════════
// §A — THE MECHANISM: `callAnthropicViaSdk` driven directly. `resolveTransportTimeouts`
// floors every non-null bound at 300,000ms (real time), so this section passes `timeoutMs`
// straight to the function under test rather than through the full derivation — exactly how
// T79e's own §A hand-builds a small `Agent` to stand in for "whatever the real clock is".
// ════════════════════════════════════════════════════════════════════════════════════
describe('T81d §A — the mechanism: a declared timeoutMs genuinely cuts a stalled query(), and names it', () => {
  it('RED: a declared timeoutMs aborts a stalled query() instead of hanging forever', async () => {
    agentSdk.mode = 'stall';
    const err = await callAnthropicViaSdk({
      agentId: 'kevin', apiModelId: 'sonnet', systemPrompt: 'you are claude',
      messages: [{ role: 'user', content: 'hi' }], timeoutMs: 50,
    }).catch((e: unknown) => e);

    // A TYPE, not just prose — this is the fact §D's model.ts branch structurally detects.
    expect(err, 'a stalled call with a declared bound must reject, not hang').toBeInstanceOf(AgentSdkPatienceExceededError);
    expect((err as AgentSdkPatienceExceededError).timeoutMs).toBe(50);
    expect((err as AgentSdkPatienceExceededError).sawAnyContent, 'nothing was ever yielded before the trip').toBe(false);
    expect((err as Error).message).toMatch(/aborted after 50ms/i);
    expect((err as Error).message, 'the cut must be NAMED — not a bare unlabeled abort').toMatch(/declared patience/i);
  });

  it('CONTROL: timeoutMs null/undefined builds no AbortController — byte-preserved for a NULL row', async () => {
    agentSdk.mode = 'answer';
    const result = await callAnthropicViaSdk({
      agentId: 'kevin', apiModelId: 'sonnet', systemPrompt: 'you are claude',
      messages: [{ role: 'user', content: 'hi' }], timeoutMs: null,
    });
    expect(result.content).toBe('It is done.');
    const call = agentSdk.queryCalls.at(-1)!;
    expect('abortController' in call.options, 'a NULL timeoutMs must not add an abortController key at all').toBe(false);
  });

  it('a genuine answer still streams through unaffected when a timeoutMs IS declared', async () => {
    agentSdk.mode = 'answer';
    const result = await callAnthropicViaSdk({
      agentId: 'kevin', apiModelId: 'sonnet', systemPrompt: 'you are claude',
      messages: [{ role: 'user', content: 'hi' }], timeoutMs: 60_000,
    });
    expect(result.content).toBe('It is done.');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §B — THE WIRING: the real `callModel` -> `callAnthropicSdkModel` path attaches the derived
// bound (or nothing, for a NULL row) to the real `query()` call. No case here waits on any
// clock — each is a fact read off the recorded `query()` invocation, exactly `the-third-
// transport...`'s §B technique for the Ollama Agent construction.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T81d §B — the real dispatch attaches the derived bound, or nothing for a NULL row', () => {
  it('a declared first-chunk bound of 600s passes a real AbortController into query()', async () => {
    // Independently verified first, so a wrong hand-computed expectation cannot rubber-stamp
    // a wrong implementation: firstChunkMs=600_000 (declared), idleMs=60_000 (standing) ->
    // bodyNeeded = max(600_000, 60_000) + 30_000 margin = 630_000, clears 300_000.
    const expected = resolveTransportTimeouts(
      resolveStreamPatience({ firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null }),
    )!.bodyTimeoutMs;
    expect(expected).toBe(630_000);

    seedAgentSdk(600_000, null, null); // no throughput declared — the pre-dial gate (§C) stays a no-op here
    const result = await callAgentSdk(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');

    const call = agentSdk.queryCalls.at(-1)!;
    expect(call.options.abortController, 'the derived bound must reach query() as a real AbortController').toBeInstanceOf(AbortController);
  });

  it('CONTROL (byte-preservation): a NULL row still streams its answer through, uncut', async () => {
    // ⚠ RE-DERIVED, NOT LOWERED (T83 fix round, review CRITICAL A-1). This clause asserted
    // `'abortController' in call.options === false`, as a proxy for "this transport had no clock
    // before today". That proxy stopped being equivalent to its requirement: T83 threads the
    // STOP BUTTON's signal into this transport (it was the one transport that dropped it, so a
    // stop ran to natural completion while `stopAgent` logged `callsAborted: 1`), and the SDK's
    // `abortController` is the only cancellation lever `Options` exposes — so a controller is
    // now present on every call, carrying cancellation that has nothing to do with patience.
    //
    // The DERIVATION is anchored independently, the way the sibling control below already
    // anchored its own: `signal.aborted` read off an instantly-answering mock is false whether a
    // clock was armed or not, so on its own it discriminates nothing. Fix-round-2 finding NEW-1
    // is exactly that gap, found by mutation; the clause after this one closes the other half.
    expect(resolveTransportTimeouts(
      resolveStreamPatience({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: null }),
    ), 'a row that declared nothing derives no bound to arm').toBeNull();

    seedAgentSdk(null, null, null);
    const result = await callAgentSdk(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');

    const call = agentSdk.queryCalls.at(-1)!;
    expect(call.options.abortController?.signal.aborted ?? false,
      'a row that declared nothing must never be cut by this transport').toBe(false);
  });

  it('CONTROL (byte-preservation): a NULL row arms NO PATIENCE CLOCK — a stall is never cut', async () => {
    // THE DISCRIMINATION, restored (fix round 2, review NEW-1). The sibling clause above reads
    // facts off a call that ANSWERED, and an answered call clears its timer in the transport's
    // own `finally` — so no assertion on it can tell "no timer was armed" from "a 630s timer was
    // armed". A mutant doing exactly that (`transportTimeouts?.bodyTimeoutMs ?? 630_000` at
    // `model.ts`) survived the whole suite. A stalled call is where the two answers differ: with
    // a clock this rejects, without one it hangs, which is precisely what "this transport had no
    // bound before today" MEANS for the row that declares nothing.
    //
    // The fake clock is pushed past any bound this file can derive (630s is the largest) and
    // then two orders of magnitude further, so "it never fired" is not "it had not fired yet".
    agentSdk.mode = 'stall';
    seedAgentSdk(null, null, null);
    vi.useFakeTimers();
    const promise = callAgentSdk(SHORT_MESSAGE);
    promise.catch(() => {}); // avoid an unhandled-rejection warning while time advances
    let settled: boolean;
    try {
      settled = await settlesWithin(promise);
    } finally {
      vi.useRealTimers();
    }

    // Non-vacuous by construction: the dial has to have HAPPENED for the absence of a cut to
    // mean anything, and the stall only hangs because a controller is reachable to hang on.
    expect(agentSdk.queryCalls, 'the transport never dialled — the clause would prove nothing').toHaveLength(1);
    const controller = agentSdk.queryCalls.at(-1)!.options.abortController as AbortController | undefined;
    expect(controller, 'T83 keeps the stop lever reachable even with no patience declared').toBeInstanceOf(AbortController);
    expect(settled, 'a row that declared nothing armed a clock and ended its own call on it').toBe(false);

    // Release the stalled generator through the OTHER aborter — which also shows the lever is
    // live, not merely present, on a row that declared no patience.
    controller!.abort();
    await promise.catch(() => {});
  });

  it('CONTROL: a declaration the standing 300s transport already covers configures nothing here either', async () => {
    // Mirrors T73b/T79e's own control for the other transports: 200s/120s needs 230s of
    // transport headroom and today's default is already 300s, so nothing is lifted.
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: 200_000, streamIdleTimeoutMs: 120_000 });
    expect(resolveTransportTimeouts(patience)).toBeNull();

    seedAgentSdk(200_000, 120_000, null);
    await callAgentSdk(SHORT_MESSAGE);
    const call = agentSdk.queryCalls.at(-1)!;
    // Same re-derivation as the clause above: the controller now also carries the stop signal,
    // so its PRESENCE no longer means "a patience clock was armed". Its signal staying unaborted
    // is what "nothing is lifted" means.
    expect(call.options.abortController?.signal.aborted ?? false).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §C — THE PRE-DIAL GATE, closing the T81b review-round's parked finding. Same shape as
// `a-doomed-request-refuses-before-dialing.test.ts`'s Anthropic-direct block, one transport
// over: `providers.tokens_per_sec` was writable on an agent-sdk provider but inert there —
// this proves it is no longer inert.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T81d §C — the pre-dial doomed-request gate now covers the agent-sdk transport too', () => {
  it('RED: a declared throughput this small refuses a prompt that cannot finish — zero dials attempted', async () => {
    seedAgentSdk(SCALED_PATIENCE_MS, null, SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callAgentSdk(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain(PRE_DIAL_REFUSAL_PHRASE);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect((err as AgentError).retryable).toBe(false);
    // The whole point: the SDK never saw a request at all.
    expect(agentSdk.queryCalls).toHaveLength(0);
  });

  it('GREEN: the same declared throughput dials a prompt that fits the ceiling', async () => {
    seedAgentSdk(SCALED_PATIENCE_MS, null, SCALED_THROUGHPUT_TOK_PER_SEC);
    const result = await callAgentSdk(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(agentSdk.queryCalls).toHaveLength(1);
  });

  it('CONTROL (byte-preservation): NULL throughput dials the SAME oversized prompt exactly as today', async () => {
    seedAgentSdk(SCALED_PATIENCE_MS, null, null);
    const result = await callAgentSdk(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(agentSdk.queryCalls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// FIX ROUND 1 — IMPORTANT I1 + CRITICAL C1 ON THE AGENT-SDK DIAL SITE.
//
// §C above covers a DECLARED throughput here. Self-calibration (owner ruling 2026-09-22) added a
// second source for the same number, and the reviewer showed this dial site's wiring to it could
// be removed with nothing going red. C1 then bounds when that source may arm the gate at all:
// `Settings.tsx` renders the patience pair only where the stream watchdog arms — which excludes
// `authType === 'agent-sdk'` — so an agent-sdk provider cannot declare a first-chunk patience
// from the UI, and a measurement must not refuse its traffic against the standing 90s default.
// ════════════════════════════════════════════════════════════════════════════════════

/** See the C1 clause below for why the standing-patience arm needs a smaller number. */
const C1_THROUGHPUT_TOK_PER_SEC = 5;

/** An agent-sdk provider with NO declared throughput and a measured reading on the row. */
const seedAgentSdkMeasured = (
  firstChunkTimeoutMs: number | null,
  measuredPrefillTokensPerSec: number | null,
): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms,
                           prefill_tokens_per_sec, measured_prefill_tokens_per_sec, measured_prefill_at,
                           is_validated, created_at, updated_at)
    VALUES ('claude-sdk', 'Claude Agent SDK', 'anthropic', 'agent-sdk', ?, NULL, NULL, ?, datetime('now'), 1, datetime('now'), datetime('now'))
  `).run(firstChunkTimeoutMs, measuredPrefillTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-sdk', 'claude-sdk', 'Claude (SDK)', 'sonnet', '["text","tools"]', 200000, 8192, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-sdk', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

describe('fix round 1 §E — the agent-sdk dial site reads the measurement, under C1\'s rule', () => {
  it('I1 RED: patience declared + a measured rate refuses — the SDK is never queried', async () => {
    seedAgentSdkMeasured(SCALED_PATIENCE_MS, SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callAgentSdk(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect((err as AgentError).message).toContain(`this provider's measured ${SCALED_THROUGHPUT_TOK_PER_SEC} tok/s`);
    expect(agentSdk.queryCalls).toHaveLength(0);
  });

  it('⚠ C1: with patience UNDECLARED — which is every agent-sdk row the UI can make — it dials', async () => {
    // A lower rate than the clauses around it, and that is what makes this a real question: an
    // undeclared patience resolves to the STANDING 90s, so the ceiling is 60 × rate. At this
    // file's usual 10 tok/s that is 600 tokens and `LONG_MESSAGE` (~500) fits inside it, so the
    // clause would pass with or without the C1 guard. At 5 tok/s the ceiling is 300 and the
    // prompt is over it — delete the guard and this turns red.
    seedAgentSdkMeasured(null, C1_THROUGHPUT_TOK_PER_SEC);
    const result = await callAgentSdk(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(agentSdk.queryCalls).toHaveLength(1);
  });

  it('CONTROL: the same declared patience with no measurement dials as today', async () => {
    seedAgentSdkMeasured(SCALED_PATIENCE_MS, null);
    const result = await callAgentSdk(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(agentSdk.queryCalls).toHaveLength(1);
  });

  it('GREEN: the same measured rate dials a prompt that fits its ceiling', async () => {
    seedAgentSdkMeasured(SCALED_PATIENCE_MS, SCALED_THROUGHPUT_TOK_PER_SEC);
    const result = await callAgentSdk(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(agentSdk.queryCalls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §D — THE FIX ROUND (CRITICAL, review round): the trip carries DECLARED_PATIENCE_EXCEEDED_CODE
// structurally, all the way up through the REAL `callModel` dispatch — not just as prose on a
// plain `Error`, which is what the first cut shipped and what reopened the livelock this whole
// plan exists to close. Fake timers are used here (unlike §A/§B/§C) because proving the CODE
// arrives at the `callModel` boundary means letting the real, `resolveTransportTimeouts`-derived
// (300s-floored) `setTimeout` actually fire — there is no way to observe the catch block's
// branch decision without it firing.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T81d §D — FIX ROUND: the trip carries DECLARED_PATIENCE_EXCEEDED_CODE through the real dispatch', () => {
  it('RED: a mid-generation patience trip through the REAL callModel dispatch carries DECLARED_PATIENCE_EXCEEDED_CODE', async () => {
    agentSdk.mode = 'stall';
    seedAgentSdk(600_000, null, null); // declared, no throughput — the pre-dial gate (§C) is a no-op here
    vi.useFakeTimers();
    const promise = callAgentSdk(SHORT_MESSAGE);
    promise.catch(() => {}); // avoid an unhandled-rejection warning while time advances
    const err = await advanceUntilSettled(promise);
    vi.useRealTimers();

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code, 'the code must reach callModel\'s boundary, not just the transport\'s own throw').toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).retryable, 'a declared-patience exhaustion is never retryable (P3)').toBe(false);
  });

  it('a trip AFTER the model had already started answering falls to the ordinary retryable STREAM_IDLE_TIMEOUT_CODE, not the honest-fail one', async () => {
    // The synthetic watchdog's `firstChunkTimedOut` reads whether THIS call ever saw content —
    // an honest signal, not a hardcoded "every trip is a first-chunk stall" claim. A stall that
    // starts only after content began is a genuine mid-stream idle case, which keeps the
    // ordinary retry every OTHER mid-stream stall gets, on either of the other two transports.
    agentSdk.mode = 'stall-after-content';
    seedAgentSdk(600_000, null, null);
    vi.useFakeTimers();
    const promise = callAgentSdk(SHORT_MESSAGE);
    promise.catch(() => {});
    const err = await advanceUntilSettled(promise);
    vi.useRealTimers();

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(STREAM_IDLE_TIMEOUT_CODE);
    expect((err as AgentError).retryable, 'a genuine mid-stream idle timeout keeps its ordinary retry').toBe(true);
  });

  it('CONTROL: an abort NOT caused by our own patience timer (a genuine SDK failure) keeps today\'s classification', async () => {
    // Three things can end this call with an "aborted"-looking error: our own timer, T83's
    // external stop signal, and the SDK failing on its own. The first is the clause above, the
    // second the clause below; this is the third, and it proves it stays classified as it always
    // was (`MODEL_CALL_FAILED`), never mistaken for a declared-patience trip.
    agentSdk.mode = 'abort-unrelated';
    seedAgentSdk(600_000, null, null); // patience IS declared — an AbortController is built —
    const err = await callAgentSdk(SHORT_MESSAGE).catch((e: unknown) => e); // — but never fires
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code, 'a genuine SDK failure must not be mistaken for our own timer trip').not.toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).code).toBe('MODEL_CALL_FAILED');
  });

  it('THE STOP, BEHAVIOURALLY (fix round 2, review NEW-2): an external abort CUTS the call and carries no patience code', async () => {
    // A-1's own guards read source text — and a source census reading `model.ts` is what passed
    // while this transport took the signal and dropped it. The shape that would have caught it
    // already existed one transport over (`the-third-transport-…test.ts`'s own external-abort
    // control), so it is mirrored here: a REAL external signal, a REAL in-flight call, in real
    // time.
    //
    // Both halves matter. (a) THE CALL IS CUT: the mock stalls until its controller fires, so a
    // settled promise is proof the stop reached `query()`'s `abortController` — the exact hop
    // that was missing. (b) IT IS NOT A PATIENCE TRIP: 600s is declared and the timer is armed,
    // but only the TIMER sets `timedOutByPatience`, so a stop can never mint the code that tells
    // T81c's restart-decline and the Healer to stand down.
    agentSdk.mode = 'stall';
    seedAgentSdk(600_000, null, null);
    const external = new AbortController();

    const promise = callModel({
      agentId: 'kevin', modelId: 'm-sdk',
      messages: [{ role: 'user', content: SHORT_MESSAGE }],
      systemPrompt: 'You are Claude.',
      tools: false,
      abortSignal: external.signal,
    });
    promise.catch(() => {});
    await waitUntil(() => agentSdk.queryCalls.length > 0);
    external.abort();

    // Bounded on purpose: the regression this clause exists for is a call that RUNS ON, and a
    // 20s suite timeout would report that as "slow test" rather than as the defect. 2s is three
    // orders of magnitude under the 630s bound that IS declared here, so a settle inside it can
    // only be the stop.
    const outcome = await Promise.race([
      promise.then(() => 'cut' as const, () => 'cut' as const),
      new Promise<'ran-on'>((r) => { setTimeout(() => r('ran-on'), 2_000); }),
    ]);
    expect(outcome, 'the stop never reached query() — the call ran on, which is the audited defect').toBe('cut');
    const err = await promise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code, 'a user-requested stop must not be mistaken for our own timer trip')
      .not.toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as Error).message, 'nor may it be NAMED as one').not.toMatch(/declared patience/i);
    expect(agentSdk.queryCalls.at(-1)!.options.abortController?.signal.aborted,
      'the signal the SDK was handed is the one the stop aborted').toBe(true);
  });
});
