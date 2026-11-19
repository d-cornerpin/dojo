// A video_jobs row records the same lineage as a generation_jobs row (source message, turn, task, conversation) plus the asked length.

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

import { runMigrations } from '../../db/migrations.js';

const AGENT = 'a5-media-agent';
const MODEL = 'model-media';
const PROVIDER = 'prov-media';

const realFetch = globalThis.fetch;

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

afterEach(async () => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
  const { endTurnContext } = await import('../../agent/turn-context.js');
  endTurnContext(AGENT);
});

describe('a video job keeps its request and its asked length', () => {
  it('a video started inside a turn records the turn\'s request', async () => {
    globalThis.fetch = vi.fn(async () => json({ id: 'prov-job-1', status: 'queued' })) as unknown as typeof globalThis.fetch;
    const { openTurnContext } = await import('../../agent/turn-context.js');
    const ctx = openTurnContext(AGENT);
    ctx.root = { kind: 'ask', id: 'ask-1', sourceMessageId: 'msg-1', conversationId: 'conv-1' };
    ctx.turnNumber = 7;
    ctx.servedWork = { taskId: 'task-1', runId: null, taskKind: null, originConvKey: null };
    const { submitVideoJob } = await import('../video-generation.js');
    const r = await submitVideoJob({ modelId: MODEL, agentId: AGENT, prompt: 'a cat', paramSpec: { params: [] } as never, canonicalParams: { duration: 8 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = mockDb.current!.prepare(
      'SELECT source_message_id, turn_number, task_id, conversation_id, duration_seconds FROM video_jobs WHERE id = ?',
    ).get(r.jobId);
    expect(row).toEqual({ source_message_id: 'msg-1', turn_number: 7, task_id: 'task-1', conversation_id: 'conv-1', duration_seconds: 8 });
  });

  it('outside a turn and with no length the values are empty', async () => {
    globalThis.fetch = vi.fn(async () => json({ id: 'prov-job-1', status: 'queued' })) as unknown as typeof globalThis.fetch;
    const { submitVideoJob } = await import('../video-generation.js');
    const r = await submitVideoJob({ modelId: MODEL, agentId: AGENT, prompt: 'a cat', paramSpec: { params: [] } as never, canonicalParams: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = mockDb.current!.prepare(
      'SELECT source_message_id, turn_number, task_id, conversation_id, duration_seconds FROM video_jobs WHERE id = ?',
    ).get(r.jobId);
    expect(row).toEqual({ source_message_id: null, turn_number: null, task_id: null, conversation_id: null, duration_seconds: null });
  });

  it('a picture job still records its lineage', async () => {
    const { openTurnContext } = await import('../../agent/turn-context.js');
    const ctx = openTurnContext(AGENT);
    ctx.root = { kind: 'ask', id: 'ask-1', sourceMessageId: 'msg-1', conversationId: 'conv-1' };
    ctx.turnNumber = 7;
    ctx.servedWork = { taskId: 'task-1', runId: null, taskKind: null, originConvKey: null };
    const { createGenerationJob } = await import('../generation-jobs.js');
    const id = createGenerationJob({ kind: 'image', agentId: AGENT, modelId: MODEL, providerId: PROVIDER, prompt: 'a cat' });
    const row = mockDb.current!.prepare(
      'SELECT source_message_id, turn_number, task_id, conversation_id FROM generation_jobs WHERE id = ?',
    ).get(id);
    expect(row).toEqual({ source_message_id: 'msg-1', turn_number: 7, task_id: 'task-1', conversation_id: 'conv-1' });
  });
});
