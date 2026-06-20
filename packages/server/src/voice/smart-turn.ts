// ════════════════════════════════════════════════════════════════════════
// Smart Turn v3 — semantic (acoustic) end-of-turn detection.
//
// Replaces the fixed-debounce / lexical-conjunction turn-taking heuristic with
// an audio model that predicts whether the speaker actually finished their
// turn. Runs locally in-process on the same onnxruntime-node the Moonshine STT
// path already pulls in, so there is no new native dependency.
//
// Model: pipecat-ai/smart-turn-v3 (BSD-2, ~8.6 MB int8 ONNX, Whisper-tiny
// encoder backbone + linear head). Input is a Whisper log-mel spectrogram
// (1, 80, 800) for 8 s of 16 kHz mono audio; output `logits` is already a
// sigmoid probability in [0, 1] — P(turn complete). >0.5 means "they're done".
//
// Preprocessing mirrors the reference inference.py exactly:
//   WhisperFeatureExtractor(chunk_length=8) called with
//   padding='max_length', max_length=8*16000, truncation=True, do_normalize=True
// transformers.js's WhisperFeatureExtractor matches the HF one for the mel
// stage but does NOT apply the waveform-level zero-mean/unit-var normalization
// (do_normalize), so we apply that ourselves before extraction. The FE also
// needs n_samples / nb_max_frames supplied explicitly (it derives them from
// preprocessor_config.json normally; this repo ships none).
//
// Everything degrades gracefully: if the model is not downloaded yet, or any
// stage throws, predictTurnComplete returns null and the caller falls back to
// the legacy heuristic. Nothing in the voice path hard-depends on this.
// ════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { VOICE_ROOT } from './model-manager.js';
import { createLogger } from '../logger.js';

const logger = createLogger('smart-turn');

const SMART_TURN_DIR = path.join(VOICE_ROOT, 'smart-turn');
const SMART_TURN_MODEL_ID = 'pipecat-ai/smart-turn-v3';
// v3.2 CPU build — newest, int8, ~12 ms/inference on a laptop CPU.
const SMART_TURN_FILE = 'smart-turn-v3.2-cpu.onnx';
const SMART_TURN_APPROX_BYTES = 8_679_182;
const MODEL_PATH = path.join(SMART_TURN_DIR, SMART_TURN_FILE);

// Whisper feature-extractor params for chunk_length=8 (matches the model's
// fixed positional embeddings: 800 mel frames, not the 3000 of stock Whisper).
const SAMPLE_RATE = 16_000;
const N_SAMPLES = 8 * SAMPLE_RATE; // 128_000
const NB_MAX_FRAMES = 800;

/** Default decision threshold: P(complete) above this ⇒ the turn is done. */
export const TURN_COMPLETE_THRESHOLD = 0.5;

export function isSmartTurnDownloaded(): boolean {
  try {
    return fs.statSync(MODEL_PATH).size > 0;
  } catch {
    return false;
  }
}

/**
 * Download the single ONNX file directly from the HF resolve URL into the
 * smart-turn cache dir (same direct-fetch approach the other voice models use).
 * Idempotent: returns immediately if already present.
 */
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
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(Buffer.from(value));
      bytes += value.byteLength;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
  await fsp.rename(tmp, MODEL_PATH);
  logger.info('Smart Turn v3 model downloaded', { bytes, approx: SMART_TURN_APPROX_BYTES });
  return MODEL_PATH;
}

// ── Lazy, single-resident session + feature extractor ──

// onnxruntime-node InferenceSession (typed loosely: it's a dynamic import and
// we only touch .run, mirroring the STT service's untyped transformers usage).
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
    ortPromise = (async () => {
      const ns = (await import('onnxruntime-node')) as unknown as { default?: OrtModule } & OrtModule;
      return (ns.default ?? ns) as OrtModule;
    })();
  }
  return ortPromise;
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await ensureSmartTurnModel();
      const ort = await getOrt();
      logger.info('Loading Smart Turn v3 ONNX session', { path: MODEL_PATH });
      return ort.InferenceSession.create(MODEL_PATH);
    })();
  }
  return sessionPromise;
}

async function getFeatureExtractor(): Promise<FeatureExtractor> {
  if (!fePromise) {
    fePromise = (async () => {
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
        // transformers.js does not derive these from chunk_length; supply the
        // exact values the Python FE computes (8 s → 128000 samples → 800 frames).
        n_samples: N_SAMPLES,
        nb_max_frames: NB_MAX_FRAMES,
      });
    })();
  }
  return fePromise;
}

/**
 * Preload the model + warm one inference so the first real turn doesn't pay
 * the model-load + JIT cost. Fire-and-forget; safe to call repeatedly.
 */
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

/** Cheap linear resample to 16 kHz. Voice sessions default to 16 kHz, so this
 *  is a rarely-hit safety path, not the common case. */
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

/** WhisperFeatureExtractor do_normalize: zero-mean / unit-variance over the
 *  valid (non-padded) samples. HF uses (x - mean) / sqrt(var + 1e-7). */
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
 * Predict P(turn complete) for an utterance's PCM. Returns a probability in
 * [0, 1], or null if the model isn't available / inference failed (caller
 * should fall back to the legacy heuristic). Never throws.
 *
 * For audio longer than 8 s we keep the TAIL — end-of-turn detection depends on
 * the most recent acoustics (trailing intonation / silence), not the opening.
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
