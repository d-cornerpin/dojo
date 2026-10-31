// A failed image generation must reach the person who asked over iMessage, not only the dashboard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const hoisted = vi.hoisted(() => ({ recipient: null as string | null, presence: 'present' }));

vi.mock('../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../util.js', async (orig) => ({ ...(await orig()), auditLog: vi.fn() }));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../agent-status.js', () => ({ writeAgentStatus: vi.fn() }));
vi.mock('../../../../memory/message-store.js', () => ({
  deliveredResult: () => ({}),
  insertMessageIfAbsent: vi.fn(),
}));
vi.mock('../../../../work/ask-settlement.js', () => ({ settleAskOnAsyncResult: vi.fn() }));
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
  sendResponseViaIMessage: vi.fn(async () => null),
  getDefaultSender: () => null,
}));
vi.mock('../../../access/read.js', () => ({ mayUseChannel: () => true }));
vi.mock('../../../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../../../turn-context.js', () => ({ turnContext: () => undefined }));

import { mediaHandlers } from '../media.js';
import { sendResponseViaIMessage } from '../../../../services/imessage-bridge.js';
import { generateImage } from '../../../../services/image-generation.js';

const sendSpy = vi.mocked(sendResponseViaIMessage);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, model_id TEXT);
    INSERT INTO agents VALUES ('a1', 'idle', NULL);`);
  sendSpy.mockClear();
  vi.mocked(generateImage).mockClear();
  hoisted.recipient = null;
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

describe('image_create failure note', () => {
  it('texts the failure to the iMessage requester', async () => {
    hoisted.recipient = '+15550100';
    await call();
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    const [text, agent, to] = sendSpy.mock.calls[0];
    expect(text).toContain('provider said no');
    expect(agent).toBe('a1');
    expect(to).toBe('+15550100');
  });

  it('does not text anyone when the request was not over iMessage and the owner is present', async () => {
    await call();
    await vi.waitFor(() => expect(vi.mocked(generateImage)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
