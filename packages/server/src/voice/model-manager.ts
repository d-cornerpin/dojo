import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';

const logger = createLogger('voice-models');

export const VOICE_ROOT = path.join(os.homedir(), '.dojo', 'voice');
export const MODELS_DIR = path.join(VOICE_ROOT, 'models');
/**
 * Where @huggingface/transformers (used by kokoro-js) caches its model files.
 * We pin this to a stable path we control instead of letting the library
 * default to `node_modules/@huggingface/transformers/.cache/`, which gets
 * wiped on every `npm install`. tts-service.ts assigns this to
 * `transformersEnv.cacheDir` at import time.
 */
export const KOKORO_CACHE_DIR = path.join(VOICE_ROOT, 'kokoro');
/** Legacy locations checked as a fallback so existing installs aren't forced to re-download. */
const KOKORO_LEGACY_HF_CACHE = path.join(os.homedir(), '.cache', 'huggingface');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const KOKORO_LEGACY_NODE_MODULES_CACHE = path.join(repoRoot, 'node_modules/@huggingface/transformers/.cache');

export type WhisperSize = 'base.en' | 'small.en' | 'medium.en' | 'large-v3-turbo';

interface WhisperSpec {
  size: WhisperSize;
  filename: string;
  url: string;
  approxBytes: number;
  label: string;
}

export const WHISPER_MODELS: Record<WhisperSize, WhisperSpec> = {
  'base.en': {
    size: 'base.en',
    filename: 'ggml-base.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    approxBytes: 147_964_211,
    label: 'Base (English only, fast, lower quality)',
  },
  'small.en': {
    size: 'small.en',
    filename: 'ggml-small.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    approxBytes: 487_601_967,
    label: 'Small (English only)',
  },
  'medium.en': {
    size: 'medium.en',
    filename: 'ggml-medium.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
    approxBytes: 1_533_763_059,
    label: 'Medium (English only)',
  },
  'large-v3-turbo': {
    size: 'large-v3-turbo',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    approxBytes: 574_041_193,
    label: 'Large v3 Turbo (multilingual, best quality, default)',
  },
};

export const DEFAULT_WHISPER: WhisperSize = 'large-v3-turbo';

/** Kokoro is loaded via kokoro-js which caches under HF cache. */
export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// ── Moonshine (STT) ──
// Runs through @huggingface/transformers, same runtime as Kokoro. The
// transformers cache bug documented above bites Moonshine identically, so we
// reuse the direct-download workaround: pull every required file directly
// from the HF resolve URLs into MOONSHINE_CACHE_DIR, then point
// env.localModelPath at the cache and disable remote fetches so the
// local-file branch fires.

export const MOONSHINE_CACHE_DIR = path.join(VOICE_ROOT, 'moonshine');
export const MOONSHINE_MODEL_ID = 'onnx-community/moonshine-base-ONNX';

export type MoonshineSize = 'base';

/**
 * Files the transformers.js automatic-speech-recognition pipeline needs for
 * Moonshine at dtype='q8'. With dtype='q8' transformers appends `_quantized`
 * to the encoder/decoder onnx filenames. The "merged" decoder bundles the
 * with-past variant so a single session handles both initial and
 * incremental decoding.
 *
 * Byte counts pulled from the HF API tree on 2026-06-02. They're a hint
 * for progress estimation — the actual content-length header overrides
 * them when present.
 */
const MOONSHINE_REQUIRED_FILES: Array<{ path: string; approxBytes: number }> = [
  { path: 'config.json',                              approxBytes: 922 },
  { path: 'generation_config.json',                   approxBytes: 147 },
  { path: 'preprocessor_config.json',                 approxBytes: 128 },
  { path: 'special_tokens_map.json',                  approxBytes: 3 },
  { path: 'tokenizer.json',                           approxBytes: 3_761_754 },
  { path: 'tokenizer_config.json',                    approxBytes: 135_735 },
  { path: 'onnx/encoder_model_quantized.onnx',         approxBytes: 20_513_063 },
  { path: 'onnx/decoder_model_merged_quantized.onnx',  approxBytes: 42_498_870 },
];

export function moonshineLocalDir(): string {
  return path.join(MOONSHINE_CACHE_DIR, 'onnx-community', 'moonshine-base-ONNX');
}

export function isMoonshineFullyDownloaded(): boolean {
  const base = moonshineLocalDir();
  return MOONSHINE_REQUIRED_FILES.every((f) => {
    try { return fs.statSync(path.join(base, f.path)).size > 0; } catch { return false; }
  });
}

export function moonshineCacheBytes(): number {
  return dirSizeSync(moonshineLocalDir());
}

/**
 * The complete set of files Kokoro's `style_text_to_speech_2` config needs.
 * We download these directly (bypassing transformers.js's broken cache layer
 * — see tts-service.ts for context) and place them in KOKORO_CACHE_DIR. With
 * `env.localModelPath` pointed at the cache dir, transformers reads them
 * locally and never touches its own cache.put/match path.
 */
const KOKORO_REQUIRED_FILES: Array<{ path: string; approxBytes: number }> = [
  { path: 'config.json',              approxBytes: 50 },
  { path: 'tokenizer_config.json',    approxBytes: 120 },
  { path: 'tokenizer.json',           approxBytes: 50_000 },
  { path: 'onnx/model_quantized.onnx', approxBytes: 92_361_116 },
];

export function kokoroLocalDir(): string {
  return path.join(KOKORO_CACHE_DIR, 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
}

/** All required files present + non-empty. */
export function isKokoroFullyDownloaded(): boolean {
  const base = kokoroLocalDir();
  return KOKORO_REQUIRED_FILES.every((f) => {
    try {
      return fs.statSync(path.join(base, f.path)).size > 0;
    } catch { return false; }
  });
}

export interface DownloadProgress {
  kind: 'whisper' | 'kokoro' | 'moonshine';
  modelId: string;
  bytesDownloaded: number;
  bytesTotal: number;
}

export type ProgressCallback = (p: DownloadProgress) => void;

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function whisperPath(size: WhisperSize): string {
  return path.join(MODELS_DIR, WHISPER_MODELS[size].filename);
}

export function isWhisperInstalled(size: WhisperSize): boolean {
  try {
    const stat = fs.statSync(whisperPath(size));
    return stat.size > 0;
  } catch {
    return false;
  }
}

export async function ensureWhisperModel(
  size: WhisperSize,
  onProgress?: ProgressCallback,
): Promise<string> {
  await ensureDir(MODELS_DIR);
  const dest = whisperPath(size);
  if (isWhisperInstalled(size)) {
    return dest;
  }

  const spec = WHISPER_MODELS[size];
  logger.info('Downloading whisper model', { size, url: spec.url, dest });

  const tmp = dest + '.partial';
  // Clean any prior partial download so we don't resume into corrupt bytes.
  try { await fsp.unlink(tmp); } catch { /* ignore */ }

  const res = await fetch(spec.url);
  if (!res.ok || !res.body) {
    throw new Error(`whisper download failed: ${res.status} ${res.statusText}`);
  }

  const totalHeader = res.headers.get('content-length');
  const bytesTotal = totalHeader ? Number(totalHeader) : spec.approxBytes;

  const reader = res.body.getReader();
  const writer = fs.createWriteStream(tmp);

  let bytesDownloaded = 0;
  let lastReport = 0;
  const REPORT_EVERY = 512 * 1024; // throttle progress to once per 512KB

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(Buffer.from(value));
      bytesDownloaded += value.byteLength;
      if (onProgress && bytesDownloaded - lastReport >= REPORT_EVERY) {
        lastReport = bytesDownloaded;
        onProgress({ kind: 'whisper', modelId: size, bytesDownloaded, bytesTotal });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  await fsp.rename(tmp, dest);
  if (onProgress) {
    onProgress({ kind: 'whisper', modelId: size, bytesDownloaded, bytesTotal: bytesDownloaded });
  }
  logger.info('Whisper model downloaded', { size, bytes: bytesDownloaded });
  return dest;
}

export interface InstalledModelInfo {
  kind: 'whisper' | 'kokoro' | 'moonshine';
  id: string;
  filename: string;
  bytes: number;
  installed: boolean;
}

export function listInstalledModels(): InstalledModelInfo[] {
  const out: InstalledModelInfo[] = [];

  for (const size of Object.keys(WHISPER_MODELS) as WhisperSize[]) {
    const p = whisperPath(size);
    let bytes = 0;
    let installed = false;
    try {
      const stat = fs.statSync(p);
      bytes = stat.size;
      installed = bytes > 0;
    } catch { /* not installed */ }
    out.push({
      kind: 'whisper',
      id: size,
      filename: WHISPER_MODELS[size].filename,
      bytes,
      installed,
    });
  }

  // Kokoro lives in the HF transformers cache. Best-effort size lookup.
  out.push({
    kind: 'kokoro',
    id: KOKORO_MODEL_ID,
    filename: KOKORO_MODEL_ID,
    bytes: kokoroCacheBytes(),
    installed: isKokoroCached(),
  });

  // Moonshine — same dual-file pattern as Kokoro (transformers.js cache bug
  // workaround). The "installed" check is the canonical "every required file
  // present", with cache size as a soft signal for partial-download states.
  out.push({
    kind: 'moonshine',
    id: MOONSHINE_MODEL_ID,
    filename: MOONSHINE_MODEL_ID,
    bytes: moonshineCacheBytes(),
    installed: isMoonshineFullyDownloaded(),
  });

  return out;
}

/** All locations the Kokoro model files might live, in preference order. */
function kokoroCachePaths(): string[] {
  return [
    kokoroLocalDir(),
    path.join(KOKORO_LEGACY_NODE_MODULES_CACHE, 'onnx-community', 'Kokoro-82M-v1.0-ONNX'),
    path.join(KOKORO_LEGACY_HF_CACHE, 'hub', 'models--onnx-community--Kokoro-82M-v1.0-ONNX'),
  ];
}

export function isKokoroCached(): boolean {
  // The authoritative "installed" check: every required file exists in our
  // pinned local dir. Legacy paths still get a size-based fallback so old
  // installs continue to show as installed until migration moves them.
  if (isKokoroFullyDownloaded()) return true;
  return kokoroCachePaths().slice(1).some((p) => {
    try { return fs.existsSync(p) && dirSizeSync(p) > 1024 * 1024; }
    catch { return false; }
  });
}

/**
 * Generic direct-download for transformers.js model files. Mirrors what
 * `ensureKokoroFiles` did for Kokoro and `ensureMoonshineFiles` does for
 * Moonshine — both bypass the @huggingface/transformers cache layer
 * (cache.put writes but cache.match returns undefined in our dev-server
 * context) by writing files directly into a pinned local dir and pointing
 * env.localModelPath at it.
 *
 * Idempotent: skips files already on disk with non-zero size. Streams
 * downloads through .partial then renames so a crashed download never
 * leaves a half-written file that future calls would skip.
 */
async function ensureModelFiles(
  kind: 'kokoro' | 'moonshine',
  modelId: string,
  baseDir: string,
  requiredFiles: Array<{ path: string; approxBytes: number }>,
  onProgress?: ProgressCallback,
): Promise<void> {
  await ensureDir(baseDir);

  const filesToFetch: Array<{ path: string; dest: string; approxBytes: number }> = [];
  let totalBytes = 0;
  let alreadyHave = 0;
  for (const f of requiredFiles) {
    const dest = path.join(baseDir, f.path);
    let onDisk = 0;
    try { onDisk = fs.statSync(dest).size; } catch { /* missing */ }
    totalBytes += Math.max(onDisk, f.approxBytes);
    if (onDisk > 0) {
      alreadyHave += onDisk;
    } else {
      filesToFetch.push({ path: f.path, dest, approxBytes: f.approxBytes });
    }
  }

  if (filesToFetch.length === 0) {
    onProgress?.({ kind, modelId, bytesDownloaded: totalBytes, bytesTotal: totalBytes });
    return;
  }

  let runningBytes = alreadyHave;
  onProgress?.({ kind, modelId, bytesDownloaded: runningBytes, bytesTotal: totalBytes });

  for (const file of filesToFetch) {
    const url = `https://huggingface.co/${modelId}/resolve/main/${file.path}`;
    const tmp = file.dest + '.partial';
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    await ensureDir(path.dirname(file.dest));

    logger.info(`Downloading ${kind} file`, { file: file.path, url });
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`${kind} file download failed (${file.path}): HTTP ${res.status} ${res.statusText}`);
    }

    const cl = res.headers.get('content-length');
    if (cl) {
      const actualBytes = Number(cl);
      if (Number.isFinite(actualBytes) && actualBytes > 0) {
        totalBytes = totalBytes - file.approxBytes + actualBytes;
      }
    }

    const reader = res.body.getReader();
    const writer = fs.createWriteStream(tmp);
    let lastReport = runningBytes;
    const REPORT_EVERY = 256 * 1024;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise<void>((resolve, reject) => {
          writer.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
        runningBytes += value.byteLength;
        if (onProgress && runningBytes - lastReport >= REPORT_EVERY) {
          lastReport = runningBytes;
          onProgress({ kind, modelId, bytesDownloaded: Math.min(runningBytes, totalBytes), bytesTotal: totalBytes });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }

    await fsp.rename(tmp, file.dest);
    logger.info(`${kind} file written`, { file: file.path });
  }

  onProgress?.({ kind, modelId, bytesDownloaded: totalBytes, bytesTotal: totalBytes });
}

/**
 * Download every required Kokoro file directly into KOKORO_CACHE_DIR. Bypasses
 * the @huggingface/transformers cache layer entirely — that layer has a
 * reproducible bug in our dev-server context where cache.put writes but
 * cache.match returns undefined ("Unable to get model file path or buffer.").
 *
 * Idempotent: skips files that are already on disk with non-zero size.
 * Streams downloads through a .partial file then renames so a crashed
 * download never leaves a half-written file that future calls would skip.
 */
export async function ensureKokoroFiles(onProgress?: ProgressCallback): Promise<void> {
  const base = kokoroLocalDir();
  await ensureDir(base);

  // First pass — figure out total bytes we still need to download so progress
  // is in real bytes, not approximate. Counts already-downloaded files as
  // completed against the total.
  const filesToFetch: Array<{ path: string; dest: string; approxBytes: number; alreadyHaveBytes: number }> = [];
  let totalBytes = 0;
  let alreadyHave = 0;
  for (const f of KOKORO_REQUIRED_FILES) {
    const dest = path.join(base, f.path);
    let onDisk = 0;
    try { onDisk = fs.statSync(dest).size; } catch { /* missing */ }
    totalBytes += Math.max(onDisk, f.approxBytes);
    if (onDisk > 0) {
      alreadyHave += onDisk;
    } else {
      filesToFetch.push({ path: f.path, dest, approxBytes: f.approxBytes, alreadyHaveBytes: 0 });
    }
  }

  if (filesToFetch.length === 0) {
    onProgress?.({ kind: 'kokoro', modelId: KOKORO_MODEL_ID, bytesDownloaded: totalBytes, bytesTotal: totalBytes });
    return;
  }

  let runningBytes = alreadyHave;
  // Emit the initial progress so the UI shows "starting at X / total".
  onProgress?.({ kind: 'kokoro', modelId: KOKORO_MODEL_ID, bytesDownloaded: runningBytes, bytesTotal: totalBytes });

  for (const file of filesToFetch) {
    const url = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/${file.path}`;
    const tmp = file.dest + '.partial';
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    await ensureDir(path.dirname(file.dest));

    logger.info('Downloading Kokoro file', { file: file.path, url });
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Kokoro file download failed (${file.path}): HTTP ${res.status} ${res.statusText}`);
    }

    // If we got a real content-length, fold it into total so the bar reflects
    // the actual size we're about to write.
    const cl = res.headers.get('content-length');
    if (cl) {
      const actualBytes = Number(cl);
      if (Number.isFinite(actualBytes) && actualBytes > 0) {
        totalBytes = totalBytes - file.approxBytes + actualBytes;
      }
    }

    const reader = res.body.getReader();
    const writer = fs.createWriteStream(tmp);
    let lastReport = runningBytes;
    const REPORT_EVERY = 256 * 1024; // 256 KB

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise<void>((resolve, reject) => {
          writer.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
        runningBytes += value.byteLength;
        if (onProgress && runningBytes - lastReport >= REPORT_EVERY) {
          lastReport = runningBytes;
          onProgress({
            kind: 'kokoro', modelId: KOKORO_MODEL_ID,
            bytesDownloaded: Math.min(runningBytes, totalBytes),
            bytesTotal: totalBytes,
          });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }

    await fsp.rename(tmp, file.dest);
    logger.info('Kokoro file written', { file: file.path, bytes: runningBytes - alreadyHave });
  }

  // Final 100% tick so the bar finishes cleanly.
  onProgress?.({ kind: 'kokoro', modelId: KOKORO_MODEL_ID, bytesDownloaded: totalBytes, bytesTotal: totalBytes });
}

/**
 * Download every required Moonshine file directly into MOONSHINE_CACHE_DIR.
 * Same direct-download pattern as Kokoro (transformers.js cache bug
 * workaround). Idempotent.
 */
export async function ensureMoonshineFiles(onProgress?: ProgressCallback): Promise<void> {
  return ensureModelFiles(
    'moonshine',
    MOONSHINE_MODEL_ID,
    moonshineLocalDir(),
    MOONSHINE_REQUIRED_FILES,
    onProgress,
  );
}

function dirSizeSync(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSizeSync(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch { /* ignore */ }
      } else if (entry.isSymbolicLink()) {
        // HF cache uses symlinks into blobs/; follow them.
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) total += stat.size;
        } catch { /* ignore */ }
      }
    }
  } catch { /* dir missing */ }
  return total;
}

export function kokoroCacheBytes(): number {
  let total = 0;
  for (const p of kokoroCachePaths()) total += dirSizeSync(p);
  return total;
}

export function totalVoiceDiskBytes(): number {
  let total = 0;
  for (const info of listInstalledModels()) {
    total += info.bytes;
  }
  return total;
}

export async function deleteModel(kind: 'whisper' | 'kokoro' | 'moonshine', id: string): Promise<void> {
  if (kind === 'whisper') {
    if (!(id in WHISPER_MODELS)) {
      throw new Error(`Unknown whisper size: ${id}`);
    }
    const p = whisperPath(id as WhisperSize);
    try { await fsp.unlink(p); } catch { /* already gone */ }
    logger.info('Deleted whisper model', { size: id });
    return;
  }
  if (kind === 'kokoro') {
    // Wipe every known cache location so re-download is guaranteed.
    for (const dir of kokoroCachePaths()) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    logger.info('Deleted kokoro cache (all known locations)');
    return;
  }
  if (kind === 'moonshine') {
    // Single pinned location, mirrors the Kokoro cleanup.
    try { await fsp.rm(moonshineLocalDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    logger.info('Deleted moonshine cache');
    return;
  }
  throw new Error(`Unknown model kind: ${kind}`);
}

export async function freeDiskMb(): Promise<number> {
  try {
    const stat = await fsp.statfs(os.homedir());
    return Math.floor((stat.bavail * stat.bsize) / (1024 * 1024));
  } catch {
    return -1;
  }
}
