// ════════════════════════════════════════════════════════════════════════════════════
// AN ANTHROPIC-DIRECT STREAM THE WATCHDOG CUTS MARKS ITS PROVIDER.
//
// When the stream watchdog cuts a stalled model call, the Ollama, OpenAI-compatible
// and Agent SDK transports all first run the call through `recordProviderError` — the
// count of repeated consecutive failures that flips a provider's Health card
// unhealthy — and then throw the timeout `AgentError`. The direct Anthropic transport
// did not: its watchdog branch only logged and threw, so an endpoint that repeatedly
// stalled never showed as degraded.
//
// Drives the REAL `callModel` on anthropic-direct, scripted at its own seam: the
// stream's final message takes the connection and stays silent until the request's
// signal aborts. A provider row declaring a 50 ms first-chunk bound
// (`providers.first_chunk_timeout_ms`, honoured by `resolveStreamPatience`) gives the
// watchdog something short to trip on with nobody aborting. The control keeps the
// neighbouring rule: a call the caller stopped with its own signal is NOT a provider
// failure. Names are invented.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

interface LogLine { level: string; message: string }
const logLines: LogLine[] = [];
vi.mock('../../logger.js', () => {
  const at = (level: string) => (message: string): void => { logLines.push({ level, message }); };
  return { createLogger: () => ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }) };
});

const recordProviderErrorSpy = vi.fn();
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: (...args: unknown[]) => recordProviderErrorSpy(...args),
  recordProviderSuccess: vi.fn(),
}));

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-anthropic-stall');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-anthropic-stall', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

// Anthropic-direct at its own seam: the stream's final message hangs until the
// request's signal aborts — a provider that took the connection and stopped talking.
vi.mock('@anthropic-ai/sdk', () => {
  class FakeStream {
    constructor(private signal?: AbortSignal) {}
    on(): FakeStream { return this; }
    finalMessage(): Promise<never> {
      return new Promise((_resolve, reject) => {
        const cut = (): void => reject(new Error('Request was aborted.'));
        if (this.signal?.aborted) cut(); else this.signal?.addEventListener('abort', cut, { once: true });
      });
    }
  }
  class FakeAnthropic {
    messages = { stream: (_p: unknown, o?: { signal?: AbortSignal }): FakeStream => new FakeStream(o?.signal) };
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic, APIError: FakeAnthropic.APIError };
});

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { AgentError } from '../errors.js';
import { callModel, clearClientCache } from '../model.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-anthropic-stall', '.dojo');

/** `firstChunkTimeoutMs` is the provider's declared patience before token 1; null = never declared. */
function seed(firstChunkTimeoutMs: number | null): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, first_chunk_timeout_ms, created_at, updated_at)
              VALUES ('prov-stall', 'Under Test', 'anthropic', null, 'api_key', 1, ?, datetime('now'), datetime('now'))`).run(firstChunkTimeoutMs);
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
              VALUES ('m-stall', 'prov-stall', 'Under Test', 'x-model', '["text","tools"]', 200000, 4096, 1, datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
              VALUES ('agent-stall', 'Box', 'm-stall', 'idle', '{}', datetime('now'), datetime('now'))`).run();
  setProviderCredential('prov-stall', 'sk-ant-fake-test-key', 'api_key');
}

const call = (opts: { abortSignal?: AbortSignal } = {}): Promise<unknown> => callModel({
  agentId: 'agent-stall', modelId: 'm-stall',
  messages: [{ role: 'user', content: 'Is it done?' }],
  systemPrompt: 'You are a model.', tools: false, ...opts,
}).catch((e: unknown) => e);

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  logLines.length = 0;
  recordProviderErrorSpy.mockClear();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('anthropic-direct: a stream the watchdog cuts', () => {
  it('is a provider failure: the stalled call is counted against its provider', async () => {
    seed(50);
    const err = await call();   // nobody aborts this call; the 50ms bound is all the watchdog needs

    expect(err).toBeInstanceOf(AgentError);
    expect((err as Error).message).toContain('no data from provider for too long');
    expect(recordProviderErrorSpy).toHaveBeenCalledTimes(1);
    expect(recordProviderErrorSpy).toHaveBeenCalledWith('prov-stall');
  });

  it('CONTROL: a call the caller stopped with its own signal is still not a provider failure', async () => {
    seed(null);
    const ctl = new AbortController();
    const pending = call({ abortSignal: ctl.signal });
    await new Promise((r) => setTimeout(r, 300));   // the dial is open and waiting
    ctl.abort('fold-in-turn-limit');
    const err = await pending;

    expect(err, 'non-vacuity: the call really ended in an error').toBeInstanceOf(Error);
    expect(recordProviderErrorSpy, 'a healthy provider is not marked unhealthy').not.toHaveBeenCalled();
  });
});
