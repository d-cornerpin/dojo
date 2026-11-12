// Smart Turn: acoustic end-of-turn detection. A local ONNX model (pipecat-ai/smart-turn, on the same
// onnxruntime-node the Moonshine STT path uses) outputs P(turn complete) in [0, 1] from a Whisper log-mel
// spectrogram (1, 80, 800) of up to 8 s of 16 kHz mono audio; above 0.5 the speaker is done.
//
// The feature extractor needs the waveform normalized (zero-mean/unit-variance) by us, and n_samples /
// nb_max_frames passed explicitly. Every failure degrades: predictTurnComplete returns null and the caller
// falls back to the heuristic debounce.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { VOICE_ROOT } from './model-manager.js';
import { createLogger } from '../logger.js';

const logger = createLogger('smart-turn');

const SMART_TURN_DIR = path.join(VOICE_ROOT, 'smart-turn');
const SMART_TURN_MODEL_ID = 'pipecat-ai/smart-turn-v3';
const SMART_TURN_FILE = 'smart-turn-v3.2-cpu.onnx';
const SMART_TURN_APPROX_BYTES = 8_679_182;
const MODEL_PATH = path.join(SMART_TURN_DIR, SMART_TURN_FILE);

// Whisper feature-extractor params for 8 s chunks: the model expects 800 mel frames, not stock Whisper's 3000.
const SAMPLE_RATE = 16_000;
const N_SAMPLES = 8 * SAMPLE_RATE; // 128_000
const NB_MAX_FRAMES = 800;

/** P(complete) above this means the turn is done. */
export const TURN_COMPLETE_THRESHOLD = 0.5;

export function isSmartTurnDownloaded(): boolean {
  try {
    return fs.statSync(MODEL_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Download the ONNX file from the HF resolve URL into the cache dir. Idempotent. */
export async function ensureSmartTurnModel(): Promise<string> {
  if (isSmartTurnDownloaded()) return MODEL_PATH;
  await fsp.mkdir(SMART_TURN_DIR, { recursive: true });
  const url = `https://huggingface.co/${SMART_TURN_MODEL_ID}/resolve/main/${SMART_TURN_FILE}`;
  logger.info('Downloading Smart Turn v3 model', { url, dest: MODEL_PATH });

  const tmp = MODEL_PATH + '.partial';
  try { await fsp.unlink(tmp); } catch { /* no prior partial */ }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`smart-turn download failed: ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const writer = fs.createWriteStream(tmp);
  // An unhandled 'error' event on the writer (disk full) would crash the server, so remember the first one
  // and throw it after the awaited writes; end() on a destroyed stream only reports a generic error.
  let streamError: Error | null = null;
  writer.on('error', (err: Error) => {
    if (!streamError) streamError = err;
  });
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!writer.write(Buffer.from(value)) && !streamError) {
        // Backpressure: wait for drain, or for the stream to error or close.
        await new Promise<void>((resolve) => {
          writer.once('drain', resolve);
          writer.once('error', () => resolve());
          writer.once('close', resolve);
        });
      }
      if (streamError) throw streamError;
      bytes += value.byteLength;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => {
        if (streamError) reject(streamError);
        else if (err) reject(err);
        else resolve();
      });
    });
  }
  if (streamError) throw streamError;
  await fsp.rename(tmp, MODEL_PATH);
  logger.info('Smart Turn v3 model downloaded', { bytes, approx: SMART_TURN_APPROX_BYTES });
  return MODEL_PATH;
}

// Lazy single-resident session and feature extractor. onnxruntime-node is typed loosely (dynamic import).
type OrtModule = {
  InferenceSession: { create(p: string): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>> }> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
};
type FeatureExtractor = (
  audio: Float32Array,
  opts: { max_length: number },
) => Promise<{ input_features: { data: ArrayLike<number>; dims: number[] } }>;

let sessionPromise: Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>> }> | null = null;
let ortPromise: Promise<OrtModule> | null = null;
let fePromise: Promise<FeatureExtractor> | null = null;

async function getOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    const promise = (async () => {
      const ns = (await import('onnxruntime-node')) as unknown as { default?: OrtModule } & OrtModule;
      return (ns.default ?? ns) as OrtModule;
    })();
    ortPromise = promise;
    // Drop a rejected promise from the cache so a later call retries.
    promise.catch(() => {
      if (ortPromise === promise) ortPromise = null;
    });
  }
  return ortPromise;
}

async function getSession() {
  if (!sessionPromise) {
    const promise = (async () => {
      await ensureSmartTurnModel();
      const ort = await getOrt();
      logger.info('Loading Smart Turn v3 ONNX session', { path: MODEL_PATH });
      return ort.InferenceSession.create(MODEL_PATH);
    })();
    sessionPromise = promise;
    // Drop a rejected promise (failed first download) so the next call retries.
    promise.catch(() => {
      if (sessionPromise === promise) sessionPromise = null;
    });
  }
  return sessionPromise;
}

async function getFeatureExtractor(): Promise<FeatureExtractor> {
  if (!fePromise) {
    const promise = (async () => {
      const { WhisperFeatureExtractor } = (await import('@huggingface/transformers')) as unknown as {
        WhisperFeatureExtractor: new (config: Record<string, unknown>) => FeatureExtractor;
      };
      return new WhisperFeatureExtractor({
        feature_size: 80,
        sampling_rate: SAMPLE_RATE,
        hop_length: 160,
        chunk_length: 8,
        n_fft: 400,
        padding_value: 0.0,
        // transformers.js does not derive these from chunk_length (8 s = 128000 samples = 800 frames).
        n_samples: N_SAMPLES,
        nb_max_frames: NB_MAX_FRAMES,
      });
    })();
    fePromise = promise;
    promise.catch(() => {
      if (fePromise === promise) fePromise = null;
    });
  }
  return fePromise;
}

/** Preload the model and run one inference so the first real turn skips load and JIT cost. */
export async function warmUpSmartTurn(): Promise<void> {
  try {
    const [fe, sess] = await Promise.all([getFeatureExtractor(), getSession()]);
    const ort = await getOrt();
    const out = await fe(new Float32Array(SAMPLE_RATE), { max_length: N_SAMPLES });
    const t = new ort.Tensor('float32', Float32Array.from(out.input_features.data), out.input_features.dims);
    await sess.run({ input_features: t });
    logger.info('Smart Turn v3 warmed up');
  } catch (err) {
    logger.warn('Smart Turn v3 warmup failed (non-fatal, will fall back)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Linear resample to 16 kHz; voice sessions are normally already 16 kHz. */
function resampleTo16k(pcm: Float32Array, srcRate: number): Float32Array {
  if (srcRate === SAMPLE_RATE) return pcm;
  const ratio = SAMPLE_RATE / srcRate;
  const outLen = Math.round(pcm.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
  }
  return out;
}

/** do_normalize: zero-mean/unit-variance over the valid samples, (x - mean) / sqrt(var + 1e-7). */
function normalizeWaveform(a: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length || 1;
  let varSum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / (a.length || 1)) + 1e-7;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - mean) / std;
  return out;
}

/**
 * P(turn complete) for an utterance's PCM, or null if the model is unavailable or inference failed. Never
 * throws. Audio over 8 s keeps its tail: end-of-turn depends on the most recent acoustics.
 */
export async function predictTurnComplete(
  pcm: Float32Array,
  sampleRate: number,
): Promise<number | null> {
  if (!isSmartTurnDownloaded()) return null;
  try {
    let audio = resampleTo16k(pcm, sampleRate);
    if (audio.length > N_SAMPLES) audio = audio.slice(audio.length - N_SAMPLES);
    const norm = normalizeWaveform(audio);
    const fe = await getFeatureExtractor();
    const feats = await fe(norm, { max_length: N_SAMPLES });
    const ort = await getOrt();
    const t = new ort.Tensor('float32', Float32Array.from(feats.input_features.data), feats.input_features.dims);
    const sess = await getSession();
    const result = await sess.run({ input_features: t });
    const p = result.logits?.data?.[0];
    return typeof p === 'number' ? p : null;
  } catch (err) {
    logger.warn('Smart Turn prediction failed (falling back to heuristic)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
