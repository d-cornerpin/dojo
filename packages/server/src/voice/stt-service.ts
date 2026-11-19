import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { createLogger } from '../logger.js';
import {
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

// Engine selection: `voice.stt_model` is 'moonshine-base' (default, no native deps) or a WhisperSize
// (Whisper.cpp via the local whisper-server binary).

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

// Whisper engine: a local whisper-server child process (spawn, free port, TCP poll, multipart POST, backoff).

const WHISPER_SERVER_BINARY = '/opt/homebrew/bin/whisper-server';

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
  private loading: Promise<void> | null = null;
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
    // One reload at a time: after a crash `this.server` is null for everyone, and parallel respawns
    // would orphan the earlier child.
    if (!this.loading) this.loading = this.doLoad().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async doLoad(): Promise<void> {
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
    // Output on either stream is the boot-progress signal waitForServerReady re-arms on.
    proc.stdout?.on('data', (chunk: Buffer) => {
      noteWhisperBootOutput();
      const line = chunk.toString().trim();
      if (line) logger.debug('whisper-server stdout', { line });
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      noteWhisperBootOutput();
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
    try {
      await waitForServerReady(port);
    } catch (err) {
      // The child is alive and unreferenced (this.server is still null): kill it before rethrowing,
      // or it keeps its port while the next load() spawns another.
      proc.kill('SIGKILL');
      throw err;
    }
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
      if (this.server || this.loading) {
        // A transcription reload (or an earlier restart) already brought a
        // server back during the back-off; spawning here would orphan it.
        logger.info('whisper-server restart skipped; a reload already covered it');
        return;
      }
      this.spawnServer().then((h) => {
        if (this.disposed || this.server) {
          // A dispose landed, or a reload installed its own server while this
          // boot was in flight; overwriting here would orphan that one.
          h.process.kill('SIGKILL');
          return;
        }
        this.server = h;
      }).catch((err) => {
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
      // `killed` flips when the signal is sent, not when the child dies: decide "still running" from the
      // exit state (null until it terminates) or a SIGTERM-ignoring child is orphaned.
      const timer = setTimeout(() => {
        if (h.process.exitCode === null && h.process.signalCode === null) {
          h.process.kill('SIGKILL');
        }
        resolve();
      }, 2000);
      timer.unref?.();
      h.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      h.process.kill('SIGTERM');
    });
  }
}

// Moonshine engine: an in-process transformers.js ASR pipeline. Files are downloaded into MOONSHINE_CACHE_DIR
// by ensureMoonshineFiles (the transformers cache layer is bypassed, see model-manager.ts ensureModelFiles).
// The absolute model dir goes straight to pipeline() so env.localModelPath, which tts-service.ts pins for
// Kokoro at import time, is never involved.

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
        // q8 = int8 quantized, matching the `_quantized.onnx` files in the manifest.
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
    // The voice WS passes a WAV-wrapped 16 kHz mono Float32 buffer (see pcmFloatToWav); Moonshine needs
    // the raw PCM samples.
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
 * Decode a WAV buffer into a mono Float32Array in [-1, 1]: 16-bit PCM (what pcmFloatToWav writes) or
 * 32-bit float (what kokoro-js emits). Walks the chunk list, so extra chunks before `data` still parse.
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
    // Voice mode always sends mono; anything else is an upstream misconfiguration, so fail loudly.
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

// One resident engine per model key, kept once loaded: dashboard voice, phone calls and the transcribe tool
// each name the engine they need, and loading one never unloads another mid-transcription.
const engines = new Map<string, Promise<SttEngine>>();
const resident = new Set<SttEngine>();

async function createEngine(parsed: ParsedSttModel): Promise<SttEngine> {
  const engine = parsed.kind === 'moonshine' ? new MoonshineEngine() : new WhisperEngine(parsed.size as WhisperSize);
  await engine.load();
  resident.add(engine);
  return engine;
}

/** The loaded engine for a model key; a failed load is forgotten, so the next call tries again. */
function engineFor(modelKey: string): Promise<SttEngine> {
  const parsed = parseSttModelKey(modelKey);
  const key = parsed.kind === 'moonshine' ? 'moonshine-base' : parsed.size;
  let engine = engines.get(key);
  if (!engine) {
    const loading = createEngine(parsed);
    engines.set(key, loading);
    loading.catch(() => { if (engines.get(key) === loading) engines.delete(key); });
    engine = loading;
  }
  return engine;
}

export async function ensureSttReady(modelKey: string = DEFAULT_STT_MODEL_KEY): Promise<void> {
  await engineFor(modelKey);
}

export async function transcribeBuffer(
  audio: Buffer,
  options: { modelKey?: string; language?: string; mime?: string } = {},
): Promise<{ text: string; durationMs: number }> {
  const engine = await engineFor(options.modelKey ?? DEFAULT_STT_MODEL_KEY);
  return engine.transcribeBuffer(audio, { language: options.language, mime: options.mime });
}

/** Tear down every whisper-server child and forget all engines (gateway shutdown). */
export async function stopWhisperServer(): Promise<void> {
  const whispers = [...resident].filter((e) => e instanceof WhisperEngine);
  resident.clear();
  engines.clear();
  await Promise.all(whispers.map((e) => e.dispose()));
}


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

// Boot bounds: the wait gives up when the server has been silent for WHISPER_BOOT_QUIET_MS, or at the
// ceiling, which does not re-arm. The ceiling is generous because a first-run load off a slow disk is slow.
const WHISPER_BOOT_QUIET_MS = 60_000;
const WHISPER_BOOT_CEILING_MS = 10 * 60_000;

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

// A slow boot is not a failed boot: the wait polls the TCP port but re-arms its quiet window each time
// whisper-server writes output (see noteWhisperBootOutput), while the ceiling stays fixed so a wedged
// binary is still given up on.
let lastWhisperBootOutputAt = 0;

/** Called for every chunk whisper-server writes while booting. */
function noteWhisperBootOutput(): void {
  lastWhisperBootOutputAt = Date.now();
}

async function waitForServerReady(
  port: number,
  quietMs = WHISPER_BOOT_QUIET_MS,
  ceilingMs = WHISPER_BOOT_CEILING_MS,
): Promise<void> {
  const start = Date.now();
  // A boot that has not printed yet still gets its first full window.
  lastWhisperBootOutputAt = start;
  for (;;) {
    if (await probeTcp(port)) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }).catch(() => null);
        clearTimeout(timer);
        if (res && res.status >= 200 && res.status < 500) return;
      } catch { /* keep polling */ }
    }
    const quietFor = Date.now() - lastWhisperBootOutputAt;
    const aliveFor = Date.now() - start;
    if (aliveFor >= ceilingMs) {
      throw new Error(
        `whisper-server did not become ready on port ${port} within its ${Math.round(ceilingMs / 1000)}s ceiling`,
      );
    }
    if (quietFor >= quietMs) {
      // Report what was observed: the server went quiet, not merely that it was slow.
      throw new Error(
        `whisper-server stopped reporting progress for ${Math.round(quietFor / 1000)}s while starting on port ${port}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export { pcmFloatToWav } from './tts-service.js';
