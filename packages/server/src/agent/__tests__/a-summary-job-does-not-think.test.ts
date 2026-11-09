// ════════════════════════════════════════════════════════════════════════════════════════
// t269 cause 3 — A SUMMARY JOB DOES NOT SPEND ITS OUTPUT ON THINKING, ON ANY TRANSPORT THAT CAN SWITCH IT.
//
// The measured shape (v35-summary-quality-investigation.md, H6): the summary dial turned thinking off
// only on the Ollama path (`think: dial ? false : …`). The OpenAI-style path (DeepSeek, OpenRouter)
// ignored `purpose` and sent thinking exactly as the model row said; every DeepSeek row on the dev box
// had thinking on at level `high`, the median summary call spent ~41% of its output reasoning, and 32
// summary calls ended at the 16,384-token cap — 12 of the 14 stored ones cut mid-text.
//
// This drives the REAL `callModel` against REAL HTTP stubs and reads the request body each transport
// wrote: a summary job goes out with thinking off; an agent turn on the same row (the control) keeps
// the owner's setting. Anthropic's direct transport sends no thinking parameter at all (nothing to
// switch), and its cut-off reason is pinned in `memory/__tests__/t269-a-cut-or-overlong-summary-is-never-kept.test.ts`.
//
// All fixture names are invented.
// ════════════════════════════════════════════════════════════════════════════════════════
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
vi.mock('../../gateway/routes/services.js', () => ({ recordProviderError: vi.fn(), recordProviderSuccess: vi.fn() }));
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t269-no-think');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs) };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t269-no-think', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';

vi.setConfig({ testTimeout: 20_000 });
const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-t269-no-think', '.dojo');

type Body = Record<string, unknown> & { thinking?: { type?: string }; reasoning_effort?: string; reasoning?: { enabled?: boolean }; extra_body?: { reasoning?: { enabled?: boolean } }; think?: boolean; options?: { num_predict?: number; num_ctx?: number } };
let openaiBodies: Body[] = [];
let ollamaBodies: Body[] = [];
let openaiServer: http.Server;
let ollamaServer: http.Server;
let openaiUrl = '';
let ollamaUrl = '';
/** What the Ollama stub says about its stop, per call. */
let ollamaDone: string[] = [];

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

beforeAll(async () => {
  openaiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      try { openaiBodies.push(JSON.parse(raw) as Body); } catch { openaiBodies.push({}); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null): string => sse({
        id: 'c-t269', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write(chunk({ role: 'assistant', content: 'A summary.' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  ollamaServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      try { ollamaBodies.push(JSON.parse(raw) as Body); } catch { ollamaBodies.push({}); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'A summary.' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: ollamaDone.shift() ?? 'stop', prompt_eval_count: 3, eval_count: 4 })}\n`);
    });
  });
  await new Promise<void>((r) => openaiServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => ollamaServer.listen(0, '127.0.0.1', r));
  openaiUrl = `http://127.0.0.1:${(openaiServer.address() as AddressInfo).port}/v1`;
  ollamaUrl = `http://127.0.0.1:${(ollamaServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => openaiServer.close(() => r()));
  await new Promise<void>((r) => ollamaServer.close(() => r()));
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  const provider = db.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, behaves_like, is_validated, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`);
  provider.run('p-ds', 'DS', 'openai-compatible', openaiUrl, 'api_key', 'deepseek-native');
  provider.run('p-or', 'OR', 'openai-compatible', openaiUrl, 'api_key', 'openrouter-proxy');
  provider.run('p-ol', 'OL', 'ollama', ollamaUrl, 'none', null);
  const model = db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, thinking_enabled, thinking_level, is_enabled, created_at, updated_at)
                            VALUES (?, ?, ?, ?, '["text","thinking"]', ?, ?, 1, 'high', 1, datetime('now'), datetime('now'))`);
  model.run('m-ds', 'p-ds', 'DS Writer', 'ds-writer', 1_000_000, 16_384);
  model.run('m-or', 'p-or', 'OR Writer', 'vendor/or-writer', 200_000, 16_384);
  model.run('m-ol', 'p-ol', 'OL Writer', 'ol-writer', 32_768, 32_768);
  model.run('m-ol-tight', 'p-ol', 'OL Tight', 'ol-tight', 32_768, 32_768);
  // The box's memory-safe window for this model (the RAM-aware recommendation): 8,192 tokens.
  db.prepare("UPDATE models SET num_ctx_recommended = 8192 WHERE id = 'm-ol-tight'").run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at) VALUES ('a-t269', 'Writer Agent', 'm-ds', 'idle', '{}', datetime('now'), datetime('now'))").run();
  setProviderCredential('p-ds', 'sk-ds', 'api_key');
  setProviderCredential('p-or', 'sk-or', 'api_key');
  openaiBodies = [];
  ollamaBodies = [];
  ollamaDone = [];
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const summaryCall = (modelId: string, extra: Record<string, unknown> = {}) => callModel({
  agentId: 'a-t269', modelId, messages: [{ role: 'user', content: 'rows to summarise' }], systemPrompt: 'Summarise.',
  tools: false, purpose: 'memory_summarize', utilityTargetTokens: 600, ...extra,
});
const agentTurn = (modelId: string) => callModel({
  agentId: 'a-t269', modelId, messages: [{ role: 'user', content: 'hello' }], systemPrompt: 'You are an agent.', tools: false,
});
const orReasoning = (b: Body): boolean | undefined => b.reasoning?.enabled ?? b.extra_body?.reasoning?.enabled;

describe('t269 cause 3 — thinking is off for a summary job on every transport that can switch it', () => {
  it('DeepSeek (native thinking parameter): the summary job sends thinking disabled and no effort level', async () => {
    await summaryCall('m-ds');
    expect(openaiBodies[0].thinking).toEqual({ type: 'disabled' });
    expect(openaiBodies[0].reasoning_effort).toBeUndefined();
  });

  it('DeepSeek control: an agent turn on the same row keeps the owner\'s thinking setting', async () => {
    await agentTurn('m-ds');
    expect(openaiBodies[0].thinking).toEqual({ type: 'enabled' });
    expect(openaiBodies[0].reasoning_effort).toBe('high');
  });

  it('OpenRouter (unified reasoning object): the summary job sends reasoning disabled; an agent turn keeps it on', async () => {
    await summaryCall('m-or');
    await agentTurn('m-or');
    expect(orReasoning(openaiBodies[0])).toBe(false);
    expect(orReasoning(openaiBodies[1])).toBe(true);
  });

  it('Ollama (the dial that already existed): think is false for the summary job — the control for the shape', async () => {
    await summaryCall('m-ol');
    expect(ollamaBodies[0].think).toBe(false);
  });

  it('Ollama: a summary job asked for more room (after a cut) is sent that room, up to the model\'s own maximum', async () => {
    await summaryCall('m-ol');
    const everyday = ollamaBodies[0].options?.num_predict ?? 0;
    await summaryCall('m-ol', { outputRoomAsk: 20_000 });
    expect(ollamaBodies[1].options?.num_predict).toBe(20_000);
    expect(ollamaBodies[1].options?.num_predict).toBeGreaterThan(everyday);
    await summaryCall('m-ol', { outputRoomAsk: 900_000 });
    expect(ollamaBodies[2].options?.num_predict, 'never past the model\'s configured maximum').toBe(32_768);
  });

  it('t269 fix round 1 (review I3) — Ollama: the retry never asks for a window larger than the configured memory-safe one', async () => {
    const out = await summaryCall('m-ol-tight', { outputRoomAsk: 20_000 });
    const body = ollamaBodies[0];
    expect(body.options?.num_ctx, 'never past the configured 8,192').toBeLessThanOrEqual(8_192);
    expect(body.options?.num_predict).toBeLessThan(8_192);
    // and the room it reports is the room that window has, so a cut there splits the span instead of growing
    expect(out.outputRoom?.ceiling).toBeLessThan(8_192);
  });
});
