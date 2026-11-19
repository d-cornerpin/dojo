// A provider that answers with a web link instead of a base64 picture never has the link's letters saved
// as a .png and reported as a made picture. A real picture starts with its format's signature; anything
// else lands on the decode failure.
// No real provider is contacted: `globalThis.fetch` is stubbed in every case.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-a-link-not-a-picture', 'dojo.db'),
  };
});

const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
}));

vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'test-key',
}));

// The effects facade refuses filesystem work outside an authorized tool call, and the generator
// ensures its output directory on the way in. Nothing here is about the filesystem, so the facade
// is answered rather than driven.
vi.mock('../../agent/effects/fs.js', () => ({
  existsSync: () => true,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  copyFileSync: () => undefined,
  readFileSync: () => Buffer.alloc(0),
  statSync: () => ({ size: 0 }),
}));

import { runMigrations } from '../../db/migrations.js';
import { generateImage } from '../image-generation.js';

const AGENT = 'a-link-picture-agent';
const MODEL = 'model-media';
const PROVIDER = 'prov-media';

// ── the fetch stub ──────────────────────────────────────────────────────────────────────

interface Dial { url: string; signal: AbortSignal | undefined }
let dials: Dial[] = [];
const realFetch = globalThis.fetch;

/** Answers with whatever the handler returns; records the signal it was handed. */
function answerWith(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    dials.push({ url: String(input), signal: init?.signal ?? undefined });
    return handler(String(input));
  }) as unknown as typeof globalThis.fetch;
}

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

/** A provider answer carrying one image URL. */
const imageAnswer = (url: string) => json({ choices: [{ message: { images: [{ image_url: { url } }] } }], usage: {} });

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Media', 'api/media', '["image_generation","audio_generation","video_generation","transcription"]', 1, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Helper', 'idle', '1970-01-01')`,
  ).run(AGENT);
}

beforeEach(() => {
  dials = [];
  frames.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a link is never saved as a picture', () => {
  it('a web link is not a picture', async () => {
    answerWith(() => imageAnswer('https://example.com/pic.png'));
    const r = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('DECODE_ERROR');
  });

  it('a real PNG is a picture', async () => {
    answerWith(() => imageAnswer('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='));
    const r = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(r.ok).toBe(true);
  });

  it('plain base64 text that is not a picture is refused', async () => {
    answerWith(() => imageAnswer('aGVsbG8gd29ybGQ='));
    const r = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('DECODE_ERROR');
  });

  it('a picture in a format the Dojo does not keep is refused in plain words', async () => {
    const bmp = Buffer.from('BM' + 'x'.repeat(40)).toString('base64');
    answerWith(() => imageAnswer(`data:image/bmp;base64,${bmp}`));
    const r = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('DECODE_ERROR');
    expect(r.ok === false && r.error).toBe('The image provider sent back something that is not a picture the Dojo can save (it has to be a PNG, JPEG, GIF or WEBP picture), so nothing was saved. Try again, or pick a different image model.');
  });
});
