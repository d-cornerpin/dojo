// ════════════════════════════════════════
// Image preparation for vision-capable models (v2.3.18; v2.9.20 vision-
// context optimization)
//
// Two failure modes this module guards against:
//
//   1. **Anthropic 5 MB cap** (v2.3.18 — original purpose). The API
//      rejects any image whose base64 payload exceeds 5 MB
//      (5,242,880 bytes), and a single rejected request injures the
//      agent. Phone photos (HEIC/JPEG from modern iPhones) routinely
//      land at 6-12 MB raw, which after base64 inflation blows the cap.
//
//   2. **Vision-token context blowup** (v2.9.20 addition). Even when
//      the byte payload fits, an unshrunk 4032×3024 iPhone photo
//      consumes ~6,000 vision tokens per turn. A handful of those
//      in a conversation pushes the agent into compaction silently,
//      eating context the agent needs to track its task. Anthropic
//      explicitly says images larger than 1568 px on the long side
//      get server-side resized anyway, so doing it on our end loses
//      nothing for them and saves tokens on every subsequent retrieval.
//      Mike's 2026-06-06 vision-delegate incident traced back to this.
//
// Strategy: probe dimensions cheaply with `sips -g`. If either the
// byte budget is overshot OR the longest edge exceeds 1568 px, resize
// + JPEG-recompress via macOS's built-in `sips` (no native npm dep).
// Cache the variant on disk next to the original so we only do the
// work once per upload — not on every turn. If sips fails or isn't
// available (non-macOS), fall back to the raw bytes.
// ════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from '../logger.js';

const logger = createLogger('image-prep');

// Anthropic's hard cap is 5MB for the base64 payload. Base64 inflates by
// ~33%, so the raw-byte budget is ~3.93MB. Use 3.7MB as the trigger to
// leave headroom for JSON envelope overhead.
export const SAFE_RAW_BYTES = Math.floor(3.7 * 1024 * 1024);

// v2.9.20: Vision-context target. Anthropic's docs say images larger
// than this get resized server-side anyway. By shrinking BEFORE we
// send, we save ~75% of vision tokens per turn on a typical iPhone
// photo (4032 px → 1568 px is a 6.6x area reduction). For receipts
// or screenshots where small text matters, the original stays on
// disk and the agent can call file_read for the full-res bytes.
const VISION_LONG_SIDE = 1568;
const VISION_QUALITY = 80;

// Larger-than-VISION cascade for the byte-budget safety case. Used
// when 1568/q80 isn't enough to fit under the Anthropic 5 MB cap
// (rare; only triggers on huge panoramas or already-mangled JPEGs).
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

  // v2.9.20: probe dimensions. If longest edge ≤ VISION_LONG_SIDE AND
  // bytes ≤ SAFE_RAW_BYTES, the image is already context-friendly —
  // passthrough with no work to do. Probe failure (non-macOS, broken
  // file) skips the dimension check and falls back to byte-only logic.
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

  // Cache check: if we've already resized this exact file, reuse it.
  // Accept the cache as long as it was built AFTER the source's last
  // modification AND fits under the byte cap. (The cache is always
  // ≤ VISION_LONG_SIDE because we set that as the first cascade target.)
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

  // Need to (re)build the cache. First attempt targets the
  // vision-context budget; subsequent attempts cascade more
  // aggressively in case we're still over the byte cap.
  const attempts: Array<{ longSide: number; quality: number }> = [
    { longSide: VISION_LONG_SIDE, quality: VISION_QUALITY },
    { longSide: FALLBACK_LONG_SIDE, quality: FALLBACK_QUALITY },
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

/**
 * Probe an image's pixel dimensions via sips. Returns null on failure
 * (non-macOS, broken file, unsupported format). Cheap (~50-100 ms);
 * we only call this once per source path per turn.
 */
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
