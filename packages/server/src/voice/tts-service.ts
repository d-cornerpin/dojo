import { KokoroTTS } from 'kokoro-js';
import { env as transformersEnv } from '@huggingface/transformers';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import { KOKORO_MODEL_ID, KOKORO_CACHE_DIR, ensureKokoroFiles, isKokoroFullyDownloaded } from './model-manager.js';
import { listCustomVoices, installCustomVoicePatch } from './custom-voices.js';

const logger = createLogger('voice-tts');

// Keep the transformers cache under ~/.dojo/voice/kokoro/ (not node_modules, which npm install wipes) so the
// dashboard can tell whether the model is on disk. Must be set before the first from_pretrained call.
try {
  fs.mkdirSync(KOKORO_CACHE_DIR, { recursive: true });
  // Serve the Kokoro files from disk ourselves (model-manager.ensureKokoroFiles downloads them): with a local
  // model root and remote models off, transformers takes its local-file branch and never touches the cache
  // layer, which throws "Unable to get model file path or buffer."
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

/** Move a Kokoro cache left in the old node_modules location to the pinned location, once. */
function migrateLegacyKokoroCache(): void {
  // Walk up from this file to the repo root. fileURLToPath, never new URL().pathname: the latter stays
  // percent-encoded, so an install path containing a space would silently find nothing.
  const here = path.dirname(fileURLToPath(import.meta.url));
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
    // A rename across filesystems can fail (EXDEV); the model then re-downloads, which is acceptable.
    logger.warn('Kokoro cache migration failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const DEFAULT_VOICE = 'am_michael';

export type LoadProgress = {
  stage: string;
  /** 0-100 percent for the file currently downloading. */
  progress: number;
  /** Bytes downloaded for the current file, if transformers reports it. */
  loaded?: number;
  /** Total bytes for the current file, if known. */
  total?: number;
};
export type LoadProgressCallback = (p: LoadProgress) => void;

let modelPromise: Promise<KokoroTTS> | null = null;
let lastDtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' = 'q8';

/** Load and cache the Kokoro model; `onProgress` is honored only on the first call. */
export function loadKokoro(
  onProgress?: LoadProgressCallback,
  dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' = 'q8',
): Promise<KokoroTTS> {
  if (modelPromise && dtype === lastDtype) return modelPromise;
  lastDtype = dtype;
  logger.info('Loading Kokoro model', { modelId: KOKORO_MODEL_ID, dtype });

  const promise = (async () => {
    // Download every required file first: with remote models off, a missing file would crash
    // from_pretrained rather than fall back to a fetch. Idempotent.
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
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype,
      device: 'cpu',
    });
    // Teach the instance about imported custom voicepacks; built-in voices keep their original path.
    await installCustomVoicePatch(tts);
    return tts;
  })();
  modelPromise = promise;
  // Drop a rejected promise so the next call retries instead of replaying the first failure forever.
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

export function listVoices(): Array<{ id: string; name: string; language: string; gender: string; custom?: boolean }> {
  // Mirror of the voice table in node_modules/kokoro-js/dist/kokoro.js (avoids forcing a model load); keep in sync.
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
  const builtIns = Object.entries(voices).map(([id, v]) => ({ id, ...v }));
  const customs = listCustomVoices().map((v) => ({
    id: v.id,
    name: v.name,
    language: v.language,
    gender: v.gender,
    custom: true as const,
  }));
  return [...builtIns, ...customs];
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
 * Producer/consumer queue of pre-split clauses. The kokoro-js sentence splitter makes first audio wait for a
 * full sentence; here the caller pushes ready clauses and synthesizeClauseStream synthesizes one at a time.
 * The surface mirrors TextSplitterStream so call sites only swap the queue.
 */
export class ClauseQueue {
  private items: string[] = [];
  private resolver: (() => void) | null = null;
  private closed = false;

  push(...clauses: string[]): void {
    for (const c of clauses) {
      const trimmed = c.trim();
      if (trimmed.length > 0) this.items.push(trimmed);
    }
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }

  /** Idempotent close. Wakes any pending iterator so it terminates. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }

  /** No-op for compatibility with kokoro-js's TextSplitterStream API. */
  flush(): void { /* clauses are flushed at push time */ }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, void> {
    while (true) {
      if (this.items.length > 0) {
        const next = this.items.shift();
        if (next !== undefined) yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.resolver = resolve; });
    }
  }
}

export function createClauseQueue(): ClauseQueue {
  return new ClauseQueue();
}

/** Synthesize each queued clause with its own `generate` call, yielding PCM as each finishes. */
export async function* synthesizeClauseStream(
  queue: ClauseQueue,
  voice: string = DEFAULT_VOICE,
  speed = 1,
  signal?: AbortSignal,
): AsyncGenerator<TtsChunk, void, void> {
  const tts = await loadKokoro();
  for await (const clauseText of queue) {
    if (signal?.aborted) {
      logger.debug('Clause TTS stream aborted by caller');
      return;
    }
    const audio = await tts.generate(clauseText, { voice: voice as keyof typeof tts.voices, speed });
    yield {
      text: clauseText,
      pcm: audio.audio,
      sampleRate: audio.sampling_rate,
    };
  }
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
