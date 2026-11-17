// ════════════════════════════════════════════════════════════════════════════════════════
// PHONE BUFFER CLEARED ON IDLE RETRY — the mid-answer stall on a live phone call.
//
// On a live phone call the model reply is spoken while it streams: `callWithRetryAndFallback`
// keeps unspoken text in `turnCtx.phoneStreamBuffer` (appended in the `onChunk` callback,
// flushed only at a sentence end) and sets `turnCtx.phoneStreamFlushedAny` when something has
// been spoken. The fixed-model stream-idle retry re-dials the SAME model from the first word,
// but the abandoned attempt's unfinished sentence stays in the buffer — the retried answer is
// appended after it, so the buffer the turn-end flush delivers is the stale fragment plus the
// new answer. The auto-router fallback path already clears both (`model-call.ts:497`); the
// idle-retry `continue` (`model-call.ts:340-344`) does not. This pins the same clear there.
//
// The harness is the T65b one (a-stall-is-never-shipped-as-an-answer) copied wholesale: the
// same `vi.mock` blocks, the same stub HTTP servers, `seedOpenAI`, `script`, `requests` and
// `HALF`/`REST`. `getCallSession` is dynamically imported in the flush path and wrapped in a
// try/catch, so with no real session nothing is spoken — and `HALF` has no sentence end, so
// nothing flushes anyway. The buffer is read directly after the call.
// ════════════════════════════════════════════════════════════════════════════════════════
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
vi.mock('../../../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-phone-buffer-idle');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

// The live call the streamed sentences are queued to; null means no call session.
const spoken: string[] = [];
const callSession: { current: { isEnded: () => boolean; queueAgentSay: (t: string) => void } | null } = { current: null };
vi.mock('../../../../../twilio/call-session.js', () => ({ getCallSession: () => callSession.current }));

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-phone-buffer-idle', 'dojo.db'),
  };
});

vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: () => {},
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { clearSecretsCache } from '../../../../../config/loader.js';
import { clearClientCache } from '../../../../model.js';
import { StreamingSpeechBuffer } from '../../../../../voice/text-sanitize.js';
import { callWithRetryAndFallback, type ModelCallInputs } from '../model-call.js';
import type { AgentTurnState } from '../../../../v2/state.js';
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

// Real sockets and cases that deliberately wait out a bound. Comfortably inside the
// default 5 s, but the margin is stated rather than assumed.
vi.setConfig({ testTimeout: 30_000 });

const FAKE_HOME = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-phone-buffer-idle');

const HALF = 'The first half of the answer';
const REST = ', and the second half.';

// ── The stub: one server, both wire protocols ──
//
// `script` is consumed one entry per chat request, so a case can say "stall, then answer" —
// which is what proves the retry grant actually reaches a second attempt. The last entry
// repeats once the script runs out.
type Behaviour = 'complete' | 'half-then-stall' | 'half-then-close' | 'echoes-a-stamp';
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

const serveOpenAI = (res: http.ServerResponse, mode: Behaviour): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  if (mode === 'echoes-a-stamp') {
    res.write(oaChunk({ role: 'assistant', content: '[Jul 16, 2026, 10:58 PM] Saved. ' }));
    res.write(oaChunk({ content: 'All done. ' }));
    res.write(oaChunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
    return;
  }
  res.write(oaChunk({ role: 'assistant', content: HALF }));
  if (mode === 'half-then-stall') { stalled.push(res); return; } // ...and then nothing, ever.
  if (mode === 'half-then-close') { res.end(); return; } // hang up mid-answer: no finish signal
  res.write(oaChunk({ content: REST }));
  res.write(oaChunk({}, 'stop'));
  res.write(sse({
    id: 'chatcmpl-t65b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
    choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  }));
  res.end('data: [DONE]\n\n');
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
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  openaiBase = `http://127.0.0.1:${port}/v1`;
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
    VALUES ('${FXID.n4}', '${FX.n4}', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

beforeEach(() => {
  fs.rmSync(path.join(FAKE_HOME, '.dojo', 'secrets.yaml'), { force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  script.openai = ['complete'];
  requests.openai = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE-RETRY GRANT, ON A LIVE PHONE CALL — the buffer must not survive the re-dial.
//
// A fixed-model agent on a live call gets one same-model retry on the stream-idle phrase. The
// retry restarts the whole answer from the first word, so the abandoned attempt's unspoken
// fragment must not be carried into it — text already spoken cannot be recalled, which is why
// the auto-router fallback path clears the buffer and the latch (`model-call.ts:497`) and no
// more. `phoneStreamCallSid` is set here so the `onChunk` sink is live; `getCallSession` is
// dynamically imported and wrapped in a try/catch, so with no real session nothing is spoken.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('T65b — the phone buffer is cleared on the idle retry', () => {
  /** The turnCtx the last `inputs()` call produced, so the cases can read the buffer after the call. */
  let currentTurnCtx: { phoneStreamBuffer: StreamingSpeechBuffer; phoneStreamFlushedAny: boolean; phoneStreamCallSid: string | null } | null = null;

  const inputs = (phoneStreamCallSid: string | null = 'CA-test'): ModelCallInputs => {
    const turnCtx = { phoneStreamBuffer: new StreamingSpeechBuffer(), phoneStreamFlushedAny: false, phoneStreamCallSid } as unknown as ModelCallInputs['turnCtx'];
    currentTurnCtx = turnCtx as unknown as typeof currentTurnCtx;
    return {
      agentId: FXID.n4,
      turnCtx,
      turnNumber: 1,
      messageId: 'msg-1',
      messages: [{ role: 'user', content: 'Is it done?' }],
      systemPrompt: 'You are a local model.',
      useTools: false,
      isAutoRouted: false,
      isA2ATurn: false,
      excludedModels: [],
      revertTriggerStampOnAbort: () => {},
      assembled: { systemVolatile: '' } as unknown as ModelCallInputs['assembled'],
      routerTier: null,
      counterparty: { kind: 'user' } as unknown as ModelCallInputs['counterparty'],
    };
  };

  it('stall then answer: the retried answer is the ONLY text left in the buffer', async () => {
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
    // The abandoned attempt's unfinished sentence must not survive into the retry. The retry
    // streams the whole answer from the first word, so the buffer holds the second attempt's
    // text only. At HEAD it is HALF + HALF + REST — the stale fragment plus the new answer.
    expect(currentTurnCtx!.phoneStreamBuffer.takeRaw()).toBe(HALF + REST);
  });

  it('and nothing was spoken, so the flushed latch stays false', async () => {
    script.openai = ['half-then-stall', 'complete'];
    seedOpenAI(6_000, 300);
    await callWithRetryAndFallback(
      { modelId: 'm-local' } as unknown as AgentTurnState,
      'm-local',
      inputs(),
    );
    // HALF has no sentence end and REST ends the stream without trailing whitespace, so no
    // flush ever fires — the latch must read false after the call, before and after the fix.
    expect(currentTurnCtx!.phoneStreamFlushedAny).toBe(false);
  });

  it('CONTROL: without a phone call the callback never touches the buffer', async () => {
    script.openai = ['half-then-stall', 'complete'];
    seedOpenAI(6_000, 300);
    await callWithRetryAndFallback(
      { modelId: 'm-local' } as unknown as AgentTurnState,
      'm-local',
      inputs(null),
    );
    expect(requests.openai).toBe(2);
    expect(currentTurnCtx!.phoneStreamBuffer.takeRaw()).toBe('');
  });

  // R7 on a live call: the no-finish retry re-dials from the first word, so speech already handed to the call
  // (it cannot be withdrawn) would be spoken a second time. When something was already spoken, do not retry.
  it('R7: a hung-up answer is retried when nothing has been spoken yet', async () => {
    script.openai = ['half-then-close', 'complete'];
    seedOpenAI(null, null);
    const outcome = await callWithRetryAndFallback({ modelId: 'm-local' } as unknown as AgentTurnState, 'm-local', inputs());
    expect(requests.openai).toBe(2);
    expect(outcome.abandoned === undefined && outcome.result.content).toBe(HALF + REST);
  });

  it('R7: a hung-up answer is NOT re-dialled from the first word when the caller has already heard part of it', async () => {
    script.openai = ['half-then-close', 'complete'];
    seedOpenAI(null, null);
    const i = inputs();
    (i.turnCtx as unknown as { phoneStreamFlushedAny: boolean }).phoneStreamFlushedAny = true;   // a sentence was already spoken
    await expect(callWithRetryAndFallback({ modelId: 'm-local' } as unknown as AgentTurnState, 'm-local', i)).rejects.toThrow(/without a finish signal/);
    expect(requests.openai, 'no second request: the spoken part cannot be recalled').toBe(1);
  });

  it('an echoed time stamp at the start of the reply is never queued to be spoken', async () => {
    script.openai = ['echoes-a-stamp'];
    seedOpenAI(6_000, 5_000);
    spoken.length = 0;
    callSession.current = { isEnded: () => false, queueAgentSay: (t) => { spoken.push(t); } };
    await callWithRetryAndFallback({ modelId: 'm-local' } as unknown as AgentTurnState, 'm-local', inputs());
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0));
    expect(spoken[0]).toBe('Saved.');
    callSession.current = null;
  });
});
