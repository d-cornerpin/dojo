// The background picture job writes no agent status: a late 'idle' could land mid-reply of a real turn.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const hoisted = vi.hoisted(() => ({ recipient: null as string | null, presence: 'present', woken: false }));
const statusWrites = vi.hoisted(() => vi.fn());
const frames = vi.hoisted(() => vi.fn());

vi.mock('../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../util.js', async (orig) => ({ ...(await orig()), auditLog: vi.fn() }));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: frames }));
vi.mock('../../../agent-status.js', () => ({ writeAgentStatus: statusWrites }));
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
vi.mock('../../../wake-with-notice.js', () => ({
  tellAgentAndWake: vi.fn(async () => undefined),
  isFailureWokenTurn: () => hoisted.woken,
  requesterReachSentence: async (a: string) => `Your written reply on this turn does NOT reach them; to tell them, call imessage_send with recipient="${a}".`,
}));

import { mediaHandlers } from '../media.js';
import { tellAgentAndWake } from '../../../wake-with-notice.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, model_id TEXT);
    INSERT INTO agents VALUES ('a1', 'idle', NULL);`);
  vi.mocked(tellAgentAndWake).mockClear();
  statusWrites.mockClear();
  frames.mockClear();
  hoisted.recipient = null;
  hoisted.woken = false;
  hoisted.presence = 'present';
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

async function call() {
  return mediaHandlers.image_create({
    agentId: 'a1', name: 'image_create', args: { description: 'a fake cat' }, callId: 'c', toolCall: {} as never,
  });
}

describe('image_create background job and the agent status', () => {
  it('a failed picture job writes no agent status', async () => {
    await call();
    await vi.waitFor(() => expect(vi.mocked(tellAgentAndWake)).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));   // let the job's tail (the old 'idle' write) run
    expect(statusWrites).not.toHaveBeenCalled();
    expect(frames.mock.calls.filter(([f]) => (f as { type?: string }).type === 'agent:status')).toEqual([]);
  });
});
