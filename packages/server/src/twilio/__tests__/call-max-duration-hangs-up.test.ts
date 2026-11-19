// ═══════════════════════════════════════════════════════════════════════
// THE TIME CAP ACTUALLY HANGS UP (phone-call time cap, never hangs up).
//
// ── THE DEFECT ──
// `CallSession.armMaxDuration` set a timer for `voiceMaxMinutesPerCall`
// and on expiry only called `this.end('max_duration_reached')`. `end()`
// marks the object ended, stops timers and writes the call-log row — but
// nothing tells Twilio to drop the call (the only REST hang-up `endCall`
// is reached from `executeVoiceCallEnd`, the agent's own end tool), and
// `end()` alone leaves the session in the `sessionsByCallSid` map. So at
// the cap the Dojo went silent and ignored the caller while the phone
// line stayed connected and kept billing, and the session stayed in the
// registry.
//
// ── WHAT IS PINNED HERE ──
// When the cap fires the call is ended on Twilio's side (exactly one
// `endCall` for the callSid) and the session is removed from the map —
// both at once, with no goodbye wait. Before the cap the session is
// untouched; if the hang-up fails the callback still doesn't throw.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const endCallMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

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

vi.mock('../client.js', () => ({ endCall: endCallMock }));

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

import { CallSession, registerCallSession, getCallSession } from '../call-session.js';

const buildSession = (): CallSession => {
  const session = new CallSession({
    callSid: 'CA777',
    streamSid: 'MZ7',
    direction: 'inbound',
    fromNumber: '+15550000001',
    toNumber: '+15550000002',
    send: () => {},
  });
  registerCallSession(session);
  return session;
};

beforeEach(() => {
  vi.useFakeTimers();
  endCallMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the time cap hangs the call up on Twilio and clears the registry', () => {
  it('fires endCall exactly once for the callSid at the cap', async () => {
    const session = buildSession();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(endCallMock).toHaveBeenCalledTimes(1);
    expect(endCallMock).toHaveBeenCalledWith('CA777');
    void session;
  });

  it('marks the session ended and removes it from the registry at the cap', async () => {
    const session = buildSession();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.isEnded()).toBe(true);
    expect(getCallSession('CA777')).toBeNull();
  });

  it('has done nothing before the cap is reached', async () => {
    const session = buildSession();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(endCallMock).not.toHaveBeenCalled();
    expect(session.isEnded()).toBe(false);
  });

  it('does not throw when the hang-up call rejects', async () => {
    const session = buildSession();
    endCallMock.mockRejectedValueOnce(new Error('boom'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.isEnded()).toBe(true);
    expect(getCallSession('CA777')).toBeNull();
  });
});
