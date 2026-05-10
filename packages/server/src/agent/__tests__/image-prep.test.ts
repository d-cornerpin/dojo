// v2.3.18 — image-prep tests. Covers the cheap, deterministic paths
// (under-budget passthrough, missing file, formatBytes). The actual resize
// path depends on /usr/bin/sips and a real over-budget JPEG; that's
// validated in prod use rather than here, since synthesizing a >3.7MB
// JPEG of noise inside a test is more apparatus than the boundary deserves.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareImageForModel, formatBytes, SAFE_RAW_BYTES } from '../image-prep.js';

// 67-byte 1x1 transparent PNG — same fixture inject-attachments uses.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-prep-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('prepareImageForModel', () => {
  it('passes through a small image under the size budget', () => {
    const p = path.join(tmpDir, 'tiny.png');
    fs.writeFileSync(p, TINY_PNG);
    const result = prepareImageForModel(p, 'image/png');
    expect(result).not.toBeNull();
    expect(result!.wasResized).toBe(false);
    expect(result!.freshlyResized).toBe(false);
    expect(result!.mediaType).toBe('image/png');
    expect(result!.data.length).toBe(TINY_PNG.length);
    expect(result!.originalSize).toBeLessThan(SAFE_RAW_BYTES);
  });

  it('normalizes unusual media types to canonical strings', () => {
    const p = path.join(tmpDir, 'tiny.jpg');
    fs.writeFileSync(p, TINY_PNG); // bytes are PNG but the media type lookup is what we check
    const result = prepareImageForModel(p, 'image/JPG');
    expect(result!.mediaType).toBe('image/jpeg');
  });

  it('declares HEIC as JPEG (the bridge converts on the way in)', () => {
    const p = path.join(tmpDir, 'photo.heic');
    fs.writeFileSync(p, TINY_PNG);
    const result = prepareImageForModel(p, 'image/heic');
    expect(result!.mediaType).toBe('image/jpeg');
  });

  it('returns null when the source file does not exist', () => {
    const result = prepareImageForModel(path.join(tmpDir, 'nope.jpg'), 'image/jpeg');
    expect(result).toBeNull();
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats kilobytes (no decimal — phone-photo scale)', () => {
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(786 * 1024)).toBe('786 KB');
  });

  it('formats megabytes with one decimal (matches user-visible note)', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(8.2 * 1024 * 1024)).toBe('8.2 MB');
  });
});
