// Ollama reloads a model whenever a request's window differs from the loaded one, so the engine's calls on the
// Dojo's resident writer send one window: the room the Dojo sets aside for it, more only when a call needs more.
// Drives the real `callModel` against an Ollama-shaped HTTP stub and reads the request bodies it wrote.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../gateway/routes/services.js', () => ({ recordProviderError: vi.fn(), recordProviderSuccess: vi.fn() }));
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { callModel, clearClientCache } from '../model.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { writerReservedWindowTokens } from '../../services/dojo-working-memory.js';

let server: http.Server;
let stubUrl = '';
let windows: Array<number | undefined> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      try { windows.push((JSON.parse(raw) as { options?: { num_ctx?: number } }).options?.num_ctx); } catch { windows.push(undefined); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'A short answer' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  clearClientCache();
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', 1)").run(stubUrl);
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, num_ctx_recommended, is_enabled)
    VALUES ('m-std-writer', 'local-ollama', 'Standard writer', ?, '["chat"]', 262144, 32768, 131072, 1)`).run(STANDARD_WRITER_MODEL.tag);
  // The writer is this agent's own model, so the Dojo sets aside its summary room.
  db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('a-local', 'Local agent', 'm-std-writer', 'idle', '{}')").run();
  windows = [];
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const engineCall = (purpose: string, chars: number): Promise<unknown> => callModel({
  agentId: 'a-local', modelId: 'm-std-writer', systemPrompt: '', tools: false, purpose,
  messages: [{ role: 'user', content: 'x'.repeat(chars) }],
});

describe('the local writer keeps one window', () => {
  it('two summaries of different length and a title all send the same window, the room set aside for the writer', async () => {
    await engineCall('memory_summarize', 2_000);
    await engineCall('memory_summarize', 40_000);
    await engineCall('ask_title', 300);
    const reserved = await writerReservedWindowTokens(131072);
    expect(windows).toEqual([reserved, reserved, reserved]);
  });

  it('a call that needs more than the room is never cut to it', async () => {
    const reserved = await writerReservedWindowTokens(131072);
    await engineCall('memory_summarize', reserved * 4);
    expect(windows[0]).toBeGreaterThan(reserved);
  });
});
