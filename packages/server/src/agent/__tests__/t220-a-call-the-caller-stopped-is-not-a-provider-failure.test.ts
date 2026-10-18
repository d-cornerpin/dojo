// ════════════════════════════════════════════════════════════════════════════════════
// t220 — A CALL THE CALLER STOPPED IS NOT A PROVIDER FAILURE.
//
// The fold aborts its summary call with its own reason when the turn's patience runs out.
// Each transport's generic catch used to treat that as a provider failure: it marked the
// provider unhealthy (`recordProviderError`) and logged at ERROR ("... call failed:
// fold-in-turn-limit") for a call the provider never failed. The question "did the call's own
// abort signal end it?" is now asked in one place (`caller-stop.ts`; `failed-call.ts` settles the catch) and every transport asks it.
//
// Drives the REAL `callModel` on all four transports. Ollama and OpenAI-compatible talk to a
// real HTTP stub that accepts the request and never answers (or answers 400 for the control);
// Anthropic-direct and the Agent SDK are scripted at their own seam. Names are invented.
//
// Per transport: (a) aborted by the caller -> no provider error, no error-level log, and a
// non-error line naming the reason; (b) CONTROL, a real failure on an un-aborted call ->
// provider error recorded and an error-level "call failed" line, exactly as before.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

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
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t220-caller-stop');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t220-caller-stop', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

// Anthropic-direct: the stream's final message waits for the request's signal (a hang), or
// rejects at once (a real failure), as the mode says.
const seam = vi.hoisted(() => ({ mode: 'hang' as 'hang' | 'fail' }));
vi.mock('@anthropic-ai/sdk', () => {
  class FakeStream {
    constructor(private signal?: AbortSignal) {}
    on(): FakeStream { return this; }
    finalMessage(): Promise<never> {
      return new Promise((_resolve, reject) => {
        if (seam.mode === 'fail') { reject(new Error('the provider fell over')); return; }
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

// Agent SDK: the dial hangs until the signal it is handed aborts, or fails at once.
vi.mock('../../providers/anthropic-sdk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/anthropic-sdk.js')>();
  return {
    ...actual,
    callAnthropicViaSdk: (a: { abortSignal?: AbortSignal }): Promise<never> => new Promise((_resolve, reject) => {
      if (seam.mode === 'fail') { reject(new Error('the provider fell over')); return; }
      const cut = (): void => reject(new Error('The operation was aborted'));
      if (a.abortSignal?.aborted) cut(); else a.abortSignal?.addEventListener('abort', cut, { once: true });
    }),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-t220-caller-stop', '.dojo');
const REASON = 'fold-in-turn-limit';

let server: http.Server;
let stubUrl = '';
/** 'hang': take the request and never answer. 'fail': answer 400 (not retried by the clients). */
let stubMode: 'hang' | 'fail' = 'hang';
let stubRequests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-x', object: 'model' }] }));
      return;
    }
    stubRequests += 1;
    req.on('data', () => {});
    req.on('end', () => {
      if (stubMode === 'hang') return;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'the box fell over' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

type Transport = 'ollama' | 'openai' | 'anthropic' | 'agent-sdk';
const TRANSPORTS: Array<{ name: Transport; failedPhrase: string }> = [
  { name: 'ollama', failedPhrase: 'Ollama call failed' },
  { name: 'openai', failedPhrase: 'OpenAI call failed' },
  { name: 'anthropic', failedPhrase: 'Model call failed' },
  { name: 'agent-sdk', failedPhrase: 'Agent SDK call failed' },
];

function seed(t: Transport): void {
  const db = mockDb.current!;
  const providerSql = `INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
                       VALUES ('prov-t220', 'Under Test', ?, ?, ?, 1, datetime('now'), datetime('now'))`;
  if (t === 'ollama') db.prepare(providerSql).run('ollama', stubUrl, 'none');
  else if (t === 'openai') db.prepare(providerSql).run('openai-compatible', `${stubUrl}/v1`, 'none');
  else if (t === 'anthropic') db.prepare(providerSql).run('anthropic', null, 'api_key');
  else db.prepare(providerSql).run('anthropic', null, 'agent-sdk');
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
              VALUES ('m-t220', 'prov-t220', 'Under Test', 'x-model', '["text","tools"]', 200000, 4096, 1, datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
              VALUES ('agent-t220', 'Box', 'm-t220', 'idle', '{}', datetime('now'), datetime('now'))`).run();
  if (t === 'anthropic') setProviderCredential('prov-t220', 'sk-ant-fake-test-key', 'api_key');
}

const call = (signal?: AbortSignal, bestEffort = false): Promise<unknown> => callModel({
  agentId: 'agent-t220', modelId: 'm-t220',
  messages: [{ role: 'user', content: 'Is it done?' }],
  systemPrompt: 'You are a model.', tools: false, abortSignal: signal, bestEffort,
}).catch((e: unknown) => e);

const errorLines = (): LogLine[] => logLines.filter((l) => l.level === 'error');

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
  stubMode = 'hang';
  stubRequests = 0;
  seam.mode = 'hang';
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

for (const { name, failedPhrase } of TRANSPORTS) {
  describe(`t220 ${name}: a call its caller aborted`, () => {
    for (const bestEffort of [false, true]) {
      it(`is not a provider failure (bestEffort=${bestEffort}): no provider error, no error-level line, the reason is named`, async () => {
        seed(name);
        const ctl = new AbortController();
        const pending = call(ctl.signal, bestEffort);
        await new Promise((r) => setTimeout(r, 300));   // the dial is open and waiting
        if (name === 'ollama' || name === 'openai') expect(stubRequests, 'non-vacuity: the request reached the stub').toBe(1);
        ctl.abort(REASON);
        const err = await pending;

        expect(err, 'non-vacuity: the call really ended in an error').toBeInstanceOf(Error);
        expect(recordProviderErrorSpy, 'a healthy provider is not marked unhealthy').not.toHaveBeenCalled();
        expect(errorLines(), 'and nothing is logged at error level').toEqual([]);
        expect(logLines.some((l) => l.message.includes(REASON) && l.level !== 'error'),
          'a non-error line says why the call ended').toBe(true);
      });
    }

    it('CONTROL: a real failure on a call nobody aborted still marks the provider and logs an error', async () => {
      seed(name);
      stubMode = 'fail';
      seam.mode = 'fail';
      const err = await call(new AbortController().signal);

      expect(err).toBeInstanceOf(Error);
      expect(recordProviderErrorSpy).toHaveBeenCalledWith('prov-t220');
      expect(errorLines().some((l) => l.message.startsWith(failedPhrase)), `an error-level "${failedPhrase}" line`).toBe(true);
    });
  });
}
