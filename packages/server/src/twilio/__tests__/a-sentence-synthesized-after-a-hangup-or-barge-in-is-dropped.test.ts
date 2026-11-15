// A caller who hangs up or speaks while a sentence is being spoken by the fallback local voice hears
// nothing more of it: the finished audio is dropped, not queued.
import { describe, it, expect, vi } from 'vitest';

const handleMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const insertMock = vi.hoisted(() => vi.fn());
const synth = vi.hoisted(() => ({ release: (): void => {} }));
vi.mock('../tts-bridge.js', () => ({
  synthesizeForTwilio: () => new Promise((resolve) => {
    synth.release = () => resolve({ pcm: new Float32Array(3), sampleRate: 24000 });
  }),
}));
vi.mock('../../voice/stt-service.js', () => ({ ensureSttReady: async () => {}, transcribeBuffer: vi.fn() }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: vi.fn(() => ({ run: vi.fn() })) }),
  closeDb: vi.fn(),
  getDbPath: () => '',
}));

vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getOwnerName: () => 'the owner',
}));

vi.mock('../../voice/session-record.js', () => ({
  startVoiceSessionRecord: vi.fn(() => 'vsr-1'),
  endVoiceSessionRecord: vi.fn(),
  bumpVoiceSessionTurnCount: vi.fn(),
  stampSpokenMessage: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  getTwilioConfig: () => ({ voiceMaxMinutesPerCall: 1 }),
}));

vi.mock('../client.js', () => ({ endCall: vi.fn(async () => ({ ok: true })) }));

vi.mock('../audio-codec.js', () => ({
  decodeTwilioFrame: vi.fn(), encodeForTwilio: vi.fn(), chunkForTwilio: vi.fn(),
  muLawEncode: vi.fn(), float32ToInt16At8k: vi.fn(), createBiquadState: () => ({}),
  applyAntiAliasLP: vi.fn(),
}));

vi.mock('../../memory/conversations.js', () => ({ resolveOrCreateConversation: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: handleMessageMock }) }));
vi.mock('../../services/channel-safe-senders.js', () => ({ getTwilioVoiceSafeCallers: vi.fn() }));
vi.mock('../../services/imessage-bridge.js', () => ({ addressesMatch: vi.fn() }));
vi.mock('../../tools/inbound-fences.js', () => ({ callUtteranceText: vi.fn() }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: insertMock }));
vi.mock('../../agent/v2/outbound.js', () => ({
  recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn(),
}));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: () => true }));



import { CallSession } from '../call-session.js';

const build = (): CallSession => new CallSession({
  callSid: 'CA777', streamSid: 'MZ7', direction: 'inbound',
  fromNumber: '+15550000001', toNumber: '+15550000002', send: () => {},
});
const queued = (s: CallSession): number => (s as unknown as { ttsQueue: unknown[] }).ttsQueue.length;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('a sentence still being synthesized when the caller hangs up or speaks', () => {
  it('control: it is queued for the caller', async () => {
    const s = build();
    await s.queueAgentSay('Hello there.');
    await tick();
    synth.release();
    await tick();
    expect(queued(s)).toBe(1);
  });

  it('a hang-up during the synthesis drops it', async () => {
    const s = build();
    await s.queueAgentSay('Hello there.');
    await tick();
    s.end('caller-hangup');
    synth.release();
    await tick();
    expect(queued(s)).toBe(0);
  });

  it('a barge-in during the synthesis drops it', async () => {
    const s = build();
    await s.queueAgentSay('Hello there.');
    await tick();
    (s as unknown as { speechGeneration: number }).speechGeneration += 1;
    synth.release();
    await tick();
    expect(queued(s)).toBe(0);
  });
});
