// A Twilio voice frame that is JSON-null, a bare scalar, or carries the
// `start`/`media` event with no body used to throw out of
// handleVoiceStreamMessage, leaving an unhandled rejection on the socket
// handler. These frames must be ignored instead; a well-formed `start`
// frame still registers its call session.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WSContext } from 'hono/ws';

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


vi.mock('../../voice/stt-service.js', () => ({
  transcribeBuffer: vi.fn(async () => ({ text: '' })),
  ensureSttReady: vi.fn(async () => {}),
}));

vi.mock('../auth.js', () => ({ getTwilioConfig: () => ({ voiceMaxMinutesPerCall: 1 }) }));

vi.mock('../client.js', () => ({ endCall: vi.fn(async () => ({ ok: true })) }));

vi.mock('../audio-codec.js', () => ({
  decodeTwilioFrame: vi.fn(), encodeForTwilio: vi.fn(), chunkForTwilio: vi.fn(),
  muLawEncode: vi.fn(), float32ToInt16At8k: vi.fn(), createBiquadState: () => ({}),
  applyAntiAliasLP: vi.fn(),
}));

vi.mock('../../memory/conversations.js', () => ({ resolveOrCreateConversation: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: vi.fn() }));
vi.mock('../../services/channel-safe-senders.js', () => ({ getTwilioVoiceSafeCallers: vi.fn() }));
vi.mock('../../services/imessage-bridge.js', () => ({ addressesMatch: vi.fn() }));
vi.mock('../../tools/inbound-fences.js', () => ({ callUtteranceText: vi.fn() }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: vi.fn() }));
vi.mock('../../agent/v2/outbound.js', () => ({
  recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn(),
}));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: vi.fn() }));

const { handleVoiceStreamMessage } = await import('../voice-stream.js');
const { getCallSession, listActiveCallSessions, announceCall } = await import('../call-session.js');

const makeWs = (): WSContext => ({ send: () => {} }) as unknown as WSContext;

const wellFormedStart = JSON.stringify({
  event: 'start',
  start: {
    callSid: 'CA-MALFORMED-TEST',
    streamSid: 'MZ-WF',
    accountSid: 'AC1',
    tracks: ['inbound'],
    mediaFormat: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  },
  streamSid: 'MZ-WF',
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleVoiceStreamMessage ignores malformed frames without throwing', () => {
  it.each([
    ['null', 'null'],
    ['a bare scalar', '42'],
    ['an empty object', '{}'],
    ['a start frame with no body', '{"event":"start"}'],
    ['a media frame with no body', '{"event":"media"}'],
    ['a connected handshake', '{"event":"connected"}'],
  ])('resolves and creates no call session for a malformed %s', async (_label, str) => {
    const before = listActiveCallSessions().length;
    await expect(handleVoiceStreamMessage(makeWs(), str)).resolves.toBeUndefined();
    expect(listActiveCallSessions().length).toBe(before);
  });

  it('still registers a session for a well-formed start frame of an announced call', async () => {
    announceCall('CA-MALFORMED-TEST', '+15550001111', '+15550002222');
    const before = listActiveCallSessions().length;
    await expect(handleVoiceStreamMessage(makeWs(), wellFormedStart)).resolves.toBeUndefined();
    expect(listActiveCallSessions().length).toBe(before + 1);
    expect(getCallSession('CA-MALFORMED-TEST')).not.toBeNull();
  });
});
