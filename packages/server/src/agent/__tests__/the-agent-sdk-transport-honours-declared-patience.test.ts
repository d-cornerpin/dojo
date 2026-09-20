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
// This transport has no per-chunk watchdog (query()'s async generator gives no bump() hook),
// so — like the Ollama raw-fetch transport — one flat derived ceiling stands in for both the
// first-chunk and idle bounds, with no translated `DECLARED_PATIENCE_EXCEEDED_CODE` (that code
// is a `StreamWatchdog` concept this transport does not have); the abort is still NAMED,
// distinctly, so it never reads as a silent hang or an unlabeled network blip.
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
  mode: 'answer' as 'answer' | 'stall',
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    agentSdk.queryCalls.push(args);
    if (agentSdk.mode === 'stall') {
      return (async function* stall() {
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
import { callAnthropicViaSdk } from '../../providers/anthropic-sdk.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE, resolveStreamPatience, resolveTransportTimeouts } from '../stream-patience.js';
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

    expect(err, 'a stalled call with a declared bound must reject, not hang').toBeInstanceOf(Error);
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

  it('CONTROL (byte-preservation): a NULL row passes no abortController — this transport had no clock before today', async () => {
    seedAgentSdk(null, null, null);
    const result = await callAgentSdk(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');

    const call = agentSdk.queryCalls.at(-1)!;
    expect('abortController' in call.options).toBe(false);
  });

  it('CONTROL: a declaration the standing 300s transport already covers configures nothing here either', async () => {
    // Mirrors T73b/T79e's own control for the other transports: 200s/120s needs 230s of
    // transport headroom and today's default is already 300s, so nothing is lifted.
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: 200_000, streamIdleTimeoutMs: 120_000 });
    expect(resolveTransportTimeouts(patience)).toBeNull();

    seedAgentSdk(200_000, 120_000, null);
    await callAgentSdk(SHORT_MESSAGE);
    const call = agentSdk.queryCalls.at(-1)!;
    expect('abortController' in call.options).toBe(false);
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
