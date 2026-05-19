/**
 * Per-connection voice session handler.
 *
 * Wire from server.ts onto a separate WS endpoint (e.g. /api/ws/voice). One
 * session belongs to one (user, agent) pair. Lifecycle:
 *
 *   client opens WS  → server creates VoiceSession
 *   client sends JSON {type:'config', voice, speed?, sttModel?}  (optional)
 *   client sends JSON {type:'utterance_start'}                   (optional, debug)
 *   client sends BINARY frames (Float32Array little-endian PCM, 16kHz mono)
 *   client sends JSON {type:'utterance_end'}
 *     → server transcribes, posts user message, subscribes chat:chunk
 *     → server pipes assistant text into kokoro stream
 *     → server emits BINARY frames (24kHz Int16 PCM WAV) back to client
 *     → server emits JSON {type:'tts_end', messageId} when stream done
 *   client sends JSON {type:'barge_in'}  → cancel TTS + stopAgent
 *   client sends JSON {type:'close'}     → tear down
 */

import type { WSContext } from 'hono/ws';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { broadcast, onBroadcast } from '../gateway/ws.js';
import { submitUserMessage } from '../gateway/routes/chat.js';
import { transcribeBuffer, pcmFloatToWav, ensureSttReady } from './stt-service.js';
import { synthesizeStream, createTextSplitter, DEFAULT_VOICE, loadKokoro, isKokoroLoaded } from './tts-service.js';
import { StreamingSpeechBuffer } from './text-sanitize.js';
import { getDb } from '../db/connection.js';
import { getPrimaryAgentName } from '../config/platform.js';
import { DEFAULT_WHISPER, WHISPER_MODELS, type WhisperSize } from './model-manager.js';
import type { WsEvent } from '@dojo/shared';

const logger = createLogger('voice-ws');

interface VoiceSession {
  ws: WSContext;
  userId: string;
  agentId: string;
  voice: string;
  speed: number;
  sttModel: WhisperSize;
  pcmChunks: Float32Array[];
  pcmSampleRate: number;
  unsubscribeChunk: (() => void) | null;
  activeTts: { abort: AbortController; messageId: string } | null;
  splitter: ReturnType<typeof createTextSplitter> | null;
  // Live partial transcription state. We run whisper against the in-flight
  // audio buffer every ~1s of new audio so the user sees their words appear
  // before the utterance ends — perceived STT latency drops from ~1s
  // (post-end-of-speech) to ~150ms (mid-speech partial).
  partialInFlight: boolean;
  partialLastChunkCount: number;
  lastPartialText: string;
  // Hands-free wake-word mode. When `wakeWordEnabled` is on and `passive`
  // is true, transcripts are discarded unless the user says `wakePhrase` —
  // at which point we flip `passive` to false and continue normally. When
  // `passive` is false (active conversation), saying `sleepPhrase` flips
  // back to passive without submitting the utterance to the LLM.
  wakeWordEnabled: boolean;
  wakePhrase: string;
  sleepPhrase: string;
  passive: boolean;
  // Application-level ping/pong so the Cloudflare tunnel doesn't kill the
  // socket during silent periods (no audio frames mean the connection looks
  // idle to intermediaries even though both ends are still active).
  pingInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Load saved voice settings out of the `config` table. Falls back to
 * defaults on any missing or malformed key.
 */
function loadVoiceSettings(): {
  voice: string; speed: number; sttModel: WhisperSize;
  wakeWordEnabled: boolean; wakePhrase: string; sleepPhrase: string;
} {
  const db = getDb();
  let voice = DEFAULT_VOICE;
  let speed = 1;
  let sttModel: WhisperSize = DEFAULT_WHISPER;
  let wakeWordEnabled = false;
  // Default to "hey <primary agent name>" — most users name their primary agent
  // and "hey kevin" makes no sense if they didn't name it Kevin.
  let wakePhrase = `hey ${getPrimaryAgentName().toLowerCase()}`;
  let sleepPhrase = 'stop listening';
  try {
    const row = db.prepare(
      "SELECT key, value FROM config WHERE key IN ('voice.preferred_voice', 'voice.playback_speed', 'voice.stt_model', 'voice.wake_word_enabled', 'voice.wake_phrase', 'voice.sleep_phrase')",
    ).all() as Array<{ key: string; value: string }>;
    for (const r of row) {
      if (r.key === 'voice.preferred_voice' && r.value) voice = r.value;
      if (r.key === 'voice.playback_speed') {
        const n = Number(r.value);
        if (Number.isFinite(n) && n >= 0.5 && n <= 2) speed = n;
      }
      if (r.key === 'voice.stt_model' && r.value in WHISPER_MODELS) {
        sttModel = r.value as WhisperSize;
      }
      if (r.key === 'voice.wake_word_enabled') wakeWordEnabled = r.value === 'true';
      if (r.key === 'voice.wake_phrase' && r.value.trim()) wakePhrase = r.value.trim().toLowerCase();
      if (r.key === 'voice.sleep_phrase' && r.value.trim()) sleepPhrase = r.value.trim().toLowerCase();
    }
  } catch { /* table may not yet have these rows — defaults are fine */ }
  return { voice, speed, sttModel, wakeWordEnabled, wakePhrase, sleepPhrase };
}

/**
 * Whisper inserts noise around short phrases — a wake phrase like "hey kevin"
 * might come back as "Hey, Kevin?" or "hey, kevin." or even "kevin". This
 * normalizes both sides before matching so the wake-word check isn't brittle.
 */
function normalizeForPhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findPhrase(transcript: string, phrase: string): { matched: boolean; remainder: string } {
  const normT = normalizeForPhrase(transcript);
  const normP = normalizeForPhrase(phrase);
  if (!normP) return { matched: false, remainder: '' };
  const idx = normT.indexOf(normP);
  if (idx === -1) return { matched: false, remainder: '' };
  const remainder = normT.slice(idx + normP.length).trim();
  return { matched: true, remainder };
}

const sessions = new Map<WSContext, VoiceSession>();

function sendJson(ws: WSContext, payload: object): void {
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

function sendBinary(ws: WSContext, buf: Buffer): void {
  try { ws.send(buf as unknown as ArrayBuffer); } catch { /* ignore */ }
}

export function verifyAndOpenVoiceSession(ws: WSContext, url: string): boolean {
  let token: string | null = null;
  let agentId: string | null = null;
  try {
    const u = new URL(url, 'http://localhost');
    token = u.searchParams.get('token');
    agentId = u.searchParams.get('agentId');
  } catch { /* ignore */ }

  if (!token) {
    logger.warn('Voice WS rejected: no token');
    ws.close(1008, 'Authentication required');
    return false;
  }
  if (!agentId) {
    logger.warn('Voice WS rejected: no agentId');
    ws.close(1008, 'agentId query param required');
    return false;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { userId: string };
    const saved = loadVoiceSettings();
    const session: VoiceSession = {
      ws,
      userId: payload.userId,
      agentId,
      voice: saved.voice,
      speed: saved.speed,
      sttModel: saved.sttModel,
      pcmChunks: [],
      pcmSampleRate: 16_000,
      unsubscribeChunk: null,
      activeTts: null,
      splitter: null,
      partialInFlight: false,
      partialLastChunkCount: 0,
      lastPartialText: '',
      wakeWordEnabled: saved.wakeWordEnabled,
      wakePhrase: saved.wakePhrase,
      sleepPhrase: saved.sleepPhrase,
      // Start passive iff wake-word mode is enabled; otherwise jump straight
      // to active behavior (same as before this feature existed).
      passive: saved.wakeWordEnabled,
      pingInterval: null,
    };
    sessions.set(ws, session);
    // Heartbeat every 25s — under Cloudflare Tunnel's default WS idle timeout
    // and under the typical 30s nginx default if anyone reverse-proxies us.
    session.pingInterval = setInterval(() => {
      try { sendJson(ws, { type: 'voice:ping', ts: Date.now() }); } catch { /* ignore */ }
    }, 25_000);
    logger.info('Voice session opened', {
      userId: payload.userId, agentId, voice: saved.voice, sttModel: saved.sttModel,
      wakeWordEnabled: saved.wakeWordEnabled, passive: session.passive,
    });
    sendJson(ws, {
      type: 'voice:opened', agentId,
      voice: saved.voice, speed: saved.speed, sttModel: saved.sttModel,
      wakeWordEnabled: saved.wakeWordEnabled, passive: session.passive,
    });
    if (session.passive) {
      sendJson(ws, { type: 'voice:state', agentId, state: 'passive' });
    }

    // Pre-warm STT + TTS in parallel with the user's first utterance.
    // First-load on both is slow (whisper-server ~9s, Kokoro ~20-30s), so
    // if we wait until the agent's text arrives to start loading Kokoro
    // we'll miss the entire first response. Kicking these off here means
    // by the time STT completes (~1s once warm) + the LLM replies (~3-5s),
    // both subprocesses are ready.
    void ensureSttReady(session.sttModel).catch((err) => {
      logger.warn('STT preload failed', { error: err instanceof Error ? err.message : String(err) });
    });
    if (!isKokoroLoaded()) {
      void loadKokoro().catch((err) => {
        logger.warn('Kokoro preload failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
    return true;
  } catch (err) {
    logger.warn('Voice WS rejected: bad token', { error: err instanceof Error ? err.message : String(err) });
    ws.close(1008, 'Invalid token');
    return false;
  }
}

export function closeVoiceSession(ws: WSContext): void {
  const session = sessions.get(ws);
  if (!session) return;
  if (session.unsubscribeChunk) session.unsubscribeChunk();
  if (session.activeTts) session.activeTts.abort.abort();
  if (session.splitter) { try { session.splitter.close(); } catch { /* ignore */ } }
  if (session.pingInterval) clearInterval(session.pingInterval);
  sessions.delete(ws);
  logger.info('Voice session closed', { userId: session.userId, agentId: session.agentId });
}

export async function handleVoiceMessage(ws: WSContext, data: string | ArrayBuffer | Buffer): Promise<void> {
  const session = sessions.get(ws);
  if (!session) return;

  // Binary frames are raw PCM audio chunks.
  if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
    const ab = Buffer.isBuffer(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    const f32 = new Float32Array(ab);
    session.pcmChunks.push(f32);
    // Kick off a partial transcription if we've accumulated enough new audio
    // since the last one. Runs async — caller doesn't wait. If a partial is
    // already in flight, this no-ops and the next frame retries.
    if (session.pcmChunks.length - session.partialLastChunkCount >= PARTIAL_TRANSCRIBE_EVERY_CHUNKS) {
      void runPartialTranscribe(session);
    }
    return;
  }

  // JSON control messages
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(data as string);
  } catch {
    logger.warn('Voice WS got invalid JSON', { sample: String(data).slice(0, 80) });
    return;
  }

  switch (msg.type) {
    case 'config': {
      if (typeof msg.voice === 'string') session.voice = msg.voice;
      if (typeof msg.speed === 'number' && msg.speed >= 0.5 && msg.speed <= 2) session.speed = msg.speed;
      if (typeof msg.pcmSampleRate === 'number') session.pcmSampleRate = msg.pcmSampleRate;
      if (typeof msg.sttModel === 'string' && msg.sttModel in WHISPER_MODELS) {
        session.sttModel = msg.sttModel as WhisperSize;
        void ensureSttReady(session.sttModel).catch(() => { /* ignore */ });
      }
      if (typeof msg.wakeWordEnabled === 'boolean') {
        const wasEnabled = session.wakeWordEnabled;
        session.wakeWordEnabled = msg.wakeWordEnabled;
        // Toggling wake-word mode on mid-session puts us back in passive;
        // toggling it off promotes us straight to active.
        if (!wasEnabled && msg.wakeWordEnabled) {
          session.passive = true;
          sendJson(ws, { type: 'voice:state', agentId: session.agentId, state: 'passive' });
        } else if (wasEnabled && !msg.wakeWordEnabled) {
          session.passive = false;
          sendJson(ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
        }
      }
      if (typeof msg.wakePhrase === 'string' && msg.wakePhrase.trim()) {
        session.wakePhrase = msg.wakePhrase.trim().toLowerCase();
      }
      if (typeof msg.sleepPhrase === 'string' && msg.sleepPhrase.trim()) {
        session.sleepPhrase = msg.sleepPhrase.trim().toLowerCase();
      }
      sendJson(ws, {
        type: 'voice:config_ack',
        voice: session.voice, speed: session.speed, sttModel: session.sttModel,
        wakeWordEnabled: session.wakeWordEnabled, passive: session.passive,
      });
      return;
    }

    case 'utterance_start': {
      session.pcmChunks = [];
      session.partialLastChunkCount = 0;
      session.lastPartialText = '';
      sendJson(ws, { type: 'voice:state', agentId: session.agentId, state: 'capturing' });
      return;
    }

    case 'utterance_end': {
      await handleUtteranceEnd(session);
      return;
    }

    case 'barge_in': {
      bargeIn(session);
      return;
    }

    case 'close': {
      try { ws.close(1000, 'client requested close'); } catch { /* ignore */ }
      return;
    }

    default:
      logger.debug('Voice WS unknown control message', { type: msg.type });
  }
}

// Roughly one second of 16 kHz mono PCM per partial transcription tick.
// vad-web yields ~30ms frames, so ~30 chunks ≈ ~1s of new audio.
const PARTIAL_TRANSCRIBE_EVERY_CHUNKS = 30;
// Don't bother running partial inference until we have at least this much
// audio buffered — whisper hallucinates badly on sub-300ms samples.
const PARTIAL_MIN_SAMPLES = 16_000 * 0.5;

/**
 * Fire-and-forget partial transcription of whatever's accumulated so far.
 * Snapshots the buffer (does NOT drain) so the final pass on utterance_end
 * still sees the complete recording. One in-flight at a time per session —
 * if a transcription is already running, new chunks just keep accumulating
 * and the NEXT tick will pick them up.
 */
async function runPartialTranscribe(session: VoiceSession): Promise<void> {
  if (session.partialInFlight) return;
  if (session.pcmChunks.length === 0) return;
  session.partialInFlight = true;
  session.partialLastChunkCount = session.pcmChunks.length;
  try {
    const pcm = concatPcm(session.pcmChunks); // snapshot, not drain
    if (pcm.length < PARTIAL_MIN_SAMPLES) return;
    const wav = pcmFloatToWav(pcm, session.pcmSampleRate);
    const result = await transcribeBuffer(wav, { modelSize: session.sttModel });
    const text = result.text.trim();
    // Skip empty / duplicate emissions — whisper sometimes returns "" or
    // re-returns the same partial when audio hasn't changed meaningfully.
    if (!text || text === session.lastPartialText) return;
    session.lastPartialText = text;
    sendJson(session.ws, {
      type: 'voice:stt_partial',
      agentId: session.agentId,
      text,
    });
  } catch (err) {
    // Partials are best-effort — quietly skip on failure.
    logger.debug('Partial transcribe failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    session.partialInFlight = false;
  }
}

function concatPcm(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── Backchannel filter ──
//
// Short acknowledgments ("yeah", "mhmm", "ok", etc.) that users naturally
// say while the agent is mid-thought aren't actual prompts. Submitting them
// preempts the agent's run and forces it to respond to nothing meaningful.
// We catch the most common ones here. The match is intentionally exact —
// "ok do that" is NOT a backchannel and passes through, while bare "ok" is.
const BACKCHANNELS = new Set([
  // Hm/mm variants
  'hm', 'hmm', 'hmmm', 'mhm', 'mhmm', 'mmhm', 'mmhmm', 'mm hmm', 'mm hm',
  // Uh-huh variants
  'uh huh', 'uhuh', 'uhhuh',
  // Affirmative
  'yeah', 'yep', 'yup', 'ya', 'yah',
  // Ok variants
  'ok', 'okay', 'kay', 'k',
  // Other quick acks
  'right', 'sure', 'got it', 'gotcha', 'understood', 'cool', 'nice',
  // Negation (short — rarely meaningful prompts on their own)
  'nah', 'nope', 'no',
]);

function isBackchannel(transcript: string): boolean {
  const cleaned = transcript
    .toLowerCase()
    .trim()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!cleaned) return false;
  // Cap at 3 words so phrases like "got it cool" still match but "yeah do that" doesn't.
  if (cleaned.split(' ').length > 3) return false;
  return BACKCHANNELS.has(cleaned);
}

async function handleUtteranceEnd(session: VoiceSession): Promise<void> {
  const chunks = session.pcmChunks;
  session.pcmChunks = [];
  // Reset partial state — next utterance starts fresh, no carryover.
  session.partialLastChunkCount = 0;
  session.lastPartialText = '';
  if (chunks.length === 0) {
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }
  const pcm = concatPcm(chunks);
  // Empty / sub-quarter-second utterances are usually mic clicks; drop.
  if (pcm.length < session.pcmSampleRate / 4) {
    logger.debug('Dropping tiny utterance', { samples: pcm.length });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }

  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'transcribing' });
  const wav = pcmFloatToWav(pcm, session.pcmSampleRate);

  let transcript: string;
  let durationMs: number;
  try {
    // Hard 30s cap. Without this, a stuck whisper-server boot (or a model
    // that's still in the middle of download/warmup) leaves the client in
    // "transcribing" forever with no error feedback.
    const result = await Promise.race([
      transcribeBuffer(wav, { modelSize: session.sttModel }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('transcribe_timeout (30s) — STT engine not ready')), 30_000),
      ),
    ]);
    transcript = result.text.trim();
    durationMs = result.durationMs;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Transcription failed', { error: msg }, session.agentId);
    sendJson(session.ws, {
      type: 'voice:state', agentId: session.agentId,
      state: 'error', detail: msg.includes('timeout') ? 'transcription_timeout' : 'transcription_failed',
    });
    return;
  }

  if (!transcript) {
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }

  // Always show the user what we heard, even if we're about to suppress it.
  sendJson(session.ws, { type: 'voice:stt_final', agentId: session.agentId, text: transcript, durationMs });

  // ── Wake word / Sleep word handling (passive ↔ active transitions) ──
  if (session.wakeWordEnabled) {
    if (session.passive) {
      // Passive: discard everything UNTIL we hear the wake phrase.
      const { matched, remainder } = findPhrase(transcript, session.wakePhrase);
      if (!matched) {
        logger.debug('Passive mode — no wake phrase, dropping transcript', { agentId: session.agentId, transcript });
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'passive' });
        return;
      }
      // Wake! Flip to active mode and notify the client.
      session.passive = false;
      logger.info('Wake phrase detected', { agentId: session.agentId, phrase: session.wakePhrase, remainder: remainder.slice(0, 80) });
      sendJson(session.ws, {
        type: 'voice:wake_detected', agentId: session.agentId,
        phrase: session.wakePhrase, remainder: remainder || null,
      });
      if (!remainder) {
        // Bare wake call — wait for the user's actual prompt next utterance.
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
        return;
      }
      // Continue with the post-wake text as the prompt.
      transcript = remainder;
    } else {
      // Active: check for sleep phrase before doing anything else with it.
      const { matched } = findPhrase(transcript, session.sleepPhrase);
      if (matched) {
        session.passive = true;
        logger.info('Sleep phrase detected', { agentId: session.agentId, phrase: session.sleepPhrase });
        sendJson(session.ws, {
          type: 'voice:sleep_detected', agentId: session.agentId,
          phrase: session.sleepPhrase,
        });
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'passive' });
        // Also cancel any in-flight TTS — sleep means "shut up".
        if (session.activeTts) {
          session.activeTts.abort.abort();
          session.activeTts = null;
        }
        return;
      }
    }
  }

  // Backchannel filter: short acknowledgments like "yeah" or "mhmm" should
  // not preempt the agent or be submitted as a new prompt. The user's
  // barge-in (if any) already cancelled in-flight TTS. Just go back to
  // listening — no LLM call, no token spend, no spurious "you said yeah"
  // entry in the chat history.
  if (isBackchannel(transcript)) {
    logger.debug('Backchannel detected — not submitting as prompt', { agentId: session.agentId, transcript });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }

  // Post the transcript through the normal chat pipeline. source='voice'
  // so the dashboard renders a mic icon on this user bubble.
  const submit = await submitUserMessage(session.agentId, transcript, undefined, 'voice');
  if (!submit.ok) {
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'error', detail: submit.error });
    return;
  }

  // Subscribe to assistant chunks for this agent; pipe into TTS.
  startTtsForAgent(session);
}

function startTtsForAgent(session: VoiceSession): void {
  // Tear down any prior subscription, splitter, and TTS stream before
  // opening a new one. Without closing the prior splitter, its consumer
  // generator would never exit (we'd no longer be listening for the idle
  // event that triggers close) — orphaned and slow-leaking memory.
  if (session.unsubscribeChunk) session.unsubscribeChunk();
  session.unsubscribeChunk = null;
  if (session.splitter) {
    try { session.splitter.close(); } catch { /* ignore */ }
    session.splitter = null;
  }
  if (session.activeTts) {
    session.activeTts.abort.abort();
    session.activeTts = null;
  }

  const splitter = createTextSplitter();
  session.splitter = splitter;
  const sanitizer = new StreamingSpeechBuffer();

  const abort = new AbortController();
  const messageId = `tts-${Date.now()}`;
  session.activeTts = { abort, messageId };

  let started = false;
  let sentenceCount = 0;
  const startStreaming = () => {
    if (started) return;
    started = true;
    logger.info('TTS streaming started', { agentId: session.agentId, messageId, voice: session.voice });
    sendJson(session.ws, { type: 'voice:tts_start', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'speaking' });
    // Drain the splitter through Kokoro and emit WAV chunks.
    void (async () => {
      try {
        for await (const chunk of synthesizeStream(splitter, session.voice, session.speed, abort.signal)) {
          if (abort.signal.aborted) break;
          sentenceCount++;
          logger.debug('TTS sentence sent', {
            agentId: session.agentId,
            messageId,
            n: sentenceCount,
            samples: chunk.pcm.length,
          });
          const wavBuf = pcmFloatToWav(chunk.pcm, chunk.sampleRate);
          sendBinary(session.ws, wavBuf);
        }
        if (!abort.signal.aborted) {
          sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
          sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
        }
      } catch (err) {
        logger.error('TTS stream failed', { error: err instanceof Error ? err.message : String(err) }, session.agentId);
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'error', detail: 'tts_failed' });
      } finally {
        if (session.activeTts && session.activeTts.abort === abort) {
          session.activeTts = null;
        }
        if (session.splitter === splitter) session.splitter = null;
        if (session.unsubscribeChunk) {
          session.unsubscribeChunk();
          session.unsubscribeChunk = null;
        }
      }
    })();
  };

  // chat:chunk fires done:true after EVERY model call. For a tool-using
  // turn that ends in text, that's: tool-turn done → tool-turn done → text-turn done.
  // We must NOT close the splitter on each done (that cut off TTS in v2.5.46-pre).
  // Instead:
  //   - chat:chunk content → run through StreamingSpeechBuffer (strips markdown +
  //     summarizes URLs/paths, only emits text past balanced markdown markers),
  //     push safe text into Kokoro splitter as it becomes available.
  //   - chat:chunk done    → flush any sanitized tail of the current bubble.
  //     This is what makes audio start AS SOON AS a bubble is complete instead
  //     of waiting for the whole multi-turn run to finish.
  //   - agent:status idle  → close the splitter for good (end of full run).
  let bubbleCount = 0;
  let bubbleChars = 0;
  const unsubscribe = onBroadcast((event: WsEvent) => {
    if (abort.signal.aborted) return;
    if (event.type === 'chat:chunk') {
      if (event.agentId !== session.agentId) return;
      if (event.content) {
        bubbleChars += event.content.length;
        const safe = sanitizer.push(event.content);
        if (safe) {
          splitter.push(safe);
          startStreaming();
        }
      }
      if (event.done) {
        bubbleCount++;
        // Flush the tail of this bubble — sanitize any pending text and
        // force the splitter to yield its in-progress sentence so audio
        // for this bubble starts immediately, even if Kevin's text didn't
        // end with terminal punctuation.
        const tail = sanitizer.flushUnsafe();
        if (tail) {
          splitter.push(tail);
          startStreaming();
        }
        try { splitter.flush(); } catch { /* ignore */ }
        logger.debug('Voice bubble done — flushed splitter', {
          agentId: session.agentId,
          bubble: bubbleCount,
          textChars: bubbleChars,
        });
        bubbleChars = 0;
      }
      return;
    }
    if (event.type === 'agent:status') {
      if (event.agentId !== session.agentId) return;
      if (event.status === 'idle') {
        const tail = sanitizer.flushUnsafe();
        if (tail) splitter.push(tail);
        try { splitter.close(); } catch { /* ignore */ }
      }
      return;
    }
    if (event.type === 'chat:error') {
      if (event.agentId !== session.agentId) return;
      try { splitter.close(); } catch { /* ignore */ }
      return;
    }
  });
  session.unsubscribeChunk = unsubscribe;
}

function bargeIn(session: VoiceSession): void {
  logger.info('Voice barge-in', { agentId: session.agentId });
  if (session.activeTts) {
    session.activeTts.abort.abort();
    sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId: session.activeTts.messageId, interrupted: true });
    session.activeTts = null;
  }
  if (session.splitter) {
    try { session.splitter.close(); } catch { /* ignore */ }
    session.splitter = null;
  }
  if (session.unsubscribeChunk) {
    session.unsubscribeChunk();
    session.unsubscribeChunk = null;
  }
  // Cancel the in-flight model call too. Without this, the agent keeps
  // generating tokens for a reply the user is overriding — wastes money on
  // unspoken text, and the agent's next turn ends up "anchored" to a thought
  // they cut off. preemptAgentForUrgentMessage aborts the fetch cleanly
  // without setting stop markers (stopAgent would inject a "[STOPPED BY USER]"
  // marker, which is wrong here — the user isn't stopping, they're redirecting).
  void import('../agent/runtime.js').then((m) => {
    try { m.preemptAgentForUrgentMessage(session.agentId); } catch { /* ignore */ }
  });
  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
}
