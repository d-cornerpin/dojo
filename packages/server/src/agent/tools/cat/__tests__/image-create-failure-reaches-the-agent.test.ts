// A failed image generation reaches the AGENT (a notice naming the error and who asked), so the agent tells the person
// in its own words. The engine writes no text to the person and no dashboard bubble in the agent's voice (C1/P1, R1).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const hoisted = vi.hoisted(() => ({ recipient: null as string | null, presence: 'present', woken: false }));

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
vi.mock('../../../../work/ask-settlement.js', () => ({ settleAskOnAsyncResult: vi.fn(), settleAskOnJobEnded: vi.fn() }));
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
vi.mock('../../../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../../../wake-with-notice.js', () => ({
  tellAgentAndWake: vi.fn(async () => undefined),
  isFailureWokenTurn: () => hoisted.woken,
  requesterReachSentence: async (a: string) => `Your written reply on this turn does NOT reach them; to tell them, call imessage_send with recipient="${a}".`,
}));
vi.mock('../../../../home.js', async () => {
  const p = await import('node:path'); const o = await import('node:os');
  const dir = p.join(process.env.DOJO_TEST_HOME_ROOT || o.tmpdir(), 'dojo-image-no-caption');
  return { homeDir: (): string => dir, dojoDir: (...a: string[]): string => p.join(dir, '.dojo', ...a) };
});
vi.mock('../../../effects/fs.js', () => ({ existsSync: () => true, mkdirSync: () => undefined, copyFileSync: () => undefined, statSync: () => ({ size: 3 }) }));
vi.mock('../../../turn-context.js', () => ({ turnContext: () => undefined }));

import { mediaHandlers } from '../media.js';
import { sendIMessage } from '../../../../services/imessage-bridge.js';
import { tellAgentAndWake } from '../../../wake-with-notice.js';
import { postAgentNotice } from '../../../agent-notice.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { generateImage } from '../../../../services/image-generation.js';

const sendSpy = vi.mocked(sendIMessage);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, model_id TEXT);
    INSERT INTO agents VALUES ('a1', 'idle', NULL);`);
  sendSpy.mockClear();
  vi.mocked(tellAgentAndWake).mockClear();
  vi.mocked(postAgentNotice).mockClear();
  vi.mocked(insertMessageIfAbsent).mockClear();
  vi.mocked(generateImage).mockClear();
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

describe('image_create failure', () => {
  it('tells the agent, naming the error and the iMessage requester, and texts nobody itself', async () => {
    hoisted.recipient = '+15550100';
    await call();
    await vi.waitFor(() => expect(vi.mocked(tellAgentAndWake)).toHaveBeenCalledTimes(1));
    const n = vi.mocked(tellAgentAndWake).mock.calls[0][0];
    expect(n.agentId).toBe('a1');   // the agent is woken so it tells the person now
    expect(n.brief).toContain('provider said no');
    expect(n.brief).toContain('+15550100');
    expect(n.brief).toMatch(/does NOT reach them/);   // R4: the woken turn is told how to reach the requester
    expect(n.brief).toContain('imessage_send');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(vi.mocked(insertMessageIfAbsent)).not.toHaveBeenCalled();   // no engine-written bubble in the agent's voice
  });

  it('tells the agent on the dashboard too, with no text and no bubble', async () => {
    await call();
    await vi.waitFor(() => expect(vi.mocked(tellAgentAndWake)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(tellAgentAndWake).mock.calls[0][0].brief).toContain('provider said no');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(vi.mocked(insertMessageIfAbsent)).not.toHaveBeenCalled();
  });
});

describe('image_create failure inside a failure-woken turn', () => {
  it('is handed to the helper as an in-failure-turn call so it cannot wake the agent again', async () => {
    hoisted.woken = true;
    await call();
    await vi.waitFor(() => expect(vi.mocked(tellAgentAndWake)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(tellAgentAndWake).mock.calls[0][0].inFailureTurn).toBe(true);
  });
});

describe('image_create success: no engine-written words in the agent\'s voice (P12/item 5)', () => {
  const okImage = async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const f = path.join(os.tmpdir(), `dojo-img-${Date.now()}.png`); fs.writeFileSync(f, 'png');
    vi.mocked(generateImage).mockResolvedValueOnce({ ok: true, filePath: f, filename: 'x.png', sizeBytes: 3, latencyMs: 1, providerId: 'p', width: 1, height: 1, inputTokens: 0, outputTokens: 0 } as never);
  };
  it('posts the image with NO caption text and tells the agent where it went', async () => {
    await okImage();
    await call();
    await vi.waitFor(() => expect(vi.mocked(insertMessageIfAbsent)).toHaveBeenCalled());
    const row = vi.mocked(insertMessageIfAbsent).mock.calls[0][0] as { content: string; attachments?: string };
    expect(row.content).toBe('');
    expect(row.attachments).toBeTruthy();
    await vi.waitFor(() => expect(vi.mocked(postAgentNotice)).toHaveBeenCalled());
    expect(vi.mocked(postAgentNotice).mock.calls[0][0].brief).toMatch(/posted in the dashboard/);
    expect(vi.mocked(tellAgentAndWake)).not.toHaveBeenCalled();   // success never wakes (the 2026-06-09 re-generation loop)
  });
});
