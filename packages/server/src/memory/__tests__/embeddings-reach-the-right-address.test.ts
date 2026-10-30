// ════════════════════════════════════════════════════════════════════════════
// THE EMBEDDING REQUEST REACHES THE RIGHT ADDRESS.
//
// An owner pointed memory embeddings at an OpenAI-compatible server, entering the
// address the way the server prints it (`http://box.example.test:8000/v1`). Chat on
// the same server worked, but every embed arrived at `/v1/v1/embeddings` and got a
// 404, so memory search never found anything. `generateEmbedding` appended `/v1` by
// hand; `openAiCompatibleUrl` (services/openai-compatible-url.ts) is the one
// builder that knows the address may already end in it.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: { current: null as Database.Database | null } }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!h.db.current) throw new Error('test DB not initialized');
    return h.db.current;
  },
}));
vi.mock('../../services/ollama-quiet.js', () => ({ localWorkBegins: async () => () => {} }));

const realFetch = globalThis.fetch;
let requested: string[];

function configure(config: Record<string, unknown>): void {
  h.db.current!.prepare("INSERT INTO config (key, value) VALUES ('embedding_config', ?)").run(JSON.stringify(config));
}

async function embedAndReturnUrl(): Promise<string> {
  const { generateEmbedding } = await import('../embeddings.js');
  await generateEmbedding('some text to embed');
  expect(requested).toHaveLength(1);
  return requested[0];
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);');
  h.db.current = db;
  requested = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ embedding: [0.1, 0.2], data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  h.db.current?.close();
  h.db.current = null;
  globalThis.fetch = realFetch;
});

describe('an OpenAI-compatible embedding address', () => {
  it.each([
    ['ends in /v1', 'http://box.example.test:8000/v1'],
    ['ends in /v1/', 'http://box.example.test:8000/v1/'],
    ['has no /v1', 'http://box.example.test:8000'],
    ['has no /v1 and a trailing slash', 'http://box.example.test:8000/'],
  ])('%s: the request goes to /v1/embeddings once', async (_label, baseUrl) => {
    configure({ provider: 'openai', model: 'embed-model', baseUrl });
    expect(await embedAndReturnUrl()).toBe('http://box.example.test:8000/v1/embeddings');
  });
});

describe('the Ollama embedding address', () => {
  it('is still {base}/api/embeddings', async () => {
    configure({ provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://box.example.test:11434/' });
    expect(await embedAndReturnUrl()).toBe('http://box.example.test:11434/api/embeddings');
  });
});
