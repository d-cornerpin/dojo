// ════════════════════════════════════════
// Twilio Voice call session (v2.9.18)
//
// One instance per active phone call (inbound or outbound). Owns the
// per-call state machine that bridges Twilio's Media Streams
// WebSocket to the agent runtime:
//
//   Caller speaks → μ-law frames in → decode/upsample to Float32 16k
//   → VAD-gated buffering → at utterance end, run STT → submit
//   transcript to primary agent as `[SOURCE: PHONE CALL FROM <num>]`
//   → agent responds → Kokoro/Hume TTS → downsample/μ-law encode →
//   paced 20ms frame send-back over the same WebSocket.
//
// Call lifecycle:
//   - new CallSession(...) on `start` event
//   - frame() called per inbound media frame
//   - finish() called on `stop` event or explicit end()
//   - call log row updated throughout
//
// Per-call max-duration cap (Settings → Voice). Tools are NOT
// recorded - transcripts only.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { startVoiceSessionRecord, endVoiceSessionRecord, bumpVoiceSessionTurnCount, stampSpokenMessage } from '../voice/session-record.js';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, getOwnerName } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import {
  decodeTwilioFrame,
  encodeForTwilio,
  chunkForTwilio,
  muLawEncode,
  float32ToInt16At8k,
  createBiquadState,
  applyAntiAliasLP,
  type BiquadState,
} from './audio-codec.js';
import { getTwilioConfig } from './auth.js';
import { getTwilioVoiceSafeCallers } from '../services/channel-safe-senders.js';
import { addressesMatch } from '../services/imessage-bridge.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';

const logger = createLogger('twilio-call-session');

// Simple energy-based VAD constants. Tunable.
const VAD_FRAME_MS = 20;
// 600 ms silence (was 800) — phone audio has clean phoneme boundaries
// from G.711, so we can endpoint more aggressively than dashboard voice
// mode. Saves 200 ms per turn. Tune up if mid-sentence pauses cut off
// real phone-style speech ("uh... hold on... yeah").
const VAD_SILENCE_MS_TO_END = 600;
const VAD_MIN_SPEECH_MS = 250;     // Drop micro-utterances (button noise, breath).
const VAD_ENERGY_THRESHOLD = 0.01; // RMS in [0,1].
// ~200 ms of pre-onset context (10 × 20 ms Twilio frames) so STT
// catches the leading edge of the utterance, not a half-clipped word.
const LOOKBACK_FRAMES = 10;

const TWILIO_FRAME_INTERVAL_MS = 20;

export interface CallSessionInit {
  callSid: string;
  streamSid: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  send: (msg: string) => void;  // JSON string sender on the WS
  // v2.9.23 phone-mode context. Optional at construct time — voicemail
  // is updated when AMD resolves, disclosures are owner policy, purpose
  // comes from outbound `voice_call(purpose=...)` args.
  voicemailDetected?: boolean;
  disclosuresRequired?: string[];
  purpose?: string;
}

interface PendingTtsChunk {
  pcm: Float32Array;
  sampleRate: number;
}

export class CallSession {
  readonly callSid: string;
  readonly streamSid: string;
  readonly direction: 'inbound' | 'outbound';
  readonly fromNumber: string;
  readonly toNumber: string;
  private send: (msg: string) => void;

  private readonly logRowId: string;
  private started = false;
  private ended = false;
  private endReason: string | null = null;
  private agentId: string | null = null;
  private startedAt = Date.now();
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  // Inbound buffering + VAD state.
  private speechBuffer: Float32Array[] = [];
  private speechSamples = 0;
  private hasSpeech = false;
  private silenceMs = 0;
  private speechMs = 0;

  // Diagnostic counters (dev-only). Helpful for figuring out whether
  // frames are arriving from Twilio and what the VAD energy looks
  // like for phone-quality audio.
  private framesReceived = 0;
  private framesLogged = 0;
  private peakEnergy = 0;

  // Anti-aliasing lowpass state for the 8 kHz → 16 kHz upsample.
  // IIR biquad, two-pole, must persist across frames or the 20 ms
  // frame boundaries introduce audible discontinuities.
  private aaLpState: BiquadState = createBiquadState();

  // Rolling pre-onset lookback so the first phoneme of an utterance
  // isn't clipped when VAD onset fires mid-word. Fixed-length ring;
  // entries shift out as new frames come in.
  private lookbackRing: Float32Array[] = [];

  // Outbound TTS pacing queue.
  private ttsQueue: PendingTtsChunk[] = [];
  private ttsTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCarry: Buffer = Buffer.alloc(0);

  // v2.10.1 — serial sentence-text queue. Streaming TTS feeds text
  // here one sentence at a time; a single drain worker pulls texts
  // in FIFO order, runs synth, and pushes the PCM to ttsQueue
  // strictly in submission order. Replaces the fire-and-forget
  // per-sentence IIFE that landed in 2.10.0 and produced
  // out-of-order audio whenever Hume socket-open jitter delayed
  // any single sentence.
  private pendingSpeechTexts: Array<{ text: string; generation: number }> = [];
  private speechSynthRunning = false;
  // Generation counter — incremented on barge-in so any sentence
  // still being synthesized OR still in pendingSpeechTexts gets
  // dropped instead of being played seconds after the caller spoke.
  private speechGeneration = 0;

  // Running transcript stitched at the end into twilio_call_log.transcript.
  private transcript: Array<{ at: string; speaker: 'caller' | 'agent'; text: string }> = [];
  private voiceSessionRecordId: string | null = null;

  // v2.9.23 phone-mode call context. Mutable: AMD flips voicemailDetected
  // when the answering-machine result arrives; the rest is set at
  // construct time (inbound: defaults; outbound: from voice_call args).
  voicemailDetected: boolean = false;
  disclosuresRequired: string[] = [];
  purpose: string | null = null;

  // v2.9.23 — soft hangup window. When voice_call_end fires, we don't
  // disconnect immediately; we set this timer so the closing ritual
  // (recap → let-you-go → trade goodbyes) can complete. Caller speech
  // during the window cancels the pending hangup and the call resumes.
  private pendingHangupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHangupReason: string | null = null;

  constructor(init: CallSessionInit) {
    this.callSid = init.callSid;
    this.streamSid = init.streamSid;
    this.direction = init.direction;
    this.fromNumber = init.fromNumber;
    this.toNumber = init.toNumber;
    this.send = init.send;
    this.voicemailDetected = init.voicemailDetected ?? false;
    this.disclosuresRequired = init.disclosuresRequired ?? [];
    this.purpose = init.purpose ?? null;
    this.logRowId = uuidv4();
    this.agentId = getPrimaryAgentId();
    this.startedAt = Date.now();
    this.persistInitialLog();
    // P8: one session identity space for the spoken lane. twilio_call_log
    // stays the call's own record; this row joins the call to voice identity
    // (speaker stamps + reply binding key on it).
    this.voiceSessionRecordId = this.agentId ? startVoiceSessionRecord({
      agentId: this.agentId, kind: 'phone', externalId: this.callSid,
    }) : null;
    this.armMaxDuration();
    logger.info('CallSession started', {
      callSid: this.callSid, streamSid: this.streamSid, direction: this.direction,
      from: this.fromNumber, to: this.toNumber, agentId: this.agentId,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  private persistInitialLog(): void {
    try {
      getDb().prepare(`
        INSERT OR IGNORE INTO twilio_call_log (
          id, call_sid, direction, from_number, to_number, status, handler,
          started_at, agent_id
        ) VALUES (?, ?, ?, ?, ?, 'in-progress', 'agent', datetime('now'), ?)
      `).run(
        this.logRowId,
        this.callSid,
        this.direction,
        this.fromNumber,
        this.toNumber,
        this.agentId,
      );
    } catch (err) {
      logger.warn('CallSession log insert failed', {
        callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private armMaxDuration(): void {
    const cfg = getTwilioConfig();
    const ms = Math.max(60_000, cfg.voiceMaxMinutesPerCall * 60_000);
    this.maxDurationTimer = setTimeout(() => {
      logger.warn('Call hit max duration cap, ending', { callSid: this.callSid });
      this.end('max_duration_reached');
    }, ms);
  }

  /** Twilio `start` event - real audio about to flow. */
  start(): void {
    this.started = true;
    // Kick the TTS pump in case queueAgentSay was called BEFORE the
    // WebSocket connected and `start` fired (typical for outbound:
    // the opening_message lands on the queue immediately, but we
    // can't pump it out until the actual `send` is bound by
    // voice-stream.ts on the WS `start` event).
    if (this.ttsQueue.length > 0 && !this.ttsTimer) this.scheduleTtsPump();

    // v2.9.23 — STT pre-warm. Moonshine takes ~600 ms to load its
    // ONNX pipeline on first use. Pre-fix we paid that cost on the
    // FIRST caller utterance, adding a noticeable delay to the
    // opening turn. Kicking it off here (fire-and-forget) means the
    // pipeline is hot by the time the caller's first sentence flushes
    // to STT. No-op if already loaded (engine registry caches).
    void (async () => {
      try {
        const { ensureSttReady } = await import('../voice/stt-service.js');
        await ensureSttReady();
      } catch (err) {
        logger.warn('STT pre-warm failed (non-fatal)', {
          callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // Dev confidence ping: speak a short opener 1.5 s after the WS
    // hands off so the caller hears SOMETHING within a couple seconds
    // of "Connected" even if STT/agent paths aren't fully working yet.
    // Inbound calls only - outbound flows already supply their own
    // opening_message via voice-outbound.
    if (this.direction === 'inbound') {
      setTimeout(() => {
        if (this.ended) return;
        void this.queueAgentSay('Hello there!');
      }, 1500);
    }
  }

  /**
   * Process one inbound μ-law base64 frame. Decodes, runs VAD, and
   * once a complete utterance is detected, hands the transcript off
   * to the agent runtime.
   */
  async frame(payloadBase64: string): Promise<void> {
    if (this.ended || !this.started) return;
    // decodeTwilioFrame produces linearly-interpolated 16 kHz Float32.
    // The anti-aliasing lowpass strips the spectral images above
    // ~3.4 kHz that the cheap upsampler creates; without it,
    // Moonshine refuses to transcribe phone audio (returns empty).
    const rawDecoded = decodeTwilioFrame(payloadBase64);
    const float = applyAntiAliasLP(rawDecoded, this.aaLpState);

    // Maintain a small rolling pre-speech ring so the eventual STT
    // buffer includes ~200 ms of context BEFORE VAD-onset (avoids
    // clipping the first phoneme). Always update the ring, even when
    // not in active speech, so the lookback is fresh when onset fires.
    this.lookbackRing.push(float);
    while (this.lookbackRing.length > LOOKBACK_FRAMES) {
      this.lookbackRing.shift();
    }

    // Only buffer into the speech buffer when VAD has detected
    // speech onset. Pre-onset silence stays in the lookback ring and
    // gets prepended only on the first speech-frame after onset.
    // This keeps the STT buffer small and content-dense — pre-fix,
    // the buffer accumulated every frame since the last flush, so a
    // 10-second silence between utterances produced a 12-second
    // buffer with 2 seconds of speech that Moonshine couldn't parse.
    if (this.hasSpeech) {
      this.speechBuffer.push(float);
      this.speechSamples += float.length;
    }

    const energy = rms(float);
    if (energy > this.peakEnergy) this.peakEnergy = energy;
    this.framesReceived++;
    // Log first frame and then every ~1s of audio (50 frames at 20ms)
    // to confirm media is flowing without spamming.
    if (this.framesReceived === 1 || this.framesReceived - this.framesLogged >= 50) {
      logger.info('Twilio frames', {
        callSid: this.callSid,
        framesReceived: this.framesReceived,
        peakEnergy: Number(this.peakEnergy.toFixed(4)),
        currentEnergy: Number(energy.toFixed(4)),
        threshold: VAD_ENERGY_THRESHOLD,
        hasSpeech: this.hasSpeech,
      });
      this.framesLogged = this.framesReceived;
    }

    if (energy > VAD_ENERGY_THRESHOLD) {
      this.silenceMs = 0;
      this.speechMs += VAD_FRAME_MS;
      if (!this.hasSpeech) {
        logger.info('VAD: speech started', { callSid: this.callSid, energy: Number(energy.toFixed(4)) });
        // v2.9.23 — BARGE-IN. If we were actively pumping TTS to the
        // caller AND the caller started talking, yield: flush the rest
        // of our outbound audio and let them go. Pre-fix the agent
        // talked over the caller until the queue drained, which is the
        // most robotic-feeling phone behavior possible.
        //
        // v2.10.1 — also bump the speech generation counter and clear
        // pendingSpeechTexts. Any sentence still queued for synth (or
        // in-flight inside drainSpeechTexts) gets dropped instead of
        // playing after the caller has gone again. Pre-fix, the model
        // kept generating sentences into the worker queue and those
        // played AFTER barge-in completed — caller would speak, brief
        // silence, then a stale sentence from the prior turn.
        if (
          this.ttsQueue.length > 0 ||
          this.ttsCarry.length > 0 ||
          this.pendingSpeechTexts.length > 0
        ) {
          const drained = this.ttsQueue.length;
          const carryBytes = this.ttsCarry.length;
          const droppedTexts = this.pendingSpeechTexts.length;
          this.ttsQueue = [];
          this.ttsCarry = Buffer.alloc(0);
          this.pendingSpeechTexts = [];
          this.speechGeneration += 1;
          if (this.ttsTimer) {
            clearTimeout(this.ttsTimer);
            this.ttsTimer = null;
          }
          logger.info('Barge-in: yielded TTS to caller', {
            callSid: this.callSid,
            droppedChunks: drained,
            droppedCarryBytes: carryBytes,
            droppedPendingTexts: droppedTexts,
            newGeneration: this.speechGeneration,
          });
        }
        // v2.9.23 — soft hangup cancellation. If a hangup was pending
        // (agent said goodbye, engine was waiting for caller's bye),
        // the caller speaking again means they aren't done — cancel.
        if (this.pendingHangupTimer) {
          clearTimeout(this.pendingHangupTimer);
          this.pendingHangupTimer = null;
          logger.info('Soft hangup cancelled: caller resumed speaking', {
            callSid: this.callSid, originalReason: this.pendingHangupReason,
          });
          this.pendingHangupReason = null;
        }
        // Onset: drain the lookback ring into the speech buffer so
        // the first phoneme of the utterance isn't clipped. The
        // current frame (energy > threshold) is appended below by
        // the hasSpeech=true branch — but the lookback is BEFORE
        // it, so prepend here.
        for (const c of this.lookbackRing) {
          this.speechBuffer.push(c);
          this.speechSamples += c.length;
        }
        // Note: current `float` / `rawDecoded` are already in the
        // lookback (we pushed at the top), so the buffer now ends
        // with them. No need to re-append. Setting hasSpeech=true
        // below is what enables future frames to flow in.
      }
      this.hasSpeech = true;
    } else {
      if (this.hasSpeech) this.silenceMs += VAD_FRAME_MS;
    }

    if (this.hasSpeech && this.silenceMs >= VAD_SILENCE_MS_TO_END) {
      const buf = this.flushBuffer();
      const speechMsCaptured = this.speechMs;
      this.silenceMs = 0;
      this.hasSpeech = false;
      this.speechMs = 0;
      logger.info('VAD: utterance complete, flushing to STT', {
        callSid: this.callSid,
        sampleCount: buf.length,
        speechMs: speechMsCaptured,
        meetsMin: buf.length / 16 >= VAD_MIN_SPEECH_MS,
      });
      if (buf.length / 16 >= VAD_MIN_SPEECH_MS) {
        // 16 samples/ms at 16 kHz.
        await this.handleUtterance(buf);
      }
    }
  }

  private flushBuffer(): Float32Array {
    const total = this.speechSamples;
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.speechBuffer) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.speechBuffer = [];
    this.speechSamples = 0;
    return out;
  }

  private async handleUtterance(pcm16k: Float32Array): Promise<void> {
    let text = '';
    const t0 = Date.now();
    try {
      // Wrap as 16k WAV and send to existing STT path. transcribeBuffer
      // is the lowest-friction entry point - it auto-routes to whichever
      // engine the user has configured (Moonshine default).
      const wav = floatToWav(pcm16k, 16000);
      // SECURITY (2026-07-27, PHASE-0 T12b / P553): every caller utterance used
      // to be written here to `/tmp/dojo-twilio-utterances` as two WAVs — a
      // world-readable, unbounded, never-cleaned recording of every phone call
      // the box handled, kept unconditionally in production because a biquad
      // investigation left its diagnostic behind. It is deleted, along with the
      // parallel pre-biquad buffer (rawBuffer/rawSamples/lookbackRingRaw/
      // flushRawBuffer) that existed only to feed it. If a debug capture is
      // genuinely wanted again it comes back as an opt-in behind the test kit,
      // never as an always-on write to a shared directory.
      const { transcribeBuffer } = await import('../voice/stt-service.js');
      const r = await transcribeBuffer(wav, { mime: 'audio/wav' });
      text = r.text.trim();
      logger.info('STT result', {
        callSid: this.callSid,
        sampleCount: pcm16k.length,
        durationMs: Date.now() - t0,
        textPreview: text.slice(0, 100),
        textLength: text.length,
      });
    } catch (err) {
      logger.warn('Inbound utterance STT failed', {
        callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!text) return;
    this.transcript.push({ at: new Date().toISOString(), speaker: 'caller', text });
    logger.info('Caller utterance', { callSid: this.callSid, text: text.slice(0, 200) });

    // Submit to the agent runtime as a user-role message.
    const primaryId = this.agentId ?? getPrimaryAgentId();
    if (!primaryId) {
      logger.warn('No primary agent, dropping utterance', { callSid: this.callSid });
      return;
    }
    // v2.9.23 — resolve the OTHER party's number (not necessarily
    // `fromNumber`) to a friendly name. For inbound calls the other
    // party IS `fromNumber`; for outbound calls the other party is
    // `toNumber` (Twilio sets webhook From = our Twilio number and
    // To = the dialed party). The dashboard badge wants "from the owner"
    // either way; using `fromNumber` blindly surfaced our own Twilio
    // number on outbound calls (production note 2026-06-07).
    const otherPartyNumber =
      this.direction === 'outbound' ? this.toNumber : this.fromNumber;
    const otherPartyName = resolveTwilioCallerName(otherPartyNumber);
    const otherPartyDisplay = otherPartyName ?? otherPartyNumber;
    const sourceTag = `[SOURCE: PHONE CALL FROM ${otherPartyDisplay}]`;
    // The trailer's `To:` is for engine diagnostics only and reflects
    // the actual technical destination of the leg (which is `toNumber`
    // for outbound, `fromNumber` for inbound — i.e. the other side of
    // what the badge shows).
    const trailerToNumber =
      this.direction === 'outbound' ? this.fromNumber : this.toNumber;
    // v2.9.23 — phone-mode call context lines (parsed by prompt assembler
    // to drive the inbound-vs-outbound, voicemail, and disclosure prompt
    // branches per the dojo phone-mode rules doc). Hidden from the user
    // bubble in non-wordy mode alongside the SID/To trailer.
    const callbackNumber = this.direction === 'outbound' ? this.fromNumber : this.toNumber;
    const trailer =
      `Call SID: ${this.callSid}\n` +
      `To: ${trailerToNumber}\n` +
      `Direction: ${this.direction}\n` +
      `Voicemail: ${this.voicemailDetected ? 'true' : 'false'}\n` +
      `Disclosures: ${this.disclosuresRequired.join(',')}\n` +
      `Their Name: ${otherPartyName ?? ''}\n` +
      `Purpose: ${this.purpose ?? ''}\n` +
      `Callback: ${callbackNumber}`;
    const content = `${sourceTag}\n\n${text}\n\n${trailer}`;
    const msgId = uuidv4();
    try {
      // P5: conversation identity = the caller's number; call sid = external id.
      const conversationId = resolveOrCreateConversation(primaryId, {
        channel: 'phone', provider: 'twilio', counterpartyId: this.fromNumber ?? null, threadRoot: null,
      });
      // v3.0.9 — structured routing metadata. Stamped synchronously before
      // handleMessage runs below so the turn reads it. A live call is already
      // connected, so the reply is always spoken back via TTS to whoever is
      // on the line (authorized:true — no safe-sender gate; you answered).
      const inboundMetaObj = {
        channel: 'phone' as const,
        accountKind: 'agent' as const,
        authorized: true,
        sender: this.fromNumber,
        phoneCallSid: this.callSid,
        phoneFromNumber: this.fromNumber,
        recipientAddress: this.fromNumber,
      };
      // T4/OR4: channel, sender and the auth verdict are stamped IN the write, from
      // the meta this leg already holds — never re-derived. recordInboundMeta below
      // still records the full blob (call sid, from number, reply address).
      // insertMessageIfAbsent keeps the call-sid de-duplication of INSERT OR IGNORE.
      insertMessageIfAbsent({
        id: msgId,
        agentId: primaryId,
        role: 'user',
        content,
        conversationId,
        externalMessageId: this.callSid ?? null,
        channel: inboundMetaObj.channel,
        senderId: inboundMetaObj.sender,
        authorized: inboundMetaObj.authorized,
      });
      // P8 speaker stamp on the id we hold (race-free) + session turn count.
      stampSpokenMessage(msgId, 'caller', this.voiceSessionRecordId);
      bumpVoiceSessionTurnCount(this.voiceSessionRecordId);
      recordInboundMeta(msgId, inboundMetaObj);
      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: msgId, agentId: primaryId, role: 'user' as const,
          content,
          // Carry the SAME structured inbound_meta into the live broadcast that
          // the DB row holds, so ws.ts stampChatMessageOrigin derives identical
          // attribution live and on refetch (mirrors iMessage OPEN-13).
          inboundMeta: JSON.stringify(inboundMetaObj),
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      const runtime = getAgentRuntime();
      void runtime.handleMessage(primaryId, content).catch(err => {
        logger.error('runtime.handleMessage failed on call utterance', {
          callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.error('Failed to persist call utterance', {
        callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Outbound TTS ───────────────────────────────────────────────

  /**
   * Speak text out to the caller using the configured TTS engine.
   * Stitches audio into 20 ms μ-law frames and paces them out via
   * the Media Streams WebSocket. Multiple queueAgentSay calls
   * concatenate; the pacing timer drains the queue at real-time.
   */
  async queueAgentSay(text: string): Promise<void> {
    if (this.ended) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.transcript.push({ at: new Date().toISOString(), speaker: 'agent', text: trimmed });
    logger.info('Agent says', { callSid: this.callSid, text: trimmed.slice(0, 200) });
    // v2.10.1 — enqueue text + current generation, then kick the
    // single-flight drain worker. The worker pulls items in FIFO
    // order and runs synth serially so the PCM lands in ttsQueue
    // in submission order. Sentences submitted with an older
    // generation than the current one (i.e. before a barge-in)
    // get skipped by the worker.
    this.pendingSpeechTexts.push({ text: trimmed, generation: this.speechGeneration });
    void this.drainSpeechTexts();
  }

  /**
   * Single-flight drain over `pendingSpeechTexts`. Runs synth one
   * sentence at a time and pushes resulting PCM strictly in order.
   * Generation gating drops any sentence enqueued before the most
   * recent barge-in. TTS failures (e.g. Hume socket error) skip
   * that sentence rather than falling back to a different engine,
   * to avoid mid-reply voice swaps.
   */
  private async drainSpeechTexts(): Promise<void> {
    if (this.speechSynthRunning) return;
    this.speechSynthRunning = true;
    try {
      while (this.pendingSpeechTexts.length > 0 && !this.ended) {
        const item = this.pendingSpeechTexts.shift()!;
        if (item.generation < this.speechGeneration) {
          logger.info('TTS skipped (stale generation, post-barge-in)', {
            callSid: this.callSid, textPreview: item.text.slice(0, 60),
            itemGeneration: item.generation, current: this.speechGeneration,
          });
          continue;
        }
        try {
          const { synthesizeForTwilio } = await import('./tts-bridge.js');
          const pcm = await synthesizeForTwilio(item.text);
          if (!pcm) {
            // Engine reported a real failure (Hume socket error,
            // missing voice config, etc.). Log + skip — do NOT swap
            // to a different engine for this sentence. Mid-reply
            // voice swaps are worse than a brief gap.
            logger.warn('TTS produced no audio for sentence (skipped)', {
              callSid: this.callSid, textPreview: item.text.slice(0, 60),
            });
            continue;
          }
          // Re-check generation AFTER synth — the caller may have
          // started speaking during synth, in which case we drop
          // the resulting audio instead of playing it.
          if (item.generation < this.speechGeneration) {
            logger.info('TTS dropped post-synth (stale generation)', {
              callSid: this.callSid, textPreview: item.text.slice(0, 60),
            });
            continue;
          }
          this.ttsQueue.push(pcm);
          if (this.started && !this.ttsTimer) this.kickTtsPump();
        } catch (err) {
          logger.warn('TTS for call utterance failed (skipped, no fallback)', {
            callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
            textPreview: item.text.slice(0, 60),
          });
        }
      }
    } finally {
      this.speechSynthRunning = false;
    }
  }

  private scheduleTtsPump(): void {
    this.ttsTimer = setTimeout(() => this.pumpTts(), TWILIO_FRAME_INTERVAL_MS);
  }

  /**
   * v2.9.23 — first-frame ship immediate. When new TTS arrives and
   * the pump isn't running, send the first frame on the current tick
   * rather than waiting one TWILIO_FRAME_INTERVAL_MS for the timer.
   * Saves 20 ms on every reply onset, which adds up across a call
   * full of turns.
   */
  private kickTtsPump(): void {
    if (this.ttsTimer) return;
    // Synchronous first pump; pumpTts re-schedules itself when there
    // is more to send.
    this.pumpTts();
  }

  private pumpTts(): void {
    if (this.ended) {
      this.ttsTimer = null;
      return;
    }
    // Convert one chunk at a time into μ-law, prepend any tail from
    // the prior chunk, slice into 160-byte frames, send one frame
    // per tick.
    if (this.ttsCarry.length < 160 && this.ttsQueue.length > 0) {
      const chunk = this.ttsQueue.shift()!;
      const pcm8k = float32ToInt16At8k(chunk.pcm, chunk.sampleRate);
      const muLaw = muLawEncode(pcm8k);
      this.ttsCarry = Buffer.concat([this.ttsCarry, muLaw]);
    }
    if (this.ttsCarry.length === 0) {
      this.ttsTimer = null;
      return;
    }
    const frames = chunkForTwilio(this.ttsCarry);
    const frame = frames.shift()!;
    this.ttsCarry = frames.length > 0
      ? Buffer.concat(frames)
      : Buffer.alloc(0);
    try {
      this.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: frame.toString('base64') },
      }));
    } catch {
      // WS closed under us - mark ended and stop pacing.
      this.end('ws_closed');
      return;
    }
    this.scheduleTtsPump();
  }

  // ── End handling ───────────────────────────────────────────────

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.ttsTimer) {
      clearTimeout(this.ttsTimer);
      this.ttsTimer = null;
    }
    endVoiceSessionRecord(this.voiceSessionRecordId, reason);
    const durationSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const transcriptText = this.transcript.length === 0
      ? null
      : this.transcript.map(t => `[${t.at}] ${t.speaker}: ${t.text}`).join('\n');
    try {
      getDb().prepare(`
        UPDATE twilio_call_log
        SET status = 'completed',
            ended_at = datetime('now'),
            duration_seconds = ?,
            transcript = ?,
            ended_reason = ?
        WHERE id = ?
      `).run(durationSeconds, transcriptText, reason, this.logRowId);
    } catch (err) {
      logger.warn('CallSession final log update failed', {
        callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('CallSession ended', {
      callSid: this.callSid, reason, durationSeconds, transcriptLines: this.transcript.length,
    });
  }

  isEnded(): boolean { return this.ended; }

  /**
   * v2.9.23 — soft hangup. Schedule disconnect after a delay rather
   * than ending the call instantly when `voice_call_end` fires. The
   * delay lets the closing ritual finish (caller's "bye"). If the
   * caller speaks again during the window, the VAD-onset path cancels
   * the timer and the call resumes.
   *
   * Calling this multiple times resets the timer (latest goodbye wins).
   * If the timer expires without caller speech, `end(reason)` fires.
   */
  requestSoftHangup(reason: string, delayMs = 6000): void {
    if (this.ended) return;
    if (this.pendingHangupTimer) {
      clearTimeout(this.pendingHangupTimer);
    }
    this.pendingHangupReason = reason;
    logger.info('Soft hangup scheduled', { callSid: this.callSid, reason, delayMs });
    this.pendingHangupTimer = setTimeout(() => {
      this.pendingHangupTimer = null;
      const r = this.pendingHangupReason ?? reason;
      this.pendingHangupReason = null;
      if (this.ended) return;
      logger.info('Soft hangup window elapsed; disconnecting', { callSid: this.callSid, reason: r });
      // Tear down via the module-level helper so the registry entry
      // is cleared too (end() alone leaves the sessionsByCallSid map
      // pointing at the dead session).
      endCallSession(this.callSid, r);
    }, delayMs);
  }

  hasPendingHangup(): boolean { return this.pendingHangupTimer !== null; }

  /**
   * Rebind the WS send-back. Used by voice-stream.ts when an
   * outbound-call's placeholder session (created with a no-op
   * sender) is connected to the actual WebSocket on `start`.
   */
  bindSend(send: (msg: string) => void, streamSid: string): void {
    this.send = send;
    (this as { streamSid: string }).streamSid = streamSid;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Build a WAV buffer wrapping mono Float32 PCM at the given rate. */
function floatToWav(pcm: Float32Array, sampleRate: number): Buffer {
  const numSamples = pcm.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);          // PCM
  buffer.writeUInt16LE(1, 22);          // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);          // block align
  buffer.writeUInt16LE(16, 34);         // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    let v = Math.round(pcm[i] * 32768);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    buffer.writeInt16LE(v, 44 + i * 2);
  }
  return buffer;
}

/** Whether an incoming caller number is allowlisted for direct agent connect. */
export function callerIsAllowlisted(fromNumber: string): boolean {
  try {
    const list = getTwilioVoiceSafeCallers();
    return list.some(s => addressesMatch(s.address, fromNumber));
  } catch {
    return false;
  }
}

/**
 * Resolve a phone number to the friendly name configured on the Twilio
 * voice safe-callers list. Returns the name if matched, or null when
 * the caller isn't in the list (or the lookup fails). Used to render
 * "from the owner via phone call" instead of "+15551234567".
 */
export function resolveTwilioCallerName(fromNumber: string): string | null {
  if (!fromNumber || fromNumber === '(unknown)') return null;
  try {
    const list = getTwilioVoiceSafeCallers();
    const hit = list.find(s => addressesMatch(s.address, fromNumber));
    return hit?.name?.trim() || null;
  } catch {
    return null;
  }
}

// ── Per-process session registry (call_sid → session) ─────────────

const sessionsByCallSid = new Map<string, CallSession>();

export function registerCallSession(s: CallSession): void {
  sessionsByCallSid.set(s.callSid, s);
}

export function getCallSession(callSid: string): CallSession | null {
  return sessionsByCallSid.get(callSid) ?? null;
}

export function endCallSession(callSid: string, reason: string): void {
  const s = sessionsByCallSid.get(callSid);
  if (s) s.end(reason);
  sessionsByCallSid.delete(callSid);
}

export function listActiveCallSessions(): Array<{ callSid: string; direction: string; fromNumber: string; toNumber: string }> {
  return [...sessionsByCallSid.values()].filter(s => !s.isEnded()).map(s => ({
    callSid: s.callSid,
    direction: s.direction,
    fromNumber: s.fromNumber,
    toNumber: s.toNumber,
  }));
}

// Suppress unused-import linting for getOwnerName / encodeForTwilio
// (used by other modules that import from here later).
void encodeForTwilio;
void getOwnerName;
