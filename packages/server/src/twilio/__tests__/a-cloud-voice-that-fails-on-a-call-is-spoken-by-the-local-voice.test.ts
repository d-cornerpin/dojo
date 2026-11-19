// On a phone call, a cloud voice that fails on a sentence hands that sentence, and the rest of the call,
// to the local voice; a cloud voice that works is untouched, and when neither can speak the sentence is
// skipped as before.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Step = 'ok' | 'fail' | 'cut' | 'frame';
let step: Step = 'ok';
let engine = 'cloud';
let configured = true;
let localBroken = false;
let opens = 0;
const localSaid: string[] = [];
const localGate: { text: string; wait: Promise<void> | null } = { text: '', wait: null };
const handleMessageMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../../voice/hume-engine.js', () => ({
  HUME_SAMPLE_RATE: 48000,
  isHumeConfigured: () => configured,
  HumeStreamSession: class {
    onWav: ((wav: Buffer) => void) | null = null;
    onError: ((e: Error) => void) | null = null;
    onDrop: ((e: Error) => void) | null = null;
    async open(): Promise<void> { opens++; }
    push(): void {}
    flush(): void {
      const wav = Buffer.concat([Buffer.alloc(44), Buffer.alloc(4)]);
      if (step === 'ok') this.onWav?.(wav);
      if (step === 'cut') { this.onWav?.(wav); this.onError?.(new Error('dropped')); }
      if (step === 'fail') this.onError?.(new Error('quota'));
      if (step === 'frame') this.onDrop?.(new Error('error frame'));
    }
    async close(): Promise<void> {}
  },
}));
// Each sentence's local audio is a steady tone whose level names it (First 0.1, Second 0.4, Third 0.7).
const level = (text: string): number => ({ 'First.': 0.1, 'Second.': 0.4, 'Third.': 0.7 })[text] ?? 0.2;
vi.mock('../../voice/tts-service.js', () => ({
  DEFAULT_VOICE: 'af_default',
  synthesizeOnce: async (text: string) => {
    if (localBroken) throw new Error('kokoro down');
    if (text === localGate.text) await localGate.wait;
    localSaid.push(text);
    return { pcm: new Float32Array(2400).fill(level(text)), sampleRate: 24000 };
  },
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [{ key: 'voice.tts_engine', value: engine }, { key: 'voice.cloud_voice', value: 'v1' }],
      run: vi.fn(),
    }),
  }),
  closeDb: vi.fn(),
  getDbPath: () => '',
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../../voice/stt-service.js', () => ({
  ensureSttReady: async () => {}, transcribeBuffer: vi.fn(), DEFAULT_STT_MODEL_KEY: 'moonshine-base', parseSttModelKey: () => ({ kind: 'moonshine' }),
}));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'primary', getPrimaryAgentName: () => 'Agent' }));
vi.mock('../auth.js', () => ({ getTwilioConfig: () => ({ voiceMaxMinutesPerCall: 1 }) }));
vi.mock('../client.js', () => ({ endCall: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../memory/conversations.js', () => ({ resolveOrCreateConversation: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: handleMessageMock }) }));
vi.mock('../../services/channel-safe-senders.js', () => ({ getTwilioVoiceSafeCallers: vi.fn() }));
vi.mock('../../services/imessage-bridge.js', () => ({ addressesMatch: vi.fn() }));
vi.mock('../../tools/inbound-fences.js', () => ({ callUtteranceText: vi.fn() }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: vi.fn() }));
vi.mock('../../agent/v2/outbound.js', () => ({ recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn() }));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: () => true }));

const { synthesizeForTwilio } = await import('../tts-bridge.js');
const { CallSession } = await import('../call-session.js');

const aCall = (): { cloudDown: boolean; agentId: string } => ({ cloudDown: false, agentId: 'primary' });

beforeEach(() => {
  step = 'ok'; engine = 'cloud'; configured = true; localBroken = false; opens = 0;
  localSaid.length = 0; localGate.wait = null;
});

describe('a failing cloud voice on a call, sentence by sentence', () => {
  it('control: a cloud voice that works speaks the sentence, the local voice is not used', async () => {
    const r = await synthesizeForTwilio('Hello there.', aCall());
    expect(r?.sampleRate).toBe(48000);
    expect(localSaid).toEqual([]);
  });

  it.each<[string, Step]>([
    ['before any audio', 'fail'],
    ['after some audio', 'cut'],
    ['with a provider error frame', 'frame'],
  ])('failing %s: the whole sentence is spoken by the local voice', async (_name, s) => {
    step = s;
    const r = await synthesizeForTwilio('Hello there.', aCall());
    expect(localSaid).toEqual(['Hello there.']);
    expect(r?.sampleRate).toBe(24000);
  });

  it('a missing cloud key is spoken by the local voice too', async () => {
    configured = false;
    expect((await synthesizeForTwilio('Hello there.', aCall()))?.sampleRate).toBe(24000);
  });

  it('when the local voice cannot speak either, the sentence is skipped', async () => {
    step = 'fail';
    localBroken = true;
    expect(await synthesizeForTwilio('Hello there.', aCall())).toBeNull();
  });

  it('a box whose phone voice is local never touches the cloud voice', async () => {
    engine = 'local';
    step = 'fail';
    expect((await synthesizeForTwilio('Hello there.', aCall()))?.sampleRate).toBe(24000);
    expect(opens).toBe(0);
  });
});

describe('a failing cloud voice through a live call', () => {
  const frames: string[] = [];
  const start = (): InstanceType<typeof CallSession> => {
    const s = new CallSession({
      callSid: 'CA1', streamSid: 'MZ1', direction: 'inbound',
      fromNumber: '+15550000001', toNumber: '+15550000002', send: (f: string) => { frames.push(f); },
    });
    s.start();
    return s;
  };
  // The tones the caller received, in order of first appearance (each frame's median μ-law byte; a louder
  // tone has the lower byte, so First, Second, Third arrive as a falling sequence).
  const median = (buf: Uint8Array): number => [...buf].sort((x, y) => x - y)[buf.length >> 1];
  const heard = (): number[] => [...new Set(frames.map((f) => median(Buffer.from(JSON.parse(f).media.payload, 'base64'))))];
  const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
  beforeEach(() => { frames.length = 0; });

  it('after one failure the rest of the call makes no cloud attempt; a new call tries the cloud again', async () => {
    step = 'fail';
    const s = start();
    await s.queueAgentSay('First.');
    await settle();
    await s.queueAgentSay('Second.');
    await settle();
    expect([opens, localSaid]).toEqual([1, ['First.', 'Second.']]);
    s.end('done');
    const next = start();
    await next.queueAgentSay('Third.');
    await settle();
    expect(opens).toBe(2);
    next.end('done');
  });

  it('a slow fallback for one sentence does not let the next play first', async () => {
    step = 'fail';
    localGate.text = 'Second.';
    let release = (): void => {};
    localGate.wait = new Promise<void>((r) => { release = r; });
    const s = start();
    for (const t of ['First.', 'Second.', 'Third.']) void s.queueAgentSay(t);
    await settle(80);
    release();
    await settle(900);
    expect(heard()).toHaveLength(3);
    expect(heard()).toEqual([...heard()].sort((a, b) => b - a));
    s.end('done');
  });

  it('a hang-up or a barge-in during the fallback synthesis sends the caller nothing more', async () => {
    for (const interrupt of ['hangup', 'bargein']) {
      frames.length = 0; opens = 0;
      step = 'fail';
      localGate.text = 'Second.';
      let release = (): void => {};
      localGate.wait = new Promise<void>((r) => { release = r; });
      const s = start();
      void s.queueAgentSay('Second.');
      await settle();
      if (interrupt === 'hangup') s.end('caller-hangup');
      else (s as unknown as { speechGeneration: number }).speechGeneration += 1;
      release();
      await settle(100);
      expect(frames).toEqual([]);
      s.end('done');
    }
  });
});
