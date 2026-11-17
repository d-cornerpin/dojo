// 205 — every caller utterance gets its own external message id, so later
// utterances of a call are not silently dropped by the unique index on
// (agent_id, channel, external_message_id). The id is the call sid plus a
// 1-based per-session utterance count (CA123:1, CA123:2, ...).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const insertMock = vi.fn(() => ({}));
const transcribeBuffer = vi.fn(async () => ({ text: 'hello there' }));
const ensureSttReady = vi.fn(async () => {});

vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: () => 'conv1',
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
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
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
  transcribeBuffer.mockReset();
  transcribeBuffer.mockImplementation(async () => ({ text: 'hello there' }));
});
afterEach(() => {
  for (const s of sessions) s.end('test');
  sessions.length = 0;
});

async function makeSession(callSid: string): Promise<CallSession> {
  const s = new CallSession({
    callSid,
    streamSid: 'MZ1',
    direction: 'inbound',
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

const ids = () =>
  insertMock.mock.calls.map(c => (c[0] as { externalMessageId: string }).externalMessageId);

describe('call utterance external ids', () => {
  it('two utterances on the same session get distinct externalMessageIds, both prefixed with the call sid', async () => {
    const s = await makeSession('CA123');
    await utter(s);
    await utter(s);
    const got = ids();
    expect(got.length).toBe(2);
    expect(got[0]).not.toBe(got[1]);
    expect(got[0].startsWith('CA123')).toBe(true);
    expect(got[1].startsWith('CA123')).toBe(true);
  });

  it('the first utterance is CA123:1 and the second is CA123:2', async () => {
    const s = await makeSession('CA123');
    await utter(s);
    await utter(s);
    expect(ids()).toEqual(['CA123:1', 'CA123:2']);
  });

  it('a second CallSession starts its numbering again at CA999:1', async () => {
    const s1 = await makeSession('CA123');
    await utter(s1);
    const s2 = await makeSession('CA999');
    await utter(s2);
    expect(ids()).toEqual(['CA123:1', 'CA999:1']);
  });

  it('an empty transcription does not insert and does not consume a number', async () => {
    const s = await makeSession('CA123');
    transcribeBuffer.mockResolvedValueOnce({ text: '   ' });
    await utter(s);
    expect(insertMock.mock.calls.length).toBe(0);
    await utter(s);
    expect(ids()).toEqual(['CA123:1']);
  });
});
