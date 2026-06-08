// ════════════════════════════════════════
// Twilio Media Streams audio codec (v2.9.18)
//
// Twilio Media Streams ships and accepts μ-law 8 kHz mono audio, 20 ms
// per frame (160 samples). Our STT engine (Moonshine) wants 16 kHz
// mono Float32; Kokoro emits 24 kHz mono Float32. These helpers
// bridge between the two.
//
// μ-law (G.711) is a logarithmic 8-bit codec. Encoding compresses
// 16-bit linear PCM into 8-bit codewords; decoding does the inverse
// via a 256-entry lookup table.
// ════════════════════════════════════════

const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

// Decode lookup table: μ-law byte → linear 16-bit signed PCM.
// Generated once at module load.
const MU_LAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const muVal = ~i & 0xFF;
    const sign = (muVal & 0x80) ? -1 : 1;
    const exponent = (muVal >> 4) & 0x07;
    const mantissa = muVal & 0x0F;
    const sample = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
    table[i] = sign * (sample - MU_LAW_BIAS);
  }
  return table;
})();

/** Decode a μ-law buffer to 16-bit linear PCM. */
export function muLawDecode(input: Buffer): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = MU_LAW_DECODE_TABLE[input[i]];
  }
  return out;
}

/** Encode a single 16-bit linear PCM sample to μ-law. */
function linearToMuLaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > MU_LAW_CLIP) sample = MU_LAW_CLIP;
  sample += MU_LAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/** Encode 16-bit linear PCM to μ-law. */
export function muLawEncode(input: Int16Array): Buffer {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = linearToMuLaw(input[i]);
  }
  return out;
}

// ── Sample-rate conversion ──────────────────────────────────────────
//
// Speech is band-limited well below 4 kHz so the simple approaches
// below are adequate:
//   - Upsample 8 kHz → 16 kHz: linear interpolation between samples
//   - Downsample 16 kHz → 8 kHz: average pairs (cheap low-pass)
//   - Downsample arbitrary → 8 kHz: linear-interpolated decimation
//
// Higher-quality SRC would help slightly but isn't worth the latency
// for telephony.

/** Upsample 8 kHz mono Int16 → 16 kHz mono Float32 in [-1, 1]. */
export function int16At8kToFloat32At16k(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    const b = i + 1 < input.length ? input[i + 1] : input[i];
    out[i * 2] = a / 32768;
    out[i * 2 + 1] = ((a + b) / 2) / 32768;
  }
  return out;
}

// ── Anti-aliasing lowpass for the 8 kHz → 16 kHz upsample ──────────
//
// Twilio sends G.711 μ-law audio at 8 kHz, bandlimited to ~3.4 kHz.
// Linear interpolation to 16 kHz is cheap but creates spectral
// images above 4 kHz that confuse Moonshine STT (verified
// experimentally on 2026-06-07: a captured Twilio utterance returned
// empty until we ffmpeg-lowpassed it at 3400 Hz, at which point
// Moonshine transcribed it correctly).
//
// Apply this biquad lowpass AFTER int16At8kToFloat32At16k to strip
// the images. Coefficients are Butterworth (Q=0.707) at fc=3400 Hz
// for fs=16000 Hz, derived from the standard RBJ cookbook formulas.
// The IIR is two-pole so the caller must hold a BiquadState across
// frames to avoid frame-boundary discontinuities.
const BIQUAD_LP_3400_16k = {
  b0: 0.2271, b1: 0.4542, b2: 0.2271,
  // Sign reflects y[n] = b·x... - a·y form. Applied in the diff
  // equation below as +0.2767·y[n-1] (because a1 itself is negative).
  a1: -0.2767, a2: 0.1850,
};

export interface BiquadState {
  x1: number; x2: number; y1: number; y2: number;
}

export function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function applyAntiAliasLP(input: Float32Array, state: BiquadState): Float32Array {
  const { b0, b1, b2, a1, a2 } = BIQUAD_LP_3400_16k;
  const out = new Float32Array(input.length);
  let { x1, x2, y1, y2 } = state;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  state.x1 = x1; state.x2 = x2;
  state.y1 = y1; state.y2 = y2;
  return out;
}

/** Downsample arbitrary mono Float32 → 8 kHz mono Int16. */
export function float32ToInt16At8k(input: Float32Array, sourceSampleRate: number): Int16Array {
  if (sourceSampleRate === 8000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = clampInt16(input[i] * 32768);
    }
    return out;
  }
  const ratio = sourceSampleRate / 8000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const a = input[srcIdx] ?? 0;
    const b = input[srcIdx + 1] ?? a;
    const sample = a * (1 - frac) + b * frac;
    out[i] = clampInt16(sample * 32768);
  }
  return out;
}

function clampInt16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return Math.round(v);
}

/** Convenience: Twilio μ-law base64 frame → Float32 16 kHz. */
export function decodeTwilioFrame(base64Payload: string): Float32Array {
  const muLaw = Buffer.from(base64Payload, 'base64');
  const pcm8k = muLawDecode(muLaw);
  return int16At8kToFloat32At16k(pcm8k);
}

/** Convenience: Float32 audio at arbitrary rate → Twilio μ-law base64. */
export function encodeForTwilio(input: Float32Array, sourceSampleRate: number): string {
  const pcm8k = float32ToInt16At8k(input, sourceSampleRate);
  return muLawEncode(pcm8k).toString('base64');
}

/**
 * Twilio expects a steady 20 ms cadence (160 samples / 160 bytes per
 * frame at 8 kHz). Slice an arbitrary-length μ-law payload into
 * 160-byte frames for paced send-back. Tail shorter than 160 is
 * padded with silence (μ-law 0xFF = silence).
 */
export function chunkForTwilio(muLaw: Buffer, frameBytes = 160): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < muLaw.length; i += frameBytes) {
    if (i + frameBytes <= muLaw.length) {
      frames.push(muLaw.subarray(i, i + frameBytes));
    } else {
      const last = Buffer.alloc(frameBytes, 0xFF);
      muLaw.copy(last, 0, i);
      frames.push(last);
    }
  }
  return frames;
}
