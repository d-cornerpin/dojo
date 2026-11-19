// A summary call (no turn behind it) that meets a provider's 429 starts no turn of the agent and writes no line:
// a rate limit only ever waits on a request's own record, and a summary call has none. Driven through the real
// model door against a real HTTP server answering 429 (the idiom of `a-402-is-broken-not-a-rate-limit`).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../home.js', async () => {
  const p = await import('node:path'); const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-summary-429');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs) };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: () => {}, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const wake = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake, notifyPrimaryOfInjury: async () => undefined }) }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';

let server: http.Server;
let baseUrl = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30', 'x-should-retry': 'false', connection: 'close' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  clearSecretsCache(); clearClientCache();
  mockDb.current = new Database(':memory:');
  runMigrations();
  const d = mockDb.current;
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('prov-a', 'Cloud', 'openai-compatible', ?, 'api_key', 1)`).run(baseUrl);
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
             VALUES ('m-a', 'prov-a', 'Model A', 'model-a', '["text"]', 32768, 4096, 1)`).run();
  d.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES ('helper', 'Helper', 'idle', 'm-a', '{}')").run();
  setProviderCredential('prov-a', 'sk-test-key', 'api_key');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); mockDb.current?.close(); });

describe('a summary call limit starts no turn', () => {
  it('the 429 is thrown to the caller; two hours later no turn was started and no line was written', async () => {
    await expect(callModel({
      agentId: 'helper', modelId: 'm-a', tools: false, purpose: 'memory_summarize',
      messages: [{ role: 'user', content: 'Summarize this.' }], systemPrompt: 'You summarize.',
    })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(wake).not.toHaveBeenCalled();
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'system'").get()).toEqual({ n: 0 });
  });
});
