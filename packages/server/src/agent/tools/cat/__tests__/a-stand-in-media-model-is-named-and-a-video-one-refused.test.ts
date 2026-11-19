// When the model picked in Settings could not be used, an enabled same-kind model stood in, and it may cost more.
// The tool result names the stand-in and its price so the agent tells the person; a video is never started on a
// stand-in by itself, the agent asks the person which video model to use.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const hoisted = vi.hoisted(() => ({ recipient: null as string | null, presence: 'present' }));
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
vi.mock('../../../../costs/spend.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), exceededBudget: () => null }));
vi.mock('../../../../services/generation-jobs.js', () => ({
  createGenerationJob: () => 'job-1',
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
  getEffectiveImageGenModel: () => ({ modelId: 'm-stand', providerId: 'fake-provider', apiModelId: 'x', source: 'failover' }),
}));
vi.mock('../../../../services/presence.js', () => ({ getPresence: () => hoisted.presence }));
vi.mock('../../../../services/imessage-bridge.js', () => ({
  getTurnScopedImRecipient: () => hoisted.recipient,
  sendIMessageWithAttachment: vi.fn(async () => true),
  sendIMessage: vi.fn(async () => null),
  getDefaultSender: () => null,
}));
vi.mock('../../../access/read.js', () => ({ mayUseChannel: () => true }));

vi.mock('../../../../services/audio-gen-model.js', () => ({ getEffectiveAudioGenModel: () => ({ modelId: 'm-stand', providerId: 'fake-provider', apiModelId: 'x', source: 'failover' }) }));
vi.mock('../../../../services/music-gen-model.js', () => ({ getEffectiveMusicGenModel: () => ({ modelId: 'm-stand', providerId: 'fake-provider', apiModelId: 'x', source: 'failover' }) }));
vi.mock('../../../../services/video-gen-model.js', () => ({ getEffectiveVideoGenModel: () => ({ modelId: 'm-stand', providerId: 'fake-provider', apiModelId: 'x', source: 'failover' }) }));
vi.mock('../../../../services/video-generation.js', () => ({ submitVideoJob: submitVideo }));
import { mediaHandlers } from '../media.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, model_id TEXT);
    INSERT INTO agents VALUES ('a1', 'idle', NULL);
    CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT, input_cost_per_m REAL, output_cost_per_m REAL, cost_per_unit REAL, pricing_unit TEXT);
    INSERT INTO models VALUES ('m-stand', 'Backup Painter', NULL, NULL, 0.04, 'megapixel');`);
  hoisted.recipient = null;
  hoisted.presence = 'present';
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a stand-in media model is named, and a video one is refused', () => {
  it('a stand-in picture model is named with its price', async () => {
    const r = await mediaHandlers.image_create({ agentId: 'a1', name: 'image_create', args: { description: 'a cat' }, callId: 'c', toolCall: {} as never });
    expect(r.content).toContain('this ran on the stand-in model "Backup Painter" (price: $0.04 per megapixel). Tell the person which model was used and its price.');
  });

  it('a stand-in speech model is named', async () => {
    mockDb.current!.prepare(`UPDATE models SET cost_per_unit = NULL, pricing_unit = 'token', input_cost_per_m = 2, output_cost_per_m = 8`).run();
    const r = await mediaHandlers.tts_create({ agentId: 'a1', name: 'tts_create', args: { text: 'hello there' }, callId: 'c', toolCall: {} as never });
    expect(r.content).toContain('(price: $2 per million input tokens and $8 per million output tokens)');
  });

  it('a video is never started on a stand-in', async () => {
    const r = await mediaHandlers.video_create({ agentId: 'a1', name: 'video_create', args: { description: 'a cat walking', duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' }, callId: 'c', toolCall: {} as never });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('the Dojo never starts a video on a stand-in model by itself');
    expect(submitVideo).not.toHaveBeenCalled();
  });
});
