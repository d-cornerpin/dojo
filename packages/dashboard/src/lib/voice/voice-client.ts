/**
 * Browser-side voice mode client.
 *
 *   const client = new VoiceClient({ agentId });
 *   client.on('state-change', s => ...);
 *   await client.start();   // requests mic, opens WS, begins listening
 *   client.toggle();        // start/stop
 *   client.stop();          // tear down
 *
 * State machine: IDLE → LISTENING ↔ CAPTURING → TRANSCRIBING → WAITING → SPEAKING → LISTENING
 *
 * Barge-in: if VAD detects speech while we're SPEAKING, we cancel local playback,
 * tell the server to cancel TTS, and immediately transition to CAPTURING.
 */

import { MicVAD } from '@ricky0123/vad-web';
import * as ortEnv from 'onnxruntime-web';

export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'waiting'
  | 'speaking'
  | 'error'
  /** Wake-word mode: mic is on but transcripts are discarded until the
   *  configured wake phrase is heard. UI should make this visually distinct
   *  from `listening` so the user knows the agent is standing by. */
  | 'passive';

export interface VoiceClientOptions {
  agentId: string;
  voice?: string;
  speed?: number;
  /** Whisper model size to use server-side (e.g. "large-v3-turbo"). */
  sttModel?: string;
  /** How patient the VAD is about end-of-speech. quick≈200ms, normal≈500ms, patient≈1s. */
  vadSensitivity?: 'quick' | 'normal' | 'patient';
  /** Override for the WS endpoint; defaults to `/api/ws/voice`. */
  wsUrl?: string;
  /** When true, the session starts in passive mode and only "wakes up"
   *  when the configured wake phrase is detected. */
  wakeWordEnabled?: boolean;
  wakePhrase?: string;
  sleepPhrase?: string;
  /** When true, detected speech while the primary agent is speaking cancels TTS and
   *  starts a new utterance. Off by default — phone speakers echo TTS into
   *  the mic and false-trigger interruption every time. */
  bargeInEnabled?: boolean;
  /** When true, play the wake / sleep / prompt-sent chimes. On by default. */
  soundEffectsEnabled?: boolean;
}

// Silence after voice activity before we declare end-of-utterance and hand the
// buffer to the server. Smart Turn v3 now owns the SEMANTIC end-of-turn
// decision server-side, so the VAD only needs a short, fixed redemption to spot
// a pause quickly and hand off — completed turns stay snappy, and the old
// quick/normal/patient knob is repurposed into a server-side "turn-taking
// patience" hold window (Settings → Voice). Short enough to be responsive,
// long enough not to fire on every micro-pause.
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
  /** Wake phrase heard — session is now active. */
  'wake': (info: { phrase: string; remainder: string | null }) => void;
  /** Sleep phrase heard — session is back to passive. */
  'sleep': (info: { phrase: string }) => void;
  /** Mic mute state changed (user-driven via setMuted). */
  'muted-change': (muted: boolean) => void;
  /**
   * Transient, non-fatal server notice (e.g. the cloud voice hit a hiccup and
   * this reply is playing in the local voice instead). Unlike `error`, this
   * does NOT move the session into the error state: voice keeps working. The
   * consumer renders it as an info toast.
   */
  notice: (message: string) => void;
  error: (message: string) => void;
}

type Listener<T extends keyof VoiceClientEvents> = VoiceClientEvents[T];

function getToken(): string | null {
  return localStorage.getItem('dojo_token');
}

// VAD/ORT runtime assets are served by the dojo backend at /api/voice/assets/.
// Same-origin path goes through vite's /api proxy in dev → backend; in prod
// it's served by the same node process that serves the dashboard.
// We pass it as the wasmPaths PREFIX so ORT will fetch both .mjs and .wasm
// from that origin and vite's source-module resolver never sees them.
const VAD_ASSET_BASE = '/api/voice/assets/vad/';
const ORT_ASSET_BASE = '/api/voice/assets/ort/';

/**
 * Heuristic mobile detection — picks up iPhone, iPad, and modern Android
 * phones. Used to enable the half-duplex mic gate during TTS playback
 * (Phase 5.2). iPadOS 13+ pretends to be macOS via UA; check
 * `maxTouchPoints` to catch it. Desktops report 0–1 touch points; even
 * touchscreen Windows laptops max out at low single digits, but they
 * usually have proper speaker separation so a false positive there is
 * benign (you just lose barge-in while the agent speaks).
 */
function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|Android|Mobile|webOS/i.test(ua)) return true;
  // iPad disguised as macOS — has touch.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function configureOrt() {
  try {
    const env = (ortEnv as { env?: { wasm?: { wasmPaths?: string; numThreads?: number } } }).env;
    if (env?.wasm) {
      env.wasm.wasmPaths = ORT_ASSET_BASE;
      // Single-threaded build dodges Cross-Origin-Isolation requirements
      // (we don't enable COOP/COEP headers in dev). The silero model is tiny;
      // throughput is fine on one thread.
      env.wasm.numThreads = 1;
    }
  } catch { /* ignore */ }
}

export class VoiceClient {
  readonly agentId: string;
  voice: string;
  speed: number;
  sttModel: string;
  vadSensitivity: 'quick' | 'normal' | 'patient';
  wakeWordEnabled: boolean;
  wakePhrase: string;
  sleepPhrase: string;
  bargeInEnabled: boolean;
  soundEffectsEnabled: boolean;
  private wsUrl: string;

  state: VoiceState = 'idle';
  private ws: WebSocket | null = null;
  private vad: MicVAD | null = null;
  private audioContext: AudioContext | null = null;

  // Playback queue: scheduled source nodes + nextStartTime
  private scheduledSources: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  // After a barge-in, drop any WAV chunks the server already had in flight.
  // Kokoro can't be cancelled mid-sentence (abort signal is only checked
  // between sentences) so the server may still emit ~500ms–2s of audio
  // before the loop notices. Without this flag the cancelled audio would
  // arrive late, decode, and start playing after the user has begun their
  // next utterance — making barge-in feel "delayed by a few seconds".
  // Reset on the next `voice:tts_start` event (new agent reply).
  private discardIncomingAudio = false;
  // True between onSpeechStart and onSpeechEnd — when on, every VAD frame
  // (~32ms) is forwarded live to the server so it can run partial
  // transcriptions. Without this the server only sees a single big PCM
  // frame at end-of-speech and can never emit a partial.
  private isCapturing = false;
  // When true, the current speech-start was suppressed (echo while the primary agent
  // was speaking, barge-in disabled). The matching speech-end must also
  // be suppressed — otherwise we'd send utterance_end to the server and
  // flip the UI to "transcribing" mid-reply for nothing.
  private suppressedCurrentUtterance = false;
  // The server fires `voice:tts_end` the moment it finishes SENDING WAV
  // chunks, but the browser is still PLAYING the buffered audio for several
  // seconds afterwards. If we transition to 'listening' immediately, the
  // mic activates while the primary agent's still talking through the speaker, the echo
  // gets through (suppression is keyed on state==='speaking'), and we kick
  // off a phantom utterance. So we defer the transition: set this flag on
  // tts_end and actually flip to 'listening' from source.onended once the
  // last scheduled chunk finishes.
  private ttsEndPendingPlayback = false;
  // Handle to the setTimeout that force-transitions to 'listening' once the
  // last expected chunk should have finished. Reschedulable — if a new chunk
  // arrives AFTER tts_end (decodeAudioData races with the JSON event), we
  // bump the timer out to the new nextStartTime so we don't transition
  // mid-playback.
  private ttsEndTimeout: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners: { [K in keyof VoiceClientEvents]?: Set<any> } = {};
  private lastError: string | null = null;

  // User-driven mute. When true, the input MediaStreamTrack is disabled
  // (browser silences the audio; the OS-level "recording" indicator goes
  // away on macOS, iOS, Windows; no audio data reaches the VAD or the
  // server) AND the VAD frame processor is paused so we're not spinning
  // CPU on silence. TTS playback is unaffected — the agent can still
  // talk to the user while their mic is muted.
  private muted = false;

  constructor(opts: VoiceClientOptions) {
    this.agentId = opts.agentId;
    this.voice = opts.voice ?? 'am_michael';
    this.speed = opts.speed ?? 1;
    // Default STT is Moonshine, no native deps. The server resolves any
    // value here through parseSttModelKey, so a stale 'large-v3-turbo' in
    // a user's settings still works — they just keep their preference.
    this.sttModel = opts.sttModel ?? 'moonshine-base';
    // Default VAD redemption is 'quick' (200 ms). The prior 'normal'
    // (500 ms) default added half a second of dead air to every turn
    // before STT could even start — the latency tax was not worth its
    // accuracy tradeoff for natural conversation. Users can still pick
    // 'normal' or 'patient' from voice settings.
    this.vadSensitivity = opts.vadSensitivity ?? 'quick';
    this.wakeWordEnabled = opts.wakeWordEnabled ?? false;
    // Track however the user named their primary agent. Falls back to the
    // codebase's role-based phrasing if the wake phrase was never set.
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
    // Phase 5.2 — half-duplex on mobile. While the agent is speaking,
    // disable the mic input track so the VAD literally can't hear the
    // TTS playback (echoCancellation in 5.1 isn't enough on iPhone
    // loudspeaker; the speaker bleed is loud enough that silero will
    // false-trigger). Desktop is unaffected: the gate is mobile-only
    // because barge-in works fine when there's any real speaker
    // separation. Trade-off: barge-in is disabled on phones during
    // playback — accepted per plan.
    if (isMobileUserAgent()) {
      if (next === 'speaking' && prev !== 'speaking') {
        this.setMicTrackEnabled(false);
      } else if (prev === 'speaking' && next !== 'speaking') {
        // Don't re-enable the mic when leaving the speaking state if the
        // user has muted manually — their mute takes priority over the
        // half-duplex auto-toggle. Without this guard, the agent
        // finishing speaking would silently un-mute the mic the user
        // explicitly turned off.
        if (!this.muted) this.setMicTrackEnabled(true);
      }
    }
  }

  /**
   * Hardware-equivalent mute for the input microphone. Sets
   * `MediaStreamTrack.enabled = false` on every audio track of the VAD's
   * underlying stream — the browser silences the audio at the OS level
   * (recording indicators disappear on macOS / iOS / Windows; the tab
   * indicator dot also goes away), no audio data flows into the VAD,
   * STT, or the WebSocket. Also pauses the VAD's frame processor so
   * we're not spinning CPU on silence.
   *
   * Unmute reverses both: re-enables the track and resumes the VAD. No
   * `getUserMedia` round-trip, no permission re-prompt, instant.
   *
   * TTS playback is untouched — the agent can still speak to the user
   * while their mic is muted. Muting also turns off wake-word
   * processing for the duration of the mute (no audio frames = no wake
   * detection); on unmute, wake-word resumes if enabled.
   */
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

  /**
   * Toggle the input MediaStreamTrack on the VAD's underlying stream.
   * Used by the mobile half-duplex gate (Phase 5.2). The `_stream` field
   * is a verified private property on @ricky0123/vad-web@0.0.30.
   */
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
    this.lastError = null;
    // Each voice session starts unmuted regardless of how the last one
    // ended. Carrying mute state across an on/off cycle would be
    // counter-intuitive — turning voice mode off then back on should
    // feel like a fresh session, not "wait, why can't the agent hear me?"
    if (this.muted) {
      this.muted = false;
      this.emit('muted-change', false);
    }
    this.setState('connecting');

    // Surface insecure-context up front instead of letting getUserMedia fail
    // with an opaque NotAllowedError. iOS Safari + Chrome both require HTTPS
    // (or localhost) for mic access.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      this.fail('insecure_context', new Error('Voice mode needs HTTPS — open this site via the tunnel URL.'));
      return;
    }

    configureOrt();

    // Mic permission + audio context (must be created in a user gesture handler for some browsers).
    // We intentionally do NOT pass `sampleRate: 16000` here:
    //   - macOS Safari and iOS Safari silently ignore (or fail) AudioContext
    //     constructor sampleRate hints other than the device's native rate.
    //   - vad-web does its own internal resampling to 16 kHz for the mic path.
    //   - Kokoro WAVs are 24 kHz; decodeAudioData resamples them to whatever
    //     the context's actual rate is.
    // Letting the browser pick the native rate (usually 48 kHz) avoids the
    // case where construction failed silently and TTS playback never started.
    try {
      // Reuse the existing AudioContext if we have one (mic toggle off→on).
      // Creating a fresh context on iOS Safari sometimes leaves it permanently
      // unable to produce audio output even with the silent-buffer unlock;
      // resuming the original context sidesteps that entire class of bug.
      if (!this.audioContext || (this.audioContext as AudioContext & { state: AudioContextState }).state === 'closed') {
        this.audioContext = new AudioContext();
      }
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      // iOS unlock: an AudioContext created in `running` state still won't
      // produce audible output until a buffer has actually been played from
      // inside the user-gesture event. Play a 1-frame silent buffer right
      // now to satisfy that requirement — without it, all subsequent Kokoro
      // WAV chunks decode and schedule fine but the speaker stays silent.
      try {
        const unlock = this.audioContext.createBuffer(1, 1, 22_050);
        const src = this.audioContext.createBufferSource();
        src.buffer = unlock;
        src.connect(this.audioContext.destination);
        src.start(0);
      } catch { /* ignore — only iOS strictly needs this */ }
      // CRITICAL: nextStartTime is stateful and survives across toggles.
      // The previous session may have left it 30+ seconds in the future
      // (it accumulates per chunk for back-to-back playback). A fresh
      // AudioContext starts its currentTime at ~0, so without this reset
      // the first chunk of the NEW session is scheduled deep into the
      // future and the user hears nothing until that time elapses.
      // (2026-05-19: this caused "Will do." to play ~30s late after a
      // voice mode off/on cycle that followed a long prior response.)
      this.nextStartTime = this.audioContext.currentTime;
      // iOS aggressively suspends AudioContext when the tab backgrounds /
      // the phone locks. Resume on return so playback doesn't stay frozen.
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

    try {
      this.vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_ASSET_BASE,
        onnxWASMBasePath: ORT_ASSET_BASE,
        // Phase 5.1 — acoustic echo cancellation, noise suppression, and
        // AGC. @ricky0123/vad-web@0.0.30's default `getStream` already
        // requests all three in its getUserMedia call (see real-time-vad.js
        // getDefaultRealTimeVADOptions), so we intentionally do NOT override
        // it: the lib's defaults are exactly the constraints Phase 5.1
        // calls for. If we ever need extra constraints (a specific
        // deviceId, samplerate hint), override `getStream` here and merge
        // these three flags in by hand. Modern Safari honours
        // echoCancellation outside WebRTC, so this also helps iPhone — but
        // it's not enough on iPhone loudspeaker, which is why Phase 5.2
        // disables the mic track entirely during TTS playback.
        // Short fixed redemption — Smart Turn v3 makes the real end-of-turn
        // call server-side (see VAD_REDEMPTION_MS above).
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
          // Tiny utterance: just stay in listening.
          if (this.state === 'capturing') this.setState('listening');
        },
        // Per-frame (~32ms) probability that audio is speech. Used to drive
        // the live volume meter in the status banner AND to stream PCM live
        // to the server during active speech so partial transcriptions can
        // run mid-utterance. We also peek at the raw waveform RMS as a
        // backup signal — silero sometimes underreports probability on
        // low-volume voices while the meter still wants to pulse with the
        // user's actual loudness.
        onFrameProcessed: (probs, frame) => {
          const isSpeech = probs.isSpeech;
          let rms = 0;
          for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
          rms = Math.sqrt(rms / frame.length);
          const rmsLevel = Math.min(1, rms / 0.3);
          const level = Math.max(isSpeech, rmsLevel * 0.8);
          this.emit('audio-level', level);

          // Stream the frame live to the server during active speech so
          // it can accumulate enough audio to run a partial transcription
          // (~1s of speech ≈ 30 frames). Outside speech we drop the frame
          // so the server's buffer doesn't fill with ambient noise.
          if (this.isCapturing && this.ws?.readyState === WebSocket.OPEN) {
            // Copy: vad-web reuses the frame buffer between callbacks.
            const copy = new Float32Array(frame.length);
            copy.set(frame);
            try { this.ws.send(copy.buffer); } catch { /* ignore */ }
          }
        },
      });
      await this.vad.start();
      this.setState('listening');
    } catch (err) {
      // Mic permission denial surfaces as a NotAllowedError. Rewrite to
      // something a user can act on (the iOS Safari toast just says "an
      // error occurred" otherwise).
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
    try { this.vad?.destroy(); } catch { /* ignore */ }
    this.vad = null;
    this.cancelPlayback();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'close' })); } catch { /* ignore */ }
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    // iOS Safari: SUSPEND, don't close. Creating a second AudioContext later
    // in the same page sometimes refuses to ever play audio even with a fresh
    // silent-buffer unlock. Suspending and resuming the original context
    // keeps the audio-output "permission" intact across mic toggles.
    try { await this.audioContext?.suspend(); } catch { /* ignore */ }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.setState('idle');
  }

  // ── Internal ──

  private fail(detail: string, err?: unknown): void {
    const message = err instanceof Error ? err.message : String(err ?? detail);
    this.lastError = message;
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
        // Send config so server knows our preferred voice, speed, STT model,
        // sample rate, and wake-word settings.
        try {
          ws.send(JSON.stringify({
            type: 'config',
            voice: this.voice,
            speed: this.speed,
            sttModel: this.sttModel,
            pcmSampleRate: 16_000,
            wakeWordEnabled: this.wakeWordEnabled,
            wakePhrase: this.wakePhrase,
            sleepPhrase: this.sleepPhrase,
          }));
        } catch { /* ignore */ }
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('voice WS error'));
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          if (this.isActive()) this.setState('idle');
        }
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
          // Don't let a server-side "listening" hint kick us out of
          // 'speaking' before client-side playback has drained — that's
          // what the tts_end handler is for (deferred via onended).
          if (msg.state === 'listening' && this.state === 'speaking' && this.scheduledSources.length > 0) break;
          this.setState(msg.state as VoiceState);
        }
        break;
      case 'voice:stt_partial':
        if (typeof msg.text === 'string') this.emit('partial-transcript', msg.text);
        break;
      case 'voice:notice':
        // Non-fatal heads-up from the server (e.g. cloud-voice fell back to
        // local for this reply). Surfaced as an info toast; the session stays
        // live, so unlike an error this must NOT touch state.
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
        // Bare wake call — play a soft "I'm listening" chime so the user
        // knows it's safe to speak the actual prompt. Skip when remainder
        // is present (one-breath "Hey <agent>, remind me..." — the agent
        // will respond directly so a chime would just be noise).
        if (!remainder) this.playChime('/wake-chime.wav');
        break;
      }
      case 'voice:sleep_detected':
        this.emit('sleep', {
          phrase: typeof msg.phrase === 'string' ? msg.phrase : this.sleepPhrase,
        });
        // Tear down playback right away — server already cancelled TTS, but
        // any chunks already in flight should be dropped (same gate as barge-in).
        this.discardIncomingAudio = true;
        this.cancelPlayback();
        this.playChime('/sleep-chime.wav');
        break;
      case 'voice:prompt_submitted':
        // Server submitted the transcript to the agent. Confirm with a chime
        // so the user knows their message is on its way (and not a backchannel
        // we silently dropped).
        this.playChime('/prompt-sent.wav');
        break;
      case 'voice:stt_final':
        if (typeof msg.text === 'string') this.emit('final-transcript', msg.text);
        this.setState('waiting');
        break;
      case 'voice:tts_start':
        // New agent reply — re-open the playback gate that barge-in shut.
        this.discardIncomingAudio = false;
        this.ttsEndPendingPlayback = false;
        this.setState('speaking');
        this.emit('tts-start');
        break;
      case 'voice:tts_end':
        this.emit('tts-end', { interrupted: msg.interrupted === true });
        if (this.state === 'capturing') break;
        // ALWAYS defer the transition, even if scheduledSources is empty
        // right now. Reason: decodeAudioData is async, and a tts_end JSON
        // event can race ahead of the WAV chunks that arrived just before
        // it on the same WS. If we transition to 'listening' immediately,
        // the just-decoded chunks would push us BACK to 'speaking' (in
        // enqueuePlayback) and we'd have no signal to ever return — voice
        // mode wedges on 'agent speaking' for the rest of the session.
        // (Desktop regression introduced in v2.6.4 — race-condition bug.)
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
        // Phone speakers feed the primary agent's TTS back into the mic. iOS's hardware
        // AEC can't cancel browser-played audio reliably, so the VAD reads
        // the echo as user speech and false-triggers barge-in within a word
        // or two of TTS starting. Half-duplex while the primary agent speaks: suppress
        // this speech-start AND mark the utterance as suppressed so the
        // matching onSpeechEnd also no-ops (otherwise we'd flip the client
        // to 'transcribing' mid-reply with no actual audio to transcribe).
        // Toggle this on in Settings → Voice if you're on headphones or a
        // device with strong AEC and want voice-driven interruption back.
        this.suppressedCurrentUtterance = true;
        this.isCapturing = false;
        return;
      }
      // Barge-in: cancel local playback + tell server + start dropping
      // any in-flight WAV chunks the server hasn't stopped sending yet.
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
      // The matching speech-start was suppressed (echo while the agent was
      // speaking). Don't send utterance_end — there's nothing to transcribe
      // and we don't want to flip UI state away from 'speaking'.
      this.suppressedCurrentUtterance = false;
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // vad-web's `audio` callback arg is the canonical utterance buffer:
    // every sample from preSpeechPadMs (800ms default on 0.0.30) BEFORE
    // onSpeechStart fired, through the redemption tail. The live frames
    // we streamed while `isCapturing` was true START at onSpeechStart, so
    // they're missing the leading 800ms — which is exactly enough to
    // chop off the first word of every utterance ("Hey <agent>" → "<agent>",
    // "How are you feeling" → "feeling"). Fix: send the canonical buffer
    // at end-of-utterance and have the server use IT for the final
    // transcript instead of its accumulated streamed frames. Live frames
    // remain useful for partials only.
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

  /**
   * Plays one of the short feedback chimes (wake / sleep / prompt-sent) by
   * fetching the WAV on first use, caching the decoded AudioBuffer per URL,
   * and routing subsequent plays through the existing audioContext (which
   * is already unlocked because mic capture is active). Suppressed when
   * soundEffectsEnabled is false.
   */
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
        const res = await fetch(url);
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
    // Fast-path: barge-in is in effect — drop the chunk without decoding.
    // (Re-checked AFTER decodeAudioData too, since decode is async.)
    if (this.discardIncomingAudio) return;
    // iOS Safari aggressively suspends AudioContext (screen lock, switching
    // apps, sometimes after a long pause). Resume before we try to decode +
    // schedule, otherwise the chunk goes into a silent queue.
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
    // Re-check post-decode — barge-in may have fired while decodeAudioData
    // was running. Without this, the just-decoded buffer would still schedule
    // and play, which is exactly the "kept talking for several seconds after
    // I interrupted" symptom.
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
      // Last chunk drained AND server already said tts_end — NOW flip to
      // listening. Doing it any earlier and we'd activate the mic while
      // the primary agent is still audibly speaking, the echo would slip through (no
      // longer guarded by state==='speaking'), and we'd start an echo
      // utterance instead of waiting for the user.
      if (this.scheduledSources.length === 0 && this.ttsEndPendingPlayback) {
        this.ttsEndPendingPlayback = false;
        if (this.state === 'speaking') this.setState('listening');
      }
    };

    if (this.state === 'transcribing' || this.state === 'waiting' || this.state === 'listening') {
      this.setState('speaking');
    }
    // A chunk that lands AFTER tts_end has been processed (decode race)
    // pushes nextStartTime out. Rearm the timer for the new deadline,
    // otherwise the force-transition could fire mid-playback.
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

  /**
   * Arm (or rearm) the force-transition timer used to flip out of 'speaking'
   * after the last queued chunk should have finished playing. Idempotent —
   * cancel + reschedule each time it's called so late-arriving chunks (which
   * advance nextStartTime) push the deadline out instead of triggering early.
   */
  private scheduleTtsEndTransition(): void {
    if (!this.ttsEndPendingPlayback) return;
    if (!this.audioContext) {
      // No audio context to time against — just transition.
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
