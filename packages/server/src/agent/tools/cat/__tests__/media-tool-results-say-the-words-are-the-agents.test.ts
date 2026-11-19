// What the media tools tell the agent about the words with the file: the engine writes no caption, so the agent's own
// words are all the person gets with it. The tool result must say that plainly, and must not call the line optional.

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
  const dir = p.join(process.env.DOJO_TEST_HOME_ROOT || o.tmpdir(), 'dojo-media-words');
  return { homeDir: (): string => dir, dojoDir: (...a: string[]): string => p.join(dir, '.dojo', ...a) };
});
vi.mock('../../../effects/fs.js', () => ({ existsSync: () => true, mkdirSync: () => undefined, copyFileSync: () => undefined, statSync: () => ({ size: 3 }) }));
vi.mock('../../../turn-context.js', () => ({ turnContext: () => undefined }));

vi.mock('../../../../services/audio-gen-model.js', () => ({ getEffectiveAudioGenModel: () => ({ modelId: 'fake-audio', providerId: 'fake-provider', apiModelId: 'x' }) }));
vi.mock('../../../../services/music-gen-model.js', () => ({ getEffectiveMusicGenModel: () => ({ modelId: 'fake-music', providerId: 'fake-provider', apiModelId: 'x' }) }));
import { mediaHandlers } from '../media.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, model_id TEXT);
    INSERT INTO agents VALUES ('a1', 'idle', NULL);`);
  hoisted.recipient = null;
  hoisted.presence = 'present';
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

/** Words that hand the agent a way to say nothing, or to close the conversation. */
const COACHES_SILENCE = /If you do write|End your turn|end your turn|without writing any further text|short caption/;
const SAYS_ITS_THE_AGENTS_WORDS = /no caption/i;

describe('the media tool results say the agent\'s words are what the person gets with the file', () => {
  it('image_create on the dashboard', async () => {
    const r = await mediaHandlers.image_create({ agentId: 'a1', name: 'image_create', args: { description: 'a fake cat' }, callId: 'c', toolCall: {} as never });
    expect(r.content).toMatch(SAYS_ITS_THE_AGENTS_WORDS);
    expect(r.content).toContain('write that line in this turn');
    expect(r.content).not.toMatch(COACHES_SILENCE);
  });
  it('image_create over iMessage', async () => {
    hoisted.recipient = '+15550100';
    const r = await mediaHandlers.image_create({ agentId: 'a1', name: 'image_create', args: { description: 'a fake cat' }, callId: 'c', toolCall: {} as never });
    expect(r.content).toContain('write that line in this turn');
    expect(r.content).toContain('check the dashboard');
    expect(r.content).not.toMatch(COACHES_SILENCE);
  });
  it('tts_create and music_create', async () => {
    for (const [name, args, kind] of [['tts_create', { text: 'hello there' }, 'audio'], ['music_create', { description: 'calm piano' }, 'music']] as const) {
      const r = await mediaHandlers[name]({ agentId: 'a1', name, args, callId: 'c', toolCall: {} as never });
      expect(r.content, name).toMatch(SAYS_ITS_THE_AGENTS_WORDS);
      expect(r.content, name).toContain(`only text that arrives with the ${kind}`);
      expect(r.content, name).not.toMatch(COACHES_SILENCE);
    }
  });
});
