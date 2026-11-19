/**
 * Browser-side voice client: vad-web mic capture, a voice-backend WebSocket,
 * scheduled TTS playback. Barge-in: speech while speaking cancels the reply.
 */

import { MicVAD } from '@ricky0123/vad-web';
import * as ortEnv from 'onnxruntime-web';
import { fetchUrl } from '../api';

export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'waiting'
  | 'speaking'
  | 'error'
  /** Mic on, transcripts dropped until the wake phrase; the UI shows it apart from `listening`. */
  | 'passive';

export interface VoiceClientOptions {
  agentId: string;
  /** Override for the WS endpoint; defaults to `/api/ws/voice`. */
  wsUrl?: string;
  wakePhrase?: string;
  sleepPhrase?: string;
  /** Detected speech while the agent speaks interrupts it. Off by
   *  default: phone speakers echo TTS into the mic. */
  bargeInEnabled?: boolean;
  /** When true, play the wake / sleep / prompt-sent chimes. On by default. */
  soundEffectsEnabled?: boolean;
}

// The VAD only spots pauses; the end-of-turn decision is server-side. Short
// enough to stay responsive, long enough to ignore micro-pauses.
const VAD_REDEMPTION_MS = 250;

export interface VoiceClientEvents {
  'state-change': (state: VoiceState) => void;
  /** Live partial transcript fired ~1×/sec while user is still speaking. Replaces itself. */
  'partial-transcript': (text: string) => void;
  'final-transcript': (text: string) => void;
  'tts-start': () => void;
  'tts-end': (info: { interrupted: boolean }) => void;
  /** Speech probability 0..1 per VAD frame (~30ms). Drives the volume meter. */
  'audio-level': (level: number) => void;
  /** Wake phrase heard; session is now active. */
  'wake': (info: { phrase: string; remainder: string | null }) => void;
  /** Sleep phrase heard; session is back to passive. */
  'sleep': (info: { phrase: string }) => void;
  'muted-change': (muted: boolean) => void;
  /** Non-fatal server notice (e.g. the cloud voice hiccupped and this reply
   *  plays in the local voice). Unlike `error` this never touches state; the
   *  consumer renders an info toast. */
  notice: (message: string) => void;
  error: (message: string) => void;
}

type Listener<T extends keyof VoiceClientEvents> = VoiceClientEvents[T];

function getToken(): string | null {
  return localStorage.getItem('dojo_token');
}

// Backend-served, so the path stays same-origin in dev and prod; as the
// wasmPaths prefix ORT fetches its own .mjs/.wasm there, away from vite.
const VAD_ASSET_BASE = '/api/voice/assets/vad/';
const ORT_ASSET_BASE = '/api/voice/assets/ort/';

// Heuristic mobile detection; iPadOS reports as Macintosh, touch points
// catch it. A false positive on a desktop only costs barge-in.
function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|Android|Mobile|webOS/i.test(ua)) return true;
  // iPad reports as Macintosh; touch points give it away.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function configureOrt() {
  try {
    const env = (ortEnv as { env?: { wasm?: { wasmPaths?: string; numThreads?: number } } }).env;
    if (env?.wasm) {
      env.wasm.wasmPaths = ORT_ASSET_BASE;
      // One thread avoids the COOP/COEP headers we don't serve; the silero
      // model is tiny, so single-thread throughput is fine.
      env.wasm.numThreads = 1;
    }
  } catch { /* ignore */ }
}

export class VoiceClient {
  readonly agentId: string;
  wakePhrase: string;
  sleepPhrase: string;
  bargeInEnabled: boolean;
  soundEffectsEnabled: boolean;
  private wsUrl: string;

  state: VoiceState = 'idle';
  private ws: WebSocket | null = null;
  private vad: MicVAD | null = null;
  private audioContext: AudioContext | null = null;

  private scheduledSources: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  // After a barge-in, drop in-flight WAV chunks; the TTS backend checks the
  // abort signal only between sentences. Cleared on the next tts_start.
  private discardIncomingAudio = false;
  private isCapturing = false;
  // A suppressed speech-start (echo with barge-in off); its end must no-op.
  private suppressedCurrentUtterance = false;
  // The server fires tts_end once all chunks are sent, but playback runs
  // seconds longer; flipping then opens the mic to echo, so wait for onended.
  private ttsEndPendingPlayback = false;
  // Fallback timer leaving 'speaking' when the last chunk should be done; rearmed by late chunks.
  private ttsEndTimeout: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners: { [K in keyof VoiceClientEvents]?: Set<any> } = {};

  // User mute: mic tracks off (OS indicators clear) and VAD paused; TTS playback keeps running.
  private muted = false;

  constructor(opts: VoiceClientOptions) {
    this.agentId = opts.agentId;
    this.wakePhrase = opts.wakePhrase ?? 'hey agent';
    this.sleepPhrase = opts.sleepPhrase ?? 'stop listening';
    this.bargeInEnabled = opts.bargeInEnabled ?? false;
    this.soundEffectsEnabled = opts.soundEffectsEnabled ?? true;
    this.wsUrl = opts.wsUrl ?? '/api/ws/voice';
  }

  on<T extends keyof VoiceClientEvents>(event: T, fn: Listener<T>): void {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event]!.add(fn);
  }

  off<T extends keyof VoiceClientEvents>(event: T, fn: Listener<T>): void {
    this.listeners[event]?.delete(fn);
  }

  private emit<T extends keyof VoiceClientEvents>(event: T, ...args: Parameters<Listener<T>>): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) {
      try { (fn as (...a: unknown[]) => void)(...args); } catch (err) { console.warn('[voice] listener error', err); }
    }
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('state-change', next);
    // Half-duplex on mobile: echoCancellation is not enough on phone
    // loudspeakers, so the mic track is muted while the agent speaks.
    if (isMobileUserAgent()) {
      if (next === 'speaking' && prev !== 'speaking') {
        this.setMicTrackEnabled(false);
      } else if (prev === 'speaking' && next !== 'speaking') {
        // Leaving speaking never overrides a manual mute.
        if (!this.muted) this.setMicTrackEnabled(true);
      }
    }
  }

  // Hardware-equivalent mute: `MediaStreamTrack.enabled = false` starves VAD,
  // STT and the WS at the OS level (indicators clear) and pauses the VAD
  // processor. Unmute reverses both instantly; TTS playback is unaffected.
  async setMuted(muted: boolean): Promise<void> {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      this.setMicTrackEnabled(false);
      try { await this.vad?.pause(); } catch (err) { console.warn('[voice] vad.pause failed', err); }
    } else {
      this.setMicTrackEnabled(true);
      try { await this.vad?.start(); } catch (err) { console.warn('[voice] vad.start failed', err); }
    }
    this.emit('muted-change', muted);
  }

  isMuted(): boolean { return this.muted; }

  // Toggles the VAD's input track; `_stream` is a private vad-web property, verified on the pinned dep.
  private setMicTrackEnabled(enabled: boolean): void {
    if (!this.vad) return;
    const stream = (this.vad as unknown as { _stream?: MediaStream })._stream;
    if (!stream) return;
    try {
      for (const track of stream.getAudioTracks()) {
        track.enabled = enabled;
      }
    } catch (err) {
      console.warn('[voice] failed to toggle mic track', err);
    }
  }

  isActive(): boolean { return this.state !== 'idle' && this.state !== 'error'; }

  async toggle(): Promise<void> {
    if (this.isActive()) {
      await this.stop();
    } else {
      await this.start();
    }
  }

  async start(): Promise<void> {
    if (this.isActive()) return;
    // A fresh session always starts unmuted; a carried mute reads as a broken mic.
    if (this.muted) {
      this.muted = false;
      this.emit('muted-change', false);
    }
    this.setState('connecting');

    // Fail before getUserMedia's opaque NotAllowedError: the mic needs HTTPS.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      this.fail('insecure_context', new Error('Voice mode needs HTTPS, open this site via the tunnel URL.'));
      return;
    }

    configureOrt();

    // No sampleRate hint: Safari rejects non-native rates, and vad-web and
    // decodeAudioData resample on their own, so let the browser pick.
    try {
      // Reuse the existing context; a fresh one on iOS can stay permanently
      // silent, resuming the original avoids that.
      if (!this.audioContext || (this.audioContext as AudioContext & { state: AudioContextState }).state === 'closed') {
        this.audioContext = new AudioContext();
      }
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      // iOS only makes output audible after a buffer plays inside the user
      // gesture; this silent frame satisfies that.
      try {
        const unlock = this.audioContext.createBuffer(1, 1, 22_050);
        const src = this.audioContext.createBufferSource();
        src.buffer = unlock;
        src.connect(this.audioContext.destination);
        src.start(0);
      } catch { /* ignore, only iOS strictly needs this */ }
      // nextStartTime can sit far in the future from a prior session while a
      // fresh context counts from ~0; without this the first chunk plays late.
      this.nextStartTime = this.audioContext.currentTime;
      // iOS suspends the context when backgrounded; resume on return.
      this.installVisibilityResume();
    } catch (err) {
      this.fail('audio_context_failed', err);
      return;
    }

    try {
      await this.openWebSocket();
    } catch (err) {
      this.fail('ws_open_failed', err);
      return;
    }
    const session = this.ws;

    try {
      const vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_ASSET_BASE,
        onnxWASMBasePath: ORT_ASSET_BASE,
        // vad-web's default getStream already requests echoCancellation,
        // noiseSuppression and AGC; don't override it (merge them if added).
        // Short fixed redemption; the end-of-turn decision is server-side.
        redemptionMs: VAD_REDEMPTION_MS,
        onSpeechStart: () => {
          this.isCapturing = true;
          this.handleSpeechStart();
        },
        onSpeechEnd: (audio: Float32Array) => {
          this.isCapturing = false;
          this.handleSpeechEnd(audio);
        },
        onVADMisfire: () => {
          this.isCapturing = false;
          if (this.state === 'capturing') this.setState('listening');
        },
        // Drives the meter and live PCM; raw RMS backs up silero on quiet voices.
        onFrameProcessed: (probs, frame) => {
          const isSpeech = probs.isSpeech;
          let rms = 0;
          for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
          rms = Math.sqrt(rms / frame.length);
          const rmsLevel = Math.min(1, rms / 0.3);
          const level = Math.max(isSpeech, rmsLevel * 0.8);
          this.emit('audio-level', level);

          // In-speech frames stream to the server for partials; the rest is ambient noise, dropped.
          if (this.isCapturing && this.ws?.readyState === WebSocket.OPEN) {
            // Copy: vad-web reuses the frame buffer between callbacks.
            const copy = new Float32Array(frame.length);
            copy.set(frame);
            try { this.ws.send(copy.buffer); } catch { /* ignore */ }
          }
        },
      });
      // The session ended (a dropped connection, or Stop) while the microphone was opening: release it.
      if (this.ws !== session) {
        try { vad.destroy(); } catch { /* ignore */ }
        return;
      }
      this.vad = vad;
      await vad.start();
      if (this.ws === session) this.setState('listening');
    } catch (err) {
      // Reword permission errors; the iOS toast alone says "an error occurred".
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.fail('mic_permission_denied', new Error('Microphone access was blocked. Enable mic access for this site in your browser settings.'));
      } else if (name === 'NotFoundError') {
        this.fail('mic_not_found', new Error('No microphone detected on this device.'));
      } else {
        this.fail('vad_init_failed', err);
      }
    }
  }

  private visibilityHandler: (() => void) | null = null;
  private installVisibilityResume(): void {
    if (this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this.audioContext?.state === 'suspended') {
        void this.audioContext.resume().catch(() => { /* ignore */ });
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.setState('idle');
  }

  // Ends everything a session holds: the microphone, playback, the server socket, the audio context and the
  // page listener. Every way out of a session (stop, a failed start, a dropped connection) ends here.
  private async teardown(): Promise<void> {
    try { this.vad?.destroy(); } catch { /* ignore */ }
    this.vad = null;
    this.cancelPlayback();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'close' })); } catch { /* ignore */ }
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    // iOS: suspend, never close. A second context created later in the page
    // can stay silent forever; suspend/resume keeps output working.
    try { await this.audioContext?.suspend(); } catch { /* ignore */ }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }


  private fail(detail: string, err?: unknown): void {
    const message = err instanceof Error ? err.message : String(err ?? detail);
    void this.teardown();
    this.setState('error');
    this.emit('error', `${detail}: ${message}`);
    console.error('[voice]', detail, err);
  }

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const token = getToken();
      if (!token) {
        reject(new Error('not authenticated'));
        return;
      }
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}${this.wsUrl}?token=${encodeURIComponent(token)}&agentId=${encodeURIComponent(this.agentId)}`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('voice WS connect timeout'));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        // The server reads voice, speed, engines and wake words from the saved settings; it needs only the sample rate.
        try {
          ws.send(JSON.stringify({ type: 'config', pcmSampleRate: 16_000 }));
        } catch { /* ignore */ }
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('voice WS error'));
      };
      ws.onclose = () => {
        if (this.ws === ws) void this.stop();
      };
      ws.onmessage = (ev) => this.handleWsMessage(ev);
    });
  }

  private handleWsMessage(ev: MessageEvent): void {
    if (ev.data instanceof ArrayBuffer) {
      void this.enqueuePlayback(ev.data);
      return;
    }
    let msg: { type?: string; [k: string]: unknown };
    try { msg = JSON.parse(ev.data as string); } catch { return; }
    switch (msg.type) {
      case 'voice:opened':
      case 'voice:config_ack':
        break;
      case 'voice:state':
        if (typeof msg.state === 'string' && this.state !== 'capturing') {
          // A server "listening" hint must not end "speaking" before
          // playback drains; tts_end owns that transition.
          if (msg.state === 'listening' && this.state === 'speaking' && this.scheduledSources.length > 0) break;
          this.setState(msg.state as VoiceState);
        }
        break;
      case 'voice:stt_partial':
        if (typeof msg.text === 'string') this.emit('partial-transcript', msg.text);
        break;
      case 'voice:notice':
        if (typeof msg.message === 'string' && msg.message.length > 0) {
          this.emit('notice', msg.message);
        }
        break;
      case 'voice:wake_detected': {
        const remainder = typeof msg.remainder === 'string' ? msg.remainder : null;
        this.emit('wake', {
          phrase: typeof msg.phrase === 'string' ? msg.phrase : this.wakePhrase,
          remainder,
        });
        // Chime on a bare wake only; with a remainder the agent answers, so a chime is noise.
        if (!remainder) this.playChime('/wake-chime.wav');
        break;
      }
      case 'voice:sleep_detected':
        this.emit('sleep', {
          phrase: typeof msg.phrase === 'string' ? msg.phrase : this.sleepPhrase,
        });
        // Server cancelled TTS; drop in-flight chunks too (same gate as barge-in).
        this.discardIncomingAudio = true;
        this.cancelPlayback();
        this.playChime('/sleep-chime.wav');
        break;
      case 'voice:prompt_submitted':
        // The chime marks a real submission, not a silently dropped backchannel.
        this.playChime('/prompt-sent.wav');
        break;
      case 'voice:stt_final':
        if (typeof msg.text === 'string') this.emit('final-transcript', msg.text);
        this.setState('waiting');
        break;
      case 'voice:tts_start':
        // New agent reply: re-open the playback gate that barge-in shut.
        this.discardIncomingAudio = false;
        this.ttsEndPendingPlayback = false;
        this.setState('speaking');
        this.emit('tts-start');
        break;
      case 'voice:tts_end':
        this.emit('tts-end', { interrupted: msg.interrupted === true });
        if (this.state === 'capturing') break;
        // Always defer: tts_end can outrun the WAV chunks that arrived just
        // before it, so a now-empty queue may refill and return to speaking.
        this.ttsEndPendingPlayback = true;
        this.scheduleTtsEndTransition();
        break;
      default:
        break;
    }
  }

  private handleSpeechStart(): void {
    if (this.state === 'speaking') {
      if (!this.bargeInEnabled) {
        // The agent's TTS echoes into the mic; suppressing this start without
        // its matching end would flip the UI to transcribing mid-reply.
        this.suppressedCurrentUtterance = true;
        this.isCapturing = false;
        return;
      }
      this.discardIncomingAudio = true;
      this.cancelPlayback();
      try { this.ws?.send(JSON.stringify({ type: 'barge_in' })); } catch { /* ignore */ }
    }
    this.suppressedCurrentUtterance = false;
    this.setState('capturing');
    try { this.ws?.send(JSON.stringify({ type: 'utterance_start' })); } catch { /* ignore */ }
  }

  private handleSpeechEnd(audio: Float32Array): void {
    if (this.suppressedCurrentUtterance) {
      this.suppressedCurrentUtterance = false;
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Includes the pre-speech pad, so it keeps the first words the live
    // frames (which start at onSpeechStart) miss: this is the final transcript.
    try {
      this.ws.send(JSON.stringify({ type: 'utterance_canonical' }));
      // Copy: vad-web reuses the underlying memory between callbacks.
      const copy = new Float32Array(audio.length);
      copy.set(audio);
      this.ws.send(copy.buffer);
      this.ws.send(JSON.stringify({ type: 'utterance_end' }));
    } catch (err) {
      this.fail('send_utterance_failed', err);
      return;
    }
    this.setState('transcribing');
  }

  // Chime WAVs decode once and cache per URL, played through the unlocked context.
  private chimeBuffers = new Map<string, AudioBuffer>();
  private chimeLoading = new Map<string, Promise<AudioBuffer | null>>();

  private async loadChime(url: string): Promise<AudioBuffer | null> {
    const cached = this.chimeBuffers.get(url);
    if (cached) return cached;
    const inflight = this.chimeLoading.get(url);
    if (inflight) return inflight;
    if (!this.audioContext) return null;
    const ctx = this.audioContext;
    const loading = (async () => {
      try {
        // Through lib/api even for an asset URL: one mockable network seam.
        const sent = await fetchUrl(url);
        if (!sent.ok) return null;
        const res = sent.response;
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(buf);
        this.chimeBuffers.set(url, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.chimeLoading.delete(url);
      }
    })();
    this.chimeLoading.set(url, loading);
    return loading;
  }

  private playChime(url: string): void {
    if (!this.soundEffectsEnabled) return;
    if (!this.audioContext) return;
    const ctx = this.audioContext;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => { /* ignore */ });
    }
    void (async () => {
      const buffer = await this.loadChime(url);
      if (!buffer) return;
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(ctx.currentTime);
      } catch { /* chime is best-effort, never block on it */ }
    })();
  }

  private async enqueuePlayback(buf: ArrayBuffer): Promise<void> {
    if (!this.audioContext) return;
    // Barge-in drop: skip the chunk; re-checked after the async decode.
    if (this.discardIncomingAudio) return;
    // iOS suspends the context on screen lock or app switch; resume first or
    // the chunk lands in a silent queue.
    if (this.audioContext.state === 'suspended') {
      try { await this.audioContext.resume(); } catch { /* ignore */ }
    }
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.audioContext.decodeAudioData(buf.slice(0));
    } catch (err) {
      console.warn('[voice] decodeAudioData failed', err);
      return;
    }
    // Re-check: barge-in may have fired during decode, and a buffer that
    // played on would talk over the user.
    if (this.discardIncomingAudio) return;
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;
    this.scheduledSources.push(source);
    source.onended = () => {
      const idx = this.scheduledSources.indexOf(source);
      if (idx >= 0) this.scheduledSources.splice(idx, 1);
      if (this.scheduledSources.length === 0 && this.ttsEndPendingPlayback) {
        this.ttsEndPendingPlayback = false;
        if (this.state === 'speaking') this.setState('listening');
      }
    };

    if (this.state === 'transcribing' || this.state === 'waiting' || this.state === 'listening') {
      this.setState('speaking');
    }
    if (this.ttsEndPendingPlayback) {
      this.scheduleTtsEndTransition();
    }
  }

  private cancelPlayback(): void {
    for (const src of this.scheduledSources) {
      try { src.onended = null; src.stop(); } catch { /* ignore */ }
    }
    this.scheduledSources = [];
    this.ttsEndPendingPlayback = false;
    if (this.ttsEndTimeout !== null) {
      clearTimeout(this.ttsEndTimeout);
      this.ttsEndTimeout = null;
    }
    if (this.audioContext) this.nextStartTime = this.audioContext.currentTime;
  }

  // Fallback timer that leaves 'speaking' when the last chunk should be done;
  // rescheduling per call lets late chunks extend the deadline, not fire early.
  private scheduleTtsEndTransition(): void {
    if (!this.ttsEndPendingPlayback) return;
    if (!this.audioContext) {
      // No audio context to time against, so just transition.
      if (this.state === 'speaking') this.setState('listening');
      this.ttsEndPendingPlayback = false;
      return;
    }
    if (this.ttsEndTimeout !== null) clearTimeout(this.ttsEndTimeout);
    const remainingSec = Math.max(0, this.nextStartTime - this.audioContext.currentTime);
    const graceMs = 500;
    this.ttsEndTimeout = window.setTimeout(() => {
      this.ttsEndTimeout = null;
      if (!this.ttsEndPendingPlayback) return;
      this.ttsEndPendingPlayback = false;
      this.scheduledSources = [];
      if (this.state === 'speaking') this.setState('listening');
    }, remainingSec * 1000 + graceMs);
  }
}
