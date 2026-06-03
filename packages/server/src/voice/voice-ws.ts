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
import { transcribeBuffer, pcmFloatToWav, ensureSttReady, DEFAULT_STT_MODEL_KEY, parseSttModelKey, isWhisperBinaryAvailable } from './stt-service.js';
import { synthesizeClauseStream, createClauseQueue, DEFAULT_VOICE, loadKokoro, isKokoroLoaded } from './tts-service.js';
import { StreamingSpeechBuffer } from './text-sanitize.js';
import { getDb } from '../db/connection.js';
import { getPrimaryAgentName } from '../config/platform.js';
import { WHISPER_MODELS, type WhisperSize } from './model-manager.js';
import type { WsEvent } from '@dojo/shared';

const logger = createLogger('voice-ws');

interface VoiceSession {
  ws: WSContext;
  userId: string;
  agentId: string;
  voice: string;
  speed: number;
  /**
   * Canonical STT model key. 'moonshine-base' (default) selects the
   * Moonshine engine; any WhisperSize string selects Whisper.cpp via the
   * native server. See parseSttModelKey in stt-service.ts.
   */
  sttModel: string;
  pcmChunks: Float32Array[];
  pcmSampleRate: number;
  unsubscribeChunk: (() => void) | null;
  activeTts: { abort: AbortController; messageId: string } | null;
  splitter: ReturnType<typeof createClauseQueue> | null;
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
  // Always-on listener that catches proactive agent messages (the ones
  // not in response to a voice prompt — e.g. a watcher firing, the agent
  // sending an unsolicited update). When it sees agent chat:chunk content
  // and there's no active TTS, it triggers a TTS burst so voice users
  // hear those too. Reset between bursts.
  unsubscribeProactive: (() => void) | null;
  /**
   * Phase 6 — held transcript awaiting a possible continuation. Populated
   * when the previous utterance ended on a conjunction; the timer submits
   * after TURN_EXTENSION_MS if the user doesn't keep talking. If they do
   * keep talking, the next handleUtteranceEnd merges this transcript with
   * the new one and clears the timer.
   */
  pendingTurnExtension: { transcript: string; timer: ReturnType<typeof setTimeout> } | null;
  /**
   * Set true by an 'utterance_canonical' control message; the very next
   * binary frame is then treated as vad-web's canonical buffer (preroll
   * included) and REPLACES pcmChunks rather than appending. Cleared
   * immediately on use. This is what restores the first word of every
   * utterance, which the live frame stream cuts off because it starts
   * at onSpeechStart instead of preSpeechPadMs before it.
   */
  expectingCanonicalFrame: boolean;
}

/**
 * Load saved voice settings out of the `config` table. Falls back to
 * defaults on any missing or malformed key.
 */
function loadVoiceSettings(): {
  voice: string; speed: number; sttModel: string;
  wakeWordEnabled: boolean; wakePhrase: string; sleepPhrase: string;
} {
  const db = getDb();
  let voice = DEFAULT_VOICE;
  let speed = 1;
  // Default to Moonshine. Users with an existing voice.stt_model = WhisperSize
  // preference keep it (the parser accepts those values too).
  let sttModel: string = DEFAULT_STT_MODEL_KEY;
  let wakeWordEnabled = false;
  // Default to "hey <primary agent name>" so the wake phrase tracks however
  // the user has named their primary agent in setup.
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
      if (r.key === 'voice.stt_model' && r.value) {
        // parseSttModelKey returns the default for unknown values, so an
        // invalid stored value silently falls back rather than failing.
        const parsed = parseSttModelKey(r.value);
        sttModel = parsed.kind === 'moonshine' ? 'moonshine-base' : parsed.size;
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

/**
 * Compact American Soundex implementation. Phonetic equivalence catches
 * the homophone class of whisper misfires for unusual proper nouns:
 *   Jain → J500, Jane → J500, Jayne → J500   (all match)
 *   Kevin → K150, Kevyn → K150               (all match)
 *
 * Hand-rolled rather than pulling in `natural` for one tiny function.
 */
function soundex(word: string): string {
  const w = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (!w) return '';
  const codes: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };
  let result = w[0];
  let prevCode = codes[w[0]] ?? '';
  for (let i = 1; i < w.length; i++) {
    const c = w[i];
    const code = codes[c];
    if (code) {
      if (code !== prevCode) result += code;
      prevCode = code;
    } else if (c !== 'H' && c !== 'W') {
      // Vowels (and Y) separate consonants so the same code can repeat.
      // H and W are transparent — they don't reset.
      prevCode = '';
    }
  }
  return (result + '0000').slice(0, 4);
}

function soundexPhrase(phrase: string): string {
  return phrase.split(' ').filter(Boolean).map(soundex).join(' ');
}

// Words that commonly prefix a wake phrase. When the configured wake phrase
// starts with one of these AND whisper drops it (which happens often for
// quiet leading words on iPad/laptop mics), we still wake on the core word
// alone — but ONLY for short utterances, so "Jain is at the store" said to
// another human doesn't false-trigger.
const WAKE_INTRO_WORDS = new Set(['hey', 'hi', 'yo', 'ok', 'okay', 'hello']);
const SHORT_UTTERANCE_MAX_WORDS = 3;

/**
 * Fuzzy wake/sleep phrase matcher. Three layers of tolerance, applied in
 * order from cheapest to loosest:
 *   1. Exact substring after normalization (fast path — preserves prior behavior).
 *   2. Phonetic equivalence: Soundex on each word, then substring match. Catches
 *      Jain/Jane/Jayne and similar whisper proper-noun drift.
 *   3. Intro-word drop: if the phrase is "hey <core>" and whisper transcribed
 *      just <core> (or a homophone), still match — but only when the
 *      utterance is ≤3 words, to avoid waking on incidental name mentions.
 */
function findPhrase(transcript: string, phrase: string): { matched: boolean; remainder: string } {
  const normT = normalizeForPhrase(transcript);
  const normP = normalizeForPhrase(phrase);
  if (!normP) return { matched: false, remainder: '' };

  // 1. Exact substring (fast path)
  const idx = normT.indexOf(normP);
  if (idx !== -1) {
    return { matched: true, remainder: normT.slice(idx + normP.length).trim() };
  }

  const transcriptWords = normT.split(' ').filter(Boolean);
  const phraseWords = normP.split(' ').filter(Boolean);
  if (transcriptWords.length === 0 || phraseWords.length === 0) {
    return { matched: false, remainder: '' };
  }

  // Word-by-word soundex with space separation so we can search the phrase
  // as a contiguous substring without false-matching across word boundaries.
  const transcriptSx = transcriptWords.map(soundex).join(' ');
  const phraseSx = phraseWords.map(soundex).join(' ');

  // 2. Phonetic substring match on the full phrase
  const sxIdx = transcriptSx.indexOf(phraseSx);
  if (sxIdx !== -1) {
    const wordsBefore = transcriptSx.slice(0, sxIdx).trim().split(' ').filter(Boolean).length;
    const remainder = transcriptWords.slice(wordsBefore + phraseWords.length).join(' ');
    return { matched: true, remainder };
  }

  // 3. Intro-word drop. Only when phrase starts with a known intro word
  // AND has at least one core word after it AND the utterance is short.
  if (
    phraseWords.length >= 2 &&
    WAKE_INTRO_WORDS.has(phraseWords[0]) &&
    transcriptWords.length <= SHORT_UTTERANCE_MAX_WORDS
  ) {
    const coreWords = phraseWords.slice(1);
    const coreSx = coreWords.map(soundex).join(' ');
    const cIdx = transcriptSx.indexOf(coreSx);
    if (cIdx !== -1) {
      const wordsBefore = transcriptSx.slice(0, cIdx).trim().split(' ').filter(Boolean).length;
      const remainder = transcriptWords.slice(wordsBefore + coreWords.length).join(' ');
      return { matched: true, remainder };
    }
  }

  return { matched: false, remainder: '' };
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
      unsubscribeProactive: null,
      pendingTurnExtension: null,
      expectingCanonicalFrame: false,
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
    // Subscribe the proactive watcher so unsolicited agent messages
    // (watchers firing, A2A pokes, scheduled triggers, etc.) also get TTS.
    session.unsubscribeProactive = subscribeProactiveWatcher(session);
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
  if (session.unsubscribeProactive) session.unsubscribeProactive();
  if (session.activeTts) session.activeTts.abort.abort();
  if (session.splitter) { try { session.splitter.close(); } catch { /* ignore */ } }
  if (session.pingInterval) clearInterval(session.pingInterval);
  // Phase 6 — clear any held turn-extension timer so it can't fire after
  // the session is gone (would land a submitUserMessage on a dead WS).
  if (session.pendingTurnExtension) {
    clearTimeout(session.pendingTurnExtension.timer);
    session.pendingTurnExtension = null;
  }
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
    // Canonical replacement path: the previous control message flipped
    // expectingCanonicalFrame, so this frame is the full vad-web
    // utterance buffer (including pre-speech padding). Drop whatever live
    // frames accumulated and use this as the authoritative final buffer.
    // Don't trigger a partial — the next message is utterance_end.
    if (session.expectingCanonicalFrame) {
      session.expectingCanonicalFrame = false;
      session.pcmChunks = [f32];
      session.partialLastChunkCount = session.pcmChunks.length;
      return;
    }
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
      if (typeof msg.sttModel === 'string' && msg.sttModel.length > 0) {
        // Accept either the new canonical key ('moonshine-base') or a
        // WhisperSize. parseSttModelKey normalises and falls back to the
        // Moonshine default for anything unknown.
        const parsed = parseSttModelKey(msg.sttModel);
        session.sttModel = parsed.kind === 'moonshine' ? 'moonshine-base' : parsed.size;
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
      session.expectingCanonicalFrame = false;
      sendJson(ws, { type: 'voice:state', agentId: session.agentId, state: 'capturing' });
      return;
    }

    case 'utterance_canonical': {
      // The next binary frame is vad-web's canonical buffer for this
      // utterance — replaces pcmChunks rather than appending. See the
      // expectingCanonicalFrame field comment for why.
      session.expectingCanonicalFrame = true;
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
    const result = await transcribeBuffer(wav, { modelKey: session.sttModel });
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

/**
 * Phase 6 — turn-taking heuristic. After the backchannel filter, look at
 * the FINAL transcript and decide whether the user actually finished the
 * thought. If the last word is a continuing conjunction ("and", "but",
 * "so", "or", "because"), treat the utterance as mid-thought and give
 * the user another 500ms of silence to keep going before we submit it
 * to the LLM. If they DO keep talking, the next utterance_end merges
 * with the held one and we submit as a single combined turn. If they
 * don't, the held timer fires and submits as-is.
 *
 * Strips terminal punctuation before checking so "and." still counts as
 * "and". Operates ONLY on the final transcript, never on partials — the
 * partial stream can flicker between conjunction and non-conjunction
 * endings depending on how the model committed each chunk.
 */
const TURN_TAKING_CONJUNCTIONS = new Set(['and', 'but', 'so', 'because', 'or']);
const TURN_EXTENSION_MS = 500;

function endsWithUnfinishedConjunction(transcript: string): boolean {
  const cleaned = transcript.trim().replace(/[.!?,;:]+$/g, '').toLowerCase();
  if (!cleaned) return false;
  const lastWord = cleaned.split(/\s+/).pop() ?? '';
  return TURN_TAKING_CONJUNCTIONS.has(lastWord);
}

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
      transcribeBuffer(wav, { modelKey: session.sttModel }),
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

  // Phase 6 — turn-taking heuristic. If a previous utterance ended on a
  // conjunction and is still held by the extension timer, merge it with
  // the new transcript and clear the timer. This is what makes "I went
  // to the store... and... bought some milk" land as a single turn even
  // though the user paused long enough for the VAD to call utterance_end
  // twice.
  if (session.pendingTurnExtension) {
    clearTimeout(session.pendingTurnExtension.timer);
    transcript = `${session.pendingTurnExtension.transcript} ${transcript}`.trim();
    session.pendingTurnExtension = null;
  }

  // Phase 6 — does THIS utterance end on a conjunction? If so, hold it
  // for 500ms before submitting. The user may still be mid-thought; the
  // VAD just fired on a natural breath. If they keep talking, the next
  // handleUtteranceEnd call merges and submits a combined turn. If they
  // don't, the timer below submits the held transcript on its own.
  if (endsWithUnfinishedConjunction(transcript)) {
    logger.debug('Holding transcript on unfinished conjunction', {
      agentId: session.agentId, transcript,
    });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    const heldTranscript = transcript;
    const timer = setTimeout(() => {
      // Only fire if nothing has cleared us first (a continuation utterance
      // would have cancelled this timer and moved the transcript forward).
      if (session.pendingTurnExtension?.timer !== timer) return;
      session.pendingTurnExtension = null;
      void submitTranscriptAndStartTts(session, heldTranscript);
    }, TURN_EXTENSION_MS);
    session.pendingTurnExtension = { transcript: heldTranscript, timer };
    return;
  }

  await submitTranscriptAndStartTts(session, transcript);
}

/**
 * Submit a final voice transcript through the chat pipeline and start
 * TTS streaming for the agent's reply. Factored out so both the normal
 * end-of-turn path and the turn-extension timer (Phase 6) can reuse it.
 */
async function submitTranscriptAndStartTts(session: VoiceSession, transcript: string): Promise<void> {
  // Post the transcript through the normal chat pipeline. source='voice'
  // so the dashboard renders a mic icon on this user bubble.
  const submit = await submitUserMessage(session.agentId, transcript, undefined, 'voice');
  if (!submit.ok) {
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'error', detail: submit.error });
    return;
  }

  // Confirm to the client that the prompt was actually submitted (not
  // dropped as a backchannel / sleep / wake-only utterance). The client
  // plays a "message sent" chime on this event.
  sendJson(session.ws, { type: 'voice:prompt_submitted', agentId: session.agentId });

  // Subscribe to assistant chunks for this agent; pipe into TTS.
  startTtsForAgent(session);
}

/**
 * Open a fresh TTS burst — splitter + Kokoro stream + chat:chunk listener.
 *
 * Called from two places:
 *  1. handleUtteranceEnd, right after submitting a transcribed voice prompt.
 *  2. subscribeProactiveWatcher, when the agent emits chat:chunk content
 *     without a corresponding voice prompt (proactive messages). In that
 *     case the watcher passes the FIRST chunk via `initialContent` so it
 *     isn't lost — the burst listener subscribes after this function
 *     returns and only catches subsequent broadcasts.
 */
function startTtsForAgent(session: VoiceSession, initialContent?: string): void {
  // Pause the proactive watcher for the duration of this burst — the
  // burst's own chat:chunk listener will handle every event from here.
  // The IIFE finally below re-subscribes the watcher.
  if (session.unsubscribeProactive) {
    session.unsubscribeProactive();
    session.unsubscribeProactive = null;
  }
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

  // Phase 4 — clause-level TTS. We drive Kokoro one clause at a time so
  // first audio lands within the first ~30 chars of the LLM's reply,
  // instead of waiting for a full sentence boundary.
  const splitter = createClauseQueue();
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
        for await (const chunk of synthesizeClauseStream(splitter, session.voice, session.speed, abort.signal)) {
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
          logger.info('Voice TTS: sending tts_end after splitter drained', {
            agentId: session.agentId, messageId, sentences: sentenceCount,
          });
          sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
          sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
          // Cloudflare named tunnels sometimes buffer trailing small WS text
          // frames waiting for more bytes. Audio chunks (binary) get through
          // fine but the tiny tts_end JSON can stall, leaving the client
          // stuck on 'agent speaking'. Push 4 redundant copies over the next
          // ~500ms — the increased traffic volume forces the tunnel to flush
          // its buffer, and the client handler is idempotent (setState to a
          // state it's already in is a no-op). Cheap insurance.
          for (let i = 1; i <= 4; i++) {
            setTimeout(() => {
              if (abort.signal.aborted) return;
              try {
                sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
              } catch { /* ignore */ }
            }, i * 120);
          }
        }
      } catch (err) {
        logger.error('TTS stream failed', { error: err instanceof Error ? err.message : String(err) }, session.agentId);
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'error', detail: 'tts_failed' });
      } finally {
        cancelQuietTimer();
        if (session.activeTts && session.activeTts.abort === abort) {
          session.activeTts = null;
        }
        if (session.splitter === splitter) session.splitter = null;
        if (session.unsubscribeChunk) {
          session.unsubscribeChunk();
          session.unsubscribeChunk = null;
        }
        // Re-arm the proactive watcher for the next unsolicited message.
        // Skipped if the WS already closed (sessions.delete handled it).
        if (sessions.has(session.ws) && !session.unsubscribeProactive) {
          session.unsubscribeProactive = subscribeProactiveWatcher(session);
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
  //
  // Safety net: close the splitter after 4 seconds of post-bubble-done
  // quiet WITH no tools in flight. The 'no tools in flight' guard is what
  // keeps this safe for tool-using turns: a tool that takes 30s to run
  // doesn't false-trigger the timer because the timer is cancelled the
  // moment chat:tool_call fires and only re-arms after chat:tool_result
  // brings the in-flight count back to zero AND chat:chunk done has been
  // seen. So desktop's existing happy path (agent:status idle always
  // fires) is unaffected; this only kicks in when agent:status is dropped
  // AND there's genuinely no activity left.
  let bubbleCount = 0;
  let bubbleChars = 0;
  const QUIET_CLOSE_MS = 4000;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let toolsInFlight = 0;
  let bubbleDoneSeen = false;
  const armQuietTimer = () => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (abort.signal.aborted) return;
      logger.info('Voice TTS: closing splitter after 4s of chat-chunk quiet', {
        agentId: session.agentId, messageId,
      });
      const tail = sanitizer.flushUnsafe();
      if (tail) splitter.push(tail);
      try { splitter.close(); } catch { /* ignore */ }
    }, QUIET_CLOSE_MS);
  };
  const cancelQuietTimer = () => {
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
  };
  const maybeArmQuietTimer = () => {
    // Only arm when the bubble is done AND no tools are still running.
    // Either condition flipping back cancels the timer.
    if (bubbleDoneSeen && toolsInFlight === 0) armQuietTimer();
  };
  abort.signal.addEventListener('abort', cancelQuietTimer, { once: true });
  // Proactive watcher path: the watcher captures the FIRST chat:chunk
  // content and hands it to us as `initialContent`. We push it through
  // sanitizer+splitter here BEFORE subscribing the burst listener, so
  // the burst's listener doesn't double-process it (the live broadcast
  // already fired before we got here).
  if (initialContent) {
    bubbleChars += initialContent.length;
    const clauses = sanitizer.pushClauses(initialContent);
    if (clauses.length > 0) {
      splitter.push(...clauses);
      startStreaming();
    }
  }
  const unsubscribe = onBroadcast((event: WsEvent) => {
    if (abort.signal.aborted) return;
    if (event.type === 'chat:chunk') {
      if (event.agentId !== session.agentId) return;
      // New content from the model = activity. Cancel any pending close;
      // we'll re-evaluate when the next done arrives.
      cancelQuietTimer();
      if (event.content) {
        bubbleChars += event.content.length;
        bubbleDoneSeen = false;  // new content means this bubble isn't done anymore
        const clauses = sanitizer.pushClauses(event.content);
        if (clauses.length > 0) {
          splitter.push(...clauses);
          startStreaming();
        }
      }
      if (event.done) {
        bubbleCount++;
        // Flush the tail of this bubble — anything past the last clause
        // boundary, sanitized with no boundary requirement, gets queued
        // as the final clause so audio for this bubble starts even when
        // the model's reply doesn't end on punctuation.
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
        bubbleDoneSeen = true;
        maybeArmQuietTimer();
      }
      return;
    }
    if (event.type === 'chat:tool_call') {
      if (event.agentId !== session.agentId) return;
      // Tool started — don't close while we wait for the result, even if
      // the tool takes 30+ seconds.
      toolsInFlight++;
      cancelQuietTimer();
      return;
    }
    if (event.type === 'chat:tool_result') {
      if (event.agentId !== session.agentId) return;
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      // If everything's settled (no tools running, bubble was done),
      // re-arm the timer to catch the case where the post-tool model call
      // never produces a second bubble (server crash / silent exit).
      maybeArmQuietTimer();
      return;
    }
    if (event.type === 'agent:status') {
      if (event.agentId !== session.agentId) return;
      if (event.status === 'idle') {
        logger.info('Voice TTS: closing splitter on agent:status idle', {
          agentId: session.agentId, messageId,
        });
        cancelQuietTimer();
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

/**
 * Catch proactive agent messages (the ones not in response to a voice
 * prompt — watchers firing, A2A pokes, scheduled triggers) and route them
 * into a TTS burst so voice-mode users hear them too.
 *
 * Self-unsubscribes the moment it triggers a burst, to avoid double-
 * processing the same event (the burst's own listener will be subscribed
 * during the same Set iteration and would otherwise also fire for it).
 * Re-subscribed by startTtsForAgent's finally block when the burst ends.
 */
function subscribeProactiveWatcher(session: VoiceSession): () => void {
  const unsubscribe = onBroadcast((event: WsEvent) => {
    if (event.type !== 'chat:chunk') return;
    if (event.agentId !== session.agentId) return;
    if (!event.content) return;        // ignore done-only / empty events
    if (session.activeTts) return;     // burst in flight; its listener handles it
    // Snap off self before kicking off the burst so we don't double-fire.
    unsubscribe();
    if (session.unsubscribeProactive === unsubscribe) {
      session.unsubscribeProactive = null;
    }
    logger.info('Voice TTS: starting burst for proactive agent message', {
      agentId: session.agentId, chars: event.content.length,
    });
    startTtsForAgent(session, event.content);
  });
  return unsubscribe;
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
