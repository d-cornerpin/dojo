/**
 * Hume Octave TTS (cloud) — second TTS engine alongside Kokoro.
 *
 * Uses the official `hume` SDK's streamInput WebSocket helper (added in
 * 0.15.x) rather than a hand-rolled `ws` client. Per the v2.9 cloud-TTS
 * brief, we run in:
 *   - instant_mode (lowest latency, requires a predefined voice)
 *   - PCM format (48 kHz mono int16 LE) which we decode to Float32 and
 *     wrap with the existing `pcmFloatToWav` helper for the WS framing
 *     the browser already understands.
 *
 * voice-ws.ts owns engine dispatch. When the active engine is 'cloud',
 * it streams text DIRECTLY into a HumeStreamSession — no clause-splitting,
 * no manual concatenation. Hume's own internal buffering handles
 * expressive timing, and we flush at LLM-clause boundaries to push audio
 * out as soon as Hume has enough text to commit to a snippet.
 *
 * Key storage is delegated to the existing secrets.yaml machinery via
 * setProviderCredential('hume', key). This module never persists keys.
 */

import { HumeClient } from 'hume';
import { getProviderCredential } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { pcmFloatToWav } from './tts-service.js';

// Hume's PCM output sample rate. Documented as the default for
// formatType: pcm. Set this in pcmFloatToWav so playback runs at the
// right pitch.
export const HUME_SAMPLE_RATE = 48_000;

// Provider key under secrets.yaml's `providers` map. Reuses the existing
// per-provider api_key slot — no new schema.
const HUME_PROVIDER_KEY = 'hume';

const logger = createLogger('voice-hume');

let cachedClient: HumeClient | null = null;
let cachedClientKey: string | null = null;

/**
 * Hume's WS types are deep inside the SDK and not always re-exported
 * cleanly. We treat the returned socket as a black box with the small
 * surface we actually use (on, sendPublish, close, waitForOpen).
 */
interface SdkSocket {
  on(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  sendPublish(message: Record<string, unknown>): void;
  close(): void;
  waitForOpen(): Promise<unknown>;
}

interface SdkAudioMessage {
  type: 'audio';
  audio: string;
  generationId: string;
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

/**
 * Validate a key by issuing one cheap voices.list call. Does NOT store
 * the key — caller (the /api/voice/hume/key endpoint) is responsible for
 * setProviderCredential and invalidateHumeClient afterward.
 */
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
    // Auth failures from Hume come back as 401 with a body containing
    // "Unauthorized" or similar. Surface those cleanly; everything else
    // gets passed through as-is.
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
 * List Hume voices. Pulls both the Voice Library (HUME_AI, 100+ voices)
 * and the user's account voices (CUSTOM_VOICE). Iterates pages until
 * exhausted. Throws if HUME_AI listing fails (likely auth); a failure
 * on CUSTOM_VOICE is logged at debug and treated as "no custom voices".
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
      // No custom voices configured is the common case; not an error.
      logger.debug('No CUSTOM_VOICE voices listed (or list failed)', { error: msg });
    }
  }
  return out;
}

/**
 * Decode Hume's base64 PCM into Float32 in [-1, 1]. Hume PCM is signed
 * 16-bit little-endian mono per the API docs.
 */
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
  /** Baseline delivery description ("acting instructions"). Optional. */
  description?: string;
  /** Speed multiplier. 1.0 default; extreme values can destabilise output. */
  speed?: number;
  /** Optional context anchor — pass last turn's generationId for continuity. */
  contextGenerationId?: string;
}

/**
 * One TTS burst (one user turn). Owns the streamInput socket from open
 * to close, decodes PCM, hands WAV chunks back through `onWav`. voice-ws.ts
 * drives the lifecycle: open at burst start, push() per LLM chat:chunk,
 * flush() at clause boundaries, close() at bubble done.
 */
export class HumeStreamSession {
  private socket: SdkSocket | null = null;
  private voice: { id: string; provider: 'HUME_AI' | 'CUSTOM_VOICE' };
  private description: string | undefined;
  private speed: number | undefined;
  private generationId: string | null = null;
  private contextGenerationId: string | undefined;
  private closed = false;
  /** Set by the message handler when we receive `isLastChunk: true`. close() waits for this. */
  private sawLastChunk = false;
  /** Set by the socket 'close' event so close() can resolve as soon as Hume hangs up. */
  private sawSocketClose = false;

  /** Decoded PCM, wrapped as WAV. voice-ws.ts forwards these straight to the browser. */
  onWav: ((wav: Buffer) => void) | null = null;
  /** Fatal socket error — caller should fall back to local engine. */
  onError: ((err: Error) => void) | null = null;
  /** Socket emitted close. Fired after our own close() too. */
  onClose: (() => void) | null = null;

  constructor(opts: HumeStreamSessionOpts) {
    this.voice = { id: opts.voiceId, provider: opts.voiceProvider ?? 'HUME_AI' };
    this.description = opts.description && opts.description.length > 0 ? opts.description : undefined;
    this.speed = opts.speed;
    this.contextGenerationId = opts.contextGenerationId;
  }

  async open(): Promise<void> {
    const c = getClient();
    if (!c) throw new Error('Hume not configured');
    const apiKey = getProviderCredential(HUME_PROVIDER_KEY);
    if (!apiKey) throw new Error('Hume API key missing');

    // The SDK's connect args type is exhaustively typed; we cast at the
    // boundary so this module's internal SdkSocket abstraction stays
    // independent of SDK version drift.
    const ttsStreamInput = (c.tts as unknown as {
      streamInput: {
        connect: (args: Record<string, unknown>) => Promise<SdkSocket>;
      };
    }).streamInput;

    // Retry the connect + waitForOpen up to 3 times on TIMEOUT errors.
    // The SDK's ReconnectingWebSocket hardcodes a 4-second
    // connectionTimeout (node_modules/hume/.../core/websocket/ws.js:61)
    // and does not expose it in ConnectArgs — so real-world hiccups
    // (DNS, TLS, Hume edge load) that push the handshake past 4s fire
    // a "TIMEOUT" error on what would otherwise be a working
    // connection. The SDK's own reconnectAttempts only triggers AFTER
    // a successful open; this loop covers the initial open.
    const openOnce = async (): Promise<SdkSocket> => {
      const sock = await ttsStreamInput.connect({
      apiKey,
      // Pin to Octave 1. When `version` is omitted, Hume auto-routes the
      // request, and the auto-router currently picks Octave 2 — which
      // SILENTLY IGNORES the `description` field (acting instructions
      // support on v2 is "coming soon" per Hume's docs). Without v1
      // every cue and baseline description gets dropped and delivery
      // falls back to flat. Revisit if/when v2 ships description support.
      version: '1',
      // instant_mode optimises latency by skipping a context-aware pass,
      // but flattens prosody. Brief says: keep this OFF while emotion is
      // the priority. We can revisit re-enabling it once we're satisfied
      // delivery still expresses correctly with it on.
      // Brief suggested turning instant_mode off while validating emotion,
      // but the WebSocket streaming endpoint (/v0/tts/stream/input)
      // rejects the connection with "Socket is not open" the moment
      // sendPublish fires when this is false — the WS path requires
      // instant_mode. We keep it on; Octave-1 + voice+description on
      // every publish + whole-sentence utterances are the actual
      // emotion fixes. If delivery still feels flat with instant_mode
      // on, the brief's documented fallback is the HTTP streaming path
      // (synthesizeJsonStreaming), where instant_mode can be off.
      instantMode: true,
      // Hume's `formatType` is the AudioFormatType enum ('pcm' | 'mp3' |
      // 'wav') as a plain string, NOT the FormatPcm `{ type: 'pcm' }`
      // wrapper used in the HTTP request body. Passing an object here
      // makes the SDK validator throw "Expected string. Received object."
      formatType: 'pcm',
      // CRITICAL: the SDK's StreamInputSocket.handleMessage always calls
      // JSON.parse on incoming messages, but the Hume server sends audio
      // frames as binary Blobs by default. Without noBinary, the SDK
      // throws "Unexpected token 'o', '[object Blob]' is not valid JSON"
      // on the first audio chunk — and the throw escapes its own
      // listener, crashing the Node process before we can catch it.
      // noBinary: true makes the server JSON-encode every frame (audio
      // arrives as a base64 string inside the JSON message), which is
      // what the SDK actually expects.
      noBinary: true,
      contextGenerationId: this.contextGenerationId,
      });
      // Attach the open/error listeners BEFORE waitForOpen so we don't
      // miss the very first lifecycle events. Reusing the socket-level
      // listeners (message/close/error) for the live phase happens below
      // — these temporary ones just race-track the handshake.
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
        // Only retry on TIMEOUT; anything else (auth failure, bad voice
        // id, etc.) won't be helped by another attempt.
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
      // Intentionally do NOT gate on this.closed — `close()` sets that
      // flag immediately when we send `{ close: true }`, but Hume keeps
      // streaming the tail audio for several hundred ms after. Dropping
      // those frames is what caused "agent says half a word and stops":
      // we hung up before the synthesised audio for the last clause
      // arrived. The SDK stops firing this listener once the socket is
      // actually closed, so no extra guard is needed.
      const m = args[0] as SdkMessage;
      if (!isAudioMessage(m)) return;
      this.generationId = m.generationId;
      try {
        const f32 = decodeHumePcm(m.audio);
        if (f32.length === 0) return;
        const wav = pcmFloatToWav(f32, HUME_SAMPLE_RATE);
        this.onWav?.(wav);
        // Cache the "is this the last chunk" signal so close() can wait
        // for it instead of guessing with a fixed timeout.
        if (m.isLastChunk) this.sawLastChunk = true;
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
      this.onClose?.();
    });
    // Socket is already open at this point — openOnce above awaited it.
  }

  /**
   * Push one utterance into the socket. The cloud-TTS brief is explicit:
   * every utterance MUST carry both the `voice` AND the `description`.
   * Sending a description WITHOUT a voice makes Hume treat it as a
   * voice-design prompt — it generates a brand-new voice from the
   * description instead of applying it as acting instructions on the
   * selected voice. That's the exact failure mode the brief calls out
   * as why emotion was being silently ignored.
   *
   * We also feed Hume whole utterances (sentences), not clause
   * fragments — Octave is an LLM that emotes across complete thoughts,
   * and acting instructions need a full unit to land on.
   */
  push(text: string): void {
    if (!this.socket || this.closed || text.length === 0) return;
    const msg: Record<string, unknown> = {
      text,
      voice: this.voice,
    };
    if (this.description) msg.description = this.description;
    if (this.speed != null) msg.speed = this.speed;
    // Diagnostic log — confirms exactly what Hume receives per utterance.
    // The emotion fix brief calls out that description-without-voice is
    // treated as a voice-design prompt; this lets us verify voice is
    // always present and description is actually being sent.
    logger.info('Hume sendPublish', {
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

  /**
   * Tell Hume to generate audio for whatever text has been buffered
   * so far. Use at LLM-clause boundaries so the first audio lands quickly
   * even when the turn continues streaming.
   */
  flush(): void {
    if (!this.socket || this.closed) return;
    try {
      this.socket.sendPublish({ flush: true });
    } catch { /* socket may be closing; non-fatal */ }
  }

  /**
   * Update the per-turn delivery description from this point on. Used by
   * the cue parser to apply a one-line `((deliver: ...))` cue extracted
   * from the agent's reply.
   */
  setDescription(description: string | undefined): void {
    this.description = description && description.length > 0 ? description : undefined;
  }

  /** Last seen generationId. Pass to the next session's contextGenerationId for continuity. */
  get lastGenerationId(): string | null {
    return this.generationId;
  }

  /**
   * End the stream. Sends `close: true` so Hume generates any buffered
   * tail audio, then waits for either `isLastChunk: true` on a frame OR
   * for the server to close the socket, whichever comes first. Falls
   * back to a hard 5s cap so a stuck socket can't hang the burst
   * forever.
   *
   * The old implementation used a 250ms fixed wait, but Hume needs
   * 200-600ms to synthesise the last clause in instant_mode — that
   * timing window was racing with the actual audio arrival and is what
   * caused "agent speaks half a word then stops" on short replies.
   */
  async close(): Promise<void> {
    if (!this.socket || this.closed) return;
    this.closed = true;
    try {
      this.socket.sendPublish({ close: true });
    } catch { /* socket may already be dead */ }

    // Wait for Hume's server to close the socket. `close: true` tells
    // Hume to generate audio for every pending text fragment we pushed,
    // then hang up. Until the socket closes, we may still be receiving
    // audio frames — `isLastChunk` is per-snippet and fires once for
    // each text fragment, so it does NOT mean "stream is over." Only
    // the actual close event does.
    //
    // Hard cap at 10s so a stuck server can't hang the burst forever.
    await new Promise<void>((resolve) => {
      const hardCap = setTimeout(resolve, 10_000);
      const tick = setInterval(() => {
        if (this.sawSocketClose) {
          clearInterval(tick);
          clearTimeout(hardCap);
          resolve();
        }
      }, 50);
    });

    try { this.socket.close(); } catch { /* ignore */ }
    this.socket = null;
  }
}

/**
 * One-shot synthesis for previews and other non-streaming callers.
 * Opens a fresh socket, sends the full text with close=true, collects
 * every PCM chunk, returns a single WAV. Shape matches `tts-service.ts:
 * synthesizeOnce` so the /api/voice/preview route can dispatch either
 * engine through the same return type.
 *
 * Hard 30s wall-clock cap so a stuck socket can't hang the route.
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
    // Same Octave-1 pin and instant_mode-off settings as the streaming
    // path — the preview needs to sound the same as live voice mode, so
    // the user can A/B description cues against actual playback.
    version: '1',
    // Same constraint as the streaming session above — instant_mode is
    // required by the /v0/tts/stream/input WS endpoint. Keep this in
    // sync with the streaming path so /preview sounds like live mode.
    instantMode: true,
    // String enum, not the FormatPcm object wrapper. Same fix as in
    // HumeStreamSession.open above; this path is the one /preview hits.
    formatType: 'pcm',
    // Same noBinary fix as in HumeStreamSession.open — without this the
    // SDK chokes on the first binary audio frame from Hume.
    noBinary: true,
  });

  const pcmChunks: Float32Array[] = [];
  let sawLastChunk = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Hume preview timeout (30s)')), 30_000);

      // Wrap every callback in try/catch — an unhandled throw inside an
      // event-emitter listener crashes the entire Node process by default.
      // The HumeStreamSession streaming path does the same wrap; this
      // is the one-shot equivalent.
      socket.on('message', (...args: unknown[]) => {
        try {
          const m = args[0] as SdkMessage;
          if (!isAudioMessage(m)) return;
          pcmChunks.push(decodeHumePcm(m.audio));
          if (m.isLastChunk) {
            sawLastChunk = true;
            // The server typically closes the socket shortly after; the
            // close handler resolves us. Add a short grace timer as a
            // belt-and-suspenders in case the close event is dropped.
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
