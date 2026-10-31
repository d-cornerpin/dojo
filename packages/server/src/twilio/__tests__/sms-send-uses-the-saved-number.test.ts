// An outbound text goes only to a number on the owner's approved list, matched exactly after
// formatting is removed, and it goes to the SAVED number, not the text the agent typed.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendSmsMock = vi.hoisted(() => vi.fn());

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../client.js', () => ({ sendSms: sendSmsMock }));
vi.mock('../auth.js', () => ({
  isSmsEnabled: () => true,
  getDefaultFromNumber: () => '+15550000001',
  getNumber: (n: string) => ({ number: n, smsEnabled: true }),
}));
vi.mock('../../services/channel-safe-senders.js', () => ({
  getTwilioSmsSafeSenders: () => [{ name: 'Owner', address: '+15550100198' }],
}));
vi.mock('../../agent/abortable-call.js', () => ({
  openAgentCall: () => ({ signal: new AbortController().signal, release: () => {} }),
}));

vi.mock('../../services/safe-senders.js', () => ({
  ownerIMessageRecords: () => [{ name: 'Me', address: '+15550123456' }],
}));

const { executeSmsSend } = await import('../sms-outbound.js');

describe('sms_send recipient', () => {
  beforeEach(() => {
    sendSmsMock.mockReset();
    sendSmsMock.mockResolvedValue({ ok: true, data: { sid: 'SMfake' } });
  });

  it('a loosely typed number texts the saved number', async () => {
    const res = await executeSmsSend({ to: '(555) 010-0198', body: 'hi' }, 'agent-1');
    expect(res.ok).toBe(true);
    expect(sendSmsMock.mock.calls[0][0]).toBe('+15550100198');
    expect(res.message).toContain('+15550100198');
  });

  it('the same number typed with an international dialling prefix texts the saved number', async () => {
    for (const typed of ['001 555 010 0198', '011 1 555 010 0198']) {
      const res = await executeSmsSend({ to: typed, body: 'hi' }, 'agent-1');
      expect(res.ok, typed).toBe(true);
      expect(sendSmsMock.mock.calls.at(-1)?.[0]).toBe('+15550100198');
    }
  });

  it('the saved number itself still works', async () => {
    const res = await executeSmsSend({ to: '+15550100198', body: 'hi' }, 'agent-1');
    expect(res.ok).toBe(true);
    expect(sendSmsMock.mock.calls[0][0]).toBe('+15550100198');
  });

  it('a number that is not on the list is refused and nothing is sent', async () => {
    const res = await executeSmsSend({ to: '+15559999999', body: 'hi' }, 'agent-1');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not on the Twilio SMS safe-sender allowlist');
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('part of a saved number does not count as that number', async () => {
    for (const partial of ['0198', '010-0198', '1', '+1 555 010 0198 (Mom)']) {
      const res = await executeSmsSend({ to: partial, body: 'hi' }, 'agent-1');
      expect(res.ok, partial).toBe(false);
    }
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('the owner\'s own number is always allowed, even off the list', async () => {
    const res = await executeSmsSend({ to: '(555) 012-3456', body: 'hi' }, 'agent-1');
    expect(res.ok).toBe(true);
    expect(sendSmsMock.mock.calls[0][0]).toBe('+15550123456');
  });

  it('a fragment of the owner\'s number is refused', async () => {
    const res = await executeSmsSend({ to: '0123456', body: 'hi' }, 'agent-1');
    expect(res.ok).toBe(false);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});
