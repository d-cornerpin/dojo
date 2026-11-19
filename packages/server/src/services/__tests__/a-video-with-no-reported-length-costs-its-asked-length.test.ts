import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-a5-media-stop', 'dojo.db'),
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

// The turn machinery is irrelevant here; mocked so the success path's lazy import of `costs/tracker.js`,
// reached through the budget chain, never pulls the model-call chain (same line as the sibling poller suites).
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

import { runMigrations } from '../../db/migrations.js';
// The cost tracker reaches the runtime graph, which compiled inside a clause, by its first import,
// costs past every wait below; it is compiled once here, at load.
import '../../costs/tracker.js';

const AGENT = 'a5-media-agent';
const MODEL = 'model-media';
const PROVIDER = 'prov-media';

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

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Media', 'api/media', '["image_generation","audio_generation","video_generation","transcription"]', 1, 'second', 0.1)`,
  ).run(MODEL, PROVIDER);
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Helper', 'idle', '1970-01-01')`,
  ).run(AGENT);
}

let STATUS: Record<string, unknown> = {};

function queueJob(): void {
  mockDb.current!.prepare(`
    INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, status, attempt_count, duration_seconds)
    VALUES ('vid_len', ?, ?, ?, 'prov-job-1', 'a cat', 'queued', 0, 8)
  `).run(AGENT, MODEL, PROVIDER);
}

function videoRow(): { status: string; duration_seconds: number | null; cost_usd: number | null } {
  return mockDb.current!.prepare('SELECT status, duration_seconds, cost_usd FROM video_jobs WHERE id = ?')
    .get('vid_len') as { status: string; duration_seconds: number | null; cost_usd: number | null };
}

/** Runs the real poll loop to the finished row: the first poll is immediate, so 2s is plenty. */
async function driveToSuccess(): Promise<void> {
  answerWith((url) => url.endsWith('/content')
    ? new Response(Buffer.from('fake-mp4-bytes'), { status: 200 })
    : json(STATUS));
  const { enqueueVideoJob } = await import('../video-job-poller.js');
  enqueueVideoJob('vid_len');
  for (let i = 0; i < 200 && videoRow().status !== 'succeeded'; i += 1) await tick(10);
}

beforeEach(() => {
  vi.resetModules();
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

describe('a finished video is priced from the provider length, else the asked length', () => {
  it('no reported length: the asked length prices it', async () => {
    STATUS = { status: 'completed' };
    queueJob();
    await driveToSuccess();

    const row = videoRow();
    expect(row.status, 'the render still has to reach the success path').toBe('succeeded');
    expect(row.duration_seconds).toBe(8);
    expect(row.cost_usd).toBeCloseTo(0.8);
  });

  it('a reported length wins', async () => {
    STATUS = { status: 'completed', duration_seconds: 4 };
    queueJob();
    await driveToSuccess();

    const row = videoRow();
    expect(row.status, 'the render still has to reach the success path').toBe('succeeded');
    expect(row.duration_seconds).toBe(4);
    expect(row.cost_usd).toBeCloseTo(0.4);
  });
});
