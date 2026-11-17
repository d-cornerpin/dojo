// TTS service (branch v35): WAV encoding, clause queue, voice list, model load/retry.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';

// The module does real work at import (it creates KOKORO_CACHE_DIR and sets
// transformers settings), so we mock its four deps before importing it and
// point the cache dir at a temp path that afterAll() removes.
const t = vi.hoisted(() => ({
  dir: (process.env.TMPDIR ?? '/tmp') + '/tts-test-' + process.pid,
  from: undefined as unknown,
  custom: [] as unknown[],
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: (...a: unknown[]) => (t.from as (...x: unknown[]) => unknown)(...a),
  },
  TextSplitterStream: class {},
}));
vi.mock('@huggingface/transformers', () => ({ env: {} }));
vi.mock('../model-manager.js', () => ({
  KOKORO_MODEL_ID: 'm',
  KOKORO_CACHE_DIR: t.dir,
  ensureKokoroFiles: vi.fn(),
  isKokoroFullyDownloaded: () => true,
}));
vi.mock('../custom-voices.js', () => ({
  listCustomVoices: () => t.custom,
  installCustomVoicePatch: vi.fn(async () => undefined),
}));

import { pcmFloatToWav, ClauseQueue, createClauseQueue, listVoices } from '../tts-service.js';

beforeEach(() => {
  t.custom = [];
});

afterAll(() => {
  fs.rmSync(t.dir, { recursive: true, force: true });
});

describe('pcmFloatToWav', () => {
  it('encodes a 16-bit PCM WAV header and clamps samples beyond +/-1', () => {
    const buf = pcmFloatToWav(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]), 24000);
    expect(buf.length).toBe(58);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(buf.subarray(36, 40).toString('ascii')).toBe('data');
    expect(buf.readUInt32LE(4)).toBe(50); // 36 + dataSize
    expect(buf.readUInt32LE(16)).toBe(16);
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(24000);
    expect(buf.readUInt32LE(28)).toBe(48000); // sampleRate * 2
    expect(buf.readUInt16LE(32)).toBe(2); // block align
    expect(buf.readUInt16LE(34)).toBe(16); // bits per sample
    expect(buf.readUInt32LE(40)).toBe(14); // dataSize
    const samples: number[] = [];
    for (let i = 44; i < buf.length; i += 2) samples.push(buf.readInt16LE(i));
    expect(samples).toEqual([0, 32767, -32768, 16383, -16384, 32767, -32768]);
  });

  it('encodes an empty PCM buffer as a header-only WAV', () => {
    const buf = pcmFloatToWav(new Float32Array([]), 16000);
    expect(buf.length).toBe(44);
    expect(buf.readUInt32LE(40)).toBe(0);
  });
});

describe('ClauseQueue', () => {
  it('trims empty clauses and yields only the non-empty ones', async () => {
    const q = createClauseQueue();
    q.push('  a ', '', '   ', 'b');
    const got: string[] = [];
    const consumer = (async () => { for await (const c of q) got.push(c); })();
    q.close();
    q.close(); // idempotent — must not throw
    await consumer;
    expect(got).toEqual(['a', 'b']);
  });

  it('a waiting consumer is woken by push and ends on close', async () => {
    const q = createClauseQueue();
    const got: string[] = [];
    const consumer = (async () => { for await (const c of q) got.push(c); })();
    q.push('one');
    await new Promise((r) => setTimeout(r, 0));
    q.push(' two ');
    q.close();
    await consumer;
    expect(got).toEqual(['one', 'two']);
  });

  it('a consumer waiting on an empty queue ends after close()', async () => {
    const q = createClauseQueue();
    const got: string[] = [];
    const consumer = (async () => { for await (const c of q) got.push(c); })();
    await new Promise((r) => setTimeout(r, 0));
    q.close();
    await consumer;
    expect(got).toEqual([]);
  });

  it('createClauseQueue returns a ClauseQueue instance', () => {
    expect(createClauseQueue()).toBeInstanceOf(ClauseQueue);
  });
});

describe('listVoices', () => {
  it('lists 28 built-in voices with no custom entries', () => {
    const voices = listVoices();
    expect(voices.length).toBe(28);
    expect(voices[0]).toEqual({ id: 'af_heart', name: 'Heart', language: 'en-us', gender: 'Female' });
    const fable = voices.find((v) => v.id === 'bm_fable')!;
    expect(fable.language).toBe('en-gb');
    expect(fable.gender).toBe('Male');
    expect(new Set(voices.map((v) => v.id)).size).toBe(voices.length);
    expect(voices.every((v) => !('custom' in v))).toBe(true);
  });

  it('appends custom voices with a custom flag', () => {
    t.custom = [{ id: 'am_mine', name: 'Mine', language: 'en-us', gender: 'Male' }];
    const voices = listVoices();
    expect(voices.length).toBe(29);
    expect(voices[voices.length - 1]).toEqual({
      id: 'am_mine',
      name: 'Mine',
      language: 'en-us',
      gender: 'Male',
      custom: true,
    });
  });
});

describe('loadKokoro', () => {
  it('caches the loaded model across calls', async () => {
    t.from = vi.fn(async () => ({ id: 'tts' }));
    vi.resetModules();
    const svc = await import('../tts-service.js');
    const a = svc.loadKokoro();
    const b = svc.loadKokoro();
    expect(a).toBe(b);
    expect(t.from).toHaveBeenCalledTimes(1);
    expect(svc.isKokoroLoaded()).toBe(true);
    await a;
  });

  it('drops a failed load so the next call retries', async () => {
    let calls = 0;
    t.from = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('net');
      return { id: 'tts2' };
    });
    vi.resetModules();
    const svc = await import('../tts-service.js');
    await expect(svc.loadKokoro()).rejects.toThrow('net');
    await Promise.resolve();
    expect(svc.isKokoroLoaded()).toBe(false);
    await expect(svc.loadKokoro()).resolves.toEqual({ id: 'tts2' });
    expect(t.from).toHaveBeenCalledTimes(2);
  });
});

describe('synthesizeClauseStream', () => {
  it('yields one chunk per clause', async () => {
    const generate = vi.fn(async () => ({ audio: new Float32Array([0.1]), sampling_rate: 24000 }));
    t.from = vi.fn(async () => ({ id: 'tts', generate }));
    vi.resetModules();
    const svc = await import('../tts-service.js');
    const q = svc.createClauseQueue();
    q.push('a', 'b');
    q.close();
    const chunks: svc.TtsChunk[] = [];
    for await (const c of svc.synthesizeClauseStream(q)) chunks.push(c);
    expect(chunks.map((c) => c.text)).toEqual(['a', 'b']);
    expect(chunks.every((c) => c.sampleRate === 24000)).toBe(true);
    expect(chunks.every((c) => c.pcm.length === 1)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('yields nothing and never generates when aborted before iterating', async () => {
    const generate = vi.fn(async () => ({ audio: new Float32Array([0.1]), sampling_rate: 24000 }));
    t.from = vi.fn(async () => ({ id: 'tts', generate }));
    vi.resetModules();
    const svc = await import('../tts-service.js');
    const q = svc.createClauseQueue();
    q.push('a');
    q.close();
    const ac = new AbortController();
    ac.abort();
    const chunks: svc.TtsChunk[] = [];
    for await (const c of svc.synthesizeClauseStream(q, svc.DEFAULT_VOICE, 1, ac.signal)) chunks.push(c);
    expect(chunks).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});
