// Twilio TTS bridge: synthesizes one utterance with the engine set in Settings, Voice (Kokoro or Hume) and
// returns PCM for the call session's μ-law encoder. The settings are read per utterance, so a change applies
// on the next one; the user's choice wins even though Hume's socket open adds 100-300 ms.

import { createLogger } from '../logger.js';
import { loadVoiceSettings, type VoiceSettings } from '../voice/voice-settings.js';

const logger = createLogger('twilio-tts-bridge');

/**
 * Synthesize one utterance: mono Float32 PCM for the call session's μ-law encoder, or `null` if no engine
 * could speak it (CallSession.drainSpeechTexts then skips the sentence). A failing cloud voice hands the
 * whole sentence to the local voice, so the caller hears the rest of the reply; the cloud audio is only
 * returned complete, so a sentence is never half cloud and half local. `call.cloudDown` (one per call, set
 * on the first failure) keeps the rest of that call on the local voice, so a dead provider costs one wait.
 */
export async function synthesizeForTwilio(
  text: string,
  call: { cloudDown: boolean; agentId: string },
): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  const settings = loadVoiceSettings('phone');
  if (settings.ttsEngine === 'cloud' && !call.cloudDown) {
    try {
      return await synthesizeCloud(text, settings, call.agentId);
    } catch (err) {
      call.cloudDown = true;
      logger.warn('Hume TTS failed on live call, the rest of the call uses the local voice', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return synthesizeLocal(text, settings);
}

async function synthesizeLocal(text: string, settings: VoiceSettings): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  try {
    const { synthesizeOnce } = await import('../voice/tts-service.js');
    const result = await synthesizeOnce(text, settings.voice, settings.speed);
    return { pcm: result.pcm, sampleRate: result.sampleRate };
  } catch (err) {
    logger.warn('Kokoro synthesis failed (sentence skipped)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Drive a one-shot Hume burst: push the utterance, collect WAV chunks until Hume signals `isLastChunk`
 * (or the socket closes), and stitch their PCM into one Float32 buffer at HUME_SAMPLE_RATE (48 kHz).
 * Throws on any failure, an error frame or hang-up included; synthesizeForTwilio then uses the local voice.
 */
async function synthesizeCloud(text: string, settings: VoiceSettings, agentId: string): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const { HumeStreamSession, HUME_SAMPLE_RATE } = await import('../voice/hume-engine.js');
  const hume = new HumeStreamSession({
    voiceId: settings.cloudVoice,
    voiceProvider: settings.cloudVoiceProvider,
    description: settings.cloudDescription ?? undefined,
    speed: settings.cloudSpeed,
    agentId,
  });
  const chunks: Buffer[] = [];
  let humeError: Error | null = null;
  hume.onWav = (wav: Buffer) => { chunks.push(wav); };
  hume.onError = (err: Error) => { humeError = err; };
  hume.onDrop = hume.onError;

  await hume.open();
  hume.push(text);
  hume.flush();
  await hume.close();

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
