// A provider answer carrying a web link is never saved as a .png: only data with a real picture signature is a picture.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'test-key',
}));

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

const realFetch = globalThis.fetch;

function answerWith(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: unknown) => handler(String(input))) as unknown as typeof globalThis.fetch;
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

  it('a picture in a format the Dojo does not keep is refused in plain words', async () => {
    const bmp = Buffer.from('BM' + 'x'.repeat(40)).toString('base64');
    answerWith(() => imageAnswer(`data:image/bmp;base64,${bmp}`));
    const r = await generateImage({ agentId: AGENT, modelId: MODEL, prompt: 'a cat' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('DECODE_ERROR');
    expect(r.ok === false && r.error).toBe('The image provider sent back something that is not a picture the Dojo can save (it has to be a PNG, JPEG, GIF or WEBP picture), so nothing was saved. Try again, or pick a different image model.');
  });
});
