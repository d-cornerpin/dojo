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
