// ════════════════════════════════════════════════════════════════════════════════════
// NO-DOOMED-DIALS T81b — REVIEW ROUND FINDING 2: A REFUSAL IS NOT A FAILURE.
//
// The FIRST cut of the Ollama pre-dial gate sat INSIDE this transport's own try/catch, so a
// refusal fell into the generic catch a few lines below the dial: `recordProviderError` marked
// a provider that was never even asked unhealthy, and an ERROR-level (or WARN, if `bestEffort`)
// log read "Ollama call failed: refused before any network dial" — a sentence that contradicts
// itself. This file drives the REAL `callModel` against a REAL Ollama-shaped HTTP stub and
// proves the fix: the gate now runs BEFORE the lock, BEFORE `startTime`, and BEFORE the
// try/catch that means "an actual dial is being attempted" — matching the other two
// transports' own structure — so a refusal never reaches either of those two side effects.
//
// ── CONTROL ──
// A genuine dial failure (the stub answers 500) still records the provider error and still
// logs at error level, proving this fix narrowed the catch's actual failure path not at all.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const loggerWarnSpy = vi.fn();
const loggerErrorSpy = vi.fn();
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarnSpy(...args),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
  }),
}));

const recordProviderErrorSpy = vi.fn();
const recordProviderSuccessSpy = vi.fn();
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: (...args: unknown[]) => recordProviderErrorSpy(...args),
  recordProviderSuccess: (...args: unknown[]) => recordProviderSuccessSpy(...args),
}));

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t81b-ollama-not-a-failure');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t81b-ollama-not-a-failure', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../stream-patience.js';
import { AgentError } from '../errors.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t81b-ollama-not-a-failure', '.dojo');

// Same scale as `a-doomed-request-refuses-before-dialing.test.ts`: a low declared throughput
// against a patience comfortably above `TRANSPORT_MARGIN_MS` produces a small, human-sized
// ceiling with no timer ever armed for the refusal case.
const SCALED_PATIENCE_MS = 40_000;
const SCALED_THROUGHPUT_TOK_PER_SEC = 10;
const SHORT_MESSAGE = 'Is it done?'; // well under the ceiling
const LONG_MESSAGE = 'x'.repeat(2_000); // well over the ceiling

let server: http.Server;
let stubUrl = '';
let requests = 0;
/** `respondBadly` flips the stub to a 500, for the genuine-failure control. */
let respondBadly = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/chat')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    requests += 1;
    req.on('data', () => {});
    req.on('end', () => {
      if (respondBadly) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'the box fell over' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'It is done.' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 })}\n`);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

const seedProvider = (prefillTokensPerSec: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(stubUrl, SCALED_PATIENCE_MS, prefillTokensPerSec);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-ollama', 'local-ollama', 'Local DS4', 'ds4-local', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-ollama', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

const call = (message: string): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-ollama',
  messages: [{ role: 'user', content: message }],
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
  requests = 0;
  respondBadly = false;
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
  recordProviderErrorSpy.mockClear();
  recordProviderSuccessSpy.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T81b review round, finding 2 — a pre-dial refusal is not logged or counted as a call failure', () => {
  it('RED→GREEN: refuses without dialing, without a provider-error count, and without an error-level "call failed" log', async () => {
    seedProvider(SCALED_THROUGHPUT_TOK_PER_SEC);
    const err = await call(LONG_MESSAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(DECLARED_PATIENCE_EXCEEDED_CODE);
    expect((err as AgentError).preDialRefusal).toBe(true);

    // The whole point: nothing dialed, so nothing failed.
    expect(requests).toBe(0);
    expect(recordProviderErrorSpy).not.toHaveBeenCalled();
    expect(recordProviderSuccessSpy).not.toHaveBeenCalled();

    // No error-level log at all for this call, and specifically not the self-contradicting
    // "Ollama call failed" sentence the first cut produced.
    expect(loggerErrorSpy).not.toHaveBeenCalled();
    const anyLogMentionsCallFailed = [...loggerWarnSpy.mock.calls, ...loggerErrorSpy.mock.calls]
      .some((call) => String(call[0]).includes('Ollama call failed'));
    expect(anyLogMentionsCallFailed).toBe(false);
  });

  it('GREEN: the same declared throughput dials a prompt that fits the ceiling', async () => {
    seedProvider(SCALED_THROUGHPUT_TOK_PER_SEC);
    const result = await call(SHORT_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(requests).toBe(1);
    expect(recordProviderSuccessSpy).toHaveBeenCalledWith('local-ollama');
  });

  it('CONTROL (byte-preservation): NULL throughput dials the SAME oversized prompt exactly as today', async () => {
    seedProvider(null);
    const result = await call(LONG_MESSAGE);
    expect(result.content).toBe('It is done.');
    expect(requests).toBe(1);
  });

  it('CONTROL: a GENUINE dial failure still records the provider error and still logs at error level', async () => {
    // Proves the fix narrowed the catch's real job not at all — only the pre-dial refusal
    // skips it now, and only because it never reaches the catch at all.
    seedProvider(SCALED_THROUGHPUT_TOK_PER_SEC);
    respondBadly = true;
    const err = await call(SHORT_MESSAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).preDialRefusal).toBe(false);
    expect(requests).toBe(1);
    expect(recordProviderErrorSpy).toHaveBeenCalledWith('local-ollama');
    expect(loggerErrorSpy).toHaveBeenCalled();
    const anyLogMentionsCallFailed = loggerErrorSpy.mock.calls
      .some((call) => String(call[0]).includes('Ollama call failed'));
    expect(anyLogMentionsCallFailed).toBe(true);
  });
});
