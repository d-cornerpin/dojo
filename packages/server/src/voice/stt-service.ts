import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { createLogger } from '../logger.js';
import {
  DEFAULT_WHISPER,
  WHISPER_MODELS,
  ensureWhisperModel,
  isWhisperInstalled,
  whisperPath,
  type WhisperSize,
  MOONSHINE_MODEL_ID,
  ensureMoonshineFiles,
  isMoonshineFullyDownloaded,
  moonshineLocalDir,
} from './model-manager.js';

const logger = createLogger('voice-stt');

// ── Engine selection ──
//
// `voice.stt_model` is a flat string key. Two shapes are accepted:
//   - 'moonshine-base'  → Moonshine v2 base (default, no native deps)
//   - any WhisperSize   → Whisper.cpp via the local whisper-server binary
//
// Default is Moonshine. Existing installs that had `voice.stt_model` set to
// a WhisperSize value keep their preference (backward compatible).

export const DEFAULT_STT_MODEL_KEY = 'moonshine-base' as const;

export type SttEngineKind = 'moonshine' | 'whisper';

export interface ParsedSttModel {
  kind: SttEngineKind;
  /** For moonshine: 'base'. For whisper: the WhisperSize string. */
  size: string;
}

export function parseSttModelKey(key: string): ParsedSttModel {
  if (key === 'moonshine-base') return { kind: 'moonshine', size: 'base' };
  if ((Object.keys(WHISPER_MODELS) as WhisperSize[]).includes(key as WhisperSize)) {
    return { kind: 'whisper', size: key };
  }
  // Unknown values fall back to the default.
  return { kind: 'moonshine', size: 'base' };
}

interface SttEngine {
  readonly key: string;
  load(): Promise<void>;
  transcribeBuffer(audio: Buffer, options?: { language?: string; mime?: string }): Promise<{ text: string; durationMs: number }>;
  dispose(): Promise<void>;
}

// ── Whisper engine ──
//
// Wraps the existing whisper-server child process model. Same spawn /
// free-port / TCP-poll / multipart-POST / exponential-backoff logic as the
// pre-engine-abstraction version, just behind the SttEngine interface.

const WHISPER_SERVER_BINARY = '/opt/homebrew/bin/whisper-server';
const WHISPER_CLI_BINARY = '/opt/homebrew/bin/whisper-cli';

export function isWhisperBinaryAvailable(): boolean {
  return fs.existsSync(WHISPER_SERVER_BINARY);
}

interface WhisperServerHandle {
  process: ChildProcess;
  port: number;
}

class WhisperEngine implements SttEngine {
  readonly key: string;
  private modelSize: WhisperSize;
  private server: WhisperServerHandle | null = null;
  private restartAttempts = 0;
  private lastRestartAt = 0;
  private disposed = false;

  constructor(modelSize: WhisperSize) {
    this.modelSize = modelSize;
    this.key = modelSize;
  }

  async load(): Promise<void> {
    if (this.disposed) throw new Error('WhisperEngine: load called after dispose');
    if (this.server) return;
    if (!isWhisperBinaryAvailable()) {
      throw new Error(
        `whisper-server not found at ${WHISPER_SERVER_BINARY}. Install via: brew install whisper-cpp`,
      );
    }
    if (!isWhisperInstalled(this.modelSize)) {
      logger.info('Whisper model missing; downloading before server start', { modelSize: this.modelSize });
      const { broadcast } = await import('../gateway/ws.js');
      await ensureWhisperModel(this.modelSize, (p) => {
        broadcast({
          type: 'voice:model_download',
          data: {
            kind: 'whisper',
            modelId: this.modelSize,
            bytesDownloaded: p.bytesDownloaded,
            bytesTotal: p.bytesTotal,
          },
        });
      });
      broadcast({
        type: 'voice:model_download',
        data: { kind: 'whisper', modelId: this.modelSize, bytesDownloaded: 1, bytesTotal: 1 },
      });
    }
    this.server = await this.spawnServer();
  }

  private async spawnServer(): Promise<WhisperServerHandle> {
    const modelPath = whisperPath(this.modelSize);
    const port = await pickFreePort();
    logger.info('Spawning whisper-server', { modelPath, port });
    const proc = spawn(
      WHISPER_SERVER_BINARY,
      [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(Math.max(1, Math.floor(os.cpus().length / 2))),
        '--inference-path', '/inference',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug('whisper-server stdout', { line });
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug('whisper-server stderr', { line });
    });
    proc.on('exit', (code, signal) => {
      logger.warn('whisper-server exited', { code, signal });
      if (this.disposed) return;
      if (this.server && this.server.process === proc) {
        this.server = null;
        void this.maybeRestart();
      }
    });
    await waitForServerReady(port);
    this.restartAttempts = 0;
    logger.info('whisper-server ready', { port, modelSize: this.modelSize });
    return { process: proc, port };
  }

  private maybeRestart(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.lastRestartAt > 60_000) this.restartAttempts = 0;
    this.lastRestartAt = now;
    if (this.restartAttempts >= 5) {
      logger.error('whisper-server crashed too many times; giving up auto-restart');
      return;
    }
    this.restartAttempts++;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    logger.info('Scheduling whisper-server restart', { attempt: this.restartAttempts, delayMs: delay });
    setTimeout(() => {
      if (this.disposed) return;
      this.spawnServer().then((h) => { this.server = h; }).catch((err) => {
        logger.error('whisper-server restart failed', { error: String(err) });
      });
    }, delay);
  }

  async transcribeBuffer(audio: Buffer, options: { language?: string; mime?: string } = {}): Promise<{ text: string; durationMs: number }> {
    await this.load();
    if (!this.server) throw new Error('whisper-server not running');
    const start = Date.now();
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audio)], { type: options.mime ?? 'audio/wav' });
    form.append('file', blob, 'utterance.wav');
    form.append('response_format', 'json');
    if (options.language) form.append('language', options.language);
    form.append('temperature', '0.0');
    const res = await fetch(`http://127.0.0.1:${this.server.port}/inference`, { method: 'POST', body: form });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`whisper inference failed: ${res.status} ${errText}`);
    }
    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? '').trim();
    return { text, durationMs: Date.now() - start };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const h = this.server;
    if (!h) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      h.process.once('exit', () => resolve());
      h.process.kill('SIGTERM');
      setTimeout(() => {
        if (!h.process.killed) h.process.kill('SIGKILL');
        resolve();
      }, 2000);
    });
  }
}

// ── Moonshine engine ──
//
// In-process transformers.js automatic-speech-recognition pipeline. Files
// are downloaded directly into MOONSHINE_CACHE_DIR via ensureMoonshineFiles
// (bypassing the transformers cache layer's known bug — see
// model-manager.ts ensureModelFiles).
//
// We avoid an env.localModelPath conflict with Kokoro (which pins its own
// dir at module-import time in tts-service.ts) by passing the absolute
// local model dir directly to pipeline(). transformers.js treats an
// absolute filesystem path as a local model and skips env.localModelPath
// resolution entirely.

type TransformersPipeline = {
  (audio: Float32Array | { array: Float32Array; sampling_rate: number }, options?: Record<string, unknown>): Promise<{ text: string }>;
  dispose?: () => Promise<void>;
};

class MoonshineEngine implements SttEngine {
  readonly key = 'moonshine-base';
  private pipelinePromise: Promise<TransformersPipeline> | null = null;
  private disposed = false;

  async load(): Promise<void> {
    if (this.disposed) throw new Error('MoonshineEngine: load called after dispose');
    if (this.pipelinePromise) {
      await this.pipelinePromise;
      return;
    }
    if (!isMoonshineFullyDownloaded()) {
      logger.info('Moonshine files missing; downloading direct (bypassing transformers cache layer)');
      const { broadcast } = await import('../gateway/ws.js');
      await ensureMoonshineFiles((p) => {
        broadcast({
          type: 'voice:model_download',
          data: {
            kind: 'moonshine',
            modelId: MOONSHINE_MODEL_ID,
            bytesDownloaded: p.bytesDownloaded,
            bytesTotal: p.bytesTotal,
          },
        });
      });
      broadcast({
        type: 'voice:model_download',
        data: { kind: 'moonshine', modelId: MOONSHINE_MODEL_ID, bytesDownloaded: 1, bytesTotal: 1 },
      });
    }
    logger.info('Loading Moonshine ASR pipeline', { localDir: moonshineLocalDir() });
    this.pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const pipe = await pipeline(
        'automatic-speech-recognition',
        moonshineLocalDir(),
        // q8 = int8 quantized. The `_quantized.onnx` files in the manifest
        // match this dtype.
        { dtype: 'q8' },
      );
      logger.info('Moonshine ASR pipeline ready');
      return pipe as unknown as TransformersPipeline;
    })();
    await this.pipelinePromise;
  }

  async transcribeBuffer(audio: Buffer, _options: { language?: string; mime?: string } = {}): Promise<{ text: string; durationMs: number }> {
    await this.load();
    if (!this.pipelinePromise) throw new Error('moonshine pipeline not ready');
    const pipe = await this.pipelinePromise;
    const start = Date.now();
    // The voice WS passes a WAV-wrapped 16 kHz mono Float32 buffer (see
    // pcmFloatToWav). Moonshine expects 16 kHz mono Float32 audio. We
    // unwrap the WAV header (44 bytes) and pass the raw PCM samples.
    const pcm = wavToFloat32(audio);
    const out = await pipe(pcm);
    const text = (out.text ?? '').trim();
    return { text, durationMs: Date.now() - start };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const p = this.pipelinePromise;
    this.pipelinePromise = null;
    if (!p) return;
    try {
      const pipe = await p;
      if (pipe.dispose) await pipe.dispose();
    } catch { /* ignore */ }
  }
}

/**
 * Decode a WAV buffer into a mono Float32Array in [-1, 1]. Handles:
 *   - 16-bit signed PCM (format code 1, what `pcmFloatToWav` writes)
 *   - 32-bit IEEE float (format code 3, what kokoro-js's audio.toWav emits)
 * Walks the chunk list rather than assuming a fixed 44-byte header so
 * files with extra metadata chunks (LIST, fact, etc.) before `data` still
 * parse correctly.
 */
function wavToFloat32(wav: Buffer): Float32Array {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wavToFloat32: not a RIFF/WAVE file');
  }
  let formatCode = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const bodyStart = off + 8;
    if (id === 'fmt ') {
      formatCode = wav.readUInt16LE(bodyStart);
      numChannels = wav.readUInt16LE(bodyStart + 2);
      bitsPerSample = wav.readUInt16LE(bodyStart + 14);
    } else if (id === 'data') {
      dataOffset = bodyStart;
      dataSize = size;
      break;
    }
    // Chunks are padded to an even length per the spec.
    off = bodyStart + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('wavToFloat32: no data chunk found');
  if (numChannels !== 1) {
    // We could downmix, but voice mode always sends mono so anything else
    // is a misconfiguration upstream — fail loudly rather than guess.
    throw new Error(`wavToFloat32: expected mono, got ${numChannels} channels`);
  }
  // 16-bit signed PCM (format 1).
  if (formatCode === 1 && bitsPerSample === 16) {
    const samples = dataSize / 2;
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const s = wav.readInt16LE(dataOffset + i * 2);
      out[i] = s < 0 ? s / 0x8000 : s / 0x7FFF;
    }
    return out;
  }
  // 32-bit IEEE float (format 3).
  if (formatCode === 3 && bitsPerSample === 32) {
    const samples = dataSize / 4;
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      out[i] = wav.readFloatLE(dataOffset + i * 4);
    }
    return out;
  }
  throw new Error(`wavToFloat32: unsupported format code=${formatCode}, bits=${bitsPerSample}`);
}

// ── Engine registry / lifecycle ──
//
// Single resident engine. Switching the active engine disposes the old one
// (terminating the whisper-server child if applicable) and loads the new
// one. In-flight transcriptions are NOT actively interrupted (the
// transformers.js ASR pipeline has no cancellation hook); instead, the
// transcribeBuffer wrapper at the bottom of this file checks whether the
// engine it used is still the active one when the call returns. If a swap
// happened during the call, the wrapper throws stt_engine_swapped so the
// caller doesn't emit a stale partial under the new model's name.

let activeEngine: SttEngine | null = null;
let activeEngineLoad: Promise<SttEngine> | null = null;

async function createEngine(parsed: ParsedSttModel): Promise<SttEngine> {
  if (parsed.kind === 'moonshine') return new MoonshineEngine();
  return new WhisperEngine(parsed.size as WhisperSize);
}

export async function ensureSttReady(modelKey: string = DEFAULT_STT_MODEL_KEY): Promise<void> {
  const parsed = parseSttModelKey(modelKey);
  const desiredKey = parsed.kind === 'moonshine' ? 'moonshine-base' : parsed.size;
  if (activeEngine && activeEngine.key === desiredKey) return;
  if (activeEngineLoad) {
    const e = await activeEngineLoad;
    if (e.key === desiredKey) return;
  }
  if (activeEngine) {
    const prev = activeEngine;
    activeEngine = null;
    void prev.dispose().catch((err) => {
      logger.warn('Engine dispose failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });
  }
  activeEngineLoad = (async () => {
    const engine = await createEngine(parsed);
    await engine.load();
    return engine;
  })();
  try {
    activeEngine = await activeEngineLoad;
  } finally {
    activeEngineLoad = null;
  }
}

export async function transcribeBuffer(
  audio: Buffer,
  options: { modelKey?: string; language?: string; mime?: string } = {},
): Promise<{ text: string; durationMs: number }> {
  const modelKey = options.modelKey ?? DEFAULT_STT_MODEL_KEY;
  await ensureSttReady(modelKey);
  const engineAtStart = activeEngine;
  if (!engineAtStart) throw new Error('STT engine not available after ensureSttReady');
  const result = await engineAtStart.transcribeBuffer(audio, { language: options.language, mime: options.mime });
  // Phase 1.4 swap guard — if another caller swapped engines while this
  // transcribe was in flight, the result belongs to the old engine and we
  // refuse to surface it under the new active model. voice-ws catches this
  // and stays in 'listening' rather than emitting a stale partial.
  if (activeEngine !== engineAtStart) {
    throw new Error('stt_engine_swapped');
  }
  return result;
}

/**
 * Tear down the active whisper-server child process and clear the engine
 * registry. Public for the gateway shutdown path. Only acts on Whisper —
 * Moonshine has no external resource to release.
 */
export async function stopWhisperServer(): Promise<void> {
  if (activeEngine instanceof WhisperEngine) {
    const e = activeEngine;
    activeEngine = null;
    activeEngineLoad = null;
    await e.dispose();
  }
}

// ── Helpers ──

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no address')));
      }
    });
    srv.on('error', reject);
  });
}

function probeTcp(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function waitForServerReady(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeTcp(port)) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }).catch(() => null);
        clearTimeout(timer);
        if (res && res.status >= 200 && res.status < 500) return;
      } catch { /* keep polling */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`whisper-server did not become ready on port ${port} within ${timeoutMs}ms`);
}

// ── CLI fallback (Whisper-only, used by voice-roundtrip.ts) ──

export async function transcribeFileCli(
  wavPath: string,
  modelSize: WhisperSize = DEFAULT_WHISPER,
): Promise<{ text: string; durationMs: number }> {
  if (!isWhisperInstalled(modelSize)) await ensureWhisperModel(modelSize);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(WHISPER_CLI_BINARY, [
      '-m', whisperPath(modelSize),
      '-f', wavPath,
      '--no-timestamps',
      '--output-txt',
      '--print-colors=false',
    ]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`whisper-cli exit ${code}: ${stderr}`));
        return;
      }
      const txtPath = wavPath + '.txt';
      let text = '';
      try {
        if (fs.existsSync(txtPath)) {
          text = fs.readFileSync(txtPath, 'utf-8').trim();
          fs.unlinkSync(txtPath);
        } else {
          text = stdout.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
        }
      } catch {
        text = stdout.trim();
      }
      resolve({ text, durationMs: Date.now() - start });
    });
  });
}

export { pcmFloatToWav } from './tts-service.js';
