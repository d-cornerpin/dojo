// An outbound call's utterances are the CALLEE's words, so every field that
// names the other party — the conversation's counterpartyId, the inbound meta
// sender/phoneFromNumber/recipientAddress, and the inserted message's
// senderId — must follow the other party (toNumber on outbound, fromNumber
// on inbound), not our own Twilio number.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const insertMock = vi.fn(() => ({}));
const convMock = vi.fn(() => 'conv1');
const metaMock = vi.fn();
const transcribeBuffer = vi.fn(async () => ({ text: 'hello there' }));
const ensureSttReady = vi.fn(async () => {});

vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: convMock,
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({}) }) }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'agent-1',
  getOwnerName: () => 'Owner',
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {} }),
}));
vi.mock('../auth.js', () => ({ getTwilioConfig: () => ({ voiceMaxMinutesPerCall: 30 }) }));
vi.mock('../../services/channel-safe-senders.js', () => ({ getTwilioVoiceSafeCallers: () => [] }));
vi.mock('../../services/imessage-bridge.js', () => ({ addressesMatch: () => false }));
vi.mock('../../tools/inbound-fences.js', () => ({ callUtteranceText: (_n: string, _d: string, t: string) => t }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: metaMock }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: insertMock }));
vi.mock('../../agent/v2/outbound.js', () => ({
  recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn(),
}));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: () => true }));
vi.mock('../../voice/stt-service.js', () => ({
  transcribeBuffer,
  ensureSttReady,
}));

const { CallSession } = await import('../call-session.js');

const sessions: CallSession[] = [];
beforeEach(() => {
  insertMock.mockReset();
  insertMock.mockImplementation(() => ({}));
  convMock.mockReset();
  convMock.mockImplementation(() => 'conv1');
  metaMock.mockReset();
  transcribeBuffer.mockReset();
  transcribeBuffer.mockImplementation(async () => ({ text: 'hello there' }));
});
afterEach(() => {
  for (const s of sessions) s.end('test');
  sessions.length = 0;
});

// +15550000001 is our Twilio number, +15550000002 the other party —
// whichever side the direction points at.
async function makeSession(callSid: string, direction: 'inbound' | 'outbound'): Promise<CallSession> {
  const s = new CallSession({
    callSid,
    streamSid: 'MZ1',
    direction,
    fromNumber: '+15550000001',
    toNumber: '+15550000002',
    send: () => {},
  });
  sessions.push(s);
  return s;
}

async function utter(s: CallSession): Promise<void> {
  await (s as unknown as { handleUtterance(p: Float32Array): Promise<void> })
    .handleUtterance(new Float32Array(16000));
}

// The four values that must name the other party, pulled out of the mocks.
function otherPartyFields(): { counterpartyId: string; sender: string; phoneFromNumber: string; recipientAddress: string; senderId: string } {
  const convArg = convMock.mock.calls[0][1] as { counterpartyId: string };
  const meta = metaMock.mock.calls[0][1] as { sender: string; phoneFromNumber: string; recipientAddress: string };
  const ins = insertMock.mock.calls[0][0] as { senderId: string };
  return {
    counterpartyId: convArg.counterpartyId,
    sender: meta.sender,
    phoneFromNumber: meta.phoneFromNumber,
    recipientAddress: meta.recipientAddress,
    senderId: ins.senderId,
  };
}

describe('call utterance names the other party', () => {
  it('an outbound call attributes the callee\'s words to the callee, not our own number', async () => {
    const s = await makeSession('CA1', 'outbound');
    await utter(s);
    expect(insertMock.mock.calls.length).toBe(1);
    expect(otherPartyFields()).toEqual({
      counterpartyId: '+15550000002',
      sender: '+15550000002',
      phoneFromNumber: '+15550000002',
      recipientAddress: '+15550000002',
      senderId: '+15550000002',
    });
  });

  it('an inbound call keeps attributing the caller\'s words to the caller', async () => {
    const s = await makeSession('CA2', 'inbound');
    await utter(s);
    expect(insertMock.mock.calls.length).toBe(1);
    expect(otherPartyFields()).toEqual({
      counterpartyId: '+15550000001',
      sender: '+15550000001',
      phoneFromNumber: '+15550000001',
      recipientAddress: '+15550000001',
      senderId: '+15550000001',
    });
  });
});
