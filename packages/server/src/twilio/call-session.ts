// Twilio Voice call session: one instance per active phone call (inbound or outbound), bridging Twilio's
// Media Streams WebSocket to the agent runtime.
//
// Caller μ-law frames are decoded and VAD-gated; each utterance is transcribed and submitted to the primary
// agent as `[SOURCE: PHONE CALL FROM <num>]`; the reply is synthesized, μ-law encoded and sent back as paced
// 20 ms frames. Lifecycle: new CallSession on `start`, frame() per media frame, end() on `stop`.
// A per-call max-duration cap applies (Settings, Voice). Tools are NOT recorded, transcripts only.

import { v4 as uuidv4 } from 'uuid';
import { PLATFORM_SENDER } from '@dojo/shared';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import {
  decodeTwilioFrame,
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
import { callUtteranceText } from '../tools/inbound-fences.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { insertInboundMessageIfAbsent } from '../work/ask-title.js';
import { recordAtDoor, recordedId, recordHeld } from '../agent/v2/outbound.js';
import { mayUseChannel } from '../agent/access/read.js';
import { sanitizeForSpeech } from '../voice/text-sanitize.js';

const logger = createLogger('twilio-call-session');

// Simple energy-based VAD constants. Tunable.
const VAD_FRAME_MS = 20;
// 600 ms of silence ends an utterance: G.711 phone audio has clean phoneme boundaries. Raise it if
// mid-sentence pauses cut off real speech.
const VAD_SILENCE_MS_TO_END = 600;
const VAD_MIN_SPEECH_MS = 250;     // Drop micro-utterances (button noise, breath).
const VAD_ENERGY_THRESHOLD = 0.01; // RMS in [0,1].
// ~200 ms of pre-onset context (10 frames) so STT does not get a half-clipped first word.
const LOOKBACK_FRAMES = 10;

const TWILIO_FRAME_INTERVAL_MS = 20;

export interface CallSessionInit {
  callSid: string;
  streamSid: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  send: (msg: string) => void;  // JSON string sender on the WS
  // Phone-mode context: voicemail is set when AMD resolves, disclosures are owner policy, and purpose
  // comes from the outbound `voice_call` args.
  voicemailDetected?: boolean;
  disclosuresRequired?: string[];
  purpose?: string;
}

interface PendingTtsChunk {
  pcm: Float32Array;
  sampleRate: number;
  text: string;
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
  private agentId: string | null = null;
  private startedAt = Date.now();
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  // Per-call utterance counter: gives each utterance its own external message id (CA123:1, CA123:2, ...),
  // since the unique index on (agent_id, channel, external_message_id) would drop later ones.
  private utteranceSeq = 0;

  private speechBuffer: Float32Array[] = [];
  private speechSamples = 0;
  private hasSpeech = false;
  private silenceMs = 0;
  private speechMs = 0;

  private framesReceived = 0;
  private framesLogged = 0;
  private peakEnergy = 0;

  // Lowpass state for the 8 to 16 kHz upsample; it must persist across frames (no boundary glitches).
  private aaLpState: BiquadState = createBiquadState();

  // Rolling pre-onset ring so the first phoneme is not clipped when VAD onset fires mid-word.
  private lookbackRing: Float32Array[] = [];

  private ttsQueue: PendingTtsChunk[] = [];
  private ttsTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCarry: Buffer = Buffer.alloc(0);
  /** The words of the audio in ttsCarry, being sent now. */
  private playingText = '';

  // Serial sentence-text queue: streaming TTS feeds one sentence at a time; one drain worker synthesizes
  // in FIFO order and pushes PCM to ttsQueue in submission order, so audio never plays out of order.
  // Each sentence's `heard` settles true once its audio is queued to the caller, false when it is dropped.
  private pendingSpeechTexts: Array<{ text: string; generation: number; heard: (queued: boolean) => void }> = [];
  private speechSynthRunning = false;
  // Bumped on barge-in: sentences still queued or being synthesized under an older generation are dropped.
  private speechGeneration = 0;
  /** Set by the TTS bridge once the cloud voice has failed on this call; the call then stays local. */
  private voiceState: { cloudDown: boolean; agentId: string };

  // Running transcript stitched at the end into twilio_call_log.transcript.
  private transcript: Array<{ at: string; speaker: 'caller' | 'agent'; text: string }> = [];

  // Phone-mode call context. AMD flips voicemailDetected when its result arrives; the rest is set
  // at construct time (inbound: defaults; outbound: from voice_call args).
  voicemailDetected: boolean = false;
  disclosuresRequired: string[] = [];
  purpose: string | null = null;

  // Soft hangup window: voice_call_end sets this timer instead of disconnecting at once, so the closing
  // ritual can finish. Caller speech during the window cancels the hangup.
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
    this.voiceState = { cloudDown: false, agentId: this.agentId ?? PLATFORM_SENDER };
    this.startedAt = Date.now();
    this.persistInitialLog();
    this.armMaxDuration();
    logger.info('CallSession started', {
      callSid: this.callSid, streamSid: this.streamSid, direction: this.direction, agentId: this.agentId,
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
      // End through the module-level helper so the registry entry is cleared too, then drop the call at
      // Twilio at once: the cap must not wait for a goodbye window.
      endCallSession(this.callSid, 'max_duration_reached');
      void import('./client.js').then((m) => m.endCall(this.callSid)).catch((err) => logger.warn('Twilio hang-up after the time cap failed', { callSid: this.callSid, error: err instanceof Error ? err.message : String(err) }));
    }, ms);
  }

  /** Twilio `start` event - real audio about to flow. */
  start(): void {
    this.started = true;
    // Pump any TTS queued before the WS `start` event bound `send` (the outbound opening_message is
    // queued immediately).
    if (this.ttsQueue.length > 0 && !this.ttsTimer) this.scheduleTtsPump();

    // Pre-warm STT (Moonshine's first load takes ~600 ms) so the first utterance does not pay for it.
    // Fire-and-forget; a no-op once loaded.
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

    // Inbound greeting 1.5 s after the WS hands off. The inbound phone-mode prompt relies on it ("You
    // already greeted with Hello there!"). Outbound calls supply their own opening_message instead.
    if (this.direction === 'inbound') {
      setTimeout(() => {
        if (this.ended) return;
        void this.queueAgentSay('Hello there!');
      }, 1500);
    }
  }

  /** Process one inbound μ-law base64 frame: decode, run VAD, hand a finished utterance to the agent. */
  async frame(payloadBase64: string): Promise<void> {
    if (this.ended || !this.started) return;
    // The lowpass strips the spectral images the cheap upsampler creates above ~3.4 kHz; without it
    // Moonshine returns empty text on phone audio.
    const rawDecoded = decodeTwilioFrame(payloadBase64);
    const float = applyAntiAliasLP(rawDecoded, this.aaLpState);

    this.lookbackRing.push(float);
    while (this.lookbackRing.length > LOOKBACK_FRAMES) {
      this.lookbackRing.shift();
    }

    // Buffer only after VAD onset; pre-onset silence stays in the ring and is prepended on the first
    // speech frame, keeping the STT buffer small and dense.
    if (this.hasSpeech) {
      this.speechBuffer.push(float);
      this.speechSamples += float.length;
    }

    const energy = rms(float);
    if (energy > this.peakEnergy) this.peakEnergy = energy;
    this.framesReceived++;
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
        // Barge-in: the caller started talking, so flush queued outbound audio and pending sentences.
        // Bumping the generation also drops any sentence already queued or mid-synthesis under the old one,
        // so a stale sentence never plays after the caller spoke.
        if (
          this.ttsQueue.length > 0 ||
          this.ttsCarry.length > 0 ||
          this.pendingSpeechTexts.length > 0
        ) {
          const drained = this.ttsQueue.length;
          const carryBytes = this.ttsCarry.length;
          const droppedTexts = this.pendingSpeechTexts.length;
          this.dropUnplayed('the caller spoke over it');
          for (const item of this.pendingSpeechTexts) item.heard(false);
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
        // Soft hangup pending (agent said goodbye): caller speech means they are not done, so cancel it.
        if (this.pendingHangupTimer) {
          clearTimeout(this.pendingHangupTimer);
          this.pendingHangupTimer = null;
          logger.info('Soft hangup cancelled: caller resumed speaking', {
            callSid: this.callSid, originalReason: this.pendingHangupReason,
          });
          this.pendingHangupReason = null;
        }
        // Onset: prepend the lookback ring (it already ends with the current frame) so the first
        // phoneme is not clipped.
        for (const c of this.lookbackRing) {
          this.speechBuffer.push(c);
          this.speechSamples += c.length;
        }
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
      const wav = floatToWav(pcm16k, 16000);
      // Caller audio is never written to disk: only the transcript is kept.
      const { transcribeBuffer } = await import('../voice/stt-service.js');
      const r = await transcribeBuffer(wav, { mime: 'audio/wav' });
      text = r.text.trim();
      logger.info('STT result', {
        callSid: this.callSid,
        sampleCount: pcm16k.length,
        durationMs: Date.now() - t0,
        textLength: text.length,
      });
    } catch (err) {
      logger.warn('Inbound utterance STT failed', {
        callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
      });
      void this.queueAgentSay('Sorry, I did not catch that.');
      return;
    }
    if (!text) return;
    // The call may have ended while this was being transcribed: those words wake nothing.
    if (this.ended) return;
    this.transcript.push({ at: new Date().toISOString(), speaker: 'caller', text });
    logger.debug('Caller utterance', { callSid: this.callSid, text: text.slice(0, 200) });

    // Submit to the agent runtime as a user-role message.
    const primaryId = this.agentId ?? getPrimaryAgentId();
    if (!primaryId) {
      logger.warn('No primary agent, dropping utterance', { callSid: this.callSid });
      return;
    }
    // The other party is toNumber on outbound calls and fromNumber on inbound (on outbound, Twilio's
    // webhook From is our own number), so the badge name resolves from that number.
    const otherPartyNumber =
      this.direction === 'outbound' ? this.toNumber : this.fromNumber;
    const otherPartyName = resolveTwilioCallerName(otherPartyNumber);
    const otherPartyDisplay = otherPartyName ?? otherPartyNumber;
    const sourceTag = `[SOURCE: PHONE CALL FROM ${otherPartyDisplay}]`;
    // The trailer's `To:` is for engine diagnostics: the leg's technical destination, which is
    // the opposite side from the badge.
    const trailerToNumber =
      this.direction === 'outbound' ? this.fromNumber : this.toNumber;
    // Phone-mode context lines, parsed by the prompt assembler (inbound/outbound, voicemail and disclosure
    // branches); hidden from the user bubble in non-wordy mode along with the SID/To trailer.
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
    const content = `${sourceTag}\n\n${callUtteranceText(otherPartyNumber, otherPartyDisplay, text)}\n\n${trailer}`;
    const msgId = uuidv4();
    try {
      const conversationId = resolveOrCreateConversation(primaryId, {
        channel: 'phone', provider: 'twilio', counterpartyId: otherPartyNumber ?? null, threadRoot: null,
      });
      // Structured routing metadata, stamped before handleMessage runs so the turn reads it. A live call is
      // already connected, so the reply is always spoken back (authorized: no safe-sender gate).
      const inboundMetaObj = {
        channel: 'phone' as const,
        accountKind: 'agent' as const,
        authorized: true,
        sender: otherPartyNumber,
        phoneCallSid: this.callSid,
        phoneFromNumber: otherPartyNumber,
        recipientAddress: otherPartyNumber,
      };
      // Channel, sender and the auth verdict are stamped in the write from the meta this leg already
      // holds, never re-derived. recordInboundMeta below records the full blob; the external message
      // id (call sid plus utterance number) de-duplicates repeat inserts.
      insertInboundMessageIfAbsent({
        id: msgId,
        agentId: primaryId,
        role: 'user',
        content,
        conversationId,
        externalMessageId: `${this.callSid}:${++this.utteranceSeq}`,
        channel: inboundMetaObj.channel,
        senderId: inboundMetaObj.sender,
        authorized: inboundMetaObj.authorized,
      });
      recordInboundMeta(msgId, inboundMetaObj);
      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: msgId, agentId: primaryId, role: 'user' as const,
          content,
          // Carry the same inbound_meta and conversationId the DB row holds, so attribution
          // is identical live and on refetch.
          conversationId,
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
   * Speak text to the caller, cleaned for speech: sentences are synthesized in order, stitched into 20 ms
   * μ-law frames and paced out over the Media Streams WebSocket. Resolves once the audio is queued to the
   * caller, or dropped; only queued words are recorded as said.
   */
  async queueAgentSay(text: string): Promise<void> {
    if (this.ended) return;
    const trimmed = sanitizeForSpeech(text).trim();
    if (!trimmed) return;
    // The voice channel grant is checked here, the one door all speech into a live call passes
    // (auto-route arms, engine ack, streaming sentences, pre-tool filler). A null agent is the
    // platform speaking, not an agent reaching a human, so a grant has no opinion on it.
    if (this.agentId && !mayUseChannel(this.agentId, 'voice')) {
      recordedId(recordHeld({
        agentId: this.agentId, tool: 'speech-out', channel: 'phone',
        recipientId: this.fromNumber,
      }, 'withheld: this agent holds no voice channel grant'), 'twilio: call speech-out withheld', { callSid: this.callSid });
      logger.warn('Phone speech-out withheld: the speaking agent holds no voice channel grant', {
        callSid: this.callSid, agentId: this.agentId,
      });
      return;
    }
    logger.debug('Agent says', { callSid: this.callSid, text: trimmed.slice(0, 200) });
    // Enqueue with the current generation and kick the single-flight drain worker, which synthesizes
    // in FIFO order and skips sentences from before a barge-in.
    const queued = await new Promise<boolean>((heard) => {
      this.pendingSpeechTexts.push({ text: trimmed, generation: this.speechGeneration, heard });
      void this.drainSpeechTexts();
    });
    if (!queued) return;
    this.transcript.push({ at: new Date().toISOString(), speaker: 'agent', text: trimmed });
    // Speech-out record: inside an outbound scope the sentences of one reply fold into one row (one thing
    // the caller heard); outside a scope (the call's own opener) each stands as its own row.
    recordedId(recordAtDoor({
      outcome: 'delivered', channel: 'phone', tool: 'speech-out',
      agentId: this.agentId ?? undefined, recipientId: this.fromNumber,
      detail: `call ${this.callSid}`,
    }), 'twilio: call speech-out', { callSid: this.callSid });
  }

  /**
   * Single-flight drain over `pendingSpeechTexts`: synthesizes one sentence at a time, pushing PCM in order.
   * Sentences from before the latest barge-in are dropped. A failing cloud voice is covered inside the
   * bridge (local voice); a sentence no engine can speak is skipped.
   */
  private async drainSpeechTexts(): Promise<void> {
    if (this.speechSynthRunning) return;
    this.speechSynthRunning = true;
    try {
      while (this.pendingSpeechTexts.length > 0 && !this.ended) {
        const item = this.pendingSpeechTexts.shift()!;
        if (item.generation < this.speechGeneration) {
          logger.info('TTS skipped (stale generation, post-barge-in)', {
            callSid: this.callSid, itemGeneration: item.generation, current: this.speechGeneration,
          });
          item.heard(false);
          continue;
        }
        let queued = false;
        try {
          const { synthesizeForTwilio } = await import('./tts-bridge.js');
          const pcm = await synthesizeForTwilio(item.text, this.voiceState);
          if (!pcm) {
            // No engine could speak it: skip the sentence.
            logger.warn('TTS produced no audio for sentence (skipped)', { callSid: this.callSid });
          } else if (item.generation < this.speechGeneration || this.ended) {
            // The caller spoke or hung up during synthesis, so the audio is dropped.
            logger.info('TTS dropped post-synth (stale generation)', { callSid: this.callSid });
          } else {
            this.ttsQueue.push({ ...pcm, text: item.text });
            queued = true;
            if (this.started && !this.ttsTimer) this.kickTtsPump();
          }
        } catch (err) {
          logger.warn('TTS for call utterance failed (skipped)', {
            callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
          });
        }
        item.heard(queued);
      }
    } finally {
      this.speechSynthRunning = false;
    }
  }

  private scheduleTtsPump(): void {
    this.ttsTimer = setTimeout(() => this.pumpTts(), TWILIO_FRAME_INTERVAL_MS);
  }

  /** Send the first frame on the current tick instead of waiting one frame interval for the timer. */
  private kickTtsPump(): void {
    if (this.ttsTimer) return;
    this.pumpTts();
  }

  private pumpTts(): void {
    if (this.ended) {
      this.ttsTimer = null;
      return;
    }
    // Convert one chunk to μ-law, prepend the prior chunk's tail, send one 160-byte frame per tick.
    if (this.ttsCarry.length < 160 && this.ttsQueue.length > 0) {
      const chunk = this.ttsQueue.shift()!;
      this.playingText = chunk.text;
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
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.ttsTimer) {
      clearTimeout(this.ttsTimer);
      this.ttsTimer = null;
    }
    for (const item of this.pendingSpeechTexts) item.heard(false);
    this.pendingSpeechTexts = [];
    this.dropUnplayed(reason === 'max_duration_reached' ? 'the call reached its time limit' : 'the caller hung up');
    const durationSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const transcriptText = this.transcript.length === 0
      ? null
      : this.transcript.map(t => `[${t.at}] ${t.speaker}: ${t.text}`).join('\n');
    const endStatus = (reason === 'failed' || reason === 'no-answer' || reason === 'busy' || reason === 'canceled') ? reason : 'completed';
    try {
      getDb().prepare(`
        UPDATE twilio_call_log
        SET status = ?,
            ended_at = datetime('now'),
            duration_seconds = ?,
            transcript = ?,
            ended_reason = ?
        WHERE id = ?
      `).run(endStatus, durationSeconds, transcriptText, reason, this.logRowId);
    } catch (err) {
      logger.warn('CallSession final log update failed', {
        callSid: this.callSid, error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('CallSession ended', {
      callSid: this.callSid, reason, durationSeconds, transcriptLines: this.transcript.length,
    });
  }

  /** Drop audio queued to the caller but not yet played; it was recorded as said, so one line names it. */
  private dropUnplayed(why: string): void {
    const unheard = [...(this.ttsCarry.length > 0 ? [this.playingText] : []), ...this.ttsQueue.map((c) => c.text)];
    if (unheard.length > 0) this.transcript.push({ at: new Date().toISOString(), speaker: 'agent', text: `(not heard, ${why}: ${unheard.join(' ')})` });
    this.ttsQueue = [];
    this.ttsCarry = Buffer.alloc(0);
  }

  isEnded(): boolean { return this.ended; }
  isStarted(): boolean { return this.started; }

  /**
   * Schedule the disconnect after a delay instead of ending at once when `voice_call_end` fires, so the
   * closing ritual can finish. Caller speech cancels it (VAD onset); calling again resets the timer.
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
      // End via the module-level helper so the registry entry is cleared too.
      endCallSession(this.callSid, r);
    }, delayMs);
  }

  hasPendingHangup(): boolean { return this.pendingHangupTimer !== null; }

  /**
   * Rebind the WS send-back: voice-stream.ts connects an outbound call's placeholder session (no-op
   * sender) to the real WebSocket on `start`.
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

/** Friendly name from the Twilio voice safe-callers list, or null when not listed or the lookup fails. */
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

// Calls the signed voice webhook answered with a stream, keyed by call id: the audio socket is public, so
// only these may open an inbound session, and their numbers are the webhook's verified ones.
const ANNOUNCED_CALL_TTL_MS = 60_000;
const announcedCalls = new Map<string, { from: string; to: string }>();

export function announceCall(callSid: string, from: string, to: string): void {
  announcedCalls.set(callSid, { from, to });
  setTimeout(() => announcedCalls.delete(callSid), ANNOUNCED_CALL_TTL_MS).unref();
}

/** The announced numbers for a call, usable once and only within the time limit; null otherwise. */
export function takeAnnouncedCall(callSid: string): { from: string; to: string } | null {
  const announced = announcedCalls.get(callSid) ?? null;
  announcedCalls.delete(callSid);
  return announced;
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
