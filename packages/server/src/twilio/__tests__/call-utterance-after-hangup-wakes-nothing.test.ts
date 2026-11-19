// A caller's words that finish being transcribed AFTER the call has ended are dropped:
// they are not stored and they do not wake a turn.
const handleMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const insertMock = vi.hoisted(() => vi.fn());
import { describe, it, expect, vi, beforeEach } from 'vitest';


const sttGate = vi.hoisted(() => ({ release: (_t: string): void => {} }));
vi.mock('../../voice/stt-service.js', () => ({
  ensureSttReady: async () => {},
  transcribeBuffer: () => new Promise<{ text: string }>((resolve) => { sttGate.release = (t: string) => resolve({ text: t }); }),
}));

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
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: vi.fn() }));


import { CallSession } from '../call-session.js';

const build = (): CallSession => new CallSession({
  callSid: 'CA888', streamSid: 'MZ8', direction: 'inbound',
  fromNumber: '+15550000001', toNumber: '+15550000002', send: () => {},
});
const utter = (s: CallSession): Promise<void> =>
  (s as unknown as { handleUtterance(p: Float32Array): Promise<void> }).handleUtterance(new Float32Array(1600));

beforeEach(() => { handleMessageMock.mockClear(); insertMock.mockClear(); });

describe('an utterance still being transcribed when the call ends', () => {
  it('does not wake a turn', async () => {
    const s = build();
    const pending = utter(s);
    await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    s.end('caller-hangup');
    sttGate.release('hello are you there');
    await pending;
    expect(handleMessageMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('while the call is live, the same words do wake a turn (control)', async () => {
    const s = build();
    const pending = utter(s);
    await new Promise((r) => setTimeout(r, 0));
    sttGate.release('hello are you there');
    await pending;
    expect(handleMessageMock).toHaveBeenCalledTimes(1);
  });
});
