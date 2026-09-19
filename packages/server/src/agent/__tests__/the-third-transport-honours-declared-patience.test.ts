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
// ── WHY THE NUMBER IS OBSERVED BY SPYING, NOT BY WAITING ──
// `TRANSPORT_DEFAULT_TIMEOUT_MS` (300,000) is a real constant this file cannot shrink — unlike
// the SSE-transport patience tests, which scale the PROVIDER's declared bound down to make a
// watchdog fire quickly, there is no separate watchdog here to scale: the single
// `AbortSignal.timeout` call below IS the bound. Proving "it armed at 630,000, not 300,000"
// by waiting would cost the suite over five real minutes per case. `vi.spyOn(AbortSignal,
// 'timeout')` calls straight through to the real implementation (nothing is faked about what
// the signal DOES), and simply reports the one number this test exists to pin: what argument
// this call site passed it. The stub server always answers immediately, so no case in this
// file waits on a clock at all — only the spy's captured argument is asserted.
//
// ── THIS IS NOT THE WATCHDOG'S SHAPE, AND THAT IS DELIBERATE (OUT OF SCOPE, STATED) ──
// This transport arms no `makeStreamWatchdog` — no bump()/contentStarted(), no separate
// first-chunk-vs-idle phase, no translated timeout phrase. One flat clock has always had to
// stand in for both. `resolveTransportTimeouts` already folds both bounds into
// `bodyTimeoutMs` (`max(headersTimeoutMs, bodyTimeoutMs)` by construction — `bodyNeeded` is
// derived from `max(firstChunkMs, idleMs)`), so that one number is the correct single ceiling:
// never tighter than either declared bound. Adding a real watchdog to this path is a bigger
// change than "honour the stored bound" and is not what this task does.
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

// ── The stub: Ollama's native `/api/chat`, newline-delimited JSON, answers at once ──
//
// Every case in this file answers immediately — the point under test is which number the
// abort was ARMED with, not whether it fires, so nothing here needs to stall.
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
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'It is done.' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 4 })}\n`);
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
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.restoreAllMocks();
});

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
    // lifted bound anyway. firstChunkMs=90_000 (standing), idleMs=500_000 (declared) ->
    // bodyNeeded = max(90_000, 500_000) + 30_000 = 530_000.
    const spy = vi.spyOn(AbortSignal, 'timeout');
    seedProvider(null, 500_000);
    const result = await call();
    expect(result.content).toBe('It is done.');
    expect(spy).toHaveBeenCalledWith(530_000);
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
