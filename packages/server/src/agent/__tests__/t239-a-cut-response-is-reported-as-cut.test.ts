// ════════════════════════════════════════════════════════════════════════════════════
// t239 (c) — A RESPONSE THE PROVIDER CUT OFF IS REPORTED AS CUT, ON EVERY TRANSPORT.
//
// The incident: a local model's reply ran out of room mid-sentence (`done_reason: "length"`,
// input + output = the call's whole window) while a tool call had already parsed. The Ollama
// transport reported `stopReason: 'tool_use'` whenever any tool call parsed, which erased the
// provider's own truncation word, so the engine ran the cut call as if it were whole and sent a
// half-written deliverable. The OpenAI transport had that fabrication deleted (SWEEP-A TB8);
// this is the same rule for the other transport, from ONE shared helper.
//
// This file drives the REAL `callModel` against a REAL Ollama-shaped HTTP stub (the harness shape
// of `an-ollama-refusal-is-not-a-failure.test.ts`), plus the shared helper's table.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: vi.fn(),
  recordProviderSuccess: vi.fn(),
}));
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t239-cut-response');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t239-cut-response', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { resolveProviderStopReason } from '../provider-stop-reason.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-t239-cut-response', '.dojo');

let server: http.Server;
let stubUrl = '';
/** What the stub's final frame says, and whether a tool call was parsed before it. */
let doneReason: string | undefined = 'stop';
let withToolCall = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const message: Record<string, unknown> = { role: 'assistant', content: 'Chapter one, and then the light was waiting to' };
      if (withToolCall) {
        message.tool_calls = [{ function: { name: 'send_to_agent', arguments: { intent: 'DELIVERABLE', agent: 'boss', payload: 'half a story' } } }];
      }
      res.write(`${JSON.stringify({ message })}\n`);
      res.end(`${JSON.stringify({ done: true, ...(doneReason ? { done_reason: doneReason } : {}), prompt_eval_count: 22396, eval_count: 8324 })}\n`);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

const call = (): Promise<ModelCallResult> => callModel({
  agentId: 'helper', modelId: 'm-ollama',
  messages: [{ role: 'user', content: 'write the story' }],
  systemPrompt: 'You are a local model.', tools: false,
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', 1, datetime('now'), datetime('now'))
  `).run(stubUrl);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-ollama', 'local-ollama', 'Local', 'local-model', '["text","tools"]', 30720, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('helper', 'Helper', 'm-ollama', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
  doneReason = 'stop';
  withToolCall = false;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t239 (c) — the Ollama transport reports the provider\'s truncation, tool call or not', () => {
  it('RED→GREEN: done_reason "length" WITH a parsed tool call is reported as length, never tool_use', async () => {
    doneReason = 'length';
    withToolCall = true;
    const r = await call();
    expect(r.toolCalls).toHaveLength(1);   // the call is still reported (the engine decides not to run it)
    expect(r.stopReason).toBe('length');
  });

  it('CONTROL: a normal stop with a tool call is still tool_use', async () => {
    doneReason = 'stop';
    withToolCall = true;
    expect((await call()).stopReason).toBe('tool_use');
  });

  it('CONTROL: a cut with no tool call is still length (the existing grind path)', async () => {
    doneReason = 'length';
    expect((await call()).stopReason).toBe('length');
  });

  it('CONTROL: a plain stop with no tool call, and a frame that names no reason, are end_turn', async () => {
    doneReason = 'stop';
    expect((await call()).stopReason).toBe('end_turn');
    doneReason = undefined;
    expect((await call()).stopReason).toBe('end_turn');
  });
});

describe('t239 (c) — ONE stop-reason rule for every transport that reads a provider reason', () => {
  it('a provider truncation word wins over the tool-call count; the ordinary words say only what the count says', () => {
    expect(resolveProviderStopReason('length', 1)).toBe('length');
    expect(resolveProviderStopReason('max_tokens', 1)).toBe('max_tokens');
    expect(resolveProviderStopReason('stop', 1)).toBe('tool_use');
    expect(resolveProviderStopReason('tool_calls', 2)).toBe('tool_use');
    expect(resolveProviderStopReason('stop', 0)).toBe('end_turn');
    expect(resolveProviderStopReason(null, 0)).toBe('end_turn');
    expect(resolveProviderStopReason(undefined, 3)).toBe('tool_use');
  });
});

describe('t239 (c) — the census: the synthesis is DELETED, not left beside the shared rule', () => {
  it('model.ts has no site that turns a tool-call count into tool_use itself', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../model.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\?\s*'tool_use'\s*:/);                 // no `n > 0 ? 'tool_use' : ...` anywhere
    expect(code.match(/resolveProviderStopReason\(/g)?.length).toBe(2);   // exactly the OpenAI and the Ollama transport
    expect(src).not.toMatch(/function resolveOpenAIStopReason/);       // and the rule has ONE home
  });
});

