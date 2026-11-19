// 700 — a Twilio retry that lands while the first call is still downloading photos
// loses the insert race (insertInboundMessageIfAbsent returns null). It must then
// stop: no second bubble, no second agent turn.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertMock = vi.fn();
const recordMock = vi.fn();
const broadcastMock = vi.fn();
const handleMock = vi.fn(async () => {});

vi.mock('../../db/connection.js', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }) }) }));
vi.mock('../../memory/conversations.js', () => ({ resolveOrCreateConversation: () => 'conv1' }));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'agent-1', getOwnerName: () => 'Owner' }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: insertMock }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: recordMock }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: broadcastMock }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: handleMock }) }));
vi.mock('../../services/channel-safe-senders.js', () => ({ senderWakes: () => true }));
vi.mock('../../services/safe-senders.js', () => ({ addressesMatch: () => false, isOwnerIMessageRecipient: () => false }));
vi.mock('../../tools/external-content.js', () => ({ fenceExternal: (_a: string, _b: string, t: string) => t }));
vi.mock('../../contacts/resolve-recipient.js', () => ({ resolveRecipientDisplay: (_c: string, n: string) => n }));
vi.mock('../auth.js', () => ({ isSmsEnabled: () => true, getTwilioCreds: () => null }));
vi.mock('../../home.js', () => ({ homeDir: () => '/nonexistent-home' }));

const { ingestInboundSms } = await import('../sms-inbound.js');

const payload = {
  messageSid: 'SM-retry-1', fromNumber: '+15550000001', toNumber: '+15550000002',
  body: 'hello', numMedia: 0, mediaUrls: [],
} as Parameters<typeof ingestInboundSms>[0];

beforeEach(() => { insertMock.mockReset(); recordMock.mockClear(); broadcastMock.mockClear(); handleMock.mockClear(); });

describe('700 inbound SMS retry', () => {
  it('second insert is a no-op: nothing recorded, shown or woken', async () => {
    insertMock.mockReturnValue(null);
    expect(await ingestInboundSms(payload)).toBe(true);
    expect(recordMock).toHaveBeenCalledTimes(0);
    expect(broadcastMock).toHaveBeenCalledTimes(0);
    expect(handleMock).toHaveBeenCalledTimes(0);
  });
  it('first insert is real: recorded, shown and woken once', async () => {
    insertMock.mockReturnValue({ seq: 1, id: 'x' });
    expect(await ingestInboundSms(payload)).toBe(true);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(handleMock).toHaveBeenCalledTimes(1);
  });
});
