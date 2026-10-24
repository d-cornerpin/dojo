// t268 ruling 3 — THE WRITER'S WINDOW COUNTS TOKENS AT THIS BOX'S MEASURED DENSITY, NOT AT 4 CHARACTERS.
// B5 (`overhaul-plans/v35-writer-measure.md`): this box's traffic averages about 2.5 characters per token, so a
// window sized at 4 undercounts by ~1.6x; in 21 of 300 writes Ollama cut the prompt to half the window and the
// writer lost its instructions and the start of the conversation. The stub below is an Ollama that counts the
// prompt at 2.48 characters per token (B5's measured median) and cuts an over-window prompt the way B5 saw
// (`prompt_eval_count` = window / 2 + 2). It drives the REAL `callModel`; nothing calls a real Ollama.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../gateway/routes/services.js', () => ({ recordProviderError: vi.fn(), recordProviderSuccess: vi.fn() }));
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t268-density');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { B5_MEASURED_CHARS_PER_TOKEN, ollamaCharsPerToken } from '../../services/token-density.js';
import { writerJobWindowTokens } from '../../services/dojo-working-memory.js';
import { getLeafChunkTokens } from '../../memory/compaction.js';
import { CHARS_PER_TOKEN } from '../../memory/budget.js';

vi.setConfig({ testTimeout: 20_000 });

/** The leaf chunk as the writer receives it: 30,000 tokens at the stored /4 count = 120,000 characters. */
const CHUNK_CHARS = getLeafChunkTokens() * CHARS_PER_TOKEN;
/** The tokenizer the stub runs: B5's measured median for this traffic. */
const TRUE_CHARS_PER_TOKEN = 2.48;

let server: http.Server;
let stubUrl = '';
const seen: Array<{ numCtx: number; promptTokens: number; evaluated: number }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }>; options?: { num_ctx?: number } };
      const chars = body.messages.reduce((n, m) => n + m.content.length, 0);
      const promptTokens = Math.ceil(chars / TRUE_CHARS_PER_TOKEN);
      const numCtx = body.options?.num_ctx ?? 8_192;
      const evaluated = promptTokens > numCtx ? numCtx / 2 + 2 : promptTokens;   // B5: the cut keeps half the window
      seen.push({ numCtx, promptTokens, evaluated });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'A faithful summary.' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: evaluated, eval_count: 5 })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  clearSecretsCache();
  clearClientCache();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  seen.length = 0;
  mockDb.current.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', 1, datetime('now'), datetime('now'))`).run(stubUrl);
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, num_ctx_recommended, is_enabled, created_at, updated_at)
    VALUES ('m-std-writer', 'local-ollama', 'Standard writer', ?, '["chat"]', 262144, 32768, 28672, 1, datetime('now'), datetime('now'))`).run(STANDARD_WRITER_MODEL.tag);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const summarize = (chars: number): Promise<unknown> => callModel({
  agentId: 'a-fixture', modelId: 'm-std-writer', systemPrompt: '',
  messages: [{ role: 'user', content: 'r'.repeat(chars) }], tools: false, purpose: 'memory_summarize', utilityTargetTokens: 5_000,
});
const proseReading = (): number | null =>
  (mockDb.current!.prepare("SELECT measured_chars_per_token_prose AS r FROM providers WHERE id = 'local-ollama'").get() as { r: number | null }).r;

describe('a long low-density input reaches the writer whole', () => {
  it('on a box that has not measured itself, the window is sized at B5\'s measured density, and nothing is cut', async () => {
    expect(ollamaCharsPerToken('local-ollama')).toBe(B5_MEASURED_CHARS_PER_TOKEN);
    await summarize(CHUNK_CHARS);
    expect(seen).toHaveLength(1);
    expect(seen[0].numCtx).toBeGreaterThanOrEqual(seen[0].promptTokens);
    expect(seen[0].evaluated, 'the B5 failure shape: half the window cut').toBe(seen[0].promptTokens);
  });

  it('the cost row teaches the box its own density (Ollama\'s prompt_eval_count), and the next window uses it', async () => {
    expect(proseReading()).toBeNull();
    await summarize(CHUNK_CHARS);
    const measured = proseReading();
    expect(measured).not.toBeNull();
    expect(measured!).toBeCloseTo(CHUNK_CHARS / Math.ceil(CHUNK_CHARS / TRUE_CHARS_PER_TOKEN), 2);
    // A denser box measures lower, and its next window grows to hold the same characters.
    mockDb.current!.prepare("UPDATE providers SET measured_chars_per_token_prose = 2.0 WHERE id = 'local-ollama'").run();
    seen.length = 0;
    await summarize(CHUNK_CHARS);
    expect(seen[0].numCtx).toBeGreaterThanOrEqual(CHUNK_CHARS / 2.0);
  });

  it('a reading above the asserted 4 never shrinks a window below today\'s', () => {
    mockDb.current!.prepare("UPDATE providers SET measured_chars_per_token_prose = 6.5 WHERE id = 'local-ollama'").run();
    expect(ollamaCharsPerToken('local-ollama')).toBe(CHARS_PER_TOKEN);
  });

  it('A4\'s reserve: the writer\'s job window holds a whole leaf chunk at the measured density', async () => {
    const window = await writerJobWindowTokens(null);
    expect(window).toBeGreaterThanOrEqual(Math.ceil(CHUNK_CHARS / B5_MEASURED_CHARS_PER_TOKEN));
  });
});
