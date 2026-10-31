// A failed sms_send must not be reported as "Twilio rejected the send": a fetch
// failure (including the owner pressing Stop) and an unconfigured account both
// come back from `client.ts` as a non-Twilio error, so only Twilio's own
// refusals are real rejections.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendSmsMock = vi.hoisted(() => vi.fn());
const openAgentCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop,
    setLogBroadcast: noop,
    readLogEntries: () => [],
  };
});

vi.mock('../client.js', () => ({ sendSms: sendSmsMock }));

// A configured, SMS-enabled account with one owned number to send from.
vi.mock('../auth.js', () => ({
  isSmsEnabled: () => true,
  getDefaultFromNumber: () => '+15550000001',
  getNumber: (n: string) => ({ number: n, smsEnabled: true }),
}));

// The recipient is on the allowlist: a safe-sender whose address matches.
vi.mock('../../services/channel-safe-senders.js', () => ({
  getTwilioSmsSafeSenders: () => [{ name: 'Owner', address: '+15550000002' }],
}));

// The slot the Stop lives in: a signal that is, or is not, already aborted.
vi.mock('../../agent/abortable-call.js', () => ({ openAgentCall: openAgentCallMock }));

const { executeSmsSend } = await import('../sms-outbound.js');

// Open a slot whose signal is (or is not) already aborted, like the owner
// pressing Stop while the text is on its way to Twilio.
function openSlotWithSignal(aborted: boolean): void {
  const ctl = new AbortController();
  if (aborted) ctl.abort();
  openAgentCallMock.mockImplementation(() => ({ signal: ctl.signal, release: vi.fn() }));
}

describe('sms_send failure wording', () => {
  beforeEach(() => {
    sendSmsMock.mockReset();
    openAgentCallMock.mockReset();
  });

  it('a network failure reads as a failed send, not a Twilio rejection', async () => {
    openSlotWithSignal(false);
    sendSmsMock.mockResolvedValue({ ok: false, error: 'Twilio network error: fetch failed' });
    const res = await executeSmsSend({ to: '+15550000002', body: 'hi' }, 'agent-1');
    expect(res).toEqual({ ok: false, message: 'SMS NOT sent - the send failed: Twilio network error: fetch failed' });
  });

  it('a stop reads as the owner pressing Stop, not a Twilio rejection', async () => {
    openSlotWithSignal(true);
    sendSmsMock.mockResolvedValue({ ok: false, error: 'Twilio network error: fetch failed' });
    const res = await executeSmsSend({ to: '+15550000002', body: 'hi' }, 'agent-1');
    expect(res).toEqual({ ok: false, message: 'SMS NOT sent - the owner pressed Stop before it reached Twilio.' });
  });

  it('a successful send keeps its wording', async () => {
    openSlotWithSignal(false);
    sendSmsMock.mockResolvedValue({ ok: true, data: { sid: 'SM1' } });
    const res = await executeSmsSend({ to: '+15550000002', body: 'hi' }, 'agent-1');
    expect(res).toEqual({ ok: true, sid: 'SM1', message: 'SMS sent (sid=SM1) to +15550000002 from +15550000001.' });
  });
});
