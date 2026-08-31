// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T65b — A STALL IS NEVER SHIPPED AS AN ANSWER.
//
// The defect this file exists for, in one sentence: when the stream watchdog cut a
// half-delivered answer, the engine returned the half as if it were the whole thing.
//
// `openai@6.32.0` (`core/streaming.js:74-76`) treats an abort as a normal end of stream:
//
//     catch (e) {
//       // If the user calls `stream.controller.abort()`, we should exit without throwing.
//       if (isAbortError(e)) return;
//
// so `callOpenAIModel`'s `for await` simply ENDED when the watchdog fired mid-answer, and
// everything downstream — the cost record, the audit row, the synthesised `end_turn`, the
// returned content — described a call that had finished normally. Two consequences, both
// owner-visible: a truncated bubble delivered with nothing saying it was truncated, and the
// v2 loop's one same-model retry (which matches on the `STREAM_IDLE_TIMEOUT_ERROR` phrase)
// unreachable for the entire class, because no error was ever raised to match.
//
// ── WHY THE STUB STALLS FOREVER ──
// A stall is not a slow answer and not a dropped connection. The server here writes half a
// sentence and then holds the socket open saying nothing, which is exactly the shape the
// watchdog's idle bound was built for and exactly the shape it could not report.
//
// ── SCALE ──
// Provider-declared bounds (T64b) let the same code path be driven in milliseconds: the row
// says 300 ms of idle patience and the stub is silent for longer. Real sockets, a real
// migration chain per case, the real SDKs, the real `callModel`. The rows are written with
// direct SQL at values the write door would refuse — the reader/door asymmetry T64b recorded.
//
// ── THE TWO CONTROLS THAT DECIDE WHETHER THIS FIX IS SAFE ──
// 1. A USER STOP keeps its partial text. The stop button aborting mid-answer and the engine
//    returning what had arrived is INTENDED behaviour, and `makeStreamWatchdog`'s
//    `timedOut()` exists precisely so the two aborts are distinguishable. Pinned below on
//    both transports, unchanged.
// 2. A GENUINE COMPLETION is untouched — same content, same stop reason, same token counts.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t65b-stall');
  return { ...real, homedir, default: { ...real, homedir } };
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t65b-stall', 'dojo.db'),
  };
});
/** Every event the live lane receives, so the retry's effect on the chat bubble is measured
 *  rather than assumed (see the hand-up at the bottom of this file). */
const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import {
  callModel, clearClientCache, streamWasCutByWatchdog, makeStreamWatchdog,
  STREAM_IDLE_TIMEOUT_ERROR, type ModelCallResult,
} from '../model.js';
import { callWithRetryAndFallback, type ModelCallInputs } from '../v2/steps/call-llm/model-call.js';
import type { AgentTurnState } from '../v2/state.js';
import { AgentError } from '../errors.js';

// Real sockets and cases that deliberately wait out a bound. Comfortably inside the
// default 5 s, but the margin is stated rather than assumed.
vi.setConfig({ testTimeout: 30_000 });

const FAKE_HOME = path.join(realOs.tmpdir(), 'dojo-t65b-stall');
const FAKE_DOJO = path.join(FAKE_HOME, '.dojo');

const HALF = 'The first half of the answer';
const REST = ', and the second half.';

// ── The stub: one server, both wire protocols ──
//
// `script` is consumed one entry per chat request, so a case can say "stall, then answer" —
// which is what proves the retry grant actually reaches a second attempt. The last entry
// repeats once the script runs out.
type Behaviour = 'complete' | 'half-then-stall';
const script: { openai: Behaviour[]; anthropic: Behaviour[] } = { openai: [], anthropic: [] };
const requests = { openai: 0, anthropic: 0 };
/** Sockets deliberately left hanging; destroyed in afterAll so the server can close. */
const stalled: http.ServerResponse[] = [];

const take = (which: 'openai' | 'anthropic'): Behaviour => {
  const q = script[which];
  return q.length > 1 ? (q.shift() as Behaviour) : (q[0] ?? 'complete');
};

let server: http.Server;
let openaiBase = '';
let anthropicBase = '';

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const oaChunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({
    id: 'chatcmpl-t65b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
const anthEvent = (type: string, data: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const serveOpenAI = (res: http.ServerResponse, mode: Behaviour): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(oaChunk({ role: 'assistant', content: HALF }));
  if (mode === 'half-then-stall') { stalled.push(res); return; } // ...and then nothing, ever.
  res.write(oaChunk({ content: REST }));
  res.write(oaChunk({}, 'stop'));
  res.write(sse({
    id: 'chatcmpl-t65b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
    choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  }));
  res.end('data: [DONE]\n\n');
};

const serveAnthropic = (res: http.ServerResponse, mode: Behaviour): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(anthEvent('message_start', { type: 'message_start', message: {
    id: 'msg_t65b', type: 'message', role: 'assistant', model: 'claude-stub', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 },
  } }));
  res.write(anthEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  res.write(anthEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: HALF } }));
  if (mode === 'half-then-stall') { stalled.push(res); return; } // ...and then nothing, ever.
  res.write(anthEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REST } }));
  res.write(anthEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }));
  res.end(anthEvent('message_stop', { type: 'message_stop' }));
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-ds4', object: 'model' }] }));
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      if (url.startsWith('/v1/chat/completions')) {
        requests.openai += 1;
        serveOpenAI(res, take('openai'));
      } else if (url.startsWith('/v1/messages')) {
        requests.anthropic += 1;
        serveAnthropic(res, take('anthropic'));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  openaiBase = `http://127.0.0.1:${port}/v1`;
  anthropicBase = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_BASE_URL = anthropicBase;
});

afterAll(async () => {
  delete process.env.ANTHROPIC_BASE_URL;
  for (const res of stalled) { try { res.destroy(); } catch { /* already gone */ } }
  server.closeAllConnections?.();
  await new Promise<void>(r => server.close(() => r()));
});

/** An openai-compatible provider + model + agent, with the patience it declares. */
const seedOpenAI = (firstChunkMs: number | null, idleMs: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(openaiBase, firstChunkMs, idleMs);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

/** The Anthropic-direct transport, pointed at the same stub via ANTHROPIC_BASE_URL. */
const seedAnthropic = (firstChunkMs: number | null, idleMs: number | null): void => {
  const db = mockDb.current!;
  fs.mkdirSync(FAKE_DOJO, { recursive: true });
  fs.writeFileSync(path.join(FAKE_DOJO, 'secrets.yaml'), 'providers:\n  anth:\n    api_key: sk-ant-stub\n', { mode: 0o600 });
  clearSecretsCache();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms, is_validated, created_at, updated_at)
    VALUES ('anth', 'Anthropic', 'anthropic', NULL, 'api_key', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(firstChunkMs, idleMs);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-anth', 'anth', 'Claude Stub', 'claude-stub', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-anth', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

const call = (modelId: string, abortSignal?: AbortSignal): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId,
  messages: [{ role: 'user', content: 'Is it done?' }],
  systemPrompt: 'You are a local model.',
  tools: false,
  abortSignal,
});

beforeEach(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  script.openai = ['complete'];
  script.anthropic = ['complete'];
  requests.openai = 0;
  requests.anthropic = 0;
  broadcasts.length = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════
// THE OPENAI SEAM — the one that shipped the stall.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T65b — the OpenAI seam', () => {
  it('RED AT HEAD: half an answer then a forever stall is RAISED, not returned', async () => {
    script.openai = ['half-then-stall'];
    seedOpenAI(6_000, 300);
    // At HEAD this call RESOLVES, with `content` = the half sentence and
    // `stopReason` = 'end_turn'. That is the whole defect in one assertion.
    await expect(call('m-local')).rejects.toThrow(STREAM_IDLE_TIMEOUT_ERROR);
  });

  it('the raised error is the retryable one, in the shape the loop already knows', async () => {
    script.openai = ['half-then-stall'];
    seedOpenAI(6_000, 300);
    const err = await call('m-local').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    const agentErr = err as AgentError;
    expect(agentErr.code).toBe('stream_idle_timeout');
    expect(agentErr.retryable).toBe(true);
    // The identical translation the first-chunk case has always produced, so nothing
    // downstream can tell whether the SDK raised the abort or the engine did.
    expect(agentErr.message).toContain('no data from provider for too long');
  });

  it('no truncated bubble: the half sentence is never returned as content', async () => {
    script.openai = ['half-then-stall'];
    seedOpenAI(6_000, 300);
    const outcome = await call('m-local').then(
      (r): { kind: string; content?: string } => ({ kind: 'resolved', content: r.content }),
      () => ({ kind: 'rejected' }),
    );
    expect(outcome).toEqual({ kind: 'rejected' });
  });

  it('the provider is recorded as having FAILED, not succeeded', async () => {
    script.openai = ['half-then-stall'];
    seedOpenAI(6_000, 300);
    await call('m-local').catch(() => undefined);
    // A shipped stall was audit-logged `result='success'` with a cost record behind it.
    const audits = mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'model_call' AND result = 'success'",
    ).get() as { n: number };
    expect(audits.n).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// THE ONE-RETRY GRANT — the half of the defect that was invisible.
//
// `model-call.ts` has granted a fixed-model agent one same-model retry on the stream-idle
// phrase since 2026-07-10. For a mid-stream stall that grant could never fire: the phrase
// was never thrown. This drives the real ladder against the real stub, scripted to stall
// once and then answer.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T65b — the one-retry grant becomes reachable for a mid-stream stall', () => {
  const inputs = (): ModelCallInputs => ({
    agentId: 'kevin',
    turnCtx: { phoneStreamBuffer: '', phoneStreamFlushedAny: false } as unknown as ModelCallInputs['turnCtx'],
    turnNumber: 1,
    messageId: 'msg-1',
    messages: [{ role: 'user', content: 'Is it done?' }],
    systemPrompt: 'You are a local model.',
    useTools: false,
    isAutoRouted: false,
    isA2ATurn: false,
    excludedModels: [],
    revertTriggerStampOnAbort: () => {},
    setAgentStatus: () => {},
    assembled: { systemVolatile: '' } as unknown as ModelCallInputs['assembled'],
    routerTier: null,
    counterparty: { kind: 'user' } as unknown as ModelCallInputs['counterparty'],
  });

  it('stall then answer: the second attempt runs and the whole answer arrives', async () => {
    script.openai = ['half-then-stall', 'complete'];
    seedOpenAI(6_000, 300);
    const outcome = await callWithRetryAndFallback(
      { modelId: 'm-local' } as unknown as AgentTurnState,
      'm-local',
      inputs(),
    );
    expect(outcome.abandoned).toBeUndefined();
    expect(requests.openai).toBe(2); // the grant was spent — at HEAD there is only ever one request
    expect(outcome.abandoned === undefined && outcome.result.content).toBe(HALF + REST);
  });

  // ── HANDED UP, MEASURED HERE, NOT FIXED BY T65b ──
  //
  // The retry streams into the SAME `messageId`, and `Chat.tsx`'s `chat:chunk` handler
  // APPENDS by message id (`content: existing.content + e.content`), so for the seconds
  // between the retry and the finalized message the live bubble holds the abandoned partial
  // followed by the real answer. The PERSISTED row is correct — it is built from the second
  // attempt's result alone — so a reload shows the right thing, and the truncated half is
  // never stored, never in history and never replayed into context. That is the fix T65b was
  // for, and it holds.
  //
  // This is NOT new with T65b: the same concatenation is already reachable at HEAD whenever
  // an auto-routed agent falls back after a mid-stream failure. What T65b changes is how
  // often the path is walked. Fixing it means a way to tell the live lane "discard what you
  // have for this bubble" — a new event on a shared wire — which is a new mechanism, and
  // T65b's census is one truth check at an existing seam. It belongs to whoever owns the
  // streaming lane, with its own RED.
  //
  // Pinned as an assertion rather than a paragraph so it is a fact with a red to flip.
  it('HAND-UP: the live lane sees the abandoned partial before the real answer', async () => {
    script.openai = ['half-then-stall', 'complete'];
    seedOpenAI(6_000, 300);
    await callWithRetryAndFallback(
      { modelId: 'm-local' } as unknown as AgentTurnState,
      'm-local',
      inputs(),
    );
    const live = broadcasts
      .filter(e => e.type === 'chat:chunk' && e.messageId === 'msg-1')
      .map(e => String(e.content))
      .join('');
    expect(live).toBe(HALF + HALF + REST); // what the bubble accumulates …
    expect(live).not.toBe(HALF);           // … but it is no longer a truncated answer
  });

  it('and the grant is still exactly ONE: two stalls in a row give up', async () => {
    script.openai = ['half-then-stall'];
    seedOpenAI(6_000, 300);
    await expect(callWithRetryAndFallback(
      { modelId: 'm-local' } as unknown as AgentTurnState,
      'm-local',
      inputs(),
    )).rejects.toThrow(STREAM_IDLE_TIMEOUT_ERROR);
    expect(requests.openai).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// CONTROL 1 — THE STOP BUTTON IS NOT A STALL, AND KEEPS ITS PARTIAL TEXT.
//
// The user pressing stop mid-answer and getting what had arrived is intended, and it is
// the reason `makeStreamWatchdog` reports `timedOut()` separately from its own abort
// signal. These cases are byte-identical before and after T65b; if the fix had keyed on
// "the stream was aborted" rather than "the WATCHDOG aborted it", they would fail.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T65b — CONTROL: a user stop mid-answer is unchanged', () => {
  it('OpenAI: the partial text comes back as a result, exactly as it always has', async () => {
    script.openai = ['half-then-stall'];
    seedOpenAI(null, null); // standing 90s/60s bounds: the watchdog never fires here
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 400);
    const result = await call('m-local', stop.signal);
    expect(result.content).toBe(HALF);
    expect(result.stopReason).toBe('end_turn');
  });

  it('OpenAI: and a stop arriving AFTER the watchdog still reads as a stop, not a timeout', async () => {
    // Both signals fired. `streamWasCutByWatchdog` answers "no" whenever the external
    // signal is aborted, which is the same precedence the catch has always applied.
    script.openai = ['half-then-stall'];
    seedOpenAI(6_000, 300);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const result = await call('m-local', stop.signal);
    expect(result.content).toBe(HALF);
  });

  it('Anthropic: a user stop mid-answer still rejects, as it always has', async () => {
    // The two transports genuinely differ here and T65b changes neither: the Anthropic SDK
    // raises `APIUserAbortError` on the user's stop, so this path has always thrown rather
    // than returning the partial. Pinned so the fix above cannot quietly harmonise it.
    script.anthropic = ['half-then-stall'];
    seedAnthropic(null, null);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 400);
    const err = await call('m-anth', stop.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(STREAM_IDLE_TIMEOUT_ERROR);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// CONTROL 2 — A GENUINE COMPLETION IS UNTOUCHED, ON BOTH TRANSPORTS.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T65b — CONTROL: a stream that ends on its own is unaffected', () => {
  it('OpenAI: same content, same stop reason, same token counts', async () => {
    seedOpenAI(6_000, 6_000);
    const result = await call('m-local');
    expect(result.content).toBe(HALF + REST);
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(11);
  });

  it('OpenAI: and with nothing declared, on the standing constants', async () => {
    seedOpenAI(null, null);
    const result = await call('m-local');
    expect(result.content).toBe(HALF + REST);
    expect(result.stopReason).toBe('end_turn');
  });

  it('Anthropic: same content and the provider\'s own stop reason', async () => {
    seedAnthropic(null, null);
    const result = await call('m-anth');
    expect(result.content).toBe(HALF + REST);
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(11);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// THE ANTHROPIC SEAM — the same guarantee, asserted as an OUTCOME.
//
// At `@anthropic-ai/sdk@0.110.0` this already held before T65b, for a reason that belongs to
// the dependency rather than to us: `MessageStream._createMessage` re-checks its controller
// after its own `for await` and throws `APIUserAbortError`, so the abort reaches the catch
// on its own. Probed directly against the real SDK and a real stalling server while this
// task's ground was being established (recorded in the T65b report), which is also how the
// OpenAI swallow was confirmed a third independent time.
//
// The engine now makes the same check for itself at this seam. These cases assert the
// OUTCOME — a stall is not an answer — so they keep passing whichever layer raises, and
// they start failing if BOTH stop.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T65b — the Anthropic seam holds the same line', () => {
  it('half an answer then a forever stall raises the timeout', async () => {
    script.anthropic = ['half-then-stall'];
    seedAnthropic(6_000, 300);
    await expect(call('m-anth')).rejects.toThrow(STREAM_IDLE_TIMEOUT_ERROR);
  });

  it('and it is the same retryable error the OpenAI seam raises', async () => {
    script.anthropic = ['half-then-stall'];
    seedAnthropic(6_000, 300);
    const err = await call('m-anth').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('stream_idle_timeout');
    expect((err as AgentError).retryable).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// THE PREDICATE ITSELF — one sentence, four call sites, no room to drift.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T65b — streamWasCutByWatchdog', () => {
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  it('is false while the stream is alive', () => {
    const w = makeStreamWatchdog(undefined, 400, 300);
    expect(streamWasCutByWatchdog(w, undefined)).toBe(false);
    w.finish();
  });

  it('is true once the watchdog has fired with no external signal', async () => {
    const w = makeStreamWatchdog(undefined, 200, 200);
    await sleep(260);
    expect(streamWasCutByWatchdog(w, undefined)).toBe(true);
    w.finish();
  });

  it('is FALSE for a user stop, even after the watchdog also fired', async () => {
    const external = new AbortController();
    const w = makeStreamWatchdog(external.signal, 200, 200);
    await sleep(260);
    expect(w.timedOut()).toBe(true);
    external.abort();
    expect(streamWasCutByWatchdog(w, external.signal)).toBe(false);
    w.finish();
  });

  it('is false for a user stop that arrives first', () => {
    const external = new AbortController();
    const w = makeStreamWatchdog(external.signal, 5_000, 5_000);
    external.abort();
    expect(streamWasCutByWatchdog(w, external.signal)).toBe(false);
    w.finish();
  });
});
