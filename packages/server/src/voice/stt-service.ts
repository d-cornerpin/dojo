import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import {
  DEFAULT_WHISPER,
  ensureWhisperModel,
  isWhisperInstalled,
  whisperPath,
  type WhisperSize,
} from './model-manager.js';

const logger = createLogger('voice-stt');

const WHISPER_SERVER_BINARY = '/opt/homebrew/bin/whisper-server';
const WHISPER_CLI_BINARY = '/opt/homebrew/bin/whisper-cli';

interface WhisperServer {
  process: ChildProcess;
  port: number;
  modelSize: WhisperSize;
  readyAt: number;
}

let server: WhisperServer | null = null;
let startupPromise: Promise<WhisperServer> | null = null;
let restartAttempts = 0;
let lastRestartAt = 0;

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
      // TCP is listening — give the HTTP layer a beat to attach, then verify with a GET.
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

async function startWhisperServer(modelSize: WhisperSize): Promise<WhisperServer> {
  if (!fs.existsSync(WHISPER_SERVER_BINARY)) {
    throw new Error(`whisper-server not found at ${WHISPER_SERVER_BINARY}. Run: brew install whisper-cpp`);
  }
  if (!isWhisperInstalled(modelSize)) {
    logger.info('Whisper model missing; downloading before server start', { modelSize });
    // Lazy auto-download path (e.g. the very first voice session). Forward
    // progress over WS as voice:model_download events so the Voice tab can
    // render a progress bar against this whisper row.
    const { broadcast } = await import('../gateway/ws.js');
    await ensureWhisperModel(modelSize, (p) => {
      broadcast({
        type: 'voice:model_download',
        data: {
          kind: 'whisper',
          modelId: modelSize,
          bytesDownloaded: p.bytesDownloaded,
          bytesTotal: p.bytesTotal,
        },
      });
    });
    broadcast({
      type: 'voice:model_download',
      data: { kind: 'whisper', modelId: modelSize, bytesDownloaded: 1, bytesTotal: 1 },
    });
  }
  const modelPath = whisperPath(modelSize);
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
    if (server && server.process === proc) {
      server = null;
      maybeRestart(modelSize);
    }
  });

  await waitForServerReady(port);
  restartAttempts = 0;
  const ws: WhisperServer = { process: proc, port, modelSize, readyAt: Date.now() };
  logger.info('whisper-server ready', { port, modelSize });
  return ws;
}

function maybeRestart(modelSize: WhisperSize): void {
  const now = Date.now();
  // Reset attempt counter after a quiet window.
  if (now - lastRestartAt > 60_000) restartAttempts = 0;
  lastRestartAt = now;
  if (restartAttempts >= 5) {
    logger.error('whisper-server crashed too many times; giving up auto-restart');
    return;
  }
  restartAttempts++;
  const delay = Math.min(30_000, 1000 * 2 ** restartAttempts);
  logger.info('Scheduling whisper-server restart', { attempt: restartAttempts, delayMs: delay });
  setTimeout(() => {
    startupPromise = startWhisperServer(modelSize).then((s) => {
      server = s;
      return s;
    }).catch((err) => {
      logger.error('whisper-server restart failed', { error: String(err) });
      throw err;
    });
  }, delay);
}

export async function ensureSttReady(modelSize: WhisperSize = DEFAULT_WHISPER): Promise<void> {
  if (server && server.modelSize === modelSize) return;
  if (startupPromise) {
    const ws = await startupPromise;
    if (ws.modelSize === modelSize) return;
  }
  // model changed or first boot — restart with new model
  if (server) await stopWhisperServer();
  startupPromise = startWhisperServer(modelSize).then((s) => {
    server = s;
    return s;
  });
  await startupPromise;
}

export async function stopWhisperServer(): Promise<void> {
  if (!server) return;
  const proc = server.process;
  server = null;
  startupPromise = null;
  return new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

/** Transcribe a WAV/audio buffer. Spawns the server on demand. */
export async function transcribeBuffer(
  audio: Buffer,
  options: { modelSize?: WhisperSize; language?: string; mime?: string } = {},
): Promise<{ text: string; durationMs: number }> {
  const modelSize = options.modelSize ?? DEFAULT_WHISPER;
  await ensureSttReady(modelSize);
  if (!server) throw new Error('whisper-server not running');

  const start = Date.now();
  const form = new FormData();
  const blob = new Blob([new Uint8Array(audio)], { type: options.mime ?? 'audio/wav' });
  form.append('file', blob, 'utterance.wav');
  form.append('response_format', 'json');
  if (options.language) form.append('language', options.language);
  form.append('temperature', '0.0');

  const res = await fetch(`http://127.0.0.1:${server.port}/inference`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`whisper inference failed: ${res.status} ${errText}`);
  }
  const json = (await res.json()) as { text?: string };
  const text = (json.text ?? '').trim();
  return { text, durationMs: Date.now() - start };
}

/** Per-utterance CLI fallback — no server needed. Slower but useful for tests. */
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
      // Try reading the .txt file next to the input
      const txtPath = wavPath + '.txt';
      let text = '';
      try {
        if (fs.existsSync(txtPath)) {
          text = fs.readFileSync(txtPath, 'utf-8').trim();
          fs.unlinkSync(txtPath);
        } else {
          // Fallback: stdout contains the transcription
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
