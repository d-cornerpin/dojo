// The daily limit guarded chat calls only: past the limit a video, a picture, a song or a spoken clip
// still spent real money. The four paid media tools ask the one limit check before they start a job.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../db/migrations.js';
import { invalidateDailySpendCache } from '../../../../costs/spend.js';

const mockDb: { current: Database.Database | null } = { current: null };
const hoisted = vi.hoisted(() => ({ recipient: null as string | null, presence: 'present' }));
const createJob = vi.hoisted(() => vi.fn(() => 'job-1'));
const submitVideo = vi.hoisted(() => vi.fn());

vi.mock('../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../util.js', async (orig) => ({ ...(await orig()), auditLog: vi.fn() }));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../agent-status.js', () => ({ writeAgentStatus: vi.fn() }));
vi.mock('../../../../services/generation-jobs.js', () => ({
  createGenerationJob: createJob,
  setRunning: () => true,
  setSucceeded: vi.fn(),
  setFailed: vi.fn(),
  setCancelled: vi.fn(),
  enqueueAudioOrMusicJob: vi.fn(),
}));
vi.mock('../../../../services/image-generation.js', () => ({
  generateImage: vi.fn(async () => ({ ok: false, code: 'PROVIDER', error: 'provider said no' })),
}));
vi.mock('../../../../services/image-gen-model.js', () => ({
  getEffectiveImageGenModel: () => ({ modelId: 'fake-image-model', providerId: 'fake-provider' }),
}));
vi.mock('../../../../services/presence.js', () => ({ getPresence: () => hoisted.presence }));
vi.mock('../../../../services/imessage-bridge.js', () => ({
  getTurnScopedImRecipient: () => hoisted.recipient,
  sendIMessageWithAttachment: vi.fn(async () => true),
  sendIMessage: vi.fn(async () => null),
  getDefaultSender: () => null,
}));
vi.mock('../../../access/read.js', () => ({ mayUseChannel: () => true }));
vi.mock('../../../effects/fs.js', () => ({ existsSync: () => true, mkdirSync: () => undefined, copyFileSync: () => undefined, statSync: () => ({ size: 3 }) }));
vi.mock('../../../turn-context.js', () => ({ turnContext: () => undefined }));

vi.mock('../../../../services/audio-gen-model.js', () => ({ getEffectiveAudioGenModel: () => ({ modelId: 'fake-audio', providerId: 'fake-provider', apiModelId: 'x' }) }));
vi.mock('../../../../services/music-gen-model.js', () => ({ getEffectiveMusicGenModel: () => ({ modelId: 'fake-music', providerId: 'fake-provider', apiModelId: 'x' }) }));
vi.mock('../../../../services/video-gen-model.js', () => ({ getEffectiveVideoGenModel: () => ({ modelId: 'fake-video', providerId: 'fake-provider', apiModelId: 'x' }) }));
vi.mock('../../../../services/video-generation.js', () => ({ submitVideoJob: submitVideo }));
import { mediaHandlers } from '../media.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.exec(`
    INSERT INTO agents (id, name, model_id, status) VALUES ('a1', 'Helper', NULL, 'idle');
    INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
      VALUES ('cr-1', 'a1', 'm', 'p', 0, 0, 30, datetime('now'));
  `);
  invalidateDailySpendCache();
  createJob.mockClear();
  submitVideo.mockClear();
  hoisted.recipient = null;
  hoisted.presence = 'present';
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const call = (name: string, args: Record<string, unknown>) =>
  mediaHandlers[name]({ agentId: 'a1', name, args, callId: 'c', toolCall: {} as never });

describe('a paid media job is refused at the spending limit', () => {
  it('a picture is refused at the daily limit', async () => {
    const r = await call('image_create', { description: 'a cat' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('The daily spending limit is reached ($30.00 spent of $25.00), so no picture was started.');
    expect(createJob).not.toHaveBeenCalled();
  });

  it('speech and music are refused', async () => {
    const t = await call('tts_create', { text: 'hello' });
    expect(t.content).toContain('so no audio was started.');
    const m = await call('music_create', { description: 'calm piano' });
    expect(m.content).toContain('so no music was started.');
    expect(createJob).not.toHaveBeenCalled();
  });

  it('a video is refused', async () => {
    const r = await call('video_create', { description: 'a cat walking', duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' });
    expect(r.content).toContain('so no video was started.');
    expect(submitVideo).not.toHaveBeenCalled();
  });

  it('an agent limit names its period', async () => {
    mockDb.current!.exec(`
      DELETE FROM budgets WHERE id = 'global_daily';
      INSERT INTO budgets (id, scope, limit_usd, period, created_at, updated_at)
        VALUES ('agent_a1', 'agent', 10, 'weekly', datetime('now'), datetime('now'));
    `);
    invalidateDailySpendCache();
    const r = await call('image_create', { description: 'a cat' });
    expect(r.content).toContain("This agent's weekly spending limit is reached ($30.00 spent of $10.00), so no picture was started.");
  });

  it('at the limit a free local model still runs and a paid one is refused', async () => {
    const db = mockDb.current!;
    db.exec(`
      INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('fake-provider', 'Local', 'ollama', 'http://localhost:11434', 'none');
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('fake-image-model', 'fake-provider', 'Local picture', 'x', '["image_generation"]', 1);
    `);
    const free = await call('image_create', { description: 'a cat' });
    expect(free.content).toContain('Image generation kicked off');
    db.exec(`UPDATE providers SET type = 'openai-compatible' WHERE id = 'fake-provider'`);
    const paid = await call('image_create', { description: 'a dog' });
    expect(paid.isError).toBe(true);
    expect(paid.content).toContain('so no picture was started.');
  });
});
