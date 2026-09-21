// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T64b — THE DECLARED PATIENCE CARRIES A REAL CALL.
//
// The owner's box does not fail a unit test; it fails a model call. So this file drives the
// REAL `callModel` against a REAL OpenAI-compatible HTTP server that behaves the way a local
// inference server behaves: it accepts the request, sends its response headers, and then
// says nothing at all while it reads the prompt. Token 1 arrives long after.
//
// ── THE SHAPE, AND WHY IT IS SCALED ──
// In the field the standing bound is 90 s and the owner's prompt-processing runs past it.
// Here the provider row declares a bound of a few hundred milliseconds and the stub is late
// by more than that: the SAME code path, the SAME watchdog, the SAME translated error, at a
// size a suite can wait for. The bounds are honoured verbatim by the resolver, so the only
// thing that changes between the two arms below is the number in the provider row.
//
// The rows here are written with direct SQL on purpose, and they hold values the write door
// would refuse (its floor is 10 s, pinned in `the-response-patience-door.test.ts`). That is
// legal and it is the whole method: the reader honours any coherent bound, because the floor
// is a kindness to the person typing rather than a claim about what the engine can obey. This
// file is not testing the door — it is testing that whatever is IN the row is what the stream
// is actually bounded by, and writing the row directly is the only way to ask that question
// at a speed a suite can afford. The full-scale version of the same proof, at the owner's own
// 90-second bound against a server that sleeps past it, is the out-of-suite driven run
// recorded in the task report.
//
// ── CONTROL ──
// The NULL row is the one every existing provider has. Its call is made against a prompt
// stub that answers immediately and it succeeds, and the patience it resolved is asserted to
// be the two standing constants — the "nothing declared, nothing moved" arm.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t64b-patience');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t64b-patience', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, STREAM_IDLE_TIMEOUT_ERROR, STREAM_FIRST_CHUNK_TIMEOUT_ERROR, STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, type ModelCallResult } from '../model.js';
import { resolveStreamPatience, DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE } from '../stream-patience.js';
import { AgentError } from '../errors.js';

// Real sockets, a real migration chain per case, and two cases that deliberately wait out a
// bound. Well inside the default 5 s per case, but the margin is stated rather than assumed.
vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t64b-patience', '.dojo');

// ── The stub: a local inference server that thinks before it speaks ──
//
// `preFirstChunkMs` is prompt-processing time: headers go out at once (exactly as
// llama.cpp / vLLM / LM Studio do), then silence. `midStreamStallMs` is a stall AFTER the
// first token, which is the other bound's case.
const behaviour = { preFirstChunkMs: 0, midStreamStallMs: 0, ackOnlyBeforeStall: false };

let server: http.Server;
let stubUrl = '';
let requests = 0;

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({
    id: 'chatcmpl-t64b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-ds4', object: 'model' }] }));
      return;
    }
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    requests += 1;
    // Drain the request body, then behave like a machine that has to read it.
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Headers are out. From the client's point of view the call has connected and
      // nothing has been said — the owner's box, mid prompt-processing.
      const finish = (): void => {
        // The answer arrives in one piece normally, and in two when the stub is asked to
        // stall MID-stream (see `afterFirst`) — either way the client accumulates exactly
        // 'It is done.', so every assertion below reads the same.
        res.write(chunk({ content: behaviour.midStreamStallMs > 0 ? 'is done.' : 'It is done.' }));
        res.write(chunk({}, 'stop'));
        res.write(sse({
          id: 'chatcmpl-t64b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
          choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }));
        res.end('data: [DONE]\n\n');
      };
      const afterFirst = (): void => {
        // The CONTENT-FREE ack frame: `delta: {"role":"assistant","content":""}`, which is
        // what llama.cpp, vLLM, LM Studio and LiteLLM send the instant generation is queued.
        // It proves the socket is open and nothing else.
        res.write(chunk({ role: 'assistant', content: '' }));
        if (behaviour.ackOnlyBeforeStall) {
          // Owner's shape (T72b claim 2): the ack lands, then the machine goes on reading
          // the prompt. Nothing has been GENERATED, so prompt-processing patience is still
          // the bound that applies.
          setTimeout(finish, behaviour.midStreamStallMs);
          return;
        }
        if (behaviour.midStreamStallMs > 0) {
          // A GENUINE mid-stream stall: real generated text, then silence. Until T72b this
          // stub never emitted a token before its "mid-stream" pause, so the cases below
          // were really testing a first-chunk gap and pinning the defect as the contract.
          res.write(chunk({ content: 'It ' }));
          setTimeout(finish, behaviour.midStreamStallMs);
        } else finish();
      };
      if (behaviour.preFirstChunkMs > 0) setTimeout(afterFirst, behaviour.preFirstChunkMs);
      else afterFirst();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

/** Write a provider + model pair whose row declares (or does not declare) its patience. */
const seedProvider = (firstChunkMs: number | null, idleMs: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(stubUrl, firstChunkMs, idleMs);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

const call = (): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-local',
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
  behaviour.midStreamStallMs = 0;
  behaviour.ackOnlyBeforeStall = false;
  requests = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T64b — the first-token bound is the provider\'s to declare', () => {
  it('RED: a bound shorter than the server\'s prompt processing kills the call', async () => {
    behaviour.preFirstChunkMs = 1_200;
    seedProvider(300, null);
    // T72b claim 2: this provider DECLARED its first-chunk bound and then exceeded it, so
    // the error now names that bound instead of borrowing the idle one. The phrase change is
    // the mechanism by which the v2 loop's cold-restart retry is withheld for this shape —
    // re-dialling would restart the whole prompt-processing run the box was most of the way
    // through, to fail at the same declared number again.
    await expect(call()).rejects.toThrow(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
    await expect(call()).rejects.not.toThrow(STREAM_IDLE_TIMEOUT_ERROR);
    expect(requests).toBe(2); // callModel itself never retries; one request per call, as before
  });

  it('T81a RED: the declared-patience exhaustion carries its OWN code, distinct from idle', async () => {
    behaviour.preFirstChunkMs = 1_200;
    seedProvider(300, null);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    // At HEAD (pre-T81a) this was 'stream_idle_timeout' — the same code a genuine dropped
    // connection carries, which is the GPU livelock incident's root cause: provider-error.ts
    // and injury-recovery.ts had nothing coded to tell the two apart.
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).code).not.toBe(STREAM_IDLE_TIMEOUT_CODE);
    // Never retryable — a cold re-dial of a doomed prefill is never the remedy (P3).
    expect((err as AgentError).retryable).toBe(false);
  });

  it('T81a: the message names the prompt size and the declared patience, for the human who reads it', async () => {
    behaviour.preFirstChunkMs = 1_200;
    seedProvider(300, null);
    const err = await call().catch((e: unknown) => e);
    // The exact token count is not asserted (the stub's tiny prompt is not the point) — only
    // that the two facts an owner needs to see WHY are both present in the one string that
    // survives every layer down to `agents.last_error`.
    expect((err as AgentError).message).toMatch(/~\d+ estimated prompt tokens/);
    expect((err as AgentError).message).toContain('declared 300ms first-chunk patience');
  });

  it('T72b: an ACK frame does not spend the declared prompt-processing grant', async () => {
    // THE OWNER'S SHAPE, end to end through the real transport. The server sends
    // `delta:{"role":"assistant","content":""}` at once — which is what put his abort at
    // ~166 s: the ack landed, the 200 s declared bound was replaced by the 60 s idle bound,
    // and the machine was still reading the prompt. Here: the ack is immediate, the real
    // tokens are 1,200 ms behind it, the declared idle bound is a tenth of that, and the
    // declared first-chunk bound covers it. At HEAD the idle bound would have cut this.
    behaviour.ackOnlyBeforeStall = true;
    behaviour.midStreamStallMs = 1_200;
    seedProvider(6_000, 120);
    const result = await call();
    expect(result.content).toBe('is done.');
  });

  it('GREEN: the SAME wait, on the SAME server, carried by a longer declared bound', async () => {
    behaviour.preFirstChunkMs = 1_200;
    seedProvider(6_000, null);
    const result = await call();
    expect(result.content).toBe('It is done.');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// THE IDLE BOUND — AND THE DEFECT THESE CASES UNCOVERED, NOW FIXED (T65b, 2026-08-31).
//
// WHAT THESE CASES ASSERTED WHEN THEY WERE WRITTEN: that a mid-stream stall did NOT raise
// `STREAM_IDLE_TIMEOUT_ERROR` — it returned the partial text as if it were the whole answer,
// carrying the synthesised `end_turn` that says "the model finished normally". That was true
// at HEAD, had nothing to do with T64b, and was pinned rather than fixed here because the
// remedy moves behaviour for every provider that declares nothing, which is the one thing
// T64b's controls forbid. It was handed up in the T64b report and became T65b.
//
// The cause, read at the source and confirmed by standalone probes against the real SDK
// (`openai@6.32.0`, `core/streaming.js:74-76`):
//
//     catch (e) {
//       // If the user calls `stream.controller.abort()`, we should exit without throwing.
//       if (isAbortError(e)) return;
//
// When the watchdog aborted DURING iteration, the `for await` in `callOpenAIModel` simply
// ended and nothing after it consulted `watchdog.timedOut()`, so the function fell through
// to its success return. The first-chunk case escaped only by accident of timing: there the
// abort lands on the awaited `create()`, which does reject.
//
// WHAT T65b CHANGED: `callOpenAIModel` now asks `streamWasCutByWatchdog` the moment the loop
// ends and raises what the SDK dropped, so a stall reaches the same translated
// `stream_idle_timeout` error the first-chunk case has always produced — which also makes
// the v2 loop's one same-model retry reachable for this shape at last. The full RED-first
// record of that fix, its controls (the stop button still keeps its partial text) and the
// Anthropic seam are in `a-stall-is-never-shipped-as-an-answer.test.ts`.
//
// THE CASES BELOW ARE UPDATED, NOT DELETED, AND THEY STILL PROVE T64b'S OWN CLAIM: the
// DECLARED idle bound is the one actually armed. The observable moved from "a truncated
// success comes back" to "the timeout is raised" — and the argument is the same one, because
// under the standing 60 s bound a 1,200 ms stall is not a stall at all and the full answer
// would have arrived.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T64b — the idle bound is separately the provider\'s to declare', () => {
  it('a short declared idle bound cuts the stream at that bound', async () => {
    behaviour.midStreamStallMs = 1_200;
    seedProvider(6_000, 300);
    // Cut before the content chunk. Under the standing 60 s bound the stub's 1,200 ms pause
    // would have passed unnoticed and this would be 'It is done.', so the declared 300 ms is
    // demonstrably the number in force.
    await expect(call()).rejects.toThrow(STREAM_IDLE_TIMEOUT_ERROR);
  });

  it('GREEN: the same stall, on the same server, carried by a longer declared idle bound', async () => {
    behaviour.midStreamStallMs = 1_200;
    seedProvider(6_000, 6_000);
    const result = await call();
    expect(result.content).toBe('It is done.');
  });

  it('a generous first-token bound does NOT silently widen the idle bound', async () => {
    // The two are independent knobs, and this is the case that proves the second one is real
    // rather than a label on the first: six seconds of patience for prompt processing buys
    // nothing at all for a stalled stream.
    behaviour.preFirstChunkMs = 400;
    behaviour.midStreamStallMs = 1_200;
    seedProvider(6_000, 300);
    await expect(call()).rejects.toThrow(STREAM_IDLE_TIMEOUT_ERROR);
  });

  it('WAS PINNED AS A DEFECT, NOW ASSERTS THE FIX: a mid-stream stall is raised, not shipped', async () => {
    // This case used to read `expect(result.content).toBe('')` and
    // `expect(result.stopReason).toBe('end_turn')` — a truncated answer, reported as a
    // normal completion, returned as a success — with a note saying that when it started
    // failing because the call rejected instead, the defect had been fixed and the case
    // should become the timeout assertion. T65b fixed it; this is that assertion.
    behaviour.midStreamStallMs = 1_200;
    seedProvider(6_000, 300);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('stream_idle_timeout');
    expect((err as AgentError).retryable).toBe(true);
    // And no fabricated stop reason survives on the abort path: there is no result at all to
    // carry one. That was the last place TB8 job 1's `end_turn` was still being invented.
    expect((err as AgentError).message).toContain(STREAM_IDLE_TIMEOUT_ERROR);
  });

  it('T81a CONTROL: a genuine mid-stream stall never picks up the declared-patience code or clause', async () => {
    behaviour.midStreamStallMs = 1_200;
    seedProvider(6_000, 300);
    const err = await call().catch((e: unknown) => e);
    expect((err as AgentError).code).not.toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    // Not size-driven — a stall after content has already started says nothing about the
    // prompt, and the message must not guess at a fact it doesn't have.
    expect((err as AgentError).message).not.toMatch(/estimated prompt tokens/);
  });
});

describe('T64b — CONTROL: a provider that declares nothing is untouched', () => {
  it('resolves to exactly the two standing constants', () => {
    seedProvider(null, null);
    const row = mockDb.current!.prepare(
      'SELECT first_chunk_timeout_ms AS f, stream_idle_timeout_ms AS i FROM providers WHERE id = ?',
    ).get('local') as { f: number | null; i: number | null };
    expect(row).toEqual({ f: null, i: null });
    expect(resolveStreamPatience({ firstChunkTimeoutMs: row.f, streamIdleTimeoutMs: row.i }))
      .toEqual({
        firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS,
        idleMs: STREAM_IDLE_TIMEOUT_MS,
        // T72b claim 2: "declared nothing" is now a fact the resolver states, because it is
        // what decides whether a first-chunk timeout keeps the loop's retry. A NULL row
        // declares nothing, so this provider keeps every behaviour it had.
        firstChunkDeclared: false,
        // T83b: the same statement for the idle side, added because a transport whose own
        // standing bound is not this module's (the Ollama native path) cannot tell a declared
        // 60,000 from a defaulted one otherwise. `toEqual` is exact on purpose — a field
        // appearing on this resolver is a fact about every caller, so it lands here.
        idleDeclared: false,
      });
  });

  it('and its call round-trips exactly as it always did', async () => {
    seedProvider(null, null);
    const result = await call();
    expect(result.content).toBe('It is done.');
    // The provider says `stop`; `resolveOpenAIStopReason` synthesises that one to `end_turn`
    // (TB8 job 1 keeps only the reasons the synthesis could not already say). Asserted as it
    // is, not as I first assumed it was.
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(11);
  });
});
