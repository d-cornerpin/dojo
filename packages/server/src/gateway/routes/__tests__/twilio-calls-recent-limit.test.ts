// GET /calls/recent: a limit that is not a whole number must not turn into a server error.
import { describe, it, expect, vi } from 'vitest';

const { seen } = vi.hoisted(() => ({ seen: [] as number[] }));

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: (n: number) => { seen.push(n); return []; } }) }),
}));
vi.mock('../../../twilio/auth.js', () => ({
  getTwilioConfig: () => ({}), getTwilioCreds: () => null, setTwilioCredentials: () => {},
  clearTwilioCredentials: () => {}, updateTwilioSettings: () => {}, upsertTwilioNumber: () => {},
  removeTwilioNumber: () => {},
}));
vi.mock('../../../twilio/client.js', () => ({
  testTwilioCredentials: async () => ({ ok: true, friendlyName: null }), verifyTwilioSignature: () => true,
}));
vi.mock('../../../twilio/sms-inbound.js', () => ({ ingestInboundSms: async () => true }));
vi.mock('../../../services/channel-safe-senders.js', () => ({
  getTwilioSmsSafeSenders: () => [], appendTwilioSmsSafeSender: () => ({ added: false, totalSenders: 0 }),
  getTwilioVoiceSafeCallers: () => [], appendTwilioVoiceSafeCaller: () => ({ added: false, totalSenders: 0 }),
}));
vi.mock('../../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: () => null }));
vi.mock('../../../services/tunnel.js', () => ({ getTunnelStatus: () => ({ status: 'off', url: null }) }));
vi.mock('../../../tools/inbound-fences.js', () => ({ voicemailNoticeContent: () => '' }));

const { twilioRouter } = await import('../twilio.js');

describe('GET /calls/recent limit', () => {
  it.each([
    ['?limit=abc', 50], ['?limit=2.5', 2], ['?limit=0', 1], ['?limit=999', 200], ['?limit=7', 7], ['', 50],
  ])('%s binds %s', async (suffix, expected) => {
    seen.length = 0;
    const res = await twilioRouter.request(`/calls/recent${suffix}`);
    expect(res.status).toBe(200);
    expect(seen).toEqual([expected]);
  });
});
