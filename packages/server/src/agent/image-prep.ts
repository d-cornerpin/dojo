// Image preparation for vision-capable models. The API rejects a base64 payload over 5 MB
// and one rejected request injures the agent; past 1568 px on the long side Anthropic
// resizes server-side anyway, so a big photo costs vision tokens for nothing.
// Probe with `sips -g`, resize only when a bound is overshot, cache the variant beside the
// original, fall back to raw bytes where `sips` is missing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from '../logger.js';

const logger = createLogger('image-prep');

// Anthropic caps the base64 payload at 5 MB and base64 inflates ~33%, so the raw budget
// is ~3.93 MB; 3.7 MB leaves headroom for the JSON envelope.
export const SAFE_RAW_BYTES = Math.floor(3.7 * 1024 * 1024);

// Past 1568 px long side: Anthropic resizes server-side anyway; shrinking here saves vision tokens.
const VISION_LONG_SIDE = 1568;
const VISION_QUALITY = 80;

// Cascade for the rare case where 1568/q80 still misses the byte cap (huge panoramas).
const FALLBACK_LONG_SIDE = 1400;
const FALLBACK_QUALITY = 70;
const LAST_RESORT_LONG_SIDE = 1024;
const LAST_RESORT_QUALITY = 60;

export type ModelSafeMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export interface PreparedImage {
  data: Buffer;
  mediaType: ModelSafeMediaType;
  /** True if the bytes were downscaled/recompressed; false if raw passed through. */
  wasResized: boolean;
  /** True only when the resize ran THIS call (not a cache hit). Drives one-shot user notes. */
  freshlyResized: boolean;
  originalSize: number;
  finalSize: number;
}

/** Read an image and return a model-safe variant under the 5 MB base64 cap; null if the
 *  file can't be read or sips fails irrecoverably. The resized variant is cached as
 *  `<filePath>.modelsafe.jpg`; the cache goes stale when the source's mtime passes it. */
export function prepareImageForModel(
  filePath: string,
  mediaType: string,
): PreparedImage | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    logger.warn('image-prep: source file missing', {
      filePath, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const originalSize = stat.size;
  const declaredType = normalizeMediaType(mediaType);

  // Within both bounds: passthrough, no work. A probe failure skips the dimension check.
  const dims = probeImageDimensions(filePath);
  const longSidePx = dims ? Math.max(dims.width, dims.height) : null;
  const needsResizeForBytes = originalSize > SAFE_RAW_BYTES;
  const needsResizeForDims = longSidePx !== null && longSidePx > VISION_LONG_SIDE;

  if (!needsResizeForBytes && !needsResizeForDims) {
    let data: Buffer;
    try { data = fs.readFileSync(filePath); }
    catch { return null; }
    return {
      data,
      mediaType: declaredType,
      wasResized: false,
      freshlyResized: false,
      originalSize,
      finalSize: originalSize,
    };
  }

  // Accept a cache built AFTER the source's last edit that still fits the byte cap.
  const cachePath = `${filePath}.modelsafe.jpg`;
  let cacheStat: fs.Stats | null = null;
  try { cacheStat = fs.statSync(cachePath); } catch { /* no cache yet */ }
  if (cacheStat && cacheStat.mtimeMs >= stat.mtimeMs && cacheStat.size <= SAFE_RAW_BYTES) {
    let data: Buffer;
    try { data = fs.readFileSync(cachePath); }
    catch { return null; }
    return {
      data,
      mediaType: 'image/jpeg',
      wasResized: true,
      freshlyResized: false,
      originalSize,
      finalSize: cacheStat.size,
    };
  }

  // Rebuild: the first attempt targets the vision budget; later ones cascade harder.
  const attempts: Array<{ longSide: number; quality: number }> = [
    { longSide: VISION_LONG_SIDE, quality: VISION_QUALITY },
    { longSide: FALLBACK_LONG_SIDE, quality: FALLBACK_QUALITY },
    { longSide: LAST_RESORT_LONG_SIDE, quality: LAST_RESORT_QUALITY },
  ];

  for (const attempt of attempts) {
    if (!runSips(filePath, cachePath, attempt.longSide, attempt.quality)) {
      // sips errored: abort the loop, no point retrying.
      break;
    }
    let resizedStat: fs.Stats;
    try { resizedStat = fs.statSync(cachePath); } catch { continue; }
    if (resizedStat.size <= SAFE_RAW_BYTES) {
      let data: Buffer;
      try { data = fs.readFileSync(cachePath); }
      catch { return null; }
      logger.info('image-prep: image resized to fit model limit', {
        filePath,
        originalSize,
        finalSize: resizedStat.size,
        longSide: attempt.longSide,
        quality: attempt.quality,
      });
      return {
        data,
        mediaType: 'image/jpeg',
        wasResized: true,
        freshlyResized: true,
        originalSize,
        finalSize: resizedStat.size,
      };
    }
  }

  // Still over budget: hand back the raw bytes. The API rejects and the user sees the
  // existing "image too large" path, which beats silently dropping the image.
  logger.warn('image-prep: could not resize image under budget — returning raw bytes', {
    filePath, originalSize,
  });
  let raw: Buffer;
  try { raw = fs.readFileSync(filePath); }
  catch { return null; }
  return {
    data: raw,
    mediaType: declaredType,
    wasResized: false,
    freshlyResized: false,
    originalSize,
    finalSize: originalSize,
  };
}

/** Pixel dimensions via sips; null on failure (non-macOS, broken file, bad format).
 *  Cheap, so it is probed once per source path per turn. */
function probeImageDimensions(src: string): { width: number; height: number } | null {
  try {
    const out = execFileSync(
      '/usr/bin/sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', src],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    const wMatch = out.match(/pixelWidth:\s*(\d+)/);
    const hMatch = out.match(/pixelHeight:\s*(\d+)/);
    if (!wMatch || !hMatch) return null;
    return { width: Number(wMatch[1]), height: Number(hMatch[1]) };
  } catch {
    return null;
  }
}

// A conversion gets two minutes: a 100-megapixel source on a busy box legitimately needs
// minutes; the probe reads two fields, so its own short bound is not a flat timer.
const SIPS_CONVERT_CEILING_MS = 2 * 60_000;

function runSips(src: string, dest: string, longSide: number, quality: number): boolean {
  try {
    execFileSync(
      '/usr/bin/sips',
      [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(quality),
        '-Z', String(longSide), // resampleHeightWidthMax: preserves aspect ratio
        src,
        '--out', dest,
      ],
      // `sips` prints nothing until it is done: no progress to re-arm on, so a slow run is
      // invisible; the work is idempotent, so a generous ceiling costs a retry, not damage.
      { encoding: 'utf-8', stdio: 'pipe', timeout: SIPS_CONVERT_CEILING_MS },
    );
    return true;
  } catch (err) {
    logger.warn('image-prep: sips invocation failed', {
      src, dest, longSide, quality,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function normalizeMediaType(mt: string): ModelSafeMediaType {
  const lower = mt.toLowerCase();
  if (lower === 'image/jpg' || lower === 'image/jpeg') return 'image/jpeg';
  if (lower === 'image/png') return 'image/png';
  if (lower === 'image/gif') return 'image/gif';
  if (lower === 'image/webp') return 'image/webp';
  // HEIC etc.: declare as JPEG, the bridge already converts those on the way in
  // (imessage-bridge.fetchImessageAttachments).
  return 'image/jpeg';
}

/** Format byte sizes for user-visible resize notes (e.g. "8.2 MB" / "780 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
