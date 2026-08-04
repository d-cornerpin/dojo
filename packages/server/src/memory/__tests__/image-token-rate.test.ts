// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T4-CAP — AN IMAGE IS BILLED BY ITS PIXELS, NOT BY ITS BASE64. Written RED-first.
//
// ── WHAT WAS WRONG, and how it reached a user ───────────────────────────────────────────
// `messageTokens` billed every content block through `estimateTokens(JSON.stringify(...))`,
// so an image block's cost was the length of its base64 payload divided by 4. Providers do
// not charge for base64 length. The fallback vision captioner's own hand-built payload —
// ONE image plus three sentences — therefore measured **185,178 tokens against budgets of
// 170,071–179,553** and C11 threw at `assembly-validation.ts:449` BEFORE the provider was
// ever asked. The agent then told its owner "I couldn't read the photo — my vision pipeline
// hit an error" (`DOJO-ISSUES-LOG.md`, `behav-sig:360ba8e3`), which was true only because
// the platform refused to send a request the provider would have answered for ~258 tokens.
// Nine of those refusals are on the platform's own durable record —
// `~/.dojo/logs/assembly-validation.jsonl`, 2026-08-01 → 2026-08-03, `tokenTotal` 185,178
// on every one.
//
// ── THE MEASUREMENT (the numbers below are receipts, not recollection) ───────────────────
// 2026-08-04, driven on the dev box: **64 image calls + 20 text-only controls = 84 provider
// receipts**, across **5 models / 2 providers** — `google/gemini-2.5-flash-image`,
// `google/gemini-3.1-flash-image-preview`, `qwen/qwen3.5-9b`, `~moonshotai/kimi-latest`
// (OpenRouter) and `gemma4:31b` (ollama-local). Each call replayed `captionOne`'s exact
// payload with ONE synthetic PNG of known dimensions; the image's own bill is the call's
// provider-reported `input_tokens` minus the text-only control's. Receipts:
// `~/.dojo/receipts/t4cap-image-token-measurement/` and `cost_records` on the dev body,
// where `estimated_input_tokens` (ours) and `input_tokens` (theirs) sit side by side.
//
//   BYTES DO NOT MOVE THE BILL. Nine flat-vs-noise pairs at IDENTICAL dimensions, byte
//   ratios up to 346x: the largest provider token delta across all nine was **3**.
//   That single fact is the whole defect — the estimator was billing the one dimension
//   providers ignore.
//
//   PIXELS DO. Steepest measured slope **1,408 tokens/megapixel** (kimi @ 512x512).
//   Smallest per-image bill anywhere is bounded below by **258** (both Gemini models bill
//   a flat 258 at every size from 64x64 to 1536x1536). Largest bill ever measured is
//   **16,387** (qwen @ 4096x4096 and above — every provider downscales past its own
//   working resolution, so the curve stops climbing).
//
// The law is those three measured numbers and nothing else, and it is chosen to never
// UNDER-bill: an estimator that under-bills lets the allocator admit an assembly the
// provider will refuse, which is the failure C11 exists to prevent. Verified against all
// 64 measurements — 0 under-billed, two of them exactly ON the bound.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import type Anthropic from '@anthropic-ai/sdk';
import {
  IMAGE_TOKENS_PER_MEGAPIXEL,
  IMAGE_TOKEN_FLOOR,
  IMAGE_TOKEN_CEILING,
  estimateImageTokens,
  imagePixelDimensions,
} from '../budget.js';
import { messageTokens, renderTokens } from '../lanes.js';

// ── a PNG of exact dimensions, with entropy we control ──────────────────────────────────
// `flat` compresses to almost nothing, `noise` does not. Same pixels, wildly different
// bytes — which is the only way to assert that bytes are not what is billed.
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, mode: 'flat' | 'noise'): Buffer {
  let seed = 1;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const o = rowStart + 1 + x * 3;
      if (mode === 'flat') { raw[o] = 40; raw[o + 1] = 90; raw[o + 2] = 160; }
      else { raw[o] = rnd(); raw[o + 1] = rnd(); raw[o + 2] = rnd(); }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(raw, { level: mode === 'flat' ? 9 : 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const imageBlock = (buf: Buffer): Anthropic.ContentBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
});

// ── THE MEASURED CORPUS ─────────────────────────────────────────────────────────────────
// Every row is a real receipt: `provider` is the HIGHEST `input_tokens − control` any of the
// five models reported for that size. The estimator may sit above these; it may never sit
// below one.
const MEASURED: Array<{ w: number; h: number; provider: number; who: string }> = [
  { w: 64, h: 64, provider: 258, who: 'gemini-2.5-flash-image / gemini-3.1-flash-image-preview' },
  { w: 256, h: 256, provider: 258, who: 'gemini-2.5-flash-image / gemini-3.1-flash-image-preview' },
  { w: 512, h: 512, provider: 369, who: 'kimi-latest' },
  { w: 896, h: 448, provider: 523, who: 'kimi-latest' },
  { w: 1024, h: 1024, provider: 1379, who: 'kimi-latest' },
  { w: 1536, h: 1536, provider: 3035, who: 'kimi-latest' },
  { w: 2048, h: 2048, provider: 5486, who: 'kimi-latest' },
  { w: 3072, h: 3072, provider: 11674, who: 'kimi-latest' },
  { w: 4096, h: 4096, provider: 16387, who: 'qwen3.5-9b' },
  { w: 6144, h: 6144, provider: 16387, who: 'qwen3.5-9b' },
  { w: 8192, h: 8192, provider: 16387, who: 'qwen3.5-9b' },
];

describe('the image-token rate is MEASURED', () => {
  it('carries the three numbers the receipts produced, and only those', () => {
    expect(IMAGE_TOKENS_PER_MEGAPIXEL).toBe(1408);  // steepest slope seen: kimi @ 512x512
    expect(IMAGE_TOKEN_FLOOR).toBe(258);            // both Gemini models, flat at every size
    expect(IMAGE_TOKEN_CEILING).toBe(16387);        // qwen @ >=4096x4096; the curve stops here
  });

  it('never bills an image BELOW what a provider was measured to charge for it', () => {
    const under = MEASURED
      .map((m) => ({ ...m, estimate: estimateImageTokens(m.w, m.h) }))
      .filter((m) => m.estimate < m.provider);
    expect(
      under,
      'the estimator under-bills a size a provider was MEASURED to charge more for. An ' +
      'under-billing estimator lets the allocator admit an assembly the provider refuses — ' +
      'the exact failure C11 exists to prevent. Re-measure before changing a constant.',
    ).toEqual([]);
  });

  it('stops climbing at the measured ceiling — providers downscale, so the estimate must too', () => {
    // 8192x8192 is 67 megapixels; the slope alone would claim 94,489 tokens for an image
    // every measured provider billed at most 16,387 for. An estimator that kept climbing
    // would refuse assemblies the provider would have answered.
    expect(estimateImageTokens(8192, 8192)).toBe(IMAGE_TOKEN_CEILING);
    expect(estimateImageTokens(20000, 20000)).toBe(IMAGE_TOKEN_CEILING);
  });

  it('never bills an image below the floor, however tiny', () => {
    expect(estimateImageTokens(1, 1)).toBe(IMAGE_TOKEN_FLOOR);
    expect(estimateImageTokens(64, 64)).toBe(IMAGE_TOKEN_FLOOR);
  });

  it('reads dimensions out of the bytes for the formats a provider will accept', () => {
    expect(imagePixelDimensions(png(320, 240, 'flat'))).toEqual({ width: 320, height: 240 });
    // JPEG: SOFn, height before width. Hand-built minimal header.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xf4,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imagePixelDimensions(jpeg)).toEqual({ width: 500, height: 300 });
    expect(imagePixelDimensions(Buffer.from('not an image at all'))).toBeNull();
  });
});

describe('messageTokens bills an image block by its pixels', () => {
  it('gives the SAME answer for the same image at 100x the byte size', () => {
    // This is the defect in one clause. 256x256 flat is ~570 bytes; 256x256 noise is
    // ~197,000. Measured, five models billed the two identically (max delta 3 tokens).
    // Before the fix these differed by 65,463 estimated tokens.
    const flat = messageTokens({ role: 'user', content: [imageBlock(png(256, 256, 'flat'))] });
    const noise = messageTokens({ role: 'user', content: [imageBlock(png(256, 256, 'noise'))] });
    expect(noise).toBe(flat);
  });

  it("does not bill the captioner's own payload out of its own budget", () => {
    // The recorded red, reproduced in miniature: `captionOne`'s literal array is ONE image
    // block plus one three-sentence text block. At 1568x1568 — the long side the platform's
    // own rectifier downscales attachments to (`agent/image-prep.ts:48`) — the assembly
    // measured 185,178 tokens against a ~173,000 budget and C11 threw. The pixels say
    // ~3,461.
    const caption = {
      role: 'user' as const,
      content: [
        imageBlock(png(1568, 1568, 'noise')),
        { type: 'text' as const, text: 'Describe this image in detail. '.repeat(10) },
      ] as Anthropic.ContentBlockParam[],
    };
    const cost = messageTokens(caption);
    expect(cost).toBeLessThan(5_000);
    expect(cost).toBeGreaterThan(IMAGE_TOKEN_FLOOR);
  });

  it('bills an image the estimator cannot size at the measured ceiling, never at nothing', () => {
    // A url-source block carries no bytes, so today it costs ~30 tokens while the provider
    // bills 258 upward — the SAME defect pointing the other way, and the direction that
    // ships an over-budget request instead of refusing one. Unsizable means "assume the
    // most any image was measured to cost", because guessing lower is guessing.
    const url = messageTokens({
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }] as Anthropic.ContentBlockParam[],
    });
    expect(url).toBeGreaterThanOrEqual(IMAGE_TOKEN_CEILING);
    const undecodable = messageTokens({
      role: 'user',
      content: [imageBlock(Buffer.from('this is not an image'))],
    });
    expect(undecodable).toBeGreaterThanOrEqual(IMAGE_TOKEN_CEILING);
  });

  it('still counts the text that rides beside the image', () => {
    const withText = messageTokens({
      role: 'user',
      content: [imageBlock(png(64, 64, 'flat')), { type: 'text', text: 'x'.repeat(4000) }] as Anthropic.ContentBlockParam[],
    });
    const withoutText = messageTokens({
      role: 'user',
      content: [imageBlock(png(64, 64, 'flat'))],
    });
    expect(withText - withoutText).toBeGreaterThanOrEqual(1000);
  });
});

describe('everything that carries no image is billed EXACTLY as before', () => {
  // The load-bearing clause for the other four readers and for both reference files.
  // `messageTokens` has five production readers and four of them are the allocator's own
  // budget accounting, so a change that moved image-free arithmetic by one token would
  // change what the allocator admits on every turn on the platform. Neither golden carries
  // an image block (`grep -c base64` = 0 on both) and neither do any of the dev body's
  // 23,101 stored messages — so image-free MUST mean unchanged, by construction and not by
  // observation.
  const CHARS = 4;
  it('a string message is its characters over four, unchanged', () => {
    const s = 'a'.repeat(4001);
    expect(messageTokens({ role: 'user', content: s })).toBe(Math.ceil(s.length / CHARS));
  });

  it('a block array with no image block is its JSON over four, unchanged', () => {
    const content = [
      { type: 'text' as const, text: 'hello there' },
      { type: 'text' as const, text: 'and again' },
    ] as Anthropic.ContentBlockParam[];
    expect(messageTokens({ role: 'user', content }))
      .toBe(Math.ceil(JSON.stringify(content).length / CHARS));
  });

  it('a tool_result block array with no image is its JSON over four, unchanged', () => {
    const content = [
      { type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'the result text' },
    ] as Anthropic.ContentBlockParam[];
    expect(messageTokens({ role: 'user', content }))
      .toBe(Math.ceil(JSON.stringify(content).length / CHARS));
  });

  it('renderTokens over image-free messages is the sum, unchanged', () => {
    const msgs = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'two' }] as Anthropic.ContentBlockParam[] },
    ];
    expect(renderTokens(msgs)).toBe(
      Math.ceil(3 / CHARS) + Math.ceil(JSON.stringify(msgs[1].content).length / CHARS),
    );
  });
});
