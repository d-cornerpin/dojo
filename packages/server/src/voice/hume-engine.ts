/**
 * Hume Octave TTS (cloud), the second engine beside Kokoro. Uses the `hume` SDK's streamInput WebSocket in
 * instant mode with PCM (48 kHz mono int16 LE), decoded to Float32 and wrapped by pcmFloatToWav. voice-ws.ts
 * streams whole sentences into a HumeStreamSession, flushing after each. API keys live in secrets.yaml
 * via setProviderCredential('hume', key); this module never persists them.
 */

import { HumeClient } from 'hume';
import { getProviderCredential } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { recordCost } from '../costs/tracker.js';
import { pcmFloatToWav } from './tts-service.js';

// Hume's PCM output sample rate; pcmFloatToWav needs it for correct pitch.
export const HUME_SAMPLE_RATE = 48_000;

// Provider key in secrets.yaml's `providers` map (the per-provider api_key slot).
const HUME_PROVIDER_KEY = 'hume';

// A socket that took text and sent no audio this long after the first push counts as failed.
const FIRST_AUDIO_LIMIT_MS = 3_000;

// The owner's Hume plan, 30,000 characters for $3 a month: what each spoken burst is worth on the cost page.
const HUME_USD_PER_CHARACTER = 0.0001;

const logger = createLogger('voice-hume');

let cachedClient: HumeClient | null = null;
let cachedClientKey: string | null = null;

/** The SDK's WS types are not cleanly re-exported, so the socket is treated as a black box with this surface. */
interface SdkSocket {
  on(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  sendPublish(message: Record<string, unknown>): void;
  close(): void;
  waitForOpen(): Promise<unknown>;
}

interface SdkAudioMessage {
  type: 'audio';
  audio: string;
  text: string;
  isLastChunk: boolean;
  chunkIndex?: number;
  snippetId?: string;
}

interface SdkTimestampMessage {
  type: 'timestamps';
  [k: string]: unknown;
}

type SdkMessage = SdkAudioMessage | SdkTimestampMessage;

function isAudioMessage(m: unknown): m is SdkAudioMessage {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'audio'
    && typeof (m as SdkAudioMessage).audio === 'string';
}

/** The SDK's error frame is `{ code?, error?, message? }` with no `type`. */
const isErrorFrame = (m: { type?: string; error?: unknown; message?: unknown } | null): boolean =>
  !m?.type && (m?.error !== undefined || m?.message !== undefined);

function getClient(): HumeClient | null {
  const apiKey = getProviderCredential(HUME_PROVIDER_KEY);
  if (!apiKey) return null;
  if (!cachedClient || cachedClientKey !== apiKey) {
    cachedClient = new HumeClient({ apiKey });
    cachedClientKey = apiKey;
  }
  return cachedClient;
}

/** Drop any cached client. Call after the key changes so the next request rebuilds with the new credential. */
export function invalidateHumeClient(): void {
  cachedClient = null;
  cachedClientKey = null;
}

export function isHumeConfigured(): boolean {
  return getProviderCredential(HUME_PROVIDER_KEY) !== null;
}

/** Validate a key with one voices.list call; storing it and invalidateHumeClient are the caller's job. */
export async function validateHumeKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!apiKey || apiKey.length < 10) {
    return { ok: false, error: 'Key looks empty or too short' };
  }
  try {
    const probe = new HumeClient({ apiKey });
    await probe.tts.voices.list({ provider: 'HUME_AI', pageSize: 1 });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/401|unauthor/i.test(msg)) {
      return { ok: false, error: 'Hume rejected the API key (401 Unauthorized).' };
    }
    return { ok: false, error: msg };
  }
}

export interface HumeVoiceInfo {
  id: string;
  name: string;
  provider: 'HUME_AI' | 'CUSTOM_VOICE';
}

/**
 * List Hume voices: the Voice Library (HUME_AI) and the account's CUSTOM_VOICE, paging until exhausted.
 * A HUME_AI failure throws (likely auth); a CUSTOM_VOICE failure means "no custom voices".
 */
export async function listHumeVoices(): Promise<HumeVoiceInfo[]> {
  const c = getClient();
  if (!c) throw new Error('Hume not configured');
  const out: HumeVoiceInfo[] = [];
  for (const provider of ['HUME_AI', 'CUSTOM_VOICE'] as const) {
    try {
      let page = await c.tts.voices.list({ provider, pageSize: 100 });
      while (true) {
        for (const v of page.data) {
          out.push({ id: v.id, name: v.name, provider: v.provider as 'HUME_AI' | 'CUSTOM_VOICE' });
        }
        if (!page.hasNextPage()) break;
        page = await page.getNextPage();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (provider === 'HUME_AI') {
        logger.warn('Failed to list HUME_AI voices', { error: msg });
        throw err;
      }
      logger.debug('No CUSTOM_VOICE voices listed (or list failed)', { error: msg });
    }
  }
  return out;
}

/** Decode Hume's base64 PCM (signed 16-bit little-endian mono) into Float32 in [-1, 1]. */
function decodeHumePcm(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64');
  const samples = Math.floor(buf.length / 2);
  const f = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    f[i] = s < 0 ? s / 0x8000 : s / 0x7FFF;
  }
  return f;
}

export interface HumeStreamSessionOpts {
  voiceId: string;
  voiceProvider?: 'HUME_AI' | 'CUSTOM_VOICE';
  description?: string;
  /** Speed multiplier. 1.0 default; extreme values can destabilise output. */
  speed?: number;
  /** The agent whose words are spoken: the burst's cost row is written under it. */
  agentId: string;
}

/**
 * One TTS burst (one user turn): owns the streamInput socket from open to close and hands decoded WAV chunks
 * to `onWav`. voice-ws.ts calls open at burst start, push and flush per sentence, close at bubble done.
 */
export class HumeStreamSession {
  private socket: SdkSocket | null = null;
  private voice: { id: string; provider: 'HUME_AI' | 'CUSTOM_VOICE' };
  private description: string | undefined;
  private speed: number | undefined;
  private agentId: string;
  private closed = false;
  private chars = 0;
  private firstAudioTimer: ReturnType<typeof setTimeout> | null = null;
  private audioSeen = false;
  /** The first-audio limit passed: close() stops waiting for a socket that is not talking. */
  private silent = false;
  /** The socket 'close' event fired, so close() can resolve as soon as Hume hangs up. */
  private sawSocketClose = false;

  /** Decoded PCM, wrapped as WAV. voice-ws.ts forwards these straight to the browser. */
  onWav: ((wav: Buffer) => void) | null = null;
  /** Hume finished sending the audio for one snippet of pushed text (its `text`). */
  onSnippetDone: ((text: string) => void) | null = null;
  /** Fatal socket or send error: the caller should fall back to the local engine. */
  onError: ((err: Error) => void) | null = null;
  /** Opt-in: also called for a provider error frame or a hang-up we did not ask for. */
  onDrop: ((err: Error) => void) | null = null;

  constructor(opts: HumeStreamSessionOpts) {
    this.voice = { id: opts.voiceId, provider: opts.voiceProvider ?? 'HUME_AI' };
    this.description = opts.description && opts.description.length > 0 ? opts.description : undefined;
    this.speed = opts.speed;
    this.agentId = opts.agentId;
  }

  async open(): Promise<void> {
    const c = getClient();
    if (!c) throw new Error('Hume not configured');
    const apiKey = getProviderCredential(HUME_PROVIDER_KEY);
    if (!apiKey) throw new Error('Hume API key missing');

    // Cast at the boundary so the SdkSocket abstraction stays independent of the SDK's exhaustive types.
    const ttsStreamInput = (c.tts as unknown as {
      streamInput: {
        connect: (args: Record<string, unknown>) => Promise<SdkSocket>;
      };
    }).streamInput;

    // Retry the initial connect on TIMEOUT: the SDK hardcodes a 4 s connectionTimeout it does not expose,
    // so a slow DNS/TLS/edge handshake fails a working connection. Its own reconnects only cover later drops.
    const openOnce = async (): Promise<SdkSocket> => {
      const sock = await ttsStreamInput.connect({
      apiKey,
      // Pin Octave 1: when `version` is omitted Hume auto-routes to Octave 2, which silently ignores
      // `description`, so every delivery cue would be dropped.
      version: '1',
      // instant_mode must stay on: the WS endpoint (/v0/tts/stream/input) closes with "Socket is not open"
      // on the first sendPublish without it.
      instantMode: true,
      // `formatType` is the plain string enum ('pcm'), not the `{ type: 'pcm' }` wrapper of the HTTP body;
      // an object fails the SDK validator.
      formatType: 'pcm',
      // noBinary is required: the SDK JSON.parses every message, and binary audio frames throw from its
      // own listener and crash the process. With it the server sends audio as base64 inside JSON.
      noBinary: true,
      });
      // Attach open/error listeners before waitForOpen so the first lifecycle events are not missed;
      // these only track the handshake, the live-phase listeners are attached below.
      let resolvedOpen = false;
      const openPromise = new Promise<SdkSocket>((resolve, reject) => {
        const onErr = (...args: unknown[]) => {
          if (resolvedOpen) return;
          resolvedOpen = true;
          const err = args[0];
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        sock.on('error', onErr);
        void sock.waitForOpen().then(
          () => {
            if (resolvedOpen) return;
            resolvedOpen = true;
            resolve(sock);
          },
          onErr,
        );
      });
      return openPromise;
    };

    const MAX_ATTEMPTS = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.socket = await openOnce();
        if (attempt > 1) {
          logger.info('Hume open succeeded on retry', { attempt });
        }
        lastErr = null;
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        lastErr = e;
        // Only TIMEOUT is retried; auth or voice-id failures will not improve.
        if (!/timeout/i.test(e.message) || attempt === MAX_ATTEMPTS) {
          throw e;
        }
        const backoffMs = 250 * attempt; // 250, 500
        logger.warn('Hume open TIMEOUT, retrying', { attempt, backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    if (!this.socket) throw lastErr ?? new Error('Hume open failed');

    this.socket.on('message', (...args: unknown[]) => {
      // Do not gate on this.closed: close() sets it on sending `{ close: true }`, but Hume keeps streaming
      // tail audio for several hundred ms, and dropping those frames cuts off the last clause.
      // The SDK stops calling this once the socket is actually closed.
      const m = args[0] as SdkMessage;
      if (this.onDrop && isErrorFrame(m)) {
        const { code, message } = m as { code?: string; message?: string };
        logger.warn('Hume error frame', { code, message });
        this.onDrop(new Error('Hume error frame'));
        return;
      }
      if (!isAudioMessage(m)) return;
      this.audioSeen = true;
      if (this.firstAudioTimer) clearTimeout(this.firstAudioTimer);
      try {
        const f32 = decodeHumePcm(m.audio);
        if (f32.length > 0) this.onWav?.(pcmFloatToWav(f32, HUME_SAMPLE_RATE));
        if (m.isLastChunk) {
          this.onSnippetDone?.(m.text);
        }
      } catch (err) {
        logger.warn('Hume audio decode failed', { error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.socket.on('error', (...args: unknown[]) => {
      const err = args[0];
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn('Hume socket error', { error: e.message });
      this.onError?.(e);
    });
    this.socket.on('close', () => {
      this.sawSocketClose = true;
      if (!this.closed) this.onDrop?.(new Error('Hume hung up mid-stream'));
    });
  }

  /**
   * Push one whole utterance (not a clause fragment: acting instructions need a complete unit). Every
   * utterance must carry both `voice` and `description`: a description without a voice is treated as a
   * voice-design prompt and generates a new voice instead of acting on the selected one.
   */
  push(text: string): void {
    if (!this.socket || this.closed || text.length === 0) return;
    const msg: Record<string, unknown> = {
      text,
      voice: this.voice,
    };
    if (this.description) msg.description = this.description;
    if (this.speed != null) msg.speed = this.speed;
    this.chars += text.length;
    if (!this.audioSeen && !this.firstAudioTimer) {
      this.firstAudioTimer = setTimeout(() => {
        this.silent = true;
        this.onError?.(new Error(`Hume sent no audio within ${FIRST_AUDIO_LIMIT_MS / 1000} s`));
      }, FIRST_AUDIO_LIMIT_MS);
    }
    logger.debug('Hume sendPublish', {
      textPreview: text.length > 60 ? text.slice(0, 60) + '…' : text,
      textLen: text.length,
      voiceId: this.voice.id,
      voiceProvider: this.voice.provider,
      hasDescription: this.description != null && this.description.length > 0,
      description: this.description ?? null,
      speed: this.speed ?? null,
    });
    try {
      this.socket.sendPublish(msg);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn('Hume sendPublish failed', { error: e.message });
      this.onError?.(e);
    }
  }

  /** Ask Hume to generate audio for the text buffered so far; called after each sentence push. */
  flush(): void {
    if (!this.socket || this.closed) return;
    try {
      this.socket.sendPublish({ flush: true });
    } catch { /* socket may be closing; non-fatal */ }
  }

  /** Update the per-turn delivery description from this point on (applies a parsed `((deliver: ...))` cue). */
  setDescription(description: string | undefined): void {
    this.description = description && description.length > 0 ? description : undefined;
  }

  /**
   * End the stream: send `close: true` so Hume generates the buffered tail audio, then wait for the server
   * to close the socket, capped at 10 s so a stuck socket cannot hang the burst. The first-audio limit keeps
   * running through the wait. Once it ends, the burst's words are billed as one cost row if audio came back.
   */
  async close(): Promise<void> {
    if (!this.socket || this.closed) return;
    this.closed = true;
    try {
      this.socket.sendPublish({ close: true });
    } catch { /* socket may already be dead */ }

    // Wait for the socket close, not `isLastChunk`: that fires once per pushed snippet, so audio may
    // still be arriving after it.
    await new Promise<void>((resolve) => {
      // The cap also clears the tick, or a stuck socket would leave the 50 ms interval running forever.
      const tick = setInterval(() => {
        if (this.sawSocketClose || this.silent) {
          clearInterval(tick);
          clearTimeout(hardCap);
          resolve();
        }
      }, 50);
      const hardCap = setTimeout(() => {
        clearInterval(tick);
        resolve();
      }, 10_000);
    });

    try { this.socket.close(); } catch { /* ignore */ }
    this.socket = null;
    if (this.firstAudioTimer) clearTimeout(this.firstAudioTimer);
    if (this.chars > 0 && this.audioSeen) {
      recordCost({
        agentId: this.agentId, modelId: 'hume-octave', providerId: HUME_PROVIDER_KEY,
        inputTokens: 0, outputTokens: 0, units: this.chars, characterRate: HUME_USD_PER_CHARACTER, requestType: 'speech',
      });
    }
  }
}

/**
 * One-shot synthesis for previews: opens a fresh socket, sends the full text with close=true and returns one
 * WAV, shaped like tts-service.ts synthesizeOnce so /api/voice/preview can dispatch either engine.
 * Capped at 30 s wall-clock.
 */
export async function synthesizeOnce(
  text: string,
  voiceId: string,
  opts: { description?: string; speed?: number; voiceProvider?: 'HUME_AI' | 'CUSTOM_VOICE' } = {},
): Promise<{ wav: Buffer; pcm: Float32Array; sampleRate: number }> {
  const c = getClient();
  if (!c) throw new Error('Hume not configured');
  const apiKey = getProviderCredential(HUME_PROVIDER_KEY);
  if (!apiKey) throw new Error('Hume API key missing');

  const ttsStreamInput = (c.tts as unknown as {
    streamInput: {
      connect: (args: Record<string, unknown>) => Promise<SdkSocket>;
    };
  }).streamInput;

  const socket = await ttsStreamInput.connect({
    apiKey,
    // Same as the streaming path (Octave 1, instant_mode, string format, noBinary) so previews match live voice.
    version: '1',
    instantMode: true,
    formatType: 'pcm',
    noBinary: true,
  });

  const pcmChunks: Float32Array[] = [];
  let sawLastChunk = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Hume preview timeout (30s)')), 30_000);

      // Wrap every callback in try/catch: an unhandled throw in an event listener crashes the process.
      socket.on('message', (...args: unknown[]) => {
        try {
          const m = args[0] as SdkMessage;
          if (!isAudioMessage(m)) return;
          pcmChunks.push(decodeHumePcm(m.audio));
          if (m.isLastChunk) {
            sawLastChunk = true;
            // The close handler normally resolves; this grace timer covers a dropped close event.
            setTimeout(() => {
              clearTimeout(timeout);
              resolve();
            }, 250);
          }
        } catch (handlerErr) {
          clearTimeout(timeout);
          reject(handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)));
        }
      });
      socket.on('error', (...args: unknown[]) => {
        try {
          clearTimeout(timeout);
          const err = args[0];
          reject(err instanceof Error ? err : new Error(String(err)));
        } catch { /* reject is idempotent on a settled promise */ }
      });
      socket.on('close', () => {
        try {
          clearTimeout(timeout);
          resolve();
        } catch { /* idempotent */ }
      });

      void socket.waitForOpen()
        .then(() => {
          const msg: Record<string, unknown> = {
            text,
            voice: { id: voiceId, provider: opts.voiceProvider ?? 'HUME_AI' },
            close: true,
          };
          if (opts.description) msg.description = opts.description;
          if (opts.speed != null) msg.speed = opts.speed;
          try {
            socket.sendPublish(msg);
          } catch (sendErr) {
            clearTimeout(timeout);
            reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
          }
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }

  if (!sawLastChunk && pcmChunks.length === 0) {
    throw new Error('Hume returned no audio for the preview text');
  }

  const total = pcmChunks.reduce((s, c) => s + c.length, 0);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const c of pcmChunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  const wav = pcmFloatToWav(pcm, HUME_SAMPLE_RATE);
  return { wav, pcm, sampleRate: HUME_SAMPLE_RATE };
}
