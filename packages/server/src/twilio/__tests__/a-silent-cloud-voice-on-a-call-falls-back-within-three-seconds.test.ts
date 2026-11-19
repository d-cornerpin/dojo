// A cloud voice that takes a call's sentence and sends no audio counts as failed three seconds after the
// words went out, not at the ten-second close cap: the local voice speaks that sentence.
import { describe, it, expect, vi } from 'vitest';

const socket = { on: () => {}, waitForOpen: async () => {}, close: () => {}, sendPublish: () => {} };
const localSaid: string[] = [];

vi.mock('hume', () => ({ HumeClient: class { tts = { streamInput: { connect: async () => socket } }; } }));
vi.mock('../../config/loader.js', () => ({ getProviderCredential: () => 'stand-in-key' }));
vi.mock('../../costs/tracker.js', () => ({ recordCost: () => {} }));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentName: () => 'Agent' }));
vi.mock('../../voice/stt-service.js', () => ({ DEFAULT_STT_MODEL_KEY: 'moonshine-base', parseSttModelKey: () => ({ kind: 'moonshine' }) }));
vi.mock('../../voice/tts-service.js', () => ({
  DEFAULT_VOICE: 'af_default',
  pcmFloatToWav: () => Buffer.alloc(44),
  synthesizeOnce: async (text: string) => { localSaid.push(text); return { pcm: new Float32Array(4), sampleRate: 24000 }; },
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [{ key: 'voice.tts_engine', value: 'cloud' }, { key: 'voice.cloud_voice', value: 'v1' }] }) }),
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const { synthesizeForTwilio } = await import('../tts-bridge.js');

describe('a silent cloud voice on a call falls back within three seconds', () => {
  it('no audio three seconds after the sentence: the local voice speaks it, well before the close cap', async () => {
    vi.useFakeTimers();
    try {
      let result: { sampleRate: number } | null | undefined;
      void synthesizeForTwilio('Hello there.', { cloudDown: false, agentId: 'agent-1' }).then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(2_900);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(result?.sampleRate).toBe(24000);
      expect(localSaid).toEqual(['Hello there.']);
    } finally { vi.useRealTimers(); }
  });
});
