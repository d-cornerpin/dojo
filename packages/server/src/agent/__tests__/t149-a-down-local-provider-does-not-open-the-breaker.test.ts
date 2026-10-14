// t149 round 2 — EVIDENCE FOR HAND-UP R-V333-18: what the platform records when a LOCAL provider is
// down (connection refused), measured through the real `callModel` against a port nothing listens on.
//
// The coordinator's ruling asks the budget stop to count only free models "whose provider may be
// dialled right now", through the router's own record (`mayDialProvider` / `provider_down`). That
// record is the BILLING breaker (`providers/billing-breaker.ts`), which opens only on PERMANENT
// failures (402 / 401 / 403). This clause pins the measured fact that a refused connection is
// transient to it: the provider stays dialable however many times it fails. The only per-provider
// record of such failures is the Health card's consecutive-failure count, fed by
// `recordProviderError` (observed here as a spy); it is cleared only by a later SUCCESSFUL call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const o = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t149-down-provider', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const providerErrors = vi.hoisted(() => ({ ids: [] as string[], successes: [] as string[] }));
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: (id: string) => { providerErrors.ids.push(id); },
  recordProviderSuccess: (id: string) => { providerErrors.successes.push(id); },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runMigrations } from '../../db/migrations.js';
import { callModel, clearClientCache } from '../model.js';
import { mayDialProvider, providerBreaker, __resetBreakersForTests } from '../../providers/billing-breaker.js';

let downUrl = '';
beforeEach(async () => {
  clearClientCache(); __resetBreakersForTests();
  providerErrors.ids = []; providerErrors.successes = [];
  mockDb.current = new Database(':memory:');
  runMigrations();
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  downUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise<void>((r) => dead.close(() => r()));
  mockDb.current.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-local', 'Local', 'ollama', ?, 'none', 1)`).run(downUrl);
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES ('m-local', 'p-local', 'Local', 'local', '["text"]', 32000, 4096, 1, 0, 0)`).run();
  mockDb.current.prepare(`INSERT INTO agents (id, name, model_id, status, config) VALUES ('a-1', 'Agent', 'm-local', 'idle', '{}')`).run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t149 round 2 — a refused connection to a local provider', () => {
  it('fails every time, is recorded only as a Health-card failure, and NEVER opens the breaker: the provider stays dialable', async () => {
    for (let i = 0; i < 6; i++) {
      await expect(callModel({
        agentId: 'a-1', modelId: 'm-local', messages: [{ role: 'user', content: 'hello' }], systemPrompt: '', tools: false,
      })).rejects.toThrow(/fetch failed|ECONNREFUSED/i);
    }
    expect(providerErrors.ids, 'each failure reaches the Health card\'s counter').toEqual(Array(6).fill('p-local'));
    expect(providerBreaker('p-local'), 'the billing breaker does not open on a transport failure').toBeNull();
    expect(mayDialProvider('p-local'), 'so the router would still offer it').toBe(true);
  });
});
