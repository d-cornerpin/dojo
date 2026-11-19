// The phone audio socket is open to anyone, so a start frame is honoured only for a call the signed
// voice webhook just answered with a stream (once, within a minute); an agent-placed call then attaches
// to its placeholder. The caller's number is the webhook's, never the frame's.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';

const state = vi.hoisted(() => ({
  configured: true,
  unknownCallerAction: 'agent' as 'agent' | 'voicemail' | 'reject',
  safeCallers: [{ name: 'Owner', address: '+15550100001' }],
}));
const runtime = vi.hoisted(() => ({ submit: vi.fn() }));
const audio = vi.hoisted(() => ({ level: 0 }));

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })) }),
  closeDb: vi.fn(), getDbPath: () => '',
}));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'primary', getOwnerName: () => 'the owner' }));
vi.mock('../auth.js', () => ({
  getTwilioConfig: () => ({
    configured: state.configured, enabled: state.configured, voiceEnabled: state.configured,
    voiceMaxMinutesPerCall: 30, voiceUnknownCallerAction: state.unknownCallerAction, voiceVoicemailGreeting: 'Leave a message.',
  }),
  getTwilioCreds: () => (state.configured ? { sid: 'AC1', token: 'tok-test' } : null),
  isVoiceEnabled: () => state.configured,
  getDefaultFromNumber: () => '+15550100900',
  getNumber: () => ({ voiceEnabled: true }),
  setTwilioCredentials: vi.fn(), clearTwilioCredentials: vi.fn(), updateTwilioSettings: vi.fn(),
  upsertTwilioNumber: vi.fn(), removeTwilioNumber: vi.fn(), isSmsEnabled: () => false,
}));
vi.mock('../client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client.js')>()),
  placeCall: vi.fn(async () => ({ ok: true, data: { sid: 'CA-OUTBOUND' } })),
  endCall: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../services/tunnel.js', () => ({ getTunnelStatus: () => ({ status: 'active', url: 'https://box.example.test' }) }));
vi.mock('../../services/channel-safe-senders.js', () => ({
  getTwilioVoiceSafeCallers: () => state.safeCallers,
  getTwilioSmsSafeSenders: () => [], appendTwilioSmsSafeSender: vi.fn(), appendTwilioVoiceSafeCaller: vi.fn(), removeTwilioSmsSafeSender: vi.fn(), removeTwilioVoiceSafeCaller: vi.fn(), senderWakes: () => false,
}));
vi.mock('../../services/imessage-bridge.js', () => ({ addressesMatch: (a: string, b: string) => a === b }));
vi.mock('../../services/safe-senders.js', async (orig) => ({ ...(await orig<typeof import('../../services/safe-senders.js')>()), ownerIMessageRecords: () => [], addressesMatch: vi.fn(), isOwnerIMessageRecipient: vi.fn() }));
vi.mock('../sms-inbound.js', () => ({ ingestInboundSms: vi.fn() }));
vi.mock('../../voice/session-record.js', () => ({
  startVoiceSessionRecord: vi.fn(() => 'vsr-1'), endVoiceSessionRecord: vi.fn(),
  bumpVoiceSessionTurnCount: vi.fn(), stampSpokenMessage: vi.fn(),
}));
vi.mock('../../voice/stt-service.js', () => ({ transcribeBuffer: vi.fn(async () => ({ text: 'it is me, the owner' })), ensureSttReady: vi.fn(async () => {}) }));
vi.mock('../audio-codec.js', () => ({
  decodeTwilioFrame: vi.fn(() => new Float32Array(160)), encodeForTwilio: vi.fn(), chunkForTwilio: vi.fn(),
  muLawEncode: vi.fn(), float32ToInt16At8k: vi.fn(), createBiquadState: () => ({}),
  applyAntiAliasLP: vi.fn(() => new Float32Array(320).fill(audio.level)),
}));
vi.mock('../../memory/conversations.js', () => ({ resolveOrCreateConversation: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => runtime }));
vi.mock('../../tools/inbound-fences.js', () => ({ callUtteranceText: vi.fn(), voicemailNoticeContent: vi.fn() }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: vi.fn() }));
vi.mock('../../agent/v2/outbound.js', () => ({ recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn() }));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: vi.fn() }));
vi.mock('../../agent/abortable-call.js', () => ({ openAgentCall: vi.fn() }));

const { twilioRouter } = await import('../../gateway/routes/twilio.js');
const { handleVoiceStreamMessage, handleVoiceStreamClose } = await import('../voice-stream.js');
const { getCallSession, listActiveCallSessions } = await import('../call-session.js');
const { executeVoiceCall } = await import('../voice-outbound.js');
const { insertInboundMessageIfAbsent } = await import('../../work/ask-title.js');

const app = new Hono().route('/api/twilio', twilioRouter);
const WEBHOOK_URL = 'https://box.example.test/api/twilio/webhook/voice';

async function webhook(form: Record<string, string>): Promise<string> {
  const data = WEBHOOK_URL + Object.keys(form).sort().map((k) => k + form[k]).join('');
  const signature = crypto.createHmac('sha1', 'tok-test').update(data).digest('base64');
  const res = await app.request('/api/twilio/webhook/voice', {
    method: 'POST',
    headers: { 'X-Twilio-Signature': signature, host: 'box.example.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return res.text();
}

const makeWs = () => {
  const ws = { send: vi.fn(), close: vi.fn() };
  return { ws, ctx: ws as unknown as WSContext };
};

const startFrame = (callSid: string, customParameters?: Record<string, string>) => JSON.stringify({
  event: 'start',
  streamSid: `MZ-${callSid}`,
  start: {
    callSid, streamSid: `MZ-${callSid}`, accountSid: 'AC1', tracks: ['inbound'], customParameters,
    mediaFormat: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  },
});
const mediaFrame = JSON.stringify({ event: 'media', streamSid: 'MZ', media: { track: 'inbound', chunk: '1', timestamp: '0', payload: 'AAAA' } });

beforeEach(() => {
  vi.useFakeTimers();
  state.configured = true;
  state.unknownCallerAction = 'agent';
  runtime.submit.mockClear();
  vi.mocked(insertInboundMessageIfAbsent).mockClear();
});
afterEach(() => vi.useRealTimers());

async function expectRefused(callSid: string, frame: string) {
  const before = listActiveCallSessions().length;
  const { ws, ctx } = makeWs();
  await handleVoiceStreamMessage(ctx, frame);
  for (const level of [0.5, 0]) {
    audio.level = level;
    for (let i = 0; i < 50; i++) await handleVoiceStreamMessage(ctx, mediaFrame);
  }
  await vi.advanceTimersByTimeAsync(3000);
  expect(ws.close).toHaveBeenCalled();
  expect(getCallSession(callSid)).toBeNull();
  expect(listActiveCallSessions().length).toBe(before);
  expect(runtime.submit).not.toHaveBeenCalled();
  expect(insertInboundMessageIfAbsent).not.toHaveBeenCalled();
  handleVoiceStreamClose(ctx);
}

describe('the phone audio socket accepts only a call the signed webhook announced', () => {
  it('refuses a made-up call id that names the owner, creating nothing', async () => {
    await expectRefused('CA-FORGED-1', startFrame('CA-FORGED-1', { From: '+15550100001', To: '+15550100900' }));
  });

  it('refuses a made-up call id when Twilio is not set up', async () => {
    state.configured = false;
    await expectRefused('CA-FORGED-2', startFrame('CA-FORGED-2', { From: '+15550100001' }));
  });

  it('connects an announced call with the webhook numbers, whatever the frame claims', async () => {
    expect(await webhook({ CallSid: 'CA-REAL-1', From: '+15550100777', To: '+15550100900', Direction: 'inbound' })).toContain('<Stream');
    const { ws, ctx } = makeWs();
    await handleVoiceStreamMessage(ctx, startFrame('CA-REAL-1', { From: '+15550100001', To: '+15550100002' }));
    expect(ws.close).not.toHaveBeenCalled();
    const session = getCallSession('CA-REAL-1');
    expect(session?.fromNumber).toBe('+15550100777');
    expect(session?.toNumber).toBe('+15550100900');
    expect(session?.direction).toBe('inbound');
  });

  it('uses an announcement once: a second socket for the same call is refused', async () => {
    await webhook({ CallSid: 'CA-REAL-2', From: '+15550100777', To: '+15550100900', Direction: 'inbound' });
    const first = makeWs();
    await handleVoiceStreamMessage(first.ctx, startFrame('CA-REAL-2'));
    const live = getCallSession('CA-REAL-2');
    expect(live).not.toBeNull();
    const second = makeWs();
    await handleVoiceStreamMessage(second.ctx, startFrame('CA-REAL-2'));
    expect(second.ws.close).toHaveBeenCalled();
    handleVoiceStreamClose(second.ctx);
    expect(getCallSession('CA-REAL-2')).toBe(live);
    expect(first.ws.close).not.toHaveBeenCalled();
  });

  it('refuses an announcement older than a minute', async () => {
    await webhook({ CallSid: 'CA-STALE', From: '+15550100777', To: '+15550100900', Direction: 'inbound' });
    await vi.advanceTimersByTimeAsync(61_000);
    await expectRefused('CA-STALE', startFrame('CA-STALE'));
  });

  it('attaches an agent-placed call to its placeholder session', async () => {
    const placed = await executeVoiceCall({ to: '+15550100001' });
    expect(placed.callSid).toBe('CA-OUTBOUND');
    const placeholder = getCallSession('CA-OUTBOUND');
    const early = makeWs();
    await handleVoiceStreamMessage(early.ctx, startFrame('CA-OUTBOUND'));
    expect(early.ws.close).toHaveBeenCalled();
    handleVoiceStreamClose(early.ctx);
    expect(placeholder?.isStarted()).toBe(false);
    expect(await webhook({ CallSid: 'CA-OUTBOUND', From: '+15550100900', To: '+15550100001', Direction: 'outbound-api' })).toContain('<Stream');
    const { ws, ctx } = makeWs();
    await handleVoiceStreamMessage(ctx, startFrame('CA-OUTBOUND', { From: '+15550100555' }));
    expect(ws.close).not.toHaveBeenCalled();
    expect(getCallSession('CA-OUTBOUND')).toBe(placeholder);
    expect(placeholder?.direction).toBe('outbound');
    expect(placeholder?.toNumber).toBe('+15550100001');
  });

  it.each(['voicemail', 'reject'] as const)('never streams an unknown caller under the %s policy', async (policy) => {
    state.unknownCallerAction = policy;
    const callSid = `CA-UNKNOWN-${policy}`;
    expect(await webhook({ CallSid: callSid, From: '+15550100444', To: '+15550100900', Direction: 'inbound' })).not.toContain('<Stream');
    await expectRefused(callSid, startFrame(callSid, { From: '+15550100444' }));
  });
});
