// Twilio TTS bridge: synthesizes one utterance with the engine set in Settings, Voice (Kokoro or Hume) and
// returns PCM for the call session's μ-law encoder. The engine is read per call, so a Settings change applies
// on the next utterance; the user's choice wins even though Hume's socket open adds 100-300 ms.

import { createLogger } from '../logger.js';

const logger = createLogger('twilio-tts-bridge');

interface TtsSettings {
  engine: 'local' | 'cloud';
  voice: string;          // Kokoro voice id, e.g. 'af_bella'
  speed: number;          // applies to either engine
  cloudVoice: string;     // Hume voice id
  cloudVoiceProvider: 'HUME_AI' | 'CUSTOM_VOICE';
  cloudDescription: string | null;
  cloudSpeed: number;
}

async function loadSettings(): Promise<TtsSettings> {
  let engine: 'local' | 'cloud' = 'local';
  let voice = 'af_bella';
  let speed = 1.0;
  let cloudVoice = '';
  let cloudVoiceProvider: 'HUME_AI' | 'CUSTOM_VOICE' = 'HUME_AI';
  let cloudDescription: string | null = null;
  let cloudSpeed = 1.0;
  try {
    const { getDb } = await import('../db/connection.js');
    const rows = getDb().prepare(`
      SELECT key, value FROM config WHERE key IN (
        'voice.tts_engine',
        'voice.kokoro_voice',
        'voice.preferred_voice',
        'voice.kokoro_speed',
        'voice.playback_speed',
        'voice.cloud_voice',
        'voice.cloud_voice_provider',
        'voice.cloud_voice_description',
        'voice.cloud_speed'
      )
    `).all() as Array<{ key: string; value: string }>;
    for (const r of rows) {
      if (r.key === 'voice.tts_engine' && r.value === 'cloud') engine = 'cloud';
      if ((r.key === 'voice.kokoro_voice' || r.key === 'voice.preferred_voice') && r.value) voice = r.value;
      if ((r.key === 'voice.kokoro_speed' || r.key === 'voice.playback_speed')) {
        const n = Number(r.value);
        if (Number.isFinite(n) && n >= 0.5 && n <= 2) speed = n;
      }
      if (r.key === 'voice.cloud_voice' && r.value) cloudVoice = r.value;
      if (r.key === 'voice.cloud_voice_provider' && r.value === 'CUSTOM_VOICE') cloudVoiceProvider = 'CUSTOM_VOICE';
      if (r.key === 'voice.cloud_voice_description' && r.value.trim()) cloudDescription = r.value.trim().slice(0, 500);
      if (r.key === 'voice.cloud_speed') {
        const n = Number(r.value);
        if (Number.isFinite(n) && n >= 0.5 && n <= 2) cloudSpeed = n;
      }
    }
  } catch { /* defaults */ }
  return { engine, voice, speed, cloudVoice, cloudVoiceProvider, cloudDescription, cloudSpeed };
}

/**
 * Synthesize one utterance: mono Float32 PCM for the call session's μ-law encoder, or `null` if the
 * configured engine failed. No cross-engine fallback: CallSession.drainSpeechTexts skips the sentence,
 * since a brief gap beats a mid-reply voice swap.
 */
export async function synthesizeForTwilio(
  text: string,
): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  const settings = await loadSettings();
  if (settings.engine === 'cloud') {
    try {
      return await synthesizeCloud(text, settings);
    } catch (err) {
      logger.error('Hume TTS failed on live call (sentence skipped, no fallback)', {
        error: err instanceof Error ? err.message : String(err),
        textPreview: text.slice(0, 60),
      });
      return null;
    }
  }
  return synthesizeLocal(text, settings);
}

async function synthesizeLocal(text: string, settings: TtsSettings): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  try {
    const { synthesizeOnce } = await import('../voice/tts-service.js');
    const result = await synthesizeOnce(text, settings.voice, settings.speed);
    return { pcm: result.pcm, sampleRate: result.sampleRate };
  } catch (err) {
    logger.warn('Kokoro synthesis failed (sentence skipped)', {
      error: err instanceof Error ? err.message : String(err),
      textPreview: text.slice(0, 60),
    });
    return null;
  }
}

/**
 * Drive a one-shot Hume burst: push the utterance, collect WAV chunks until Hume signals `isLastChunk`
 * (or the socket closes), and stitch their PCM into one Float32 buffer at HUME_SAMPLE_RATE (48 kHz).
 * Throws on any failure; synthesizeForTwilio then skips the sentence.
 */
async function synthesizeCloud(text: string, settings: TtsSettings): Promise<{ pcm: Float32Array; sampleRate: number }> {
  if (!settings.cloudVoice) {
    throw new Error('Hume voice id not configured.');
  }
  const { HumeStreamSession, HUME_SAMPLE_RATE, isHumeConfigured } = await import('../voice/hume-engine.js');
  if (!isHumeConfigured()) {
    throw new Error('Hume API key not configured.');
  }
  const hume = new HumeStreamSession({
    voiceId: settings.cloudVoice,
    voiceProvider: settings.cloudVoiceProvider,
    description: settings.cloudDescription ?? undefined,
    speed: settings.cloudSpeed,
  });
  const chunks: Buffer[] = [];
  let humeError: Error | null = null;
  hume.onWav = (wav: Buffer) => { chunks.push(wav); };
  hume.onError = (err: Error) => { humeError = err; };

  await hume.open();
  try {
    hume.push(text);
    hume.flush();
    await hume.close();
  } finally {
    // close() is idempotent.
  }

  if (humeError !== null) {
    throw humeError as Error;
  }
  if (chunks.length === 0) {
    throw new Error('Hume returned no audio.');
  }

  // Each chunk is a self-contained WAV (44-byte header, 16-bit PCM body): strip headers, stitch bodies.
  const pcmBodies: Buffer[] = chunks.map(c => c.subarray(44));
  const totalBytes = pcmBodies.reduce((a, b) => a + b.length, 0);
  const totalSamples = totalBytes / 2;
  const out = new Float32Array(totalSamples);
  let outIdx = 0;
  for (const body of pcmBodies) {
    for (let i = 0; i < body.length; i += 2) {
      const sample = body.readInt16LE(i);
      out[outIdx++] = sample / 32768;
    }
  }
  return { pcm: out, sampleRate: HUME_SAMPLE_RATE };
}
