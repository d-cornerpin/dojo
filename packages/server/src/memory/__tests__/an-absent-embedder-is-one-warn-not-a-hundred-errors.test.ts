// ════════════════════════════════════════════════════════════════════════════
// THE OPTIONAL EMBEDDER IS HONEST ABOUT BEING ABSENT.
//
// ── THE INCIDENT ────────────────────────────────────────────────────────────
// Release ritual v3.1.26 ROUND 9 (2026-09-21) came back RED on one signature,
// 102 of them in 19 minutes:
//
//   [embeddings] Failed to store embedding
//     error: Ollama embedding failed: HTTP 404
//            {"error":"model \"nomic-embed-text\" not found, try pulling it first"}
//
// The daemon was UP and serving zero models. `storeEmbedding` decided whether an
// absent backend was worth an ERROR by testing the message PROSE against
// /ECONNREFUSED|fetch failed|aborted|timeout|ENOTFOUND|network/i — which knows
// about a refused connection and nothing at all about a 404. So the OPTIONAL
// embedder, which fires on every message, response and summary, spent the blast
// broadcasting dashboard ERRORs, and the SAFETY gate stopped the release on them.
//
// ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
//   1. A 404 is ABSENCE. Across many attempts it is ONE warn and ZERO errors.
//   2. It is absence by TYPE, not by prose: the 404 leaves `generateEmbedding`
//      as an EmbeddingBackendUnavailableError. The case below also asserts the
//      round-9 regex cannot match that message — the defect, stated as a fact
//      rather than remembered.
//   3. A 500 and a malformed body still take the ERROR branch. Without this
//      control, "classify everything as absent" would pass the first two.
//   4. The latch is not a gag: once the backend answers, a LATER absence speaks.
//
// The engine keeps TRYING throughout — the graceful path is unchanged, only the
// logging is. Each case asserts the fetch count to hold that line.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => {
  const calls = {
    debug: [] as unknown[][], info: [] as unknown[][],
    warn: [] as unknown[][], error: [] as unknown[][],
  };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
    db: { current: null as Database.Database | null },
  };
});

vi.mock('../../logger.js', () => ({ createLogger: () => h.logger }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!h.db.current) throw new Error('test DB not initialized');
    return h.db.current;
  },
}));

const CONTENT = 'a body of text comfortably past the twenty-character floor storeEmbedding enforces';
const ATTEMPTS = 25;
const NOT_FOUND_BODY = '{"error":"model \\"nomic-embed-text\\" not found, try pulling it first"}';

// The classifier as round 9 found it. Kept here as EVIDENCE, not as machinery:
// the 404 case asserts it does not match, which is the whole defect in one line.
const ROUND_9_REGEX = /ECONNREFUSED|fetch failed|aborted|timeout|ENOTFOUND|network/i;

const realFetch = globalThis.fetch;

// The absence latch is module state, so every case gets a freshly evaluated module.
async function freshEmbeddings(): Promise<typeof import('../embeddings.js')> {
  vi.resetModules();
  return import('../embeddings.js');
}

function respond(body: string, status: number): () => Promise<Response> {
  return async () => new Response(body, { status });
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE embeddings (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
      agent_id TEXT, content_preview TEXT, embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL, created_at TEXT
    );
  `);
  h.db.current = db;
  h.calls.debug.length = 0;
  h.calls.info.length = 0;
  h.calls.warn.length = 0;
  h.calls.error.length = 0;
});

afterEach(() => {
  h.db.current?.close();
  h.db.current = null;
  globalThis.fetch = realFetch;
});

describe('an embedder that is not there', () => {
  it('404 "model not found" across 25 attempts is ONE warn and ZERO errors', async () => {
    const fetchStub = vi.fn(respond(NOT_FOUND_BODY, 404));
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const { storeEmbedding } = await freshEmbeddings();
    for (let i = 0; i < ATTEMPTS; i++) await storeEmbedding('message', `src-${i}`, null, CONTENT);

    expect(h.calls.error, 'an OPTIONAL backend being absent is not an operator-actionable error').toHaveLength(0);
    expect(h.calls.warn, 'absence is one fact, not one fact per message').toHaveLength(1);
    // The graceful path is PRESERVED, not replaced: it still tried every time and
    // still swallowed the failure. Only the log posture changed.
    expect(fetchStub).toHaveBeenCalledTimes(ATTEMPTS);
    expect(h.db.current!.prepare('SELECT COUNT(*) c FROM embeddings').get()).toEqual({ c: 0 });
  });

  it('the 404 arrives as a TYPE, and the round-9 regex provably could not see it', async () => {
    globalThis.fetch = vi.fn(respond(NOT_FOUND_BODY, 404)) as unknown as typeof fetch;
    const { generateEmbedding, isEmbeddingBackendUnavailable, EmbeddingBackendUnavailableError } =
      await freshEmbeddings();

    const err = await generateEmbedding(CONTENT).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingBackendUnavailableError);
    expect((err as InstanceType<typeof EmbeddingBackendUnavailableError>).status).toBe(404);
    expect(isEmbeddingBackendUnavailable(err)).toBe(true);
    // THE DEFECT, stated: the message reads exactly as it did in the round-9 logs,
    // and the classifier that was reading messages cannot match it. Classification
    // had to stop depending on prose; widening the prose was never the fix.
    expect(ROUND_9_REGEX.test((err as Error).message)).toBe(false);
    expect((err as Error).message).toContain('HTTP 404');
  });

  it('an OpenAI-compatible backend answering 404 is absent on the same terms', async () => {
    h.db.current!.prepare("INSERT INTO config (key, value) VALUES ('embedding_config', ?)")
      .run(JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'http://localhost:9999' }));
    globalThis.fetch = vi.fn(respond('{"error":{"message":"The model does not exist"}}', 404)) as unknown as typeof fetch;

    const { storeEmbedding } = await freshEmbeddings();
    for (let i = 0; i < 5; i++) await storeEmbedding('summary', `oai-${i}`, null, CONTENT);

    expect(h.calls.error).toHaveLength(0);
    expect(h.calls.warn).toHaveLength(1);
  });

  it('a daemon that never answers is absent too — one warn, no errors', async () => {
    const fetchStub = vi.fn(async () => { throw new TypeError('fetch failed'); });
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const { storeEmbedding } = await freshEmbeddings();
    for (let i = 0; i < ATTEMPTS; i++) await storeEmbedding('message', `down-${i}`, null, CONTENT);

    expect(h.calls.error).toHaveLength(0);
    expect(h.calls.warn).toHaveLength(1);
    expect(fetchStub).toHaveBeenCalledTimes(ATTEMPTS);
  });

  it('the latch is not a gag: the backend returning re-arms the next warning', async () => {
    let body = NOT_FOUND_BODY;
    let status = 404;
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

    const { storeEmbedding } = await freshEmbeddings();
    await storeEmbedding('message', 'gone-1', null, CONTENT);
    await storeEmbedding('message', 'gone-2', null, CONTENT);
    expect(h.calls.warn).toHaveLength(1);

    body = JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4] });
    status = 200;
    await storeEmbedding('message', 'back', null, CONTENT);
    expect(h.db.current!.prepare('SELECT COUNT(*) c FROM embeddings').get()).toEqual({ c: 1 });

    body = NOT_FOUND_BODY;
    status = 404;
    await storeEmbedding('message', 'gone-3', null, CONTENT);
    expect(h.calls.warn, 'a second, later absence is its own fact and must be said').toHaveLength(2);
    expect(h.calls.error).toHaveLength(0);
  });
});

describe('the discrimination control — a genuine failure is still an ERROR', () => {
  it('a 500 is not absence', async () => {
    globalThis.fetch = vi.fn(respond('internal failure in the inference runtime', 500)) as unknown as typeof fetch;

    const { storeEmbedding } = await freshEmbeddings();
    for (let i = 0; i < 3; i++) await storeEmbedding('message', `boom-${i}`, null, CONTENT);

    expect(h.calls.error, 'a backend that IS there and is broken is an operator problem').toHaveLength(3);
    expect(h.calls.warn).toHaveLength(0);
    expect(h.calls.error[0][0]).toBe('Failed to store embedding');
  });

  it('a 200 carrying a malformed body is not absence', async () => {
    globalThis.fetch = vi.fn(respond('<html>proxy ate it</html>', 200)) as unknown as typeof fetch;

    const { storeEmbedding } = await freshEmbeddings();
    await storeEmbedding('message', 'garbled', null, CONTENT);

    expect(h.calls.error).toHaveLength(1);
    expect(h.calls.warn).toHaveLength(0);
  });

  it('a DB write fault is not absence', async () => {
    globalThis.fetch = vi.fn(respond(JSON.stringify({ embedding: [1, 2, 3] }), 200)) as unknown as typeof fetch;
    h.db.current!.exec('DROP TABLE embeddings');

    const { storeEmbedding } = await freshEmbeddings();
    await storeEmbedding('message', 'no-table', null, CONTENT);

    expect(h.calls.error, 'the ERROR branch the original comment reserved for exactly this').toHaveLength(1);
    expect(h.calls.warn).toHaveLength(0);
  });
});
