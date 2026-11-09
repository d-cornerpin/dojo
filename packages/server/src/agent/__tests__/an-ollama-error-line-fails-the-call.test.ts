// 9605 — Ollama answers HTTP 200 first, so a failure part-way through arrives as an `error` line (or as
// a stream that just stops). Neither is a finished reply. Harness copied from
// an-ollama-refusal-is-not-a-failure.test.ts; only what the stub streams differs. Fake data only.
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
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-9605-ollama-error-line');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-9605-ollama-error-line', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { AgentError } from '../errors.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-9605-ollama-error-line', '.dojo');

// Same scale as `a-doomed-request-refuses-before-dialing.test.ts`: a low declared throughput
// against a patience comfortably above `TRANSPORT_MARGIN_MS` produces a small, human-sized
// ceiling with no timer ever armed for the refusal case.
const SCALED_PATIENCE_MS = 40_000;
const SHORT_MESSAGE = 'Is it done?'; // well under the ceiling

let server: http.Server;
let stubUrl = '';
let requests = 0;
/** The NDJSON lines the stub streams (each a JSON object); the response then ends. */
let script: unknown[] = [];

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
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(script.map(l => JSON.stringify(l) + '\n').join(''));
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
    VALUES ('${FXID.n4}', '${FX.n4}', 'm-ollama', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

const call = (message: string): Promise<ModelCallResult> => callModel({
  agentId: FXID.n4,
  modelId: 'm-ollama',
  messages: [{ role: 'user', content: message }],
  systemPrompt: 'You are a local model.',
  tools: false,
});

beforeEach(() => {
  fs.rmSync(path.join(FAKE_DOJO, 'secrets.yaml'), { force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  requests = 0;
  script = [];
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
  recordProviderErrorSpy.mockClear();
  recordProviderSuccessSpy.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const content = (t: string) => ({ message: { role: 'assistant', content: t } });

describe('9605 — an Ollama error line, or a stream that never says it is done, fails the call', () => {
  it('an error line after partial content rejects, is retryable, and counts as a provider error', async () => {
    seedProvider(null);
    script = [content('Hello'), content(' wor'), { error: 'model runner has unexpectedly stopped' }];
    const err = await call(SHORT_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain('Ollama call failed');
    expect((err as AgentError).retryable).toBe(true);
    expect(recordProviderErrorSpy).toHaveBeenCalled();
    expect(recordProviderSuccessSpy).not.toHaveBeenCalled();
  });

  it('a stream that ends without a done line rejects the same way', async () => {
    seedProvider(null);
    script = [content('Hello'), content(' wor')];
    const err = await call(SHORT_MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain('Ollama call failed');
    expect(recordProviderErrorSpy).toHaveBeenCalled();
    expect(recordProviderSuccessSpy).not.toHaveBeenCalled();
  });

  it('CONTROL: content plus a final done line resolves with the full text', async () => {
    seedProvider(null);
    script = [content('Hello'), content(' world'), { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 }];
    const result = await call(SHORT_MESSAGE);
    expect(result.content).toBe('Hello world');
    expect(recordProviderSuccessSpy).toHaveBeenCalledTimes(1);
    expect(recordProviderErrorSpy).not.toHaveBeenCalled();
  });
});
