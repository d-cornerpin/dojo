// On a phone call, a cloud voice that fails on a sentence hands that sentence to the local voice; a
// cloud voice that works is untouched, and when neither can speak the sentence is skipped as before.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Step = 'ok' | 'fail' | 'cut' | 'frame';
let step: Step = 'ok';
let engine = 'cloud';
let localBroken = false;
const localSaid: string[] = [];

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../../voice/hume-engine.js', () => ({
  HUME_SAMPLE_RATE: 48000,
  isHumeConfigured: () => true,
  HumeStreamSession: class {
    onWav: ((wav: Buffer) => void) | null = null;
    onError: ((e: Error) => void) | null = null;
    onDrop: ((e: Error) => void) | null = null;
    async open(): Promise<void> {}
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
vi.mock('../../voice/tts-service.js', () => ({
  synthesizeOnce: async (text: string) => {
    if (localBroken) throw new Error('kokoro down');
    localSaid.push(text);
    return { pcm: new Float32Array(3), sampleRate: 24000 };
  },
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [
        { key: 'voice.tts_engine', value: engine },
        { key: 'voice.cloud_voice', value: 'v1' },
      ],
    }),
  }),
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const { synthesizeForTwilio } = await import('../tts-bridge.js');

beforeEach(() => { step = 'ok'; engine = 'cloud'; localBroken = false; localSaid.length = 0; });

describe('a failing cloud voice on a call', () => {
  it('control: a cloud voice that works speaks the sentence, the local voice is not used', async () => {
    const r = await synthesizeForTwilio('Hello there.');
    expect(r?.sampleRate).toBe(48000);
    expect(localSaid).toEqual([]);
  });

  it.each<[string, Step]>([
    ['before any audio', 'fail'],
    ['after some audio', 'cut'],
    ['with a provider error frame', 'frame'],
  ])('failing %s: the whole sentence is spoken by the local voice', async (_name, s) => {
    step = s;
    const r = await synthesizeForTwilio('Hello there.');
    expect(localSaid).toEqual(['Hello there.']);
    expect(r?.sampleRate).toBe(24000);
  });

  it('when the local voice cannot speak either, the sentence is skipped', async () => {
    step = 'fail';
    localBroken = true;
    expect(await synthesizeForTwilio('Hello there.')).toBeNull();
  });

  it('a box whose phone voice is local never touches the cloud voice', async () => {
    engine = 'local';
    step = 'fail';
    const r = await synthesizeForTwilio('Hello there.');
    expect(localSaid).toEqual(['Hello there.']);
    expect(r?.sampleRate).toBe(24000);
  });
});
