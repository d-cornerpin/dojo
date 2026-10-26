// ════════════════════════════════════════════════════════════════════════════
// PINNING TESTS for src/twilio/audio-codec.ts (v35).
//
// This module bridges Twilio's G.711 μ-law 8 kHz mono audio to the Float32
// 16 kHz the STT/TTS engines want. A sign error or an off-by-one in any of
// these functions is audible garbage on every call, so the arithmetic is pinned
// here against its v35 behaviour. The source is NOT touched: a case that
// disagrees with the code is kept out of the suite and reported, never weakened.
//
// Pure functions, no mocks. Buffer / Int16Array / Float32Array are Node globals.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  muLawEncode,
  muLawDecode,
  chunkForTwilio,
  int16At8kToFloat32At16k,
  float32ToInt16At8k,
  encodeForTwilio,
  decodeTwilioFrame,
  applyAntiAliasLP,
  createBiquadState,
} from '../audio-codec.js';

// Every 97th int16 value, -32768..32767, as a flat sweep.
function int16Sweep(): Int16Array {
  const xs: number[] = [];
  for (let x = -32768; x <= 32767; x += 97) xs.push(x);
  return Int16Array.from(xs);
}

describe('muLawEncode / muLawDecode', () => {
  it('encodes the boundary samples to the G.711 codewords', () => {
    // 0xFF = silence, 0x80 = positive full scale, 0x00 = negative full scale.
    expect([...muLawEncode(new Int16Array([0, -1, 32767, -32768]))]).toEqual([255, 127, 128, 0]);
  });

  it('round-trips the fixed sample set exactly', () => {
    const decoded = muLawDecode(
      muLawEncode(new Int16Array([0, 1000, -1000, 32767, -32768, 8000])),
    );
    expect([...decoded]).toEqual([0, 988, -988, 32124, -32124, 7932]);
  });

  it('stays within 4% (plus 8 units) of the input across the whole range', () => {
    const xs = int16Sweep();
    const decoded = muLawDecode(muLawEncode(xs));
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      expect(Math.abs(decoded[i] - x)).toBeLessThanOrEqual(0.04 * Math.abs(x) + 8);
    }
  });

  it('preserves the input sign for magnitudes of 100 or more', () => {
    const xs = int16Sweep();
    const decoded = muLawDecode(muLawEncode(xs));
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (Math.abs(x) < 100) continue;
      expect(Math.sign(decoded[i])).toBe(Math.sign(x));
    }
  });

  it('encode and decode both no-op on empty input', () => {
    expect(muLawDecode(Buffer.alloc(0)).length).toBe(0);
    expect(muLawEncode(new Int16Array(0)).length).toBe(0);
  });
});

describe('int16At8kToFloat32At16k', () => {
  it('upsamples 8 kHz → 16 kHz by linear interpolation, repeating the last sample', () => {
    const out = int16At8kToFloat32At16k(new Int16Array([0, 16384, 0]));
    expect(out.length).toBe(6);
    expect([...out]).toEqual([0, 0.25, 0.5, 0.25, 0, 0]);
  });
});

describe('float32ToInt16At8k', () => {
  it('scales and clamps to the int16 range at 8 kHz', () => {
    const out = float32ToInt16At8k(new Float32Array([0, 1, -1, 2]), 8000);
    expect([...out]).toEqual([0, 32767, -32768, 32767]);
  });

  it('decimates an arbitrary sample rate down to 8 kHz', () => {
    expect(float32ToInt16At8k(new Float32Array(16000), 16000).length).toBe(8000);
  });

  it('gives an empty output for empty input', () => {
    expect(float32ToInt16At8k(new Float32Array(0), 16000).length).toBe(0);
  });
});

describe('chunkForTwilio', () => {
  it('splits into 160-byte frames, padding the short tail with 0xFF silence', () => {
    const frames = chunkForTwilio(Buffer.alloc(250, 1));
    expect(frames.length).toBe(2);
    expect(frames[0].length).toBe(160);
    expect(frames[1].length).toBe(160);
    // First frame is pure data; the tail frame is 90 data bytes + 70 of silence.
    expect(frames[1].subarray(0, 90).every((b) => b === 1)).toBe(true);
    expect(frames[1].subarray(90, 160).every((b) => b === 0xff)).toBe(true);
  });

  it('returns no frames for an empty payload', () => {
    expect(chunkForTwilio(Buffer.alloc(0))).toEqual([]);
  });

  it('cuts exact multiples with no padding frame', () => {
    const frames = chunkForTwilio(Buffer.alloc(320, 7));
    expect(frames.length).toBe(2);
    // No 0xFF tail was ever allocated: both frames are pure data.
    expect(frames.every((f) => f.length === 160 && f.every((b) => b === 7))).toBe(true);
  });

  it('honours a custom frameBytes argument', () => {
    const frames = chunkForTwilio(Buffer.alloc(40, 3), 8);
    expect(frames.length).toBe(5);
    expect(frames.every((f) => f.length === 8)).toBe(true);
  });
});

describe('encodeForTwilio / decodeTwilioFrame', () => {
  it('encodes empty audio to the empty string', () => {
    expect(encodeForTwilio(new Float32Array(0), 8000)).toBe('');
  });

  it('decodes a 0xFF silence frame to flat 16 kHz audio', () => {
    const payload = Buffer.alloc(160, 0xff).toString('base64');
    const out = decodeTwilioFrame(payload);
    expect(out.length).toBe(320);
    expect(out.every((v) => Math.abs(v) < 1e-3)).toBe(true);
  });
});

describe('applyAntiAliasLP / createBiquadState', () => {
  it('starts from a zeroed state', () => {
    expect(createBiquadState()).toEqual({ x1: 0, x2: 0, y1: 0, y2: 0 });
  });

  it('converges a constant 1.0 input to its DC gain (~1.0)', () => {
    const out = applyAntiAliasLP(new Float32Array(200).fill(1), createBiquadState());
    expect(Math.abs(out[out.length - 1] - 1)).toBeLessThan(0.01);
  });

  it('threads its state across a split so two halves equal one whole call', () => {
    const signal = new Float32Array(320);
    for (let i = 0; i < signal.length; i++) signal[i] = Math.sin(i * 0.1);

    const whole = applyAntiAliasLP(signal, createBiquadState());

    const state = createBiquadState();
    const first = applyAntiAliasLP(signal.subarray(0, 160), state);
    const second = applyAntiAliasLP(signal.subarray(160), state);

    expect([...first, ...second]).toEqual([...whole]);
  });
});
