// ════════════════════════════════════════════════════════════════════════════════════
// NO-DOOMED-DIALS T81b — A DOOMED REQUEST NEVER REACHES THE WIRE.
//
// Census row 37: `agent/model.ts` already computes a token estimate for the exact request
// about to go out, on every transport, immediately before dispatch. This file drives the REAL
// `callModel` and proves the estimate is now compared against a REAL ceiling BEFORE any socket
// opens — not a unit test of the arithmetic (that lives in
// `a-provider-declares-its-own-prefill-throughput.test.ts`), but a proof that the arithmetic
// is actually wired into the two live dial sites at the point a request would otherwise leave
// the process.
//
// ── WHY SCALED NUMBERS, NOT THE INCIDENT'S OWN ──
// The incident's fixture (110K tokens, 180 tok/s, 600s) needs no real waiting to prove here —
// a refusal is instant, there is no timer involved — but building a ~440KB prompt just to
// clear `estimateTokens`'s 4-chars-per-token floor is unnecessary weight for a suite that only
// needs to prove WIRING. Scaled numbers (a low declared throughput, a patience comfortably
// above `TRANSPORT_MARGIN_MS`) produce a small, human-sized ceiling faster to assert against,
// in `the-patience-carries-a-real-call.test.ts`'s own idiom of scaling the SIZE of the proof
// while keeping the SHAPE of the mechanism real.
//
// ── CONTROL ──
// A NULL `prefill_tokens_per_sec` — every provider configured before this task — dials exactly
// as it does today, for a prompt of any size, on both transports.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// ── The Anthropic SDK is mocked for the Anthropic-direct half of this file only. It never
// reaches a real network in this suite regardless of arm (refuse or dial-control), so the
// mock's job is purely to answer "was `.messages.stream` ever called" — the one fact this file
// needs from that transport. ──
const anthropic = vi.hoisted(() => ({ streamCalls: [] as unknown[] }));

vi.mock('@anthropic-ai/sdk', () => {
  // The real `MessageStream` is an event emitter (`.on('text'|'contentBlock'|'streamEvent', …)`)
  // plus `.finalMessage()` — not a plain async iterable — which is exactly what
  // `callModel`'s Anthropic-direct arm drives. This fake answers with content-free success
  // immediately: nothing in this file's GREEN/CONTROL cases reads the answer text, only
  // whether the dial happened at all.
  class FakeStream {
    on(): FakeStream { return this; }
    async finalMessage(): Promise<{ content: never[]; usage: { input_tokens: number; output_tokens: number } }> {
      return { content: [], usage: { input_tokens: 1, output_tokens: 1 } };
    }
  }
  class FakeAnthropic {
    messages = {
      stream: (...args: unknown[]): FakeStream => {
        anthropic.streamCalls.push(args);
        return new FakeStream();
      },
    };
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic, APIError: FakeAnthropic.APIError };
});

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t81b-doomed-dial');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t81b-doomed-dial', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_FIRST_CHUNK_TIMEOUT_MS } from '../stream-patience.js';
import { PRE_DIAL_REFUSAL_PHRASE } from '../model.js';
import { AgentError } from '../errors.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t81b-doomed-dial', '.dojo');

// A short throughput/patience pair, scaled for the suite (see header): 40s of usable patience
// after the 30s transport margin leaves 10s, at 10 tok/s that is a 100-token ceiling — small
// enough that a short user message dials and a long one refuses, with no timer ever armed.
const SCALED_PATIENCE_MS = 40_000;
const SCALED_THROUGHPUT_TOK_PER_SEC = 10;
const SHORT_MESSAGE = 'Is it done?'; // ~3 estimated tokens — well under the ceiling
const LONG_MESSAGE = 'x'.repeat(2_000); // ~500 estimated tokens — well over the ceiling

let server: http.Server;
let stubUrl = '';
let openaiRequests = 0;

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({
    id: 'chatcmpl-t81b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
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
    openaiRequests += 1;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(chunk({ content: 'It is done.' }));
      res.write(chunk({}, 'stop'));
      res.write(sse({
        id: 'chatcmpl-t81b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
        choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

/** Seed an OpenAI-compatible provider whose row declares (or does not declare) throughput. */
const seedOpenAICompatible = (prefillTokensPerSec: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(stubUrl, SCALED_PATIENCE_MS, prefillTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

/**
 * T81 fix wave (final review, Minor M2): a provider that declares ONLY its prefill throughput
 * and leaves `first_chunk_timeout_ms` NULL — `patience.firstChunkMs` resolves to the STANDING
 * default, not anything this row declared, which is the exact case `refuseIfDoomed`'s wording
 * got wrong.
 */
const seedOpenAICompatibleUndeclaredFirstChunk = (prefillTokensPerSec: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'none', ?, 1, datetime('now'), datetime('now'))
  `).run(stubUrl, prefillTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

/** Seed an Anthropic-direct provider whose row declares (or does not declare) throughput. */
const seedAnthropicDirect = (prefillTokensPerSec: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES ('anthropic', 'Anthropic', 'anthropic', 'api_key', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(SCALED_PATIENCE_MS, prefillTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-anthropic', 'anthropic', 'Claude', 'claude-x', '["text","tools"]', 200000, 8192, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-anthropic', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
  setProviderCredential('anthropic', 'sk-ant-fake-test-key', 'api_key');
};

const callOpenAICompatible = (message: string): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-local',
  messages: [{ role: 'user', content: message }],
  systemPrompt: 'You are a local model.',
  tools: false,
});

const callAnthropicDirect = (message: string): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-anthropic',
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
  openaiRequests = 0;
  anthropic.streamCalls = [];
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T81b — OpenAI-compatible transport: RED, then the fix', () => {
  it('RED: a declared throughput this small refuses a prompt that cannot finish — zero dials attempted', async () => {
    seedOpenAICompatible(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain(PRE_DIAL_REFUSAL_PHRASE);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect((err as AgentError).retryable).toBe(false);
    // The whole point: the server never saw a request at all.
    expect(openaiRequests).toBe(0);
  });

  it('the refusal message names the estimate, the ceiling and both remedies', async () => {
    seedOpenAICompatible(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    const msg = (err as AgentError).message;
    expect(msg).toMatch(/~\d+ estimated prompt tokens/);
    expect(msg).toMatch(/~\d+-token ceiling/);
    expect(msg).toMatch(/compact the conversation/i);
    expect(msg).toMatch(/raise this provider's declared patience or prefill throughput/i);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // T82a (ANSWER-ANYWAY) — POST-T82a THIS GATE IS A BACKSTOP, NOT THE MECHANISM.
  //
  // T82a taught `memory/budget.ts`'s admission budget and `memory/compaction.ts`'s own
  // compaction trigger this SAME `resolveDoomCeiling` arithmetic, so a healthy turn's
  // assembly is planned to fit inside it long before a dial is ever attempted. This gate
  // (T81b) stays as the pre-dial ASSERTION it always was structurally, but its meaning
  // changes: seeing this refusal fire now means the budget upstream was sized wrong, not
  // that nothing upstream tried.
  // ══════════════════════════════════════════════════════════════════════════════════════
  it('RED (T82a): the refusal names itself a backstop and points at the upstream budget', async () => {
    seedOpenAICompatible(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    const msg = (err as AgentError).message;
    expect(msg).toMatch(/upstream budget/i);
  });

  it('GREEN: the same declared throughput dials a prompt that fits the ceiling', async () => {
    seedOpenAICompatible(SCALED_THROUGHPUT_TOK_PER_SEC);
    const result = await callOpenAICompatible(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(openaiRequests).toBe(1);
  });

  it('CONTROL (byte-preservation): NULL throughput dials the SAME oversized prompt exactly as today', async () => {
    seedOpenAICompatible(null);
    const result = await callOpenAICompatible(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(openaiRequests).toBe(1);
  });
});

describe('T81b — Anthropic-direct transport: RED, then the fix', () => {
  it('RED: a declared throughput this small refuses before the client ever streams — zero dials attempted', async () => {
    seedAnthropicDirect(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callAnthropicDirect(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect(anthropic.streamCalls).toHaveLength(0);
  });

  it('CONTROL (byte-preservation): NULL throughput reaches the real dial exactly as today', async () => {
    seedAnthropicDirect(null);
    await callAnthropicDirect(LONG_MESSAGE);
    expect(anthropic.streamCalls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// T81 FIX WAVE (NO-DOOMED-DIALS final review, Minor M2) — THE WORDING IS HONEST ABOUT
// STANDING VS DECLARED PATIENCE.
//
// `refuseIfDoomed`'s message said "its declared ${firstChunkMs}ms first-chunk patience"
// UNCONDITIONALLY — but `resolveDoomCeiling` only needs `prefillTokensPerSec` to be declared;
// `patience.firstChunkMs` can still be the STANDING default (nobody declared it) when a
// provider declares throughput alone. The refusal then claimed a number was "declared" that
// nobody set. `patience.firstChunkDeclared` (T72b) already answers which case this is.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T81 fix wave — refuseIfDoomed\'s wording is honest about standing vs declared patience', () => {
  it('says "declared" when the first-chunk bound really was declared', async () => {
    seedOpenAICompatible(SCALED_THROUGHPUT_TOK_PER_SEC); // this helper also declares first_chunk_timeout_ms
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    const msg = (err as AgentError).message;
    expect(msg).toContain(`its declared ${SCALED_PATIENCE_MS}ms first-chunk patience`);
  });

  it('RED: says "standing", not "declared", when only prefill throughput was declared', async () => {
    // `first_chunk_timeout_ms` is left NULL: `patience.firstChunkMs` resolves to the STANDING
    // `STREAM_FIRST_CHUNK_TIMEOUT_MS` (90s) default, not anything this row declared. A
    // throughput of 1 tok/s (the module's own floor) keeps the ceiling small enough that
    // `LONG_MESSAGE` still refuses.
    seedOpenAICompatibleUndeclaredFirstChunk(1);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).preDialRefusal).toBe(true);
    const msg = (err as AgentError).message;
    expect(msg).toContain(`the standing ${STREAM_FIRST_CHUNK_TIMEOUT_MS}ms first-chunk patience`);
    expect(msg, 'must not claim a number nobody declared').not.toMatch(/its declared \d+ms first-chunk patience/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// PREFILL SELF-CALIBRATION (owner design ruling, 2026-09-22) — THE GATE STOPS NEEDING TO
// BE TOLD.
//
// Every RED above needs a human to have typed a tokens-per-second figure into a form. The
// owner's ruling: "never ask the user for a number the platform can observe." Migration 167
// stores what `costs/prefill-calibration.ts` derives from this engine's own cost ledger, and
// the pre-dial gate falls back to it when — and ONLY when — nobody declared one.
//
// This block drives the REAL `callModel` against a provider whose `prefill_tokens_per_sec` is
// NULL and whose `measured_prefill_tokens_per_sec` is set, at the same live dial site the
// declared cases above use. The CONTROL immediately above this comment (NULL throughput dials
// an oversized prompt) is what proves the fallback is not always-on: that row has no
// measurement either, and it still dials.
// ════════════════════════════════════════════════════════════════════════════════════

/**
 * A provider that has DECLARED NO THROUGHPUT and been MEASURED. `firstChunkTimeoutMs` is an
 * explicit argument because fix round 1's C1 turns it into the load-bearing fact: a MEASURED
 * rate may arm the pre-dial gate only where the owner declared the patience it is measured
 * against. Passing `null` reproduces the reviewer's exact defect shape.
 */
const seedOpenAICompatibleMeasuredOnly = (
  measuredTokensPerSec: number | null,
  firstChunkTimeoutMs: number | null = SCALED_PATIENCE_MS,
): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms,
                           prefill_tokens_per_sec, measured_prefill_tokens_per_sec, measured_prefill_at,
                           is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'none', ?, NULL, ?, datetime('now'), 1, datetime('now'), datetime('now'))
  `).run(stubUrl, firstChunkTimeoutMs, measuredTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

describe('self-calibration — a provider nobody declared for still refuses a doomed request', () => {
  it('RED: an UNDECLARED provider with a MEASURED reading refuses — zero dials attempted', async () => {
    // Before the ruling this exact row dialed unconditionally (the CONTROL above). The only
    // thing that changed is that the ledger has since written down how fast this box reads.
    seedOpenAICompatibleMeasuredOnly(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect(openaiRequests).toBe(0);
  });

  it('and the refusal says MEASURED, because nobody declared anything', async () => {
    // The T81 fix wave's own rule, applied to the second half of the same sentence: a number
    // the engine worked out for itself must not be reported as something its owner declared.
    seedOpenAICompatibleMeasuredOnly(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    const msg = (err as AgentError).message;
    expect(msg).toContain(`this provider's measured ${SCALED_THROUGHPUT_TOK_PER_SEC} tok/s prefill throughput`);
    expect(msg, 'must not claim a number nobody declared').not.toContain(`declared ${SCALED_THROUGHPUT_TOK_PER_SEC} tok/s`);
  });

  it('a DECLARED figure still wins outright, and still reads as "declared"', async () => {
    // Both columns set and DISAGREEING: declared 10 tok/s (a 100-token ceiling, refuses) beside
    // a measured 10,000 tok/s (which would sail past it). The owner's number is the answer.
    const db = () => mockDb.current!;
    seedOpenAICompatible(SCALED_THROUGHPUT_TOK_PER_SEC);
    db().prepare(
      "UPDATE providers SET measured_prefill_tokens_per_sec = 10000, measured_prefill_at = datetime('now') WHERE id = 'local'",
    ).run();
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain(`this provider's declared ${SCALED_THROUGHPUT_TOK_PER_SEC} tok/s prefill throughput`);
    expect(openaiRequests).toBe(0);
  });

  it('GREEN: the same measured reading dials a prompt that fits its ceiling', async () => {
    seedOpenAICompatibleMeasuredOnly(SCALED_THROUGHPUT_TOK_PER_SEC);
    const result = await callOpenAICompatible(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(openaiRequests).toBe(1);
  });

  it('CONTROL: a measurement too small to be coherent is no measurement — the gate stays off', async () => {
    // `Math.floor(0.4)` is 0, which is below `PREFILL_THROUGHPUT_MIN_TOK_PER_SEC`. A reader that
    // trusted the column blindly would hand the gate a zero ceiling and refuse every request
    // this provider ever receives.
    seedOpenAICompatibleMeasuredOnly(0.4);
    const result = await callOpenAICompatible(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(openaiRequests).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// FIX ROUND 1 — CRITICAL C1: A MEASUREMENT MAY ONLY TIGHTEN A BOUND SOMEBODY DECLARED.
//
// `refuseIfDoomed` was the only ceiling consumer without a `firstChunkDeclared` guard. That was
// harmless while a throughput had to be TYPED — the door had no client caller anywhere in the
// tree, so the branch was unreachable. Self-calibration removed the precondition, and the gate
// began arming itself against the STANDING 90-second default: a bound nobody agreed to, on
// exactly the population this feature targets.
//
// The reviewer's own numbers: ceiling = 60 × rate, so a box measured at this build's own fixture
// (181 tok/s) refuses anything over ~10,860 tokens, and the owner's conversations run 42–52K.
//
// This block is the shape, scaled: an UNDECLARED patience must dial, a DECLARED one must still
// refuse. Remove the guard and the first clause goes red; remove the fallback and the second
// does — so neither half can be lost without something saying so.
// ════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY A SECOND, LOWER RATE THAN THE REST OF THIS FILE ──
// The defect only shows at all if the STANDING patience produces a ceiling the test prompt
// exceeds. Standing is 90s, so the ceiling is `(90_000 − 30_000)/1000 × rate` = 60 × rate; at
// this file's usual 10 tok/s that is 600 tokens and `LONG_MESSAGE` (~500 estimated) fits inside
// it — the guarded and unguarded builds would both dial, and the clause would pass for the wrong
// reason. Measured, not assumed: with 10 tok/s the C1 guard could be deleted and nothing went
// red. At 5 tok/s the standing ceiling is 300 and the same prompt is decisively over it, so the
// clause below is a real question. The declared-patience arm is then 40s − 30s = 10s × 5 = 50
// tokens, which `LONG_MESSAGE` clears easily and `SHORT_MESSAGE` (~3) sits well under.
const C1_THROUGHPUT_TOK_PER_SEC = 5;

describe('C1 — a measured rate never arms the gate against a patience nobody declared', () => {
  it('⚠ RED (the defect): UNDECLARED patience + a measured rate DIALS the oversized prompt', async () => {
    // first_chunk_timeout_ms NULL: `patience.firstChunkMs` is the STANDING 90s, not this
    // provider's word. Before the fix this refused, citing that standing bound in its own
    // message. It must dial, exactly as it did before anything was ever measured.
    seedOpenAICompatibleMeasuredOnly(C1_THROUGHPUT_TOK_PER_SEC, null);
    const result = await callOpenAICompatible(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(openaiRequests).toBe(1);
  });

  it('CONTROL: the identical row with NO measurement also dials — the two agree', async () => {
    // The baseline the clause above must match. If the fix ever over-corrects into "measured
    // rows never refuse", this pair still passes and the next one catches it.
    seedOpenAICompatibleMeasuredOnly(null, null);
    const result = await callOpenAICompatible(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(openaiRequests).toBe(1);
  });

  it('GREEN (the feature): DECLARED patience + a measured rate still refuses, zero dials', async () => {
    // The half that must survive the fix. This is what self-calibration is FOR: an owner who
    // declared how long their box may think, and a ledger that has since worked out how fast it
    // reads, together refuse a prompt that provably cannot finish.
    seedOpenAICompatibleMeasuredOnly(C1_THROUGHPUT_TOK_PER_SEC, SCALED_PATIENCE_MS);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect(openaiRequests).toBe(0);
    // And it names the bound honestly: DECLARED patience, MEASURED throughput.
    const msg = (err as AgentError).message;
    expect(msg).toContain(`its declared ${SCALED_PATIENCE_MS}ms first-chunk patience`);
    expect(msg).toContain(`this provider's measured ${C1_THROUGHPUT_TOK_PER_SEC} tok/s`);
  });

  it('a DECLARED throughput is unchanged by C1 — it still arms on the standing patience', async () => {
    // Deliberate asymmetry, and the reason it is not an oversight: typing a throughput is an
    // act. The T81 fix wave already made this sentence tell the truth about which bound it is
    // holding the request to, and that behaviour predates this task and must not move.
    seedOpenAICompatibleUndeclaredFirstChunk(1);
    const err = await callOpenAICompatible(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect((err as AgentError).message).toContain(`the standing ${STREAM_FIRST_CHUNK_TIMEOUT_MS}ms first-chunk patience`);
    expect(openaiRequests).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// FIX ROUND 1 — IMPORTANT I1: THE ANTHROPIC-DIRECT WIRING IS PINNED TOO.
//
// The reviewer removed the measured fallback from the Ollama, Anthropic-SDK and
// Anthropic-direct dial sites, left the OpenAI-compatible one intact, and ran 70 files / 855
// tests green. Three of the four wirings could be silently reverted and nothing would notice.
// This block closes the Anthropic-direct one; `the-third-transport-honours-declared-patience`
// and `the-agent-sdk-transport-honours-declared-patience` close the other two, beside their own
// declared-throughput clauses.
// ════════════════════════════════════════════════════════════════════════════════════

/** Anthropic-direct, declared patience, NO declared throughput, measured. Post-C1 this arms. */
const seedAnthropicDirectMeasuredOnly = (measuredTokensPerSec: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms,
                           prefill_tokens_per_sec, measured_prefill_tokens_per_sec, measured_prefill_at,
                           is_validated, created_at, updated_at)
    VALUES ('anthropic', 'Anthropic', 'anthropic', 'api_key', ?, NULL, ?, datetime('now'), 1, datetime('now'), datetime('now'))
  `).run(SCALED_PATIENCE_MS, measuredTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-anthropic', 'anthropic', 'Claude', 'claude-x', '["text","tools"]', 200000, 8192, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-anthropic', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
  setProviderCredential('anthropic', 'sk-ant-fake-test-key', 'api_key');
};

describe('I1 — the Anthropic-direct dial site reads the measurement too', () => {
  it('RED: an undeclared-throughput provider with a measured rate refuses before the client streams', async () => {
    seedAnthropicDirectMeasuredOnly(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await callAnthropicDirect(LONG_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);
    expect((err as AgentError).message).toContain(`this provider's measured ${SCALED_THROUGHPUT_TOK_PER_SEC} tok/s`);
    expect(anthropic.streamCalls).toHaveLength(0);
  });

  it('CONTROL: no measurement on the same row dials exactly as today', async () => {
    seedAnthropicDirectMeasuredOnly(null);
    await callAnthropicDirect(LONG_MESSAGE);
    expect(anthropic.streamCalls).toHaveLength(1);
  });

  it('GREEN: the same measured rate dials a prompt that fits its ceiling', async () => {
    seedAnthropicDirectMeasuredOnly(SCALED_THROUGHPUT_TOK_PER_SEC);
    await callAnthropicDirect(SHORT_MESSAGE);
    expect(anthropic.streamCalls).toHaveLength(1);
  });
});
