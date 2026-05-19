import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { env as transformersEnv } from '@huggingface/transformers';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../logger.js';
import { KOKORO_MODEL_ID, KOKORO_CACHE_DIR, ensureKokoroFiles, isKokoroFullyDownloaded } from './model-manager.js';

const logger = createLogger('voice-tts');

// Park the @huggingface/transformers cache under ~/.dojo/voice/kokoro/ instead
// of the npm package's bundled `.cache/`. Two reasons:
//   1. `npm install` wipes node_modules — the bundled cache vanishes with it,
//      forcing a 330 MB re-download on every reinstall.
//   2. We want the dashboard's "Text-to-speech model" row to know whether the
//      model is on disk; tying it to a stable path we own makes that trivial.
// Must be set before the first `from_pretrained` call.
try {
  fs.mkdirSync(KOKORO_CACHE_DIR, { recursive: true });
  // Bypass transformers.js's broken cache layer by serving the Kokoro files
  // from disk ourselves (see model-manager.ensureKokoroFiles). We download
  // every file required by `style_text_to_speech_2` directly into
  // KOKORO_CACHE_DIR/onnx-community/Kokoro-82M-v1.0-ONNX/, then tell
  // transformers to treat KOKORO_CACHE_DIR as a local model root. Its
  // local-file branch returns a FileResponse and short-circuits before
  // ever touching cache.put/cache.match — the path that was reproducibly
  // throwing "Unable to get model file path or buffer." in the dev-server
  // process (2026-05-19).
  //
  //   env.localModelPath = "<cacheDir>"
  //   env.allowRemoteModels = false   (force local-only — any remote fetch
  //                                    would hit the broken cache layer)
  //   env.useFSCache stays at its default (true) — irrelevant because
  //                                    we never reach the cache code path.
  const env = transformersEnv as {
    cacheDir?: string;
    localModelPath?: string;
    allowRemoteModels?: boolean;
  };
  env.cacheDir = KOKORO_CACHE_DIR;
  env.localModelPath = KOKORO_CACHE_DIR;
  env.allowRemoteModels = false;
  migrateLegacyKokoroCache();
} catch (err) {
  logger.warn('Failed to configure Kokoro env; loads may fail', {
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * One-time migration: if a previous run cached Kokoro at the old default
 * (inside `node_modules/@huggingface/transformers/.cache/`), move it to the
 * pinned location so a) the dashboard sees "installed" and b) the next
 * `npm install` doesn't wipe 330 MB.
 */
function migrateLegacyKokoroCache(): void {
  // Walk up from this file: src/voice/tts-service.ts → repo root
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '../../../..');
  const legacyRoot = path.join(repoRoot, 'node_modules/@huggingface/transformers/.cache');
  const legacyKokoro = path.join(legacyRoot, 'onnx-community/Kokoro-82M-v1.0-ONNX');
  const newKokoro = path.join(KOKORO_CACHE_DIR, 'onnx-community/Kokoro-82M-v1.0-ONNX');
  try {
    if (!fs.existsSync(legacyKokoro)) return;
    if (fs.existsSync(newKokoro)) return; // already migrated
    fs.mkdirSync(path.dirname(newKokoro), { recursive: true });
    fs.renameSync(legacyKokoro, newKokoro);
    logger.info('Migrated legacy Kokoro cache out of node_modules', { from: legacyKokoro, to: newKokoro });
  } catch (err) {
    // Rename across filesystems can fail with EXDEV; the model will just
    // re-download on next session, which is acceptable.
    logger.warn('Kokoro cache migration failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const KOKORO_SAMPLE_RATE = 24_000;
export const DEFAULT_VOICE = 'am_michael';

export type LoadProgress = {
  stage: string;
  /** 0–100 percent for the file currently downloading. */
  progress: number;
  /** Bytes downloaded for the current file, if transformers reports it. */
  loaded?: number;
  /** Total bytes for the current file, if known. */
  total?: number;
};
export type LoadProgressCallback = (p: LoadProgress) => void;

let modelPromise: Promise<KokoroTTS> | null = null;
let lastDtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' = 'q8';

/**
 * Load and cache the Kokoro model. Subsequent calls return the cached instance.
 * Pass `onProgress` only on the first call — later calls ignore it.
 */
export function loadKokoro(
  onProgress?: LoadProgressCallback,
  dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' = 'q8',
): Promise<KokoroTTS> {
  if (modelPromise && dtype === lastDtype) return modelPromise;
  lastDtype = dtype;
  logger.info('Loading Kokoro model', { modelId: KOKORO_MODEL_ID, dtype });

  const promise = (async () => {
    // Make sure every required Kokoro file is on disk BEFORE transformers
    // starts looking. With `env.localModelPath` set to KOKORO_CACHE_DIR and
    // `allowRemoteModels=false`, transformers will only read locally — so a
    // missing file would crash from_pretrained instead of falling back to
    // a remote fetch. ensureKokoroFiles is idempotent and a no-op once
    // everything is present.
    if (!isKokoroFullyDownloaded()) {
      logger.info('Kokoro files missing; downloading direct (bypassing transformers cache layer)');
      await ensureKokoroFiles((p) => {
        if (onProgress) {
          const pct = p.bytesTotal > 0 ? (p.bytesDownloaded / p.bytesTotal) * 100 : 0;
          onProgress({
            stage: 'kokoro',
            progress: pct,
            loaded: p.bytesDownloaded,
            total: p.bytesTotal,
          });
        }
      });
    }
    return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype,
      device: 'cpu',
    });
  })();
  modelPromise = promise;
  // If the load rejects, drop the cached promise so the next attempt actually
  // retries. Without this, a single transient transformers.js error (e.g.
  // network hiccup, or the "Unable to get model file path or buffer." race
  // we hit 2026-05-19) would poison the cache for the rest of the server's
  // lifetime — every subsequent loadKokoro() would re-throw the original
  // failure without trying again.
  promise.catch((err) => {
    logger.warn('Kokoro load rejected — clearing cached promise so retry works', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (modelPromise === promise) modelPromise = null;
  });
  return modelPromise;
}

export function isKokoroLoaded(): boolean {
  return modelPromise !== null;
}

export function listVoices(): Array<{ id: string; name: string; language: string; gender: string }> {
  // Mirror of the static voice list in kokoro-js to avoid forcing a model load.
  // Keep in sync with node_modules/kokoro-js/dist/kokoro.js voice table.
  const voices: Record<string, { name: string; language: string; gender: string }> = {
    af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
    af_alloy: { name: 'Alloy', language: 'en-us', gender: 'Female' },
    af_aoede: { name: 'Aoede', language: 'en-us', gender: 'Female' },
    af_bella: { name: 'Bella', language: 'en-us', gender: 'Female' },
    af_jessica: { name: 'Jessica', language: 'en-us', gender: 'Female' },
    af_kore: { name: 'Kore', language: 'en-us', gender: 'Female' },
    af_nicole: { name: 'Nicole', language: 'en-us', gender: 'Female' },
    af_nova: { name: 'Nova', language: 'en-us', gender: 'Female' },
    af_river: { name: 'River', language: 'en-us', gender: 'Female' },
    af_sarah: { name: 'Sarah', language: 'en-us', gender: 'Female' },
    af_sky: { name: 'Sky', language: 'en-us', gender: 'Female' },
    am_adam: { name: 'Adam', language: 'en-us', gender: 'Male' },
    am_echo: { name: 'Echo', language: 'en-us', gender: 'Male' },
    am_eric: { name: 'Eric', language: 'en-us', gender: 'Male' },
    am_fenrir: { name: 'Fenrir', language: 'en-us', gender: 'Male' },
    am_liam: { name: 'Liam', language: 'en-us', gender: 'Male' },
    am_michael: { name: 'Michael', language: 'en-us', gender: 'Male' },
    am_onyx: { name: 'Onyx', language: 'en-us', gender: 'Male' },
    am_puck: { name: 'Puck', language: 'en-us', gender: 'Male' },
    am_santa: { name: 'Santa', language: 'en-us', gender: 'Male' },
    bf_emma: { name: 'Emma', language: 'en-gb', gender: 'Female' },
    bf_isabella: { name: 'Isabella', language: 'en-gb', gender: 'Female' },
    bm_george: { name: 'George', language: 'en-gb', gender: 'Male' },
    bm_lewis: { name: 'Lewis', language: 'en-gb', gender: 'Male' },
    bf_alice: { name: 'Alice', language: 'en-gb', gender: 'Female' },
    bf_lily: { name: 'Lily', language: 'en-gb', gender: 'Female' },
    bm_daniel: { name: 'Daniel', language: 'en-gb', gender: 'Male' },
    bm_fable: { name: 'Fable', language: 'en-gb', gender: 'Male' },
  };
  return Object.entries(voices).map(([id, v]) => ({ id, ...v }));
}

/** One-shot synthesis. Returns a WAV buffer. */
export async function synthesizeOnce(
  text: string,
  voice: string = DEFAULT_VOICE,
  speed = 1,
): Promise<{ wav: Buffer; pcm: Float32Array; sampleRate: number }> {
  const tts = await loadKokoro();
  const audio = await tts.generate(text, { voice: voice as keyof typeof tts.voices, speed });
  const wav = Buffer.from(audio.toWav());
  return { wav, pcm: audio.audio, sampleRate: audio.sampling_rate };
}

export interface TtsChunk {
  text: string;
  pcm: Float32Array;
  sampleRate: number;
}

/**
 * Stream synthesis. Feed text via `splitter.push(...)`; call `splitter.close()`
 * when no more text is coming. Yields one PCM chunk per sentence.
 * Pass an AbortSignal to support barge-in cancellation.
 */
export async function* synthesizeStream(
  splitter: TextSplitterStream,
  voice: string = DEFAULT_VOICE,
  speed = 1,
  signal?: AbortSignal,
): AsyncGenerator<TtsChunk, void, void> {
  const tts = await loadKokoro();
  for await (const part of tts.stream(splitter, { voice: voice as keyof typeof tts.voices, speed })) {
    if (signal?.aborted) {
      logger.debug('TTS stream aborted by caller');
      return;
    }
    yield {
      text: part.text,
      pcm: part.audio.audio,
      sampleRate: part.audio.sampling_rate,
    };
  }
}

export function createTextSplitter(): TextSplitterStream {
  return new TextSplitterStream();
}

/** Encode a Float32Array PCM buffer as a 16-bit PCM WAV Buffer. */
export function pcmFloatToWav(pcm: Float32Array, sampleRate: number): Buffer {
  const numSamples = pcm.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7FFF, 44 + i * 2);
  }
  return buffer;
}
