// ════════════════════════════════════════════════════════════════════════════════════
// T79e — THE THIRD TRANSPORT HONOURS DECLARED PATIENCE.
//
// `model.ts:954` bounded the Ollama native `/api/chat` call with a flat
// `AbortSignal.timeout(300000)` that read neither patience column — a ceiling of its own
// making that happened to land on undici's unconfigured 300 s, and gave the owner's DS4 box
// (~200 tok/s cold prefill) a hard cap around 55K prompt tokens against conversations that
// run 42–52K. `callOpenAIModel` and the Anthropic-direct path already derive their transport
// clock from the provider row via `resolveStreamPatience` / `resolveTransportTimeouts`
// (T64b/T73b); this is that same derivation reaching the third transport.
//
// ── FIX-ROUND FINDING (CRITICAL): THE ABORT SIGNAL ALONE WAS NOT ENOUGH ──
// The first pass derived the `AbortSignal.timeout` argument correctly but never attached a
// `dispatcher` to the `fetch` call. Node's built-in `fetch` runs on undici's GLOBAL dispatcher
// unless one is explicitly attached, and that global dispatcher carries its OWN independent
// `headersTimeout`/`bodyTimeout` (unconfigured default: 300,000 — same fact this file's sibling,
// `the-transport-honours-the-declared-patience.test.ts`, documents for the other two
// transports). An `AbortSignal` and a dispatcher clock are two unrelated timers racing the same
// socket, and whichever fires first wins — so a declared 600 s row still died at ~300 s in
// production even with the "correct" `AbortSignal.timeout(630000)` armed. §A and §B below are
// the fix round's new coverage for exactly that gap; the original describe block below them is
// the first pass's coverage of the abort-DURATION arithmetic, kept because it is still true and
// still useful, just no longer sufficient on its own.
//
// ── WHY THE ABORT-DURATION NUMBER IS OBSERVED BY SPYING, NOT BY WAITING ──
// `TRANSPORT_DEFAULT_TIMEOUT_MS` (300,000) is a real constant this file cannot shrink — unlike
// the SSE-transport patience tests, which scale the PROVIDER's declared bound down to make a
// watchdog fire quickly, there is no separate watchdog here to scale: the single
// `AbortSignal.timeout` call IS the bound. Proving "it armed at 630,000, not 300,000" by waiting
// would cost the suite over five real minutes per case. `vi.spyOn(AbortSignal, 'timeout')` calls
// straight through to the real implementation (nothing is faked about what the signal DOES),
// and simply reports the one number under test.
//
// ── WHY §A/§B ARE STILL TIMING-FREE (NO CASE WAITS OUT 300 S) ──
// §A proves the GENERAL mechanism (an attached dispatcher's own clock governs, independent of
// any AbortSignal) at a scaled size — a hand-built small `Agent` standing in for "whatever the
// ambient default is", exactly the technique the sibling file's §2 uses, and for the identical
// reason: the real default is 300,000 ms and cannot be shrunk. §B proves the WIRING (the real
// call path attaches the Agent `resolveTransportTimeouts` actually derives, or none at all for a
// NULL row) without waiting on any clock, by recording `Agent` construction and `connect` events
// on a REAL subclass of the REAL `undici.Agent` — the sibling file's own §3 technique.
//
// ── THIS IS NOT THE WATCHDOG'S SHAPE, AND THAT IS DELIBERATE (OUT OF SCOPE, STATED) ──
// This transport arms no `makeStreamWatchdog` — no bump()/contentStarted(), no separate
// first-chunk-vs-idle phase, no translated timeout phrase. One flat clock has always had to
// stand in for both. `resolveTransportTimeouts` already folds both bounds into `bodyTimeoutMs`
// (`max(headersTimeoutMs, bodyTimeoutMs)` by construction — `bodyNeeded` is derived from
// `max(firstChunkMs, idleMs)`), so that one number is the correct single ceiling for BOTH the
// `AbortSignal` and the dispatcher's own clocks: never tighter than either declared bound.
// Adding a real watchdog to this path is a bigger change than "honour the stored bound" and is
// not what this task does.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import { Agent } from 'undici';
import type { AddressInfo } from 'node:net';

// ── The Agent wrapper §B reads ──
//
// A SUBCLASS of the real `undici.Agent` (this file's own sibling's exact technique), so every
// Agent built anywhere in this file — including the two §A builds by hand — is a real
// dispatcher doing real work. It records the options it was constructed with and counts the
// connections it actually carried, which is what turns "the client was wired to this clock"
// from a claim about a constructor into an observation.
interface AgentBuild { options: { headersTimeout?: number; bodyTimeout?: number }; connects: () => number }
const built = vi.hoisted(() => ({ agents: [] as AgentBuild[] }));

vi.mock('undici', async (orig) => {
  const real = await orig<typeof import('undici')>();
  class RecordingAgent extends real.Agent {
    constructor(options: ConstructorParameters<typeof real.Agent>[0]) {
      super(options);
      let connects = 0;
      this.on('connect', () => { connects += 1; });
      built.agents.push({ options: (options ?? {}) as AgentBuild['options'], connects: () => connects });
    }
  }
  return { ...real, Agent: RecordingAgent };
});

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t79e-ollama-patience');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t79e-ollama-patience', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { resolveStreamPatience, resolveTransportTimeouts, TRANSPORT_DEFAULT_TIMEOUT_MS } from '../stream-patience.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t79e-ollama-patience', '.dojo');

// ── The stub: Ollama's native `/api/chat`, newline-delimited JSON ──
//
// Headers are flushed immediately (exactly as llama.cpp/vLLM/LM Studio do, and as the sibling
// file's own stub does for the same reason: without an explicit flush, Node holds the headers
// until the first body write, which would turn every stall case below into a headers-gap case
// instead of the body-gap case under test). `behaviour.preFirstChunkMs` then stalls before any
// body byte goes out — the shape `resolveTransportTimeouts`'s `bodyTimeoutMs` bounds. Every case
// in the ORIGINAL describe block below (the abort-duration arithmetic) leaves this at 0 and
// answers at once, since the point there is which number was armed, not whether it fires.
const behaviour = { preFirstChunkMs: 0 };

let server: http.Server;
let stubUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/chat')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders(); // bytes on the wire now: what follows is a BODY gap
      const write = (): void => {
        if (res.writableEnded || res.destroyed) return; // the client may have already aborted
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'It is done.' } })}\n`);
        res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 4 })}\n`);
      };
      if (behaviour.preFirstChunkMs > 0) setTimeout(write, behaviour.preFirstChunkMs);
      else write();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

/** Write a provider + model pair whose row declares (or does not declare) its patience. */
const seedProvider = (firstChunkMs: number | null, idleMs: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms, is_validated, created_at, updated_at)
    VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(stubUrl, firstChunkMs, idleMs);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-ollama', 'local-ollama', 'Local DS4', 'ds4-local', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-ollama', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

const call = (): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-ollama',
  messages: [{ role: 'user', content: 'Is it done?' }],
  systemPrompt: 'You are a local model.',
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
  behaviour.preFirstChunkMs = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════════════
// §A — THE MECHANISM: an attached dispatcher's own clock governs a fetch call,
// INDEPENDENTLY of whatever AbortSignal rides alongside it.
//
// This is the fact the fix round's critical finding rests on, proven directly and without
// going through `model.ts` at all — a real `fetch`, a real socket, a real `undici.Agent`.
// Scaled: a 400 ms Agent stands in for "whatever the ambient default is" (the real default is
// 300,000 ms and cannot be shrunk for a test), exactly as the sibling file's §2 does for the
// SSE transports.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T79e §A — the mechanism: the ATTACHED dispatcher governs, not the AbortSignal', () => {
  const STALL_MS = 2_000;

  it('RED: a short dispatcher kills a stall a much larger AbortSignal would have permitted', async () => {
    behaviour.preFirstChunkMs = STALL_MS;
    const smallAgent = new Agent({ headersTimeout: 400, bodyTimeout: 400 });
    // A plain try/catch, not `.then(ok, fail)`: the connection resolves its HEADERS fine (the
    // stub flushes them immediately), so `fetch()` itself fulfils — it is the BODY read below
    // that hits the small Agent's clock, and an error thrown inside a `.then` fulfilment
    // handler does not reach that same call's rejection handler.
    let err: (Error & { code?: string; cause?: { code?: string } }) | null = null;
    try {
      const r = await fetch(`${stubUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        // Thirty seconds — nowhere near firing during a two-second stall. If the AbortSignal
        // were the only clock in play, as it was before this fix round, this call would survive.
        signal: AbortSignal.timeout(30_000),
        dispatcher: smallAgent,
      } as RequestInit);
      await r.text();
    } catch (e) {
      err = e as typeof err;
    }

    expect(err).not.toBeNull();
    const code = err!.code ?? err!.cause?.code;
    expect(code).toBe('UND_ERR_BODY_TIMEOUT');
  });

  it('GREEN: the SAME stall survives when the attached dispatcher is sized to match', async () => {
    behaviour.preFirstChunkMs = STALL_MS;
    const matchedAgent = new Agent({ headersTimeout: STALL_MS + 3_000, bodyTimeout: STALL_MS + 3_000 });
    const response = await fetch(`${stubUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
      dispatcher: matchedAgent,
    } as RequestInit);
    const text = await response.text();
    expect(text).toContain('It is done.');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §B — THE WIRING: the real `callOllamaModel` path attaches the Agent
// `resolveTransportTimeouts` actually derives — or none at all for a NULL row.
//
// No case here waits on a clock: each is a construction-and-connection fact, read off the
// dispatcher itself, exactly the sibling file's §3 technique. Each declares a DIFFERENT
// patience than every other test in this file (including §ORIGINAL below), because
// `transportAgentCache` in `model.ts` is keyed by the derived clock and persists for the whole
// file — two tests sharing a clock would have the second answered out of that cache, which
// would make "no new Agent was built" a fact about test order rather than about the row.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T79e §B — the real call attaches the derived dispatcher, or none for a NULL row', () => {
  it('a declared row\'s fetch is carried by an Agent built with the derived clock', async () => {
    const before = built.agents.length;
    // 900s declared, no idle -> bodyNeeded = max(900_000, 60_000) + 30_000 = 930_000 =
    // headersNeeded, so both bounds land on 930_000. A combo no other test in this file uses.
    seedProvider(900_000, null);
    const result = await call();
    expect(result.content).toBe('It is done.');

    expect(built.agents.length).toBe(before + 1);
    const agent = built.agents[before];
    expect(agent.options).toEqual({ headersTimeout: 930_000, bodyTimeout: 930_000 });
    // And the request actually went out on it — the dispatcher's own connect event, not an
    // inference from the constructor having run. This is the exact fact the critical finding
    // says was missing: an Agent could be BUILT with the right numbers and the real request
    // still ride the global default instead, if nothing attached it to the fetch call.
    expect(agent.connects()).toBeGreaterThanOrEqual(1);
  });

  it('CONTROL: a NULL row attaches no dispatcher at all — the call rides the global default', async () => {
    const before = built.agents.length;
    seedProvider(null, null);
    const result = await call();
    expect(result.content).toBe('It is done.');
    // Nothing constructed means no `dispatcher` key was ever passed to `fetch` — the call goes
    // out on undici's global dispatcher exactly as it did before this task existed. This is R6
    // at the client-configuration layer, not just the abort-duration layer.
    expect(built.agents.length).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §ORIGINAL — the abort-duration arithmetic (the first pass's coverage).
//
// Still true and still worth pinning: `AbortSignal.timeout` must be armed with the derived
// bound, not the flat 300 s. Kept exactly as the fix round found it, with two fixes applied:
// the idle-only case now computes its expectation the same way its siblings do (rather than a
// hand-typed number in a comment), and `resolveStreamPatience` is now called with `modelInfo`
// directly wherever this file mirrors it, matching `callOpenAIModel` / the Anthropic-direct
// path's own call shape.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T79e — the Ollama transport clock is derived from the declared patience', () => {
  it('a declared first-chunk bound of 600s arms the abort at the derived bound, not 300s', async () => {
    // The exact pin the task brief names. Verified independently first, so a wrong
    // hand-computed expectation in this test cannot rubber-stamp a wrong implementation:
    // firstChunkMs=600_000 (declared), idleMs=60_000 (standing, undeclared) ->
    // bodyNeeded = max(600_000, 60_000) + 30_000 margin = 630_000, which clears 300_000 so
    // it is the number `resolveTransportTimeouts` returns rather than the 300s default.
    const expected = resolveTransportTimeouts(
      resolveStreamPatience({ firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null }),
    )!.bodyTimeoutMs;
    expect(expected).toBe(630_000);
    expect(expected).not.toBe(TRANSPORT_DEFAULT_TIMEOUT_MS);

    const spy = vi.spyOn(AbortSignal, 'timeout');
    seedProvider(600_000, null);
    const result = await call();
    expect(result.content).toBe('It is done.');
    expect(spy).toHaveBeenCalledWith(630_000);
    expect(spy).not.toHaveBeenCalledWith(300_000);
  });

  it('a declared idle bound alone also lifts the flat abort (there is no separate idle phase here)', async () => {
    // This transport has no watchdog to split first-chunk from idle, so BOTH bounds have to
    // be carried by the one number — proven by declaring only the idle side and getting a
    // lifted bound anyway. Computed the same way the sibling cases in this describe block are,
    // rather than hand-typed: firstChunkMs=90_000 (standing), idleMs=500_000 (declared).
    const expected = resolveTransportTimeouts(
      resolveStreamPatience({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: 500_000 }),
    )!.bodyTimeoutMs;
    expect(expected).toBe(530_000);

    const spy = vi.spyOn(AbortSignal, 'timeout');
    seedProvider(null, 500_000);
    const result = await call();
    expect(result.content).toBe('It is done.');
    expect(spy).toHaveBeenCalledWith(expected);
  });

  it('CONTROL: a NULL row preserves the exact pre-existing 300s bound, byte for byte', async () => {
    // R6: byte-preservation outranks symmetry. `resolveTransportTimeouts` of the NULL-row
    // standing patience (90s/60s) is `null` — nothing to lift — so this call site must fall
    // back to the LITERAL 300000 that shipped before this task, not some other number this
    // function's arithmetic could otherwise produce.
    expect(resolveTransportTimeouts(resolveStreamPatience(null))).toBeNull();

    const spy = vi.spyOn(AbortSignal, 'timeout');
    seedProvider(null, null);
    const result = await call();
    expect(result.content).toBe('It is done.');
    expect(spy).toHaveBeenCalledWith(300_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a declaration the standing 300s transport already covers configures nothing', async () => {
    // Mirrors T73b's own control for the other two transports: 200s/120s needs 230s of
    // transport headroom and today's is already 300s, so nothing is lifted and the call
    // goes out on the exact same 300s bound as an undeclared row.
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: 200_000, streamIdleTimeoutMs: 120_000 });
    expect(resolveTransportTimeouts(patience)).toBeNull();

    const spy = vi.spyOn(AbortSignal, 'timeout');
    seedProvider(200_000, 120_000);
    await call();
    expect(spy).toHaveBeenCalledWith(300_000);
  });
});
