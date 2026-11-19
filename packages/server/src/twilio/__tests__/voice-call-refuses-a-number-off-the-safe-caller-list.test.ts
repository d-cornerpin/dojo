// An outbound call rings only a number on the owner's approved caller list, matched exactly
// after formatting is removed, and it rings the SAVED number.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const placeMock = vi.hoisted(() => vi.fn());

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../client.js', () => ({ placeCall: placeMock }));
vi.mock('../auth.js', () => ({
  isVoiceEnabled: () => true,
  getDefaultFromNumber: () => '+15550000001',
  getNumber: () => ({ number: '+15550000001', voiceEnabled: true }),
}));
vi.mock('../../services/tunnel.js', () => ({ getTunnelStatus: () => ({ status: 'active', url: 'https://example.invalid' }) }));
vi.mock('../../agent/abortable-call.js', () => ({
  openAgentCall: () => ({ signal: new AbortController().signal, release: () => {} }),
}));
vi.mock('../call-session.js', () => ({
  CallSession: class { queueAgentSay = vi.fn(async () => {}); },
  registerCallSession: vi.fn(),
  getCallSession: vi.fn(),
  listActiveCallSessions: vi.fn(() => []),
}));
vi.mock('../../services/channel-safe-senders.js', () => ({
  getTwilioVoiceSafeCallers: () => [{ name: 'Owner', address: '+15550100198' }],
}));

vi.mock('../../services/safe-senders.js', () => ({
  ownerIMessageRecords: () => [{ name: 'Me', address: '+15550123456' }],
  recipientKind: () => 'an approved sender',
}));

const { executeVoiceCall } = await import('../voice-outbound.js');

describe('voice_call recipient', () => {
  beforeEach(() => {
    placeMock.mockReset();
    placeMock.mockResolvedValue({ ok: true, data: { sid: 'CAfake' } });
  });

  it('a number off the list is refused and no call is placed', async () => {
    const res = await executeVoiceCall({ to: '+15559999999' });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('safe-caller allowlist');
    expect(res.message).toContain('+15550100198');
    expect(placeMock).not.toHaveBeenCalled();
  });

  it('a loosely typed number rings the saved number', async () => {
    const res = await executeVoiceCall({ to: '(555) 010-0198' });
    expect(res.ok).toBe(true);
    expect(placeMock.mock.calls[0][0]).toBe('+15550100198');
  });

  it('the saved number itself still works', async () => {
    const res = await executeVoiceCall({ to: '+15550100198' });
    expect(res.ok).toBe(true);
    expect(res.callSid).toBe('CAfake');
  });

  it('part of a saved number does not count as that number', async () => {
    for (const partial of ['0198', '1']) {
      const res = await executeVoiceCall({ to: partial });
      expect(res.ok, partial).toBe(false);
    }
    expect(placeMock).not.toHaveBeenCalled();
  });

  it('the owner\'s own number is always allowed, even off the list', async () => {
    const res = await executeVoiceCall({ to: '(555) 012-3456' });
    expect(res.ok).toBe(true);
    expect(placeMock.mock.calls[0][0]).toBe('+15550123456');
  });

  it('a fragment of the owner\'s number is refused', async () => {
    const res = await executeVoiceCall({ to: '0123456' });
    expect(res.ok).toBe(false);
    expect(placeMock).not.toHaveBeenCalled();
  });
});
