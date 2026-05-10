// ════════════════════════════════════════
// Image preparation for vision-capable models (v2.3.18)
//
// Anthropic's API rejects any image whose base64 payload exceeds 5MB
// (5,242,880 bytes), and a single rejected request injures the agent.
// Phone photos (especially HEIC/JPEG from modern iPhones) routinely land
// at 6-12MB raw, which after base64 inflation blows the cap.
//
// Strategy: at injection time, check raw bytes against a safe threshold.
// If over budget, downscale + JPEG-recompress with macOS's built-in
// `sips` tool (no native npm dep). Cache the resized variant on disk
// next to the original so we only do the work once per upload — not on
// every turn. If sips fails or isn't available (non-macOS), fall back
// to the raw bytes; the API will still reject, but the agent error path
// already surfaces "image too large" to the user.
// ════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from '../logger.js';

const logger = createLogger('image-prep');

// Anthropic's hard cap is 5MB for the base64 payload. Base64 inflates by
// ~33%, so the raw-byte budget is ~3.93MB. Use 3.7MB as the trigger to
// leave headroom for JSON envelope overhead.
export const SAFE_RAW_BYTES = Math.floor(3.7 * 1024 * 1024);

// Vision tasks rarely benefit from raw 12MP detail. 2000px on the long
// side preserves enough fidelity for "what's in this picture", "read this
// receipt", or "describe this scene" while shedding the bulk of the bytes.
const MAX_LONG_SIDE = 2000;
const PRIMARY_QUALITY = 85;
const FALLBACK_QUALITY = 70;
// Last-resort: if even quality 70 at 2000px is still over budget (rare, but
// possible for very wide panoramas), downsize harder.
const LAST_RESORT_LONG_SIDE = 1400;
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

/**
 * Read an image and return a model-safe variant (under the 5MB base64 cap).
 * Returns null if the file can't be read or sips fails irrecoverably.
 *
 * Caches the resized variant as `<filePath>.modelsafe.jpg` so subsequent
 * reads are zero-cost. The cache is invalidated when the source file's
 * mtime advances past the cache's mtime.
 */
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

  // Under-budget passthrough — the common case, no work to do.
  if (originalSize <= SAFE_RAW_BYTES) {
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

  // Cache check: if we've already resized this exact file, reuse it.
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

  // Need to (re)build the cache. Try progressively more aggressive settings.
  const attempts: Array<{ longSide: number; quality: number }> = [
    { longSide: MAX_LONG_SIDE, quality: PRIMARY_QUALITY },
    { longSide: MAX_LONG_SIDE, quality: FALLBACK_QUALITY },
    { longSide: LAST_RESORT_LONG_SIDE, quality: LAST_RESORT_QUALITY },
  ];

  for (const attempt of attempts) {
    if (!runSips(filePath, cachePath, attempt.longSide, attempt.quality)) {
      // sips errored — abort the loop, no point retrying.
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

  // Even the most aggressive attempt didn't get under budget. Hand back
  // the raw bytes anyway — the API will reject and the user will see the
  // existing "image too large" error path. This is preferable to silently
  // skipping the image (the model would then hallucinate content).
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

function runSips(src: string, dest: string, longSide: number, quality: number): boolean {
  try {
    execFileSync(
      '/usr/bin/sips',
      [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(quality),
        '-Z', String(longSide), // resampleHeightWidthMax — preserves aspect ratio
        src,
        '--out', dest,
      ],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 },
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
  // HEIC, etc. — declare as JPEG since the bridge already converts those
  // on the way in (imessage-bridge.fetchImessageAttachments).
  return 'image/jpeg';
}

/** Format byte sizes for user-visible resize notes (e.g. "8.2 MB" / "780 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
