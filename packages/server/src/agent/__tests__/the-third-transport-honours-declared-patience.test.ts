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
// ── T83b: THE FLAT CEILING IS GONE, AND WITH IT THE REASON THIS FILE SPIED ON A CONSTRUCTOR ──
// T79e left one flat `AbortSignal.timeout` standing in for both bounds, and this file's original
// describe block could only prove "it armed 630,000, not 300,000" by spying on the constructor:
// there was no watchdog to scale down, so the alternative was five real minutes per case. That
// clock is deleted. `callOllamaModel` now arms the SAME `makeStreamWatchdog` the other two
// transports do, which means the PROVIDER's declared bounds can be scaled to milliseconds and
// every case below observes real behaviour in real time — the sibling patience suites' technique,
// finally available here. §C/§E/§F/§G are that coverage; §ORIGINAL is deleted rather than
// rewritten, because what it pinned (which number reached a constructor) is no longer a fact
// about this transport.
//
// WHY IT WAS DELETED: a flat total-duration ceiling cannot tell a healthy 13 tok/s generation at
// t=301s from a dead socket, and for three consecutive nights it called the first one the second
// — killing Kevin's memory-summarize at 300,001ms and reporting "no data from provider for too
// long" about a stream that had been emitting continuously (ticket-ollama-flat-ceiling.md).
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
// ── THE DISPATCHER CLOCKS ARE STILL THE RIGHT SHAPE UNDERNEATH THE WATCHDOG ──
// §A/§B's subject is undici's `headersTimeout`/`bodyTimeout`, and T83b leaves both exactly as
// T79e wired them. They are INTER-READ timers, not a total duration, so they never had the
// defect the flat `AbortSignal.timeout` had: a stream that keeps emitting keeps resetting them.
// What they still need is to be no TIGHTER than the watchdog above them, which is what
// `resolveTransportTimeouts`' margin buys and what §B reads off a real Agent.
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
import { setLogBroadcast } from '../../logger.js';
import { clearSecretsCache } from '../../config/loader.js';
import {
  callModel, clearClientCache, streamTripBound, makeStreamWatchdog,
  STREAM_IDLE_TIMEOUT_ERROR, STREAM_FIRST_CHUNK_TIMEOUT_ERROR,
  type ModelCallResult, type StreamWatchdog,
} from '../model.js';
import {
  resolveStreamPatience, resolveTransportTimeouts, TRANSPORT_DEFAULT_TIMEOUT_MS,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE,
  type StreamPatience,
} from '../stream-patience.js';
import { AgentError } from '../errors.js';

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
//
// `mode`, T81 fix wave: three new shapes §D needs, none of which any earlier test in this file
// uses (so `preFirstChunkMs`'s own contract above is untouched for every existing case):
//   'answer'            — the original behaviour (headers flush, then `preFirstChunkMs`, then
//                          one content chunk + `done` together).
//   'hold'               — headers flush, then NOTHING — the connection sits open until the
//                          client aborts it. Proves a trip BEFORE any content.
//   'content-then-hold'  — headers flush, ONE content chunk, then nothing — the connection sits
//                          open with `sawAnyContent` already true. Proves a trip AFTER content.
//   'error500'           — an ordinary non-2xx response, no stall involved at all — the CONTROL
//                          proving a genuine HTTP failure is untouched by this task.
//
// `drip`, T83b: the shape the whole ticket is about — a HEALTHY stream that simply takes a long
// time. `dripCount` content chunks `dripGapMs` apart, then `done`. Every gap is small; the TOTAL
// is many multiples of it. That is Kevin's 13 tok/s summarize in miniature, and the only shape
// that can tell a per-chunk watchdog from a total-duration ceiling — they agree on every other
// case in this file.
const behaviour: {
  preFirstChunkMs: number;
  mode: 'answer' | 'hold' | 'content-then-hold' | 'error500' | 'drip';
  dripCount: number;
  dripGapMs: number;
} = { preFirstChunkMs: 0, mode: 'answer', dripCount: 16, dripGapMs: 150 };

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
      if (behaviour.mode === 'error500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders(); // bytes on the wire now: what follows is a BODY gap
      if (behaviour.mode === 'hold') return; // never write anything — a first-chunk stall
      if (behaviour.mode === 'content-then-hold') {
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Working on it' } })}\n`);
        return; // one chunk, then nothing — an idle stall AFTER content
      }
      if (behaviour.mode === 'drip') {
        let sent = 0;
        const tick = (): void => {
          // The client may have cut us; stop the chain rather than writing into a dead socket.
          if (res.writableEnded || res.destroyed) return;
          if (sent < behaviour.dripCount) {
            res.write(`${JSON.stringify({ message: { role: 'assistant', content: `tok${sent} ` } })}\n`);
            sent += 1;
            setTimeout(tick, behaviour.dripGapMs);
            return;
          }
          res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: sent })}\n`);
        };
        setTimeout(tick, behaviour.dripGapMs);
        return;
      }
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
  behaviour.mode = 'answer';
  behaviour.dripCount = 16;
  behaviour.dripGapMs = 150;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  setLogBroadcast(() => {}); // §G installs one; nothing else in this file wants it
  vi.restoreAllMocks();
});

/** A call that streams its chunks back, for the cases that need to watch content arrive. */
const streamingCall = (
  onChunk: (c: string) => void,
  abortSignal?: AbortSignal,
): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-ollama',
  messages: [{ role: 'user', content: 'Is it done?' }],
  systemPrompt: 'You are a local model.',
  tools: false,
  onChunk,
  ...(abortSignal ? { abortSignal } : {}),
});

const waitUntil = async (check: () => boolean, timeoutMs = 4_000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never became true within timeoutMs');
    await new Promise(r => setTimeout(r, 10));
  }
};

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
    // Anchored independently first, the shape fix round 2's NEW-1 finding asked for: "no Agent
    // was built" must be a fact about the ROW, not about what happened to run before it.
    expect(resolveTransportTimeouts(resolveStreamPatience(null)), 'a NULL row has nothing to lift').toBeNull();
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
// §C (T83b) — THE DEFECT ITSELF: A HEALTHY STREAM OUTLIVES ANY TOTAL-DURATION CEILING.
//
// Kevin's nightly memory-summarize failed three consecutive nights at elapsed 300,001–300,030ms
// on a provider row that declares NOTHING — the flat `TRANSPORT_DEFAULT_TIMEOUT_MS`. The box was
// healthy: sibling summarize calls the same nights ran 3,319-in/2,801-out in 211s, i.e. ~13
// tok/s, and the failed job simply needed more than 300s of TOTAL runtime. A wall clock on the
// whole call cannot tell that stream from a dead socket, and it chose "dead" every time.
//
// Scaled, not waited: the row declares bounds in MILLISECONDS (the reader honours any coherent
// positive value — `stream-patience.ts`'s `isCoherent` doc argues why the reader's rule is not
// the write door's), and the stub drips real chunks through a real socket. Every inter-chunk gap
// sits inside the bound; the TOTAL is many multiples of it. That is the one shape a per-chunk
// watchdog and a total-duration ceiling disagree about.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T83b §C — a healthy stream is governed by its gaps, never by its length', () => {
  it('RED (the nightly failure): a steady stream runs far past the bound and is NOT killed', async () => {
    behaviour.mode = 'drip';
    behaviour.dripCount = 16;
    behaviour.dripGapMs = 150; // ~2.4s of streaming, in 150ms steps

    // Both bounds declared at 500ms — SHORTER than the call will take, by a factor of ~5. Under
    // the deleted flat ceiling this row's call is dead at t=500ms with "no data from provider
    // for too long", about a stream that emitted 16 times.
    seedProvider(500, 500);

    const t0 = Date.now();
    const result = await call();
    const elapsed = Date.now() - t0;

    expect(result.content).toContain('tok0');
    expect(result.content, 'the LAST chunk arrived too — the stream was not truncated').toContain('tok15');
    expect(result.outputTokens).toBe(16);
    expect(elapsed, 'the call outlived its own bound several times over, which is the point')
      .toBeGreaterThan(1_500);
  });

  it('CONTROL: the bound is still a bound — a GAP that outlives it cuts the same stream', async () => {
    // The guard against "fixed it by deleting the bound". Same drip machinery, same declared
    // numbers' shape; only the gap moves, from inside the idle bound to outside it.
    behaviour.mode = 'drip';
    behaviour.dripCount = 16;
    behaviour.dripGapMs = 900;
    seedProvider(2_000, 400);

    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(STREAM_IDLE_TIMEOUT_CODE);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §E (T83b) — TWO PHASES, EACH DYING ON ITS OWN BOUND, EACH WITH ITS OWN IDENTITY.
//
// T79e's catch built a synthetic `StreamWatchdog` whose `timedOut()` was hardcoded `true` and
// reported "no data from provider for too long" — a claim about inter-chunk gaps that the flat
// timer had never measured. The real watchdog measures both. These two cases are deliberately
// MIRRORED: the first declares a short first-chunk bound and a long idle one, the second the
// reverse, against the same server. If the phases were not really separate, one of them would
// wait out the other's bound and blow its elapsed assertion.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T83b §E — the first-chunk bound and the idle bound are told apart honestly', () => {
  it('a stall BEFORE any content dies at the FIRST-CHUNK bound, with the first-chunk identity', async () => {
    behaviour.mode = 'hold'; // headers flush, then nothing at all
    seedProvider(600, 15_000); // idle is 25x first-chunk: only one of them can be governing

    const t0 = Date.now();
    const err = await call().catch((e: unknown) => e);
    const elapsed = Date.now() - t0;

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).retryable, 'a declared-patience exhaustion is never retryable (P3)').toBe(false);
    expect((err as AgentError).message).toContain(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
    // T81a's human-facing clause, which only a genuine first-chunk trip may carry.
    expect((err as AgentError).message).toMatch(/estimated prompt tokens against a declared 600ms first-chunk patience/);
    expect(elapsed, 'it died on the 600ms bound, not the 15s one').toBeLessThan(6_000);
  });

  it('a stall AFTER content dies at the IDLE bound, with the idle identity and its ordinary retry', async () => {
    behaviour.mode = 'content-then-hold'; // one content chunk, then nothing
    seedProvider(15_000, 600); // the mirror image of the case above

    const t0 = Date.now();
    const err = await call().catch((e: unknown) => e);
    const elapsed = Date.now() - t0;

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(STREAM_IDLE_TIMEOUT_CODE);
    expect((err as AgentError).retryable, 'a genuine mid-stream idle timeout keeps its ordinary retry (T81a)').toBe(true);
    expect((err as AgentError).message).toContain(STREAM_IDLE_TIMEOUT_ERROR);
    // Not size-driven: a stall after content says nothing about the prompt, so the message must
    // not guess at a fact it does not have. Same control the SSE suite holds for its own path.
    expect((err as AgentError).message).not.toMatch(/estimated prompt tokens/);
    expect(elapsed, 'it died on the 600ms idle bound, not the 15s first-chunk one').toBeLessThan(6_000);
  });

  it('CONTROL: a genuine 500 response keeps MODEL_CALL_FAILED, unchanged', async () => {
    behaviour.mode = 'error500';
    seedProvider(600_000, null); // patience IS declared — a watchdog is armed — but never fires
    const err = await call().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code, 'a genuine HTTP failure must not be mistaken for a watchdog trip').toBe('MODEL_CALL_FAILED');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §F (T83b) — THE DECLARED NUMBER IS THE NUMBER, AND THE STOP IS NEVER A PATIENCE TRIP.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T83b §F — declared bounds honoured exactly; an external stop is not a trip', () => {
  it('a declared first-chunk bound carries a prefill it is sized for', async () => {
    behaviour.preFirstChunkMs = 900; // the box thinks for 900ms before token 1
    seedProvider(3_000, 3_000);
    const result = await call();
    expect(result.content).toBe('It is done.');
  });

  it('and the SAME prefill dies under a shorter declared bound — the number is read, not ignored', async () => {
    behaviour.preFirstChunkMs = 900;
    seedProvider(400, 3_000);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
  });

  it('THE STOP, BEHAVIOURALLY: an external abort CUTS the call and carries no patience code', async () => {
    // Mirrors the agent-sdk transport's own NEW-2 clause (6b975368). Both halves matter.
    // (a) THE CALL IS CUT: the stub holds the connection open after one chunk, so a settled
    // promise can only be the stop reaching `watchdog.signal`'s `AbortSignal.any` composition.
    // (b) IT IS NOT A PATIENCE TRIP: both bounds are declared at 600s and neither can fire
    // inside the window, and `watchdog.timedOut()` is written in the timer callback and nowhere
    // else — so a stop can never mint the code that tells T81c's restart-decline and the
    // Healer's auto-wake to stand down.
    behaviour.mode = 'content-then-hold';
    seedProvider(600_000, 600_000);
    const external = new AbortController();
    const chunks: string[] = [];

    const promise = streamingCall((c) => chunks.push(c), external.signal);
    promise.catch(() => {});
    await waitUntil(() => chunks.length > 0);
    external.abort();

    // Bounded on purpose: the regression this clause exists for is a call that RUNS ON, and the
    // suite timeout would report that as a slow test rather than as the defect.
    const outcome = await Promise.race([
      promise.then(() => 'cut' as const, () => 'cut' as const),
      new Promise<'ran-on'>((r) => { setTimeout(() => r('ran-on'), 2_000); }),
    ]);
    expect(outcome, 'the stop never reached the fetch — the call ran on').toBe('cut');

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code, 'a user-requested stop must not be mistaken for a watchdog trip')
      .not.toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).code).not.toBe(STREAM_IDLE_TIMEOUT_CODE);
    expect((err as Error).message, 'nor may it be NAMED as one')
      .not.toMatch(/declared patience|first-chunk timeout|stream idle timeout/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §G (T83b) — THE UNDECLARED ROW: THIS TRANSPORT'S OWN STANDING BOUND, NAMED HONESTLY.
//
// `mac-studio-ollama` declares nothing, so the numbers it runs on are the ones this transport
// chooses — and the choice is `TRANSPORT_DEFAULT_TIMEOUT_MS` (300s), the bound it has always
// had, now per-phase instead of total. `resolveStreamPatience`'s standing 90s/60s are derived
// from HOSTED behaviour (its own header says so) and arming them here would make an undeclared
// local box LESS patient than it was yesterday: a 31B model reading a 50K prompt is not a dead
// socket at t=91s.
//
// ── WHY THE TRIP ITSELF IS NOT DRIVEN HERE ──
// 300s is a real constant this file cannot shrink for an undeclared row — that is what "the
// standing bound" means — so the two facts are pinned where each can be observed: the ARMED
// NUMBERS off a real call (`setTimeout` is what `makeStreamWatchdog.arm` spends, called through
// to the real implementation), and the WORDING off `streamTripBound`, the one decision the log
// line is built from. The wording's WIRING is then read off a real declared-row trip below, so
// no link in the chain is asserted only in prose.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T83b §G — an undeclared row keeps 300s on both phases, and the log says whose bound it is', () => {
  it('a NULL row arms this transport\'s 300s standing bound, never the hosted 90s default', async () => {
    const armed: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number') armed.push(ms);
      return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    }) as unknown as typeof setTimeout);

    seedProvider(null, null);
    const result = await call();
    expect(result.content).toBe('It is done.');

    expect(armed, 'the undeclared bound is this transport\'s own 300s').toContain(TRANSPORT_DEFAULT_TIMEOUT_MS);
    // The mutant this excludes: `patience.firstChunkMs` passed straight through, which for a
    // NULL row is the hosted 90s and a tightening nobody asked for. (The idle side's 60s is
    // deliberately not asserted against: `ollama-lock.ts`'s QUEUE_TIMEOUT_MS is also 60,000 and
    // a shared number cannot discriminate.)
    expect(armed, 'stream-patience\'s hosted first-chunk default must not reach this transport')
      .not.toContain(STREAM_FIRST_CHUNK_TIMEOUT_MS);
  });

  it('an undeclared trip is not reported as a "declared" one — the lie the flat ceiling told', () => {
    const tripped = (firstChunk: boolean): StreamWatchdog => ({
      ...makeStreamWatchdog(undefined, 1, 1),
      timedOut: () => true,
      firstChunkTimedOut: () => firstChunk,
    });
    const undeclared: StreamPatience = {
      firstChunkMs: TRANSPORT_DEFAULT_TIMEOUT_MS, idleMs: TRANSPORT_DEFAULT_TIMEOUT_MS,
      firstChunkDeclared: false, idleDeclared: false,
    };
    expect(streamTripBound(tripped(true), undeclared)).toBe('the standing 300000ms first-chunk bound');
    expect(streamTripBound(tripped(false), undeclared)).toBe('the standing 300000ms idle bound');
    expect(streamTripBound(tripped(true), undeclared)).not.toMatch(/declared/i);
    expect(streamTripBound(tripped(false), undeclared)).not.toMatch(/declared/i);

    // And the other direction, so "never says declared" is not how it passes: a row that DID
    // declare is named as having declared, per bound, with its own number.
    const declared: StreamPatience = {
      firstChunkMs: 600_000, idleMs: 400_000, firstChunkDeclared: true, idleDeclared: true,
    };
    expect(streamTripBound(tripped(true), declared)).toBe('its declared 600000ms first-chunk bound');
    expect(streamTripBound(tripped(false), declared)).toBe('its declared 400000ms idle bound');

    // The mixed row — declared on one side only — is the one a single flag would get wrong.
    const mixed: StreamPatience = {
      firstChunkMs: 600_000, idleMs: TRANSPORT_DEFAULT_TIMEOUT_MS,
      firstChunkDeclared: true, idleDeclared: false,
    };
    expect(streamTripBound(tripped(true), mixed)).toBe('its declared 600000ms first-chunk bound');
    expect(streamTripBound(tripped(false), mixed)).toBe('the standing 300000ms idle bound');
  });

  it('and that decision is the string the real log line opens with', async () => {
    const warned: string[] = [];
    setLogBroadcast((entry) => { if (entry.level === 'warn') warned.push(entry.message); });
    behaviour.mode = 'hold';
    seedProvider(600, 15_000);
    await call().catch(() => {});

    expect(
      warned.some(w => w.startsWith('Ollama call aborted by its declared 600ms first-chunk bound:')),
      `no log line carried the trip's bound; saw: ${JSON.stringify(warned)}`,
    ).toBe(true);
  });
});
