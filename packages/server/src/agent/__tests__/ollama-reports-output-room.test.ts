// ════════════════════════════════════════════════════════════════════════════════════
// B14 — THE OLLAMA TRANSPORT REPORTS THE OUTPUT ROOM IT GAVE.
//
// The Ollama call sends `options.num_predict` (the model's configured maximum, or a dial's own
// cap), but its result reported no room, so when a reply was cut at that cap the engine's cut
// ladder read "the transport reported no room to give" and could say nothing true about it. The
// OpenAI-compatible transport has always reported `outputRoom: { sent, ceiling }`.
//
// Driven through the REAL `callModel` against a REAL Ollama-shaped HTTP stub (the harness of
// `t239-a-cut-response-is-reported-as-cut.test.ts`).
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
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-b14-ollama-room');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-b14-ollama-room', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { outputTruncationClassifier } from '../v2/classifiers/output.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-b14-ollama-room', '.dojo');

let server: http.Server;
let stubUrl = '';
/** What the stub's final frame says, and whether a tool call was parsed before it. */
let doneReason: string | undefined = 'stop';
let withToolCall = false;
/** The `options.num_predict` the stub's last request carried. */
let sentNumPredict: number | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { sentNumPredict = (JSON.parse(Buffer.concat(chunks).toString()) as { options?: { num_predict?: number } }).options?.num_predict; } catch { sentNumPredict = undefined; }
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
  fs.rmSync(path.join(FAKE_DOJO, 'secrets.yaml'), { force: true });
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
  sentNumPredict = undefined;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });


describe('B14 — the Ollama result carries the room the call was given', () => {
  it('outputRoom.sent is the num_predict that went on the wire, and the ceiling is the model\'s maximum', async () => {
    const r = await call();
    expect(sentNumPredict).toBe(4096);
    expect(r.outputRoom).toEqual({ sent: 4096, ceiling: 4096 });
  });

  it('a cut reply is no longer "the transport reported no room to give"', async () => {
    doneReason = 'length';
    const r = await call();
    const decision = outputTruncationClassifier({
      stopReason: r.stopReason,
      contentLength: r.content?.length ?? 0,
      currentBudget: r.outputRoom?.sent ?? 0,
      ceiling: r.outputRoom?.ceiling,
      alreadyEscalated: false,
    });
    expect(decision.truncated).toBe(true);
    expect((decision as { reason: string }).reason).not.toContain('reported no room');
    expect((decision as { reason: string }).reason).toContain('4096');
  });

  it('a model whose stored maximum is below the bindable floor sends no cap and reports no room', async () => {
    mockDb.current!.prepare("UPDATE models SET max_output_tokens = 100 WHERE id = 'm-ollama'").run();
    clearClientCache();
    const r = await call();
    expect(sentNumPredict).toBeUndefined();
    expect(r.outputRoom).toBeUndefined();
  });
});
