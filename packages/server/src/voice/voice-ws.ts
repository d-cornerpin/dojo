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
import { checkCustomVoiceUsable } from './custom-voices.js';
import { StreamingSpeechBuffer } from './text-sanitize.js';
import { HumeStreamSession, isHumeConfigured } from './hume-engine.js';
import { createCueExtractor } from './cue-parser.js';
import { getDb } from '../db/connection.js';
import { getPrimaryAgentName } from '../config/platform.js';
import { WHISPER_MODELS, KOKORO_MODEL_ID, type WhisperSize } from './model-manager.js';
import { predictTurnComplete, TURN_COMPLETE_THRESHOLD, warmUpSmartTurn } from './smart-turn.js';
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
  // before the utterance ends, perceived STT latency drops from ~1s
  // (post-end-of-speech) to ~150ms (mid-speech partial).
  partialInFlight: boolean;
  partialLastChunkCount: number;
  lastPartialText: string;
  // Hands-free wake-word mode. When `wakeWordEnabled` is on and `passive`
  // is true, transcripts are discarded unless the user says `wakePhrase` ,
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
  // not in response to a voice prompt, e.g. a watcher firing, the agent
  // sending an unsolicited update). When it sees agent chat:chunk content
  // and there's no active TTS, it triggers a TTS burst so voice users
  // hear those too. Reset between bursts.
  unsubscribeProactive: (() => void) | null;
  /**
   * Phase 6, held transcript awaiting a possible continuation. Populated
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
  /**
   * Active TTS engine for this session, 'local' (Kokoro) or 'cloud'
   * (Hume). Stored in config as voice.tts_engine; voice-ws.ts reads it
   * once at session open and again whenever the dashboard sends a
   * 'config' WS message with a new tts_engine field. The Cloud path
   * silently falls back to Local when isHumeConfigured() is false.
   */
  ttsEngine: 'local' | 'cloud';
  /** Hume voice id used for cloud TTS bursts. */
  cloudVoice: string;
  /** Hume provider: HUME_AI (Voice Library) or CUSTOM_VOICE (the user's). */
  cloudVoiceProvider: 'HUME_AI' | 'CUSTOM_VOICE';
  /** Standing delivery description for cloud TTS. null = let Octave decide. */
  cloudDescription: string | null;
  /** Speed multiplier for cloud TTS. */
  cloudSpeed: number;
  /**
   * Engine-agnostic handle for pushing text into the currently active
   * TTS burst. Set by whichever burst is running (local Kokoro pushes
   * into its ClauseQueue; cloud Hume pushes via hume.push()). Cleared
   * in the burst's finally block. Used by `pushVoiceFiller` so the
   * filler-phrase feature works regardless of TTS engine choice.
   */
  activeBurstPush: ((text: string) => void) | null;
  /**
   * Fast first-responder window. Set true when a voice prompt is submitted;
   * the burst's chat:chunk listener flips it false the instant the FULL
   * agent's first real content arrives. The fast-opener only speaks while
   * this is true, so if the real reply beats the opener we drop the opener
   * rather than play it out of order.
   */
  /**
   * Timestamp (ms) of the last utterance_end we actually processed. Used to
   * drop vad-web's duplicate onSpeechEnd double-fire (~10-15 ms apart) so one
   * utterance isn't transcribed + merged onto itself.
   */
  lastUtteranceEndAt: number;
  openerWindowOpen: boolean;
  /**
   * True once the fast-opener has been spoken this turn. Suppresses the
   * loop's generic pre-tool filler so the user doesn't hear a contextual
   * opener AND a generic "on it" back to back. Reset each submit.
   */
  openerSpoken: boolean;
  /**
   * FA-VO2 (D-D): true once the one-shot "cloud voice fell back to local"
   * notice has been sent this session. A flaky cloud connection shouldn't
   * spam the notice on every turn, the engine choice stays user-driven and
   * genuinely persistent misconfig already degrades at load, so one heads-up
   * per session is enough.
   */
  cloudFallbackNotified: boolean;
  /**
   * FA-VO3: true once the one-shot "custom voice unavailable, using default"
   * warn has been logged this session. A corrupt/missing voicepack (or a
   * Kokoro model bump that invalidates the pinned geometry) would otherwise
   * warn on every clause; this collapses it to one structured warn.
   */
  customVoiceWarned: boolean;
}

/**
 * Load saved voice settings out of the `config` table. Falls back to
 * defaults on any missing or malformed key.
 */
function loadVoiceSettings(): {
  voice: string; speed: number; sttModel: string;
  wakeWordEnabled: boolean; wakePhrase: string; sleepPhrase: string;
  ttsEngine: 'local' | 'cloud';
  cloudVoice: string;
  cloudVoiceProvider: 'HUME_AI' | 'CUSTOM_VOICE';
  cloudDescription: string | null;
  cloudSpeed: number;
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
  let ttsEngine: 'local' | 'cloud' = 'local';
  let cloudVoice = '';
  let cloudVoiceProvider: 'HUME_AI' | 'CUSTOM_VOICE' = 'HUME_AI';
  let cloudDescription: string | null = null;
  let cloudSpeed = 1;
  try {
    const row = db.prepare(
      "SELECT key, value FROM config WHERE key IN ('voice.preferred_voice', 'voice.playback_speed', 'voice.stt_model', 'voice.wake_word_enabled', 'voice.wake_phrase', 'voice.sleep_phrase', 'voice.tts_engine', 'voice.cloud_voice', 'voice.cloud_voice_provider', 'voice.cloud_voice_description', 'voice.cloud_speed')",
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
      if (r.key === 'voice.tts_engine' && r.value === 'cloud') ttsEngine = 'cloud';
      if (r.key === 'voice.cloud_voice' && r.value) cloudVoice = r.value;
      if (r.key === 'voice.cloud_voice_provider' && r.value === 'CUSTOM_VOICE') cloudVoiceProvider = 'CUSTOM_VOICE';
      if (r.key === 'voice.cloud_voice_description' && r.value.trim()) cloudDescription = r.value.trim().slice(0, 500);
      if (r.key === 'voice.cloud_speed') {
        const n = Number(r.value);
        if (Number.isFinite(n) && n >= 0.5 && n <= 2) cloudSpeed = n;
      }
    }
  } catch { /* table may not yet have these rows, defaults are fine */ }
  // Hard guard: if the user picked cloud but never configured a key OR
  // a cloud voice, drop back to local. We don't want voice mode to break
  // on a misconfiguration; engine fallback is the contract.
  if (ttsEngine === 'cloud' && (!isHumeConfigured() || cloudVoice.length === 0)) {
    ttsEngine = 'local';
  }
  return {
    voice, speed, sttModel,
    wakeWordEnabled, wakePhrase, sleepPhrase,
    ttsEngine, cloudVoice, cloudVoiceProvider, cloudDescription, cloudSpeed,
  };
}

/**
 * Mark an assistant message as voice-delivered: stamps messages.source =
 * 'voice' in the DB and broadcasts chat:source_updated so live dashboard
 * sessions update the bubble's "via voice" badge in place. Idempotent ,
 * the SQL only updates rows where source IS NULL, and the broadcast is
 * cheap, so duplicate calls during a burst are a no-op end-to-end.
 */
function markAssistantMessageVoiced(agentId: string, messageId: string): void {
  if (!messageId) return;
  try {
    const db = getDb();
    const res = db.prepare(
      "UPDATE messages SET source = 'voice' WHERE id = ? AND role = 'assistant' AND (source IS NULL OR source = '')",
    ).run(messageId);
    if (res.changes > 0) {
      broadcast({ type: 'chat:source_updated', agentId, messageId, source: 'voice' });
    }
  } catch (err) {
    logger.warn('Failed to mark message as voice-delivered', {
      messageId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whisper inserts noise around short phrases, a wake phrase like "hey aria"
 * might come back as "Hey, Aria?" or "hey, aria." or even "aria". This
 * normalizes both sides before matching so the wake-word check isn't brittle.
 */
function normalizeForPhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Compact American Soundex implementation. Phonetic equivalence catches
 * the homophone class of whisper misfires for unusual proper nouns:
 *   Aria → A600, Arya → A600, Ariya → A600   (all match)
 *   Alex → A420, Aleks → A420                (all match)
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
      // H and W are transparent, they don't reset.
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
// alone, but ONLY for short utterances, so "Aria is at the store" said to
// another human doesn't false-trigger.
const WAKE_INTRO_WORDS = new Set(['hey', 'hi', 'yo', 'ok', 'okay', 'hello']);
const SHORT_UTTERANCE_MAX_WORDS = 3;

/**
 * Fuzzy wake/sleep phrase matcher. Three layers of tolerance, applied in
 * order from cheapest to loosest:
 *   1. Exact substring after normalization (fast path, preserves prior behavior).
 *   2. Phonetic equivalence: Soundex on each word, then substring match. Catches
 *      Aria/Arya/Ariya and similar whisper proper-noun drift.
 *   3. Intro-word drop: if the phrase is "hey <core>" and whisper transcribed
 *      just <core> (or a homophone), still match, but only when the
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

/**
 * Push a short filler phrase into the active TTS burst for the named
 * agent. Used by the v2 loop when a voice-triggered turn is about to
 * run tools and the model produced no pre-tool acknowledgment of its
 * own - the filler keeps the user from sitting in silence while tools
 * execute.
 *
 * Engine-agnostic: routes through `session.activeBurstPush`, which the
 * active burst (local Kokoro or cloud Hume) sets when it starts and
 * clears in its finally block. Returns false when no voice session is
 * open for this agent, or no burst is currently active.
 */
export function pushVoiceFiller(agentId: string, phrase: string): boolean {
  for (const session of sessions.values()) {
    if (session.agentId !== agentId) continue;
    // If a contextual fast-opener already spoke this turn, skip the generic
    // filler, the user would otherwise hear "let me pull that up" followed by
    // a redundant "on it". One bridge per turn.
    if (session.openerSpoken) return false;
    if (!session.activeBurstPush) return false;
    try {
      session.activeBurstPush(phrase);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function sendJson(ws: WSContext, payload: object): void {
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

function sendBinary(ws: WSContext, buf: Buffer): void {
  try { ws.send(buf as unknown as ArrayBuffer); } catch { /* ignore */ }
}

/**
 * FA-VO2 (D-D): release a voice client from its post-prompt waiting/speaking
 * state after a cloud-TTS failure we are NOT re-driving through local. Sends
 * the same tts_end + voice:state listening terminal frames (plus the
 * Cloudflare-tunnel insurance copies) the normal completion path would, so the
 * orb never hangs. This is the cloud-path analogue of the local engine's
 * emitTerminalIfNeverStarted "always release the client" contract.
 */
function releaseVoiceClient(session: VoiceSession, messageId: string): void {
  sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
  for (let i = 1; i <= 4; i++) {
    setTimeout(() => {
      try { sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId }); } catch { /* ignore */ }
    }, i * 120);
  }
}

/**
 * FA-VO2 (D-D): one-shot, per-session, plain-language notice that a transient
 * cloud-voice failure pushed this reply to the local voice. Sent as a
 * `voice:notice` frame on the voice WS, the client renders it as an info
 * toast (the same surface it already uses for voice errors), which shows
 * regardless of the chat's wordy/non-wordy mode. Fires at most once per
 * session so a flaky cloud link can't spam the toast.
 */
function notifyCloudVoiceFallbackOnce(session: VoiceSession): void {
  if (session.cloudFallbackNotified) return;
  session.cloudFallbackNotified = true;
  logger.info('Cloud voice fell back to local, notifying user once', { agentId: session.agentId });
  sendJson(session.ws, {
    type: 'voice:notice',
    agentId: session.agentId,
    message: 'Your cloud voice had a temporary problem, so this reply is playing in the local voice. It will try the cloud voice again next time.',
  });
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
      ttsEngine: saved.ttsEngine,
      cloudVoice: saved.cloudVoice,
      cloudVoiceProvider: saved.cloudVoiceProvider,
      cloudDescription: saved.cloudDescription,
      cloudSpeed: saved.cloudSpeed,
      activeBurstPush: null,
      lastUtteranceEndAt: 0,
      openerWindowOpen: false,
      openerSpoken: false,
      cloudFallbackNotified: false,
      customVoiceWarned: false,
    };
    sessions.set(ws, session);
    // Heartbeat every 25s, under Cloudflare Tunnel's default WS idle timeout
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
    // Preload Smart Turn v3 (downloads ~8.6 MB on first use, then warms one
    // inference). Until ready, the turn-taking gate falls back to the legacy
    // conjunction heuristic, so this is pure best-effort.
    void warmUpSmartTurn();
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
  // Phase 6, clear any held turn-extension timer so it can't fire after
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
    // Don't trigger a partial, the next message is utterance_end.
    if (session.expectingCanonicalFrame) {
      session.expectingCanonicalFrame = false;
      session.pcmChunks = [f32];
      session.partialLastChunkCount = session.pcmChunks.length;
      return;
    }
    session.pcmChunks.push(f32);
    // Kick off a partial transcription if we've accumulated enough new audio
    // since the last one. Runs async, caller doesn't wait. If a partial is
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
      if (typeof msg.ttsEngine === 'string') {
        const next: 'local' | 'cloud' = msg.ttsEngine === 'cloud' ? 'cloud' : 'local';
        // Same fallback rule as initial load: cloud requires both a key
        // and a chosen voice. Misconfigured cloud silently degrades to
        // local so voice mode never breaks.
        session.ttsEngine = (next === 'cloud' && (!isHumeConfigured() || session.cloudVoice.length === 0))
          ? 'local' : next;
      }
      if (typeof msg.cloudVoice === 'string' && msg.cloudVoice.length > 0) session.cloudVoice = msg.cloudVoice;
      if (msg.cloudVoiceProvider === 'CUSTOM_VOICE' || msg.cloudVoiceProvider === 'HUME_AI') {
        session.cloudVoiceProvider = msg.cloudVoiceProvider;
      }
      if (typeof msg.cloudDescription === 'string') {
        session.cloudDescription = msg.cloudDescription.trim().length > 0
          ? msg.cloudDescription.trim().slice(0, 500) : null;
      }
      if (typeof msg.cloudSpeed === 'number' && msg.cloudSpeed >= 0.5 && msg.cloudSpeed <= 2) {
        session.cloudSpeed = msg.cloudSpeed;
      }
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
        ttsEngine: session.ttsEngine,
        cloudVoice: session.cloudVoice,
        cloudVoiceProvider: session.cloudVoiceProvider,
        cloudSpeed: session.cloudSpeed,
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
      // utterance, replaces pcmChunks rather than appending. See the
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
// audio buffered, whisper hallucinates badly on sub-300ms samples.
const PARTIAL_MIN_SAMPLES = 16_000 * 0.5;

/**
 * Fire-and-forget partial transcription of whatever's accumulated so far.
 * Snapshots the buffer (does NOT drain) so the final pass on utterance_end
 * still sees the complete recording. One in-flight at a time per session ,
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
    // Skip empty / duplicate emissions, whisper sometimes returns "" or
    // re-returns the same partial when audio hasn't changed meaningfully.
    if (!text || text === session.lastPartialText) return;
    session.lastPartialText = text;
    sendJson(session.ws, {
      type: 'voice:stt_partial',
      agentId: session.agentId,
      text,
    });
  } catch (err) {
    // Partials are best-effort, quietly skip on failure.
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
// We catch the most common ones here. The match is intentionally exact ,
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
  // FA-VO4 (D-E): negations (no / nope / nah) are deliberately NOT here.
  // A bare "no" is (almost) always a real instruction, most importantly the
  // "stop what you just announced" case: the agent says "I'll email the whole
  // team now", the user says "No!". Suppressing that as a backchannel let the
  // action proceed. Negations always submit; only the acknowledgment class
  // (mm-hmm / yeah / ok / sure ...) above is suppressed.
]);

/**
 * Phase 6, turn-taking heuristic. After the backchannel filter, look at
 * the FINAL transcript and decide whether the user actually finished the
 * thought. If the last word is a continuing conjunction ("and", "but",
 * "so", "or", "because"), treat the utterance as mid-thought and give
 * the user another 500ms of silence to keep going before we submit it
 * to the LLM. If they DO keep talking, the next utterance_end merges
 * with the held one and we submit as a single combined turn. If they
 * don't, the held timer fires and submits as-is.
 *
 * Strips terminal punctuation before checking so "and." still counts as
 * "and". Operates ONLY on the final transcript, never on partials, the
 * partial stream can flicker between conjunction and non-conjunction
 * endings depending on how the model committed each chunk.
 */
const TURN_TAKING_CONJUNCTIONS = new Set(['and', 'but', 'so', 'because', 'or']);
const TURN_EXTENSION_MS = 500;

// vad-web double-fires onSpeechEnd ~10-15 ms apart for one utterance; coalesce
// utterance_end signals that land within this window (well below any real
// continuation gap, which is hundreds of ms).
const DOUBLE_FIRE_GUARD_MS = 250;

// ── Smart Turn hold policy ──
// When Smart Turn says the user is mid-thought, the old flat 500ms wait was
// far too short to catch a real thinking pause, so the fragment submitted and
// the agent answered an unfinished sentence. Instead, wait LONGER the more
// confident the model is that they're not done (lower p), bounded below by a
// snappy floor and above by a cap that keeps a wrong "incomplete" from feeling
// stuck. A continuation utterance arriving in this window merges + re-runs the
// model; if none arrives, the held transcript submits on its own.
// Turn-taking patience dial, how long to wait for the user to continue a
// mid-thought turn. Driven by the `voice.vad_sensitivity` setting (repurposed
// from the old client VAD-redemption knob into a pure patience control). Each
// level is a [min, max] hold range; the confidence-scaled hold lands inside it
// (lower p ⇒ more certain they're mid-thought ⇒ closer to max).
const HOLD_RANGES: Record<'quick' | 'normal' | 'patient', { min: number; max: number }> = {
  quick:   { min: 300,  max: 1000 },
  normal:  { min: 700,  max: 2500 },
  patient: { min: 1200, max: 4000 },
};

function getTurnPatience(): 'quick' | 'normal' | 'patient' {
  try {
    const row = getDb()
      .prepare("SELECT value FROM config WHERE key = 'voice.vad_sensitivity'")
      .get() as { value: string } | undefined;
    const v = row?.value;
    if (v === 'quick' || v === 'normal' || v === 'patient') return v;
  } catch { /* fall back to the default below */ }
  // FA-VO6(a): the unset default must MATCH the dashboard, which shows 'quick'
  // for a box that never set voice.vad_sensitivity (Settings VoiceTab initial
  // state). This used to default 'normal' here, so the two silently diverged:
  // the UI claimed a snappy hold while the server ran the slower one. Migration
  // 097 also seeds the row so the stored state is explicit going forward.
  return 'quick';
}

function smartTurnHoldMs(pComplete: number, threshold: number): number {
  const { min, max } = HOLD_RANGES[getTurnPatience()];
  // frac = 0 at the threshold (barely incomplete), 1 at p=0 (certain mid-thought).
  const frac = Math.max(0, Math.min(1, (threshold - pComplete) / Math.max(threshold, 1e-6)));
  return Math.round(min + frac * (max - min));
}

// Decision threshold: P(complete) at/above this submits, below holds. Tunable
// live via the `voice.turn_complete_threshold` config key (0..1), higher =
// more patient (fewer cut-offs, but more latency when the model wrongly thinks
// a finished turn is unfinished). Defaults to the Smart Turn module default.
function getTurnCompleteThreshold(): number {
  try {
    const row = getDb()
      .prepare("SELECT value FROM config WHERE key = 'voice.turn_complete_threshold'")
      .get() as { value: string } | undefined;
    const v = row?.value ? Number(row.value) : NaN;
    if (Number.isFinite(v) && v > 0 && v < 1) return v;
  } catch { /* fall back to default */ }
  return TURN_COMPLETE_THRESHOLD;
}

// Merge a held transcript with a continuation, deduping the case where they are
// really the SAME utterance (a vad double-fire that slipped past the time guard,
// or overlapping canonical buffers). A genuine continuation adds NEW words; a
// duplicate just repeats them, concatenating those gives "make this make this".
function mergeHeldTranscript(held: string, next: string): string {
  const h = held.trim();
  const n = next.trim();
  if (!h) return n;
  if (!n) return h;
  const norm = (s: string) => s.toLowerCase().replace(/[.,!?;:]+$/g, '').trim();
  const nh = norm(h);
  const nn = norm(n);
  if (nh === nn) return n.length >= h.length ? n : h; // exact duplicate → keep one
  if (nn.startsWith(nh)) return n;                    // next already contains held
  if (nh.startsWith(nn)) return h;                    // held already contains next
  return `${h} ${n}`.trim();                          // genuine continuation
}

function endsWithUnfinishedConjunction(transcript: string): boolean {
  const cleaned = transcript.trim().replace(/[.!?,;:]+$/g, '').toLowerCase();
  if (!cleaned) return false;
  const lastWord = cleaned.split(/\s+/).pop() ?? '';
  return TURN_TAKING_CONJUNCTIONS.has(lastWord);
}

export function isBackchannel(transcript: string): boolean {
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

/**
 * Carve-out for the backchannel filter: if the agent just asked the
 * user a question (most recent assistant message in the last 60s
 * ends with `?`), short acknowledgments like "yeah", "yep", "ok", or
 * "sure" are legitimate answers, not mid-thought acks. We bypass the
 * backchannel filter in that window. (Negations like "no"/"nope" are no
 * longer in the backchannel set at all per FA-VO4, so they always submit
 * regardless of this carve-out.)
 *
 * Time window stops a stale question from years-ago staying open
 * forever (e.g. agent asked an hour ago, user mumbles "yeah" while
 * unrelated). Most natural Q&A lands within a couple of seconds; 60s
 * is generous.
 */
function lastAssistantWasQuestion(agentId: string): boolean {
  try {
    const row = getDb().prepare(`
      SELECT content, created_at
      FROM messages
      WHERE agent_id = ?
        AND role = 'assistant'
        AND content IS NOT NULL
        AND content <> ''
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(agentId) as { content: string; created_at: string } | undefined;
    if (!row?.content) return false;
    // Stored as either plain text or a JSON array of content blocks
    // (text + tool_use). Pull just the text.
    let text = row.content;
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: { type?: string }) => b?.type === 'text')
            .map((b: { text?: string }) => b.text ?? '')
            .join(' ');
        }
      } catch { /* not JSON, treat as text */ }
    }
    const cleaned = text.trim();
    if (!cleaned.endsWith('?')) return false;
    // created_at is stored as UTC datetime string without timezone marker.
    const ageMs = Date.now() - new Date(row.created_at + (row.created_at.includes('Z') ? '' : 'Z')).getTime();
    return ageMs >= 0 && ageMs < 60_000;
  } catch {
    return false;
  }
}

async function handleUtteranceEnd(session: VoiceSession): Promise<void> {
  // vad-web can emit onSpeechEnd twice ~10-15 ms apart for a single utterance;
  // the client sends a full canonical-frame + utterance_end sequence each time,
  // so without a guard we transcribe and process the SAME utterance twice, and
  // with the hold/merge path enabled, the second copy gets merged onto the
  // first ("make this make this"). A genuine continuation utterance is hundreds
  // of ms away, never ~10 ms, so coalesce end signals inside a short window.
  const nowMs = Date.now();
  if (nowMs - session.lastUtteranceEndAt < DOUBLE_FIRE_GUARD_MS) {
    logger.debug('Dropping duplicate utterance_end (vad double-fire)', {
      agentId: session.agentId, gapMs: nowMs - session.lastUtteranceEndAt,
    });
    session.pcmChunks = [];
    return;
  }
  session.lastUtteranceEndAt = nowMs;

  const chunks = session.pcmChunks;
  session.pcmChunks = [];
  // Reset partial state, next utterance starts fresh, no carryover.
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

  // Kick off semantic end-of-turn detection in parallel with transcription so
  // its ~12 ms cost is fully hidden behind STT. Consumed at the turn-taking
  // decision below; resolves to null when the model is unavailable, in which
  // case we fall back to the lexical-conjunction heuristic.
  const turnCompletePromise = predictTurnComplete(pcm, session.pcmSampleRate);

  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'transcribing' });
  const wav = pcmFloatToWav(pcm, session.pcmSampleRate);

  // Hard 30s cap. Without this, a stuck whisper-server boot (or a model that's
  // still in the middle of download/warmup) leaves the client in "transcribing"
  // forever with no error feedback.
  const runTranscribe = () => Promise.race([
    transcribeBuffer(wav, { modelKey: session.sttModel }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('transcribe_timeout (30s) — STT engine not ready')), 30_000),
    ),
  ]);
  const emitTranscribeError = (msg: string): void => {
    sendJson(session.ws, {
      type: 'voice:state', agentId: session.agentId,
      state: 'error', detail: msg.includes('timeout') ? 'transcription_timeout' : 'transcription_failed',
    });
  };

  let transcript: string;
  let durationMs: number;
  try {
    const result = await runTranscribe();
    transcript = result.text.trim();
    durationMs = result.durationMs;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // FA-VO6(b): the STT engine was swapped out from under this FINAL
    // transcribe (a settings change flipped the model mid-utterance), so
    // stt-service refused a result that belongs to the now-stale engine. This
    // is the real utterance, not a throwaway partial, don't lose it to a hard
    // error. Retry once: transcribeBuffer re-runs ensureSttReady, so the retry
    // transcribes against the now-active engine. Any other failure keeps the
    // original hard-error behaviour.
    if (msg === 'stt_engine_swapped') {
      logger.warn('STT engine swapped during final transcribe, retrying once against the active engine', { agentId: session.agentId }, session.agentId);
      try {
        const result = await runTranscribe();
        transcript = result.text.trim();
        durationMs = result.durationMs;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        logger.error('Transcription failed after engine-swap retry', { error: retryMsg }, session.agentId);
        emitTranscribeError(retryMsg);
        return;
      }
    } else {
      logger.error('Transcription failed', { error: msg }, session.agentId);
      emitTranscribeError(msg);
      return;
    }
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
        logger.debug('Passive mode, no wake phrase, dropping transcript', { agentId: session.agentId, transcript });
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
        // Bare wake call, wait for the user's actual prompt next utterance.
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
        // Also cancel any in-flight TTS, sleep means "shut up".
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
  // listening, no LLM call, no token spend, no spurious "you said yeah"
  // entry in the chat history.
  //
  // EXCEPTION: if the agent JUST asked a question (most recent assistant
  // message in the last 60s ends with `?`), short answers ARE the
  // actual answer. Without this carve-out, the agent would ask "should
  // I email Sarah?" and the user's "yes" would silently disappear.
  if (isBackchannel(transcript) && !lastAssistantWasQuestion(session.agentId)) {
    logger.debug('Backchannel detected, not submitting as prompt', { agentId: session.agentId, transcript });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }

  // Phase 6, turn-taking heuristic. If a previous utterance ended on a
  // conjunction and is still held by the extension timer, merge it with
  // the new transcript and clear the timer. This is what makes "I went
  // to the store... and... bought some milk" land as a single turn even
  // though the user paused long enough for the VAD to call utterance_end
  // twice.
  if (session.pendingTurnExtension) {
    clearTimeout(session.pendingTurnExtension.timer);
    transcript = mergeHeldTranscript(session.pendingTurnExtension.transcript, transcript);
    session.pendingTurnExtension = null;
  }

  // Turn-taking decision. Smart Turn v3 predicts acoustically whether the
  // user finished their thought (trailing intonation / pause shape), which is
  // far better than the old lexical-conjunction guess: it catches mid-thought
  // pauses that DON'T end on a conjunction, and it submits immediately when the
  // user is clearly done even if they happened to end on "and"/"so", so the
  // common (complete) case pays no debounce at all. We fall back to the
  // conjunction heuristic only when the model is unavailable (returns null).
  //
  // If we believe the user is mid-thought, hold the transcript briefly so a
  // continuation utterance can merge (the Phase 6 mechanism); if no
  // continuation arrives, the timer submits the held transcript on its own.
  const threshold = getTurnCompleteThreshold();
  const turnComplete = await turnCompletePromise;
  const holdForContinuation = turnComplete !== null
    ? turnComplete < threshold
    : endsWithUnfinishedConjunction(transcript);
  const holdMs = turnComplete !== null ? smartTurnHoldMs(turnComplete, threshold) : TURN_EXTENSION_MS;

  logger.debug('Smart Turn decision', {
    agentId: session.agentId, pComplete: turnComplete, threshold,
    hold: holdForContinuation, holdMs: holdForContinuation ? holdMs : undefined,
  });

  if (holdForContinuation) {
    logger.debug('Holding transcript, turn looks unfinished', {
      agentId: session.agentId, transcript, holdMs,
      reason: turnComplete !== null ? `smart-turn p=${turnComplete.toFixed(3)}` : 'conjunction',
    });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    const heldTranscript = transcript;
    const timer = setTimeout(() => {
      // Only fire if nothing has cleared us first (a continuation utterance
      // would have cancelled this timer and moved the transcript forward).
      if (session.pendingTurnExtension?.timer !== timer) return;
      session.pendingTurnExtension = null;
      void submitTranscriptAndStartTts(session, heldTranscript);
    }, holdMs);
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

  // Fast first-responder: open the opener window, start the burst (which sets
  // activeBurstPush synchronously), then race a low-TTFT model to speak a
  // short CONTEXTUAL BRIDGE ("sure, let me pull that up") while the full agent
  // spins up. The opener shares this burst, so it plays first and the real
  // reply streams in right behind it. The opener never states facts, so it
  // can't contradict the answer. If the full agent's reply beats the opener,
  // openerWindowOpen is already false and the opener is dropped (no out-of-
  // order playback).
  session.openerWindowOpen = true;
  session.openerSpoken = false;

  // Subscribe to assistant chunks for this agent; pipe into TTS.
  startTtsForAgent(session);

  void fireFastOpener(session, transcript);
}

// ── Fast first-responder (contextual bridge) ──
//
// Tightly constrained: the opener is a SPOKEN BRIDGE, never an answer. It must
// not state facts, numbers, names, or opinions, only acknowledge the request
// and signal "I'm on it", so it can never contradict the full agent's reply.
const OPENER_SYSTEM_PROMPT =
  'You are the voice of an assistant. The user just spoke a request. Reply with ONE very short ' +
  'spoken bridge phrase (3 to 8 words) that warmly acknowledges the request and signals you are ' +
  'about to handle it — like a person saying "sure, let me take a look" or "good question, one sec". ' +
  'Hard rules: do NOT answer the request; do NOT state any fact, number, name, date, or opinion; ' +
  'do NOT ask a question; do NOT repeat the request back. Output ONLY the phrase, no quotes, no prose.';

const OPENER_TIMEOUT_MS = 1500;
const OPENER_MAX_CHARS = 80;

/**
 * Resolve the model used for the spoken opener. Prefers the dedicated
 * `voice.opener_model` config (a low-TTFT model the user picks); falls back to
 * the System model so the feature works out of the box. `voice.opener_model`
 * set to 'off' disables the opener entirely.
 */
async function resolveOpenerModel(): Promise<string | null> {
  let configured: string | undefined;
  try {
    const row = getDb()
      .prepare("SELECT value FROM config WHERE key = 'voice.opener_model'")
      .get() as { value: string } | undefined;
    configured = row?.value?.trim();
  } catch { /* config table read failed, fall through to system model */ }
  if (configured === 'off') return null;
  if (configured) return configured;
  try {
    const { getSystemModel } = await import('../router/selector.js');
    return getSystemModel() ?? null;
  } catch {
    return null;
  }
}

/** Tidy the model's opener: strip wrapping quotes, collapse to one line, cap
 *  length, and ensure clean terminal punctuation for the TTS clause splitter. */
function sanitizeOpener(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  // Strip a single pair of wrapping quotes the model may have added.
  t = t.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
  // Keep only the first line / sentence-ish, openers should be one clause.
  t = t.split('\n')[0].trim();
  if (t.length > OPENER_MAX_CHARS) t = t.slice(0, OPENER_MAX_CHARS).trim();
  if (t && !/[.!?,…]$/.test(t)) t += '.';
  return t;
}

/**
 * Race a fast model to speak a contextual opener while the full agent spins
 * up. Fully best-effort: any failure (no model, timeout, torn-down burst, real
 * reply already started) silently does nothing. Never throws.
 */
async function fireFastOpener(session: VoiceSession, transcript: string): Promise<void> {
  try {
    const modelId = await resolveOpenerModel();
    if (!modelId) return;
    const { callModel } = await import('../agent/model.js');
    const result = await callModel({
      agentId: session.agentId,
      modelId,
      systemPrompt: OPENER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      tools: false,
      abortSignal: AbortSignal.timeout(OPENER_TIMEOUT_MS),
      // W3-1: documented "fully best-effort, never throws" opener; a failure
      // means silence, which the real reply covers. WARN, not ERROR.
      bestEffort: true,
    });
    const text = sanitizeOpener(result.content ?? '');
    if (!text) return;
    // Ordering guard: only speak if the full agent's real reply hasn't already
    // started (and the burst is still alive).
    if (!session.openerWindowOpen || !session.activeBurstPush) return;
    session.activeBurstPush(text);
    session.openerSpoken = true;
    logger.info('Voice fast-opener spoken', { agentId: session.agentId, model: modelId, text });
  } catch (err) {
    logger.warn('Voice fast-opener failed (non-fatal)', {
      agentId: session.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Open a fresh TTS burst, splitter + Kokoro stream + chat:chunk listener.
 *
 * Called from two places:
 *  1. handleUtteranceEnd, right after submitting a transcribed voice prompt.
 *  2. subscribeProactiveWatcher, when the agent emits chat:chunk content
 *     without a corresponding voice prompt (proactive messages). In that
 *     case the watcher passes the FIRST chunk via `initialContent` so it
 *     isn't lost, the burst listener subscribes after this function
 *     returns and only catches subsequent broadcasts.
 */
/**
 * Strip engine control markers from text destined for TTS. These tokens
 * are routing/suppression signals the agent emits for the chat pipeline
 * (e.g. `[no-reply]` to say "this turn produces no chat reply"), they
 * are NEVER meant to be spoken. When the agent emits just `[no-reply]`
 * by itself, Octave will improvise something plausible from the
 * baseline description rather than synthesise the literal token; the
 * user hears words the agent never wrote. Strip them here so neither
 * engine has a chance to read them aloud.
 */
function stripEngineControlMarkers(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[no-reply\]/gi, '')
    // Collapse runs of spaces produced by the removal so word boundaries
    // stay intact but we don't end up with double spaces.
    .replace(/ {2,}/g, ' ');
}

function startTtsForAgent(
  session: VoiceSession,
  initialContent?: string,
  opts?: { forceLocal?: boolean; replayEvents?: WsEvent[] },
): void {
  // Pause the proactive watcher for the duration of this burst, the
  // burst's own chat:chunk listener will handle every event from here.
  // The IIFE finally below re-subscribes the watcher.
  if (session.unsubscribeProactive) {
    session.unsubscribeProactive();
    session.unsubscribeProactive = null;
  }
  // Tear down any prior subscription, splitter, and TTS stream before
  // opening a new one. Without closing the prior splitter, its consumer
  // generator would never exit (we'd no longer be listening for the idle
  // event that triggers close), orphaned and slow-leaking memory.
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

  // Engine dispatch, cloud (Hume) takes a totally different streaming
  // shape (one socket per turn, internal buffering, no clause queue), so
  // it lives in its own handler. Local (Kokoro) keeps the clause-queue
  // path below. `opts.forceLocal` is the FA-VO2 (D-D) per-burst override:
  // a transient cloud failure re-drives THIS burst through local without
  // touching session.ttsEngine, so the user's engine choice still stands
  // for the next turn.
  if (session.ttsEngine === 'cloud' && !opts?.forceLocal) {
    startCloudTtsBurst(session, initialContent);
    return;
  }

  // FA-VO3: resolve the voice this burst will actually synthesize with. A
  // custom voicepack that's missing/corrupt, or byte-valid but dimensionally
  // wrong after a KOKORO_MODEL_ID bump, would otherwise throw inside
  // tts.generate on every clause and produce a silent turn. checkCustomVoiceUsable
  // pre-flights the pack (and the model-version pin) and, when it can't be used,
  // we fall back to the default built-in voice for this burst and warn once per
  // session instead of per clause. Built-in voices pass through untouched.
  let effectiveVoice = session.voice;
  const voiceCheck = checkCustomVoiceUsable(session.voice, KOKORO_MODEL_ID);
  if (!voiceCheck.ok) {
    effectiveVoice = DEFAULT_VOICE;
    if (!session.customVoiceWarned) {
      session.customVoiceWarned = true;
      logger.warn('Custom voice unavailable, using default voice for this session', {
        agentId: session.agentId,
        requestedVoice: session.voice,
        fallbackVoice: DEFAULT_VOICE,
        reason: voiceCheck.reason,
      });
    }
  }

  // Phase 4, clause-level TTS. We drive Kokoro one clause at a time so
  // first audio lands within the first ~30 chars of the LLM's reply,
  // instead of waiting for a full sentence boundary.
  const splitter = createClauseQueue();
  session.splitter = splitter;
  const sanitizer = new StreamingSpeechBuffer();

  const abort = new AbortController();
  const messageId = `tts-${Date.now()}`;
  session.activeTts = { abort, messageId };

  let started = false;
  // FA-VO1: guards the empty-reply terminal emit below. A voice turn whose
  // text sanitizes to nothing speakable ([no-reply] only, ((mood:)) only, or a
  // tool-only turn) never calls startStreaming(), so the clause-stream
  // completion block that emits tts_end + voice:state listening never runs and
  // the client sits in its post-prompt waiting state forever. This one-shot
  // flag lets the terminal handlers emit that transition exactly once, and
  // ONLY when synthesis never started (if it did, the completion block owns
  // the state change and emitting here would flip the client to listening
  // while audio is still draining).
  let terminalEmitted = false;
  let sentenceCount = 0;
  const startStreaming = () => {
    if (started) return;
    started = true;
    logger.info('TTS streaming started', { agentId: session.agentId, messageId, voice: effectiveVoice });
    sendJson(session.ws, { type: 'voice:tts_start', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'speaking' });
    // Drain the splitter through Kokoro and emit WAV chunks.
    void (async () => {
      try {
        for await (const chunk of synthesizeClauseStream(splitter, effectiveVoice, session.speed, abort.signal)) {
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
          // ~500ms, the increased traffic volume forces the tunnel to flush
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
        session.activeBurstPush = null;
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

  // FA-VO1: emit the terminal tts_end + voice:state listening that the
  // clause-stream completion block would have sent, but ONLY when synthesis
  // never started (empty / marker-only / tool-only reply). Mirrors what the
  // cloud engine's finishStream does unconditionally, so the local (default)
  // engine matches the cloud path's "always release the client from waiting"
  // contract. The !started guard is the load-bearing invariant: if synthesis
  // DID start, the completion block owns the state transition and calling this
  // would emit listening while audio is still draining. One-shot via
  // terminalEmitted so the three terminal handlers (agent:status idle,
  // chat:error, quiet-timer close) can each call it without double-driving the
  // client. A barge-in aborts the controller first, so abort.signal.aborted
  // short-circuits us and barge-in's own listening emit stands alone.
  const emitTerminalIfNeverStarted = (): void => {
    if (started || terminalEmitted || abort.signal.aborted) return;
    terminalEmitted = true;
    logger.info('Voice TTS: empty reply, releasing client (synthesis never started)', {
      agentId: session.agentId, messageId,
    });
    sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    // Same Cloudflare-tunnel insurance as the completion block: a few
    // redundant tts_end frames so a buffered trailing JSON frame can't leave
    // the client wedged in 'waiting'. Idempotent on the client.
    for (let i = 1; i <= 4; i++) {
      setTimeout(() => {
        if (abort.signal.aborted) return;
        try { sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId }); } catch { /* ignore */ }
      }, i * 120);
    }
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
      // FA-VO1: if this quiet-timer close is reached without synthesis ever
      // starting (agent:status idle was dropped AND the reply was empty), the
      // splitter close has no consumer to trigger the completion block, so
      // release the waiting client here.
      emitTerminalIfNeverStarted();
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
  // Defensive cue strip, even on the local engine, if the agent emits
  // a stray ((deliver: ...)) cue we don't want it read aloud. Kokoro
  // discards the description; only the cloud path acts on it.
  const cueExtractor = createCueExtractor();
  // Pending buffer for unclosed bracket markers. The model streams
  // character-by-character, so a control marker like `[no-reply]` will
  // rarely arrive as a single chat:chunk, it shows up as `[`, `no-`,
  // `reply]` etc. A per-chunk regex strip can't see the full token and
  // misses it, letting "no reply" leak through to TTS. We hold back
  // any content from the last unmatched `[` onward until its `]`
  // arrives, then strip the complete marker. Flushed verbatim at
  // stream end so genuinely-orphan `[` text (rare) still gets spoken.
  let bracketPending = '';
  const pushContent = (raw: string): void => {
    let combined = bracketPending + raw;
    // Hold back any text from the last UNMATCHED `[` onward until we
    // see its closing `]`. Track depth so nested brackets are handled
    // correctly (rare in TTS-bound text but safe).
    let cursor = 0;
    let depth = 0;
    let holdFrom = -1;
    for (let i = 0; i < combined.length; i++) {
      const ch = combined[i];
      if (ch === '[') {
        if (depth === 0) holdFrom = i;
        depth++;
      } else if (ch === ']') {
        if (depth > 0) depth--;
        if (depth === 0) {
          holdFrom = -1;
          cursor = i + 1;
        }
      }
    }
    if (holdFrom >= 0) {
      bracketPending = combined.slice(holdFrom);
      combined = combined.slice(0, holdFrom);
    } else {
      bracketPending = '';
    }
    void cursor; // silence unused, depth/holdFrom carry the logic
    const stripped = stripEngineControlMarkers(combined);
    if (stripped.length === 0) return;
    const { content } = cueExtractor.consume(stripped);
    if (content.length === 0) return;
    const clauses = sanitizer.pushClauses(content);
    if (clauses.length > 0) {
      splitter.push(...clauses);
      startStreaming();
    }
  };
  /** Flush any held-back bracket buffer through the strip + clauses pipeline. */
  const flushBracketPending = (): void => {
    if (!bracketPending) return;
    const tail = bracketPending;
    bracketPending = '';
    const stripped = stripEngineControlMarkers(tail);
    if (!stripped) return;
    const { content } = cueExtractor.consume(stripped);
    if (!content) return;
    const clauses = sanitizer.pushClauses(content);
    if (clauses.length > 0) {
      splitter.push(...clauses);
      startStreaming();
    }
  };
  // v2.9.16 (fix v2.9.18): expose engine-agnostic push handle. Must
  // route through pushContent (NOT splitter.push directly): splitter
  // is just a queue, and the TTS for-await loop only fires when
  // startStreaming() is called - which happens inside pushContent
  // when the first content arrives. The previous wiring did
  // `splitter.push(text)` straight from activeBurstPush, which queued
  // the filler but never started TTS. Result: the filler audio sat
  // buffered until the agent's real response arrived, at which point
  // it played glued to the response instead of during the wait.
  // pushContent also runs the sanitizer + bracket buffer so an
  // accidental control marker in the filler phrase doesn't leak
  // through.
  session.activeBurstPush = (text: string) => {
    try { pushContent(text); } catch { /* burst already torn down */ }
  };

  // Proactive watcher path: the watcher captures the FIRST chat:chunk
  // content and hands it to us as `initialContent`. We push it through
  // sanitizer+splitter here BEFORE subscribing the burst listener, so
  // the burst's listener doesn't double-process it (the live broadcast
  // already fired before we got here).
  if (initialContent) {
    bubbleChars += initialContent.length;
    pushContent(initialContent);
  }
  const handleLocalEvent = (event: WsEvent): void => {
    if (abort.signal.aborted) return;
    if (event.type === 'chat:chunk') {
      if (event.agentId !== session.agentId) return;
      // New content from the model = activity. Cancel any pending close;
      // we'll re-evaluate when the next done arrives.
      cancelQuietTimer();
      if (event.content) {
        // Real agent content has begun, close the fast-opener window so a
        // late opener doesn't play out of order behind the actual reply.
        session.openerWindowOpen = false;
        bubbleChars += event.content.length;
        bubbleDoneSeen = false;  // new content means this bubble isn't done anymore
        pushContent(event.content);
      }
      if (event.done) {
        bubbleCount++;
        // Stamp the assistant message as voice-delivered so the dashboard
        // renders the "via voice" badge on the agent bubble. Done here
        // (NOT in the content branch) because the messages row is
        // INSERTed in loop.ts after streaming completes, during
        // content chunks the row doesn't exist yet so the UPDATE
        // silently matched 0 rows and no broadcast fired. By `done`
        // the row is persisted.
        markAssistantMessageVoiced(session.agentId, event.messageId);
        // If the model ended mid-bracket (e.g. just emitted "[no") and
        // never closed it, flush whatever we held back so the user
        // hears it. Genuine control markers like `[no-reply]` always
        // arrive complete and get stripped in pushContent before
        // ever entering the splitter.
        flushBracketPending();
        // FA-VO5(a): release any unclosed ((deliver: ...)) cue still held in
        // the extractor. It never closed, so it was not a real cue, feed the
        // held body through as normal speech instead of letting it swallow the
        // whole reply. Before the sanitizer flush so the released text lands in
        // this bubble's tail. Kokoro ignores the description.
        const cueTail = cueExtractor.flush();
        if (cueTail.content.length > 0) {
          const cueClauses = sanitizer.pushClauses(cueTail.content);
          if (cueClauses.length > 0) {
            splitter.push(...cueClauses);
            startStreaming();
          }
        }
        // Flush the tail of this bubble, anything past the last clause
        // boundary, sanitized with no boundary requirement, gets queued
        // as the final clause so audio for this bubble starts even when
        // the model's reply doesn't end on punctuation.
        const tail = sanitizer.flushUnsafe();
        if (tail) {
          splitter.push(tail);
          startStreaming();
        }
        try { splitter.flush(); } catch { /* ignore */ }
        logger.debug('Voice bubble done, flushed splitter', {
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
      // Tool started, don't close while we wait for the result, even if
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
        // FA-VO1: the flush above ran first (terminal logic unchanged). If the
        // reply produced nothing speakable, synthesis never started, so
        // closing the splitter has no consumer to emit tts_end + listening ,
        // release the waiting client explicitly. No-op once synthesis started.
        emitTerminalIfNeverStarted();
      }
      return;
    }
    if (event.type === 'chat:error') {
      if (event.agentId !== session.agentId) return;
      try { splitter.close(); } catch { /* ignore */ }
      // FA-VO1: same release for the error terminal, if synthesis never
      // started, the client would otherwise sit in 'waiting' forever.
      emitTerminalIfNeverStarted();
      return;
    }
  };
  const unsubscribe = onBroadcast(handleLocalEvent);
  session.unsubscribeChunk = unsubscribe;
  // FA-VO2 (D-D) re-drive: when a cloud burst fails to open, it re-drives
  // THIS turn through local and hands us the chat events it buffered during
  // the failed hume.open() handshake. Replay them through the same handler,
  // in order, so the local fallback speaks the WHOLE reply (which may have
  // already fully streamed while cloud was trying to connect) rather than
  // only what arrives after the switch. Runs synchronously right after we
  // subscribe, so no live event can interleave and none is lost.
  if (opts?.replayEvents) {
    for (const e of opts.replayEvents) handleLocalEvent(e);
  }
}

/**
 * Cloud (Hume) TTS burst. Mirrors the Kokoro burst's lifecycle (chat:chunk
 * for text + flush points, agent:status idle for end-of-turn, quiet
 * timer fallback) but drives a single HumeStreamSession instead of a
 * ClauseQueue + per-clause Kokoro generate() loop.
 *
 * Key differences vs the local path:
 *   - One socket per BURST (not per clause). Hume buffers internally for
 *     expressive timing; we flush at LLM-clause boundaries to push audio
 *     out as soon as a clause completes.
 *   - The ((deliver: ...)) cue at the front of the burst is parsed and
 *     applied as the per-turn `description` (Hume's "acting
 *     instructions") before the first sendPublish.
 *   - On Hume open() or socket error, we surface a voice:state error so
 *     the client can fall back at the UI level. Engine-level fallback
 *     (silently switch to local mid-session) is intentionally NOT done
 *     here: the engine choice is user-driven, and a silent flip would
 *     mask a misconfiguration.
 */
function startCloudTtsBurst(session: VoiceSession, initialContent?: string): void {
  const abort = new AbortController();
  const messageId = `tts-cloud-${Date.now()}`;
  session.activeTts = { abort, messageId };

  const sanitizer = new StreamingSpeechBuffer();
  const cueExtractor = createCueExtractor();

  const hume = new HumeStreamSession({
    voiceId: session.cloudVoice,
    voiceProvider: session.cloudVoiceProvider,
    description: session.cloudDescription ?? undefined,
    speed: session.cloudSpeed,
  });
  // v2.9.16: engine-agnostic push handle (same pattern as the local
  // path). Lets pushVoiceFiller inject acknowledgments regardless of
  // which TTS engine is active. Cleared in the finally blocks below.
  //
  // Hume isn't open yet at this point - `await hume.open()` runs
  // inside the IIFE below and has a 100-300ms window where calling
  // hume.push() would silently drop the text (same window the
  // existing chat:chunk handler buffers via pendingEvents). The
  // filler trigger from the v2 loop can fire INSIDE this window when
  // a voice-triggered turn goes straight to tools, so we buffer
  // pre-open pushes here and drain after open() resolves. Without
  // this the cloud-TTS user would silently lose the filler.
  let started = false;
  const startStreaming = (): void => {
    if (started) return;
    started = true;
    logger.info('Cloud TTS streaming started', {
      agentId: session.agentId, messageId, voice: session.cloudVoice,
    });
    sendJson(session.ws, { type: 'voice:tts_start', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'speaking' });
  };

  let humeOpened = false;
  const preOpenBuffer: string[] = [];
  session.activeBurstPush = (text: string) => {
    // v2.9.16 (fix v2.9.18): also fire startStreaming so the
    // dashboard moves into 'speaking' state when the filler plays.
    // Without this, hume.push generates audio that the client plays,
    // but the UI still shows the 'thinking' indicator because the
    // voice:tts_start event was never sent.
    if (!humeOpened) {
      preOpenBuffer.push(text);
      return;
    }
    try {
      hume.push(text);
      startStreaming();
    } catch { /* burst already closing */ }
  };

  hume.onWav = (wav) => {
    if (abort.signal.aborted) return;
    sendBinary(session.ws, wav);
  };
  hume.onError = (err) => {
    if (abort.signal.aborted) return; // already tearing down (barge-in / prior error)
    logger.error('Cloud TTS stream error mid-burst, releasing client to listening', {
      error: err.message, agentId: session.agentId,
    }, session.agentId);
    // FA-VO2 (D-D): a mid-burst socket failure. Re-driving only the *remaining*
    // text through local is NOT clean here: Hume buffers internally and the
    // client has already played part of this reply, while the un-spoken
    // remainder streams in via future chat:chunks this aborted burst no longer
    // listens for, splicing local audio onto a half-spoken cloud sentence
    // would double or gap it. So we release the client to listening (the
    // FA-VO1 "never leave the orb hanging" contract, cloud-side) and tell the
    // user once. The engine choice stays cloud for the next turn, which will
    // retry it fresh. release-only is deliberate; see the report for why a
    // mid-burst re-drive isn't attempted.
    releaseVoiceClient(session, messageId);
    notifyCloudVoiceFallbackOnce(session);
    // Tear down burst state so the next turn starts clean and proactive
    // messages resume. abort() fires the abort listener below, which closes
    // the socket; finishStream's terminal frames are then gated off by the
    // aborted check, so there is no double emit with releaseVoiceClient above.
    abort.abort();
    unsubscribe();
    if (session.activeTts && session.activeTts.abort === abort) session.activeTts = null;
    if (session.unsubscribeChunk === unsubscribe) session.unsubscribeChunk = null;
    session.activeBurstPush = null;
    if (sessions.has(session.ws) && !session.unsubscribeProactive) {
      session.unsubscribeProactive = subscribeProactiveWatcher(session);
    }
  };

  // Subscribe to chat:chunk SYNCHRONOUSLY so the 100-300ms window for
  // hume.open() doesn't drop events. The proactive watcher snaps off
  // the moment it triggers this burst; without this immediate
  // subscription, every chat:chunk that arrives during the handshake
  // has no listener and is lost. The bug manifested as proactive
  // agent messages getting only their first content token spoken,
  // with the rest of the message orphaned in the buffer until the
  // NEXT proactive message tacked onto it.
  const pendingEvents: WsEvent[] = [];
  let handler: ((event: WsEvent) => void) | null = null;
  const unsubscribe = onBroadcast((event: WsEvent) => {
    if (handler) handler(event);
    else pendingEvents.push(event);
  });

  void (async () => {
    try {
      await hume.open();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unsubscribe();
      if (session.activeTts && session.activeTts.abort === abort) session.activeTts = null;
      session.activeBurstPush = null;
      // Barge-in or session close already tore this burst down and released
      // the client, don't re-drive a turn the user abandoned.
      if (abort.signal.aborted || !sessions.has(session.ws)) {
        logger.info('Cloud TTS open failed after abort/close, not re-driving', { error: msg }, session.agentId);
        if (sessions.has(session.ws) && !session.unsubscribeProactive) {
          session.unsubscribeProactive = subscribeProactiveWatcher(session);
        }
        return;
      }
      // FA-VO2 (D-D): the cloud voice is correctly configured (the open-time
      // guard in loadVoiceSettings / config already passed) but hit a
      // TRANSIENT failure opening this burst. Don't drop the reply, re-drive
      // THIS burst through the resident local (Kokoro) engine and tell the
      // user once. Per-burst only: session.ttsEngine is untouched, so the next
      // turn retries cloud. Hand the local burst any chat events buffered
      // during the failed handshake so it speaks the full reply (the whole
      // turn may have streamed while cloud was still retrying its connect).
      logger.warn('Cloud TTS open failed, falling back to local voice for this burst', { error: msg }, session.agentId);
      notifyCloudVoiceFallbackOnce(session);
      const buffered = pendingEvents.splice(0);
      startTtsForAgent(session, initialContent, { forceLocal: true, replayEvents: buffered });
      return;
    }

    // Hume is now open. Drain any pushes that arrived during the
    // open() handshake (e.g. the v2 loop's voice-filler trigger when
    // tools fire immediately after the turn starts). Without this
    // drain those pushes vanished silently. From this point on,
    // activeBurstPush goes directly to hume.push.
    humeOpened = true;
    const hadBuffered = preOpenBuffer.length > 0;
    for (const buffered of preOpenBuffer) {
      try { hume.push(buffered); } catch { /* ignore */ }
    }
    preOpenBuffer.length = 0;
    // If we drained pre-open content (e.g. a filler the loop pushed
    // during the open handshake), fire startStreaming so the
    // dashboard moves into 'speaking' state. Without this the audio
    // would play but the UI would stay on 'thinking'.
    if (hadBuffered) startStreaming();
    if (session.activeBurstPush) {
      // Replace the buffering wrapper with a direct passthrough now
      // that the open window is closed. Still fires startStreaming
      // so any subsequent filler / proactive push surfaces the
      // 'speaking' state.
      session.activeBurstPush = (text: string) => {
        try {
          hume.push(text);
          startStreaming();
        } catch { /* burst already closing */ }
      };
    }

    let bubbleCount = 0;
    let bubbleChars = 0;
    const QUIET_CLOSE_MS = 4000;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let toolsInFlight = 0;
    let bubbleDoneSeen = false;
    let finishing = false;

    const cancelQuietTimer = (): void => {
      if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    };
    const finishStream = (reason: string): void => {
      if (finishing) return;
      finishing = true;
      cancelQuietTimer();
      logger.info('Cloud TTS: finishing burst', { agentId: session.agentId, messageId, reason });
      const tail = sanitizer.flushUnsafe();
      if (tail) {
        hume.push(tail);
        startStreaming();
      }
      hume.flush();
      void hume.close().finally(() => {
        if (!abort.signal.aborted) {
          sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
          sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
          // Same Cloudflare tunnel insurance as the local path, push 4
          // redundant tts_end frames so the client doesn't get stuck on
          // 'speaking' if the trailing JSON gets buffered.
          for (let i = 1; i <= 4; i++) {
            setTimeout(() => {
              if (abort.signal.aborted) return;
              try { sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId }); } catch { /* ignore */ }
            }, i * 120);
          }
        }
        if (session.activeTts && session.activeTts.abort === abort) {
          session.activeTts = null;
        }
        session.activeBurstPush = null;
        if (session.unsubscribeChunk) {
          session.unsubscribeChunk();
          session.unsubscribeChunk = null;
        }
        if (sessions.has(session.ws) && !session.unsubscribeProactive) {
          session.unsubscribeProactive = subscribeProactiveWatcher(session);
        }
      });
    };
    const armQuietTimer = (): void => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (abort.signal.aborted) return;
        finishStream('quiet_timeout');
      }, QUIET_CLOSE_MS);
    };
    const maybeArmQuietTimer = (): void => {
      if (bubbleDoneSeen && toolsInFlight === 0) armQuietTimer();
    };
    abort.signal.addEventListener('abort', () => {
      cancelQuietTimer();
      // Best-effort close on abort so the socket doesn't dangle.
      void hume.close();
    }, { once: true });

    // When the agent emits a `((deliver: ...))` cue, override Hume's
    // active description for this turn. When it doesn't, leave the
    // baseline (set on the HumeStreamSession constructor from
    // voice.cloud_voice_description) in place, that's the user's
    // Settings → Voice → Cloud → Baseline delivery field, which is the
    // intended fallback for cue-less replies. If they leave the field
    // blank, that's a deliberate choice and we don't substitute one.
    // Same bracket-buffer fix as the local engine: hold back any text
    // from an unmatched `[` onward until its `]` arrives so that split
    // control markers like `[no-reply]` don't leak through. See the
    // local engine's pushContent for the full rationale.
    let bracketPending = '';
    const pushContent = (raw: string): void => {
      let combined = bracketPending + raw;
      let depth = 0;
      let holdFrom = -1;
      for (let i = 0; i < combined.length; i++) {
        const ch = combined[i];
        if (ch === '[') {
          if (depth === 0) holdFrom = i;
          depth++;
        } else if (ch === ']') {
          if (depth > 0) depth--;
          if (depth === 0) holdFrom = -1;
        }
      }
      if (holdFrom >= 0) {
        bracketPending = combined.slice(holdFrom);
        combined = combined.slice(0, holdFrom);
      } else {
        bracketPending = '';
      }
      const stripped = stripEngineControlMarkers(combined);
      if (stripped.length === 0) return;
      const { content, description } = cueExtractor.consume(stripped);
      if (description) hume.setDescription(description);
      if (content.length === 0) return;
      // Whole-sentence buffering for the cloud engine. The Hume emotion
      // brief is explicit: feed Octave complete thoughts, not clause
      // fragments. sanitizer.push() returns text up to the last balanced
      // sentence boundary (period/!/? followed by whitespace), so each
      // hume.push() carries one or more complete sentences. Anything
      // mid-sentence stays in the buffer until the next chunk completes
      // it, and the bubble-done path uses flushUnsafe to drain the
      // tail when the reply ends mid-sentence.
      const safe = sanitizer.push(content);
      if (safe.length > 0) {
        hume.push(safe);
        hume.flush();
        startStreaming();
      }
    };
    const flushBracketPending = (): void => {
      if (!bracketPending) return;
      const tail = bracketPending;
      bracketPending = '';
      const stripped = stripEngineControlMarkers(tail);
      if (!stripped) return;
      const { content, description } = cueExtractor.consume(stripped);
      if (description) hume.setDescription(description);
      if (!content) return;
      const safe = sanitizer.push(content);
      if (safe.length > 0) {
        hume.push(safe);
        hume.flush();
        startStreaming();
      }
    };

    const handleEvent = (event: WsEvent): void => {
      if (abort.signal.aborted || finishing) return;
      if (event.type === 'chat:chunk') {
        if (event.agentId !== session.agentId) return;
        cancelQuietTimer();
        if (event.content) {
          // Real agent content has begun, close the fast-opener window.
          session.openerWindowOpen = false;
          bubbleChars += event.content.length;
          bubbleDoneSeen = false;
          pushContent(event.content);
        }
        if (event.done) {
          bubbleCount++;
          // Stamp the assistant message as voice-delivered. Done here
          // (NOT in the content branch) because the row is INSERTed in
          // loop.ts after streaming completes, by `done` it exists.
          markAssistantMessageVoiced(session.agentId, event.messageId);
          // Flush any held-back bracket buffer (mid-marker text that
          // never got its closing bracket) so it isn't silently
          // dropped on stream end.
          flushBracketPending();
          // FA-VO5(a): release any unclosed ((deliver: ...)) cue still held in
          // the extractor. It never closed, so it was not a real cue, speak
          // the held body rather than swallow the whole reply. Before the
          // sanitizer flush so the released text rides this bubble's tail.
          const cueTail = cueExtractor.flush();
          if (cueTail.description) hume.setDescription(cueTail.description);
          if (cueTail.content.length > 0) {
            const safe = sanitizer.push(cueTail.content);
            if (safe.length > 0) {
              hume.push(safe);
              hume.flush();
              startStreaming();
            }
          }
          const tail = sanitizer.flushUnsafe();
          if (tail) {
            hume.push(tail);
            startStreaming();
          }
          hume.flush();
          logger.debug('Cloud TTS bubble done', { agentId: session.agentId, bubble: bubbleCount, textChars: bubbleChars });
          bubbleChars = 0;
          bubbleDoneSeen = true;
          maybeArmQuietTimer();
        }
        return;
      }
      if (event.type === 'chat:tool_call') {
        if (event.agentId !== session.agentId) return;
        toolsInFlight++;
        cancelQuietTimer();
        return;
      }
      if (event.type === 'chat:tool_result') {
        if (event.agentId !== session.agentId) return;
        toolsInFlight = Math.max(0, toolsInFlight - 1);
        maybeArmQuietTimer();
        return;
      }
      if (event.type === 'agent:status') {
        if (event.agentId !== session.agentId) return;
        if (event.status === 'idle') finishStream('agent_idle');
        return;
      }
      if (event.type === 'chat:error') {
        if (event.agentId !== session.agentId) return;
        finishStream('chat_error');
        return;
      }
    };

    // Process the initial chunk (captured by the proactive watcher
    // before this burst was created) FIRST, then drain any chat:chunk
    // events that landed during hume.open(). After draining, attach the
    // live handler so future events flow through directly.
    if (initialContent) {
      bubbleChars += initialContent.length;
      pushContent(initialContent);
    }
    while (pendingEvents.length > 0) {
      const e = pendingEvents.shift();
      if (e) handleEvent(e);
    }
    handler = handleEvent;
    session.unsubscribeChunk = unsubscribe;
  })();
}

/**
 * Catch proactive agent messages (the ones not in response to a voice
 * prompt, watchers firing, A2A pokes, scheduled triggers) and route them
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
  // FA-VO5(b): re-arm the proactive watcher. startTtsForAgent snapped it off
  // when the burst began, and only the burst's own completion/finish path
  // re-subscribes it. A barge-in that lands BEFORE streaming started tears the
  // burst down here without that path ever running, so without this the
  // watcher stays unsubscribed and proactive agent messages go unspoken until
  // the next fully-completed turn. Guarded on the null so a burst that already
  // re-subscribed (later completion) can't double-subscribe.
  if (sessions.has(session.ws) && !session.unsubscribeProactive) {
    session.unsubscribeProactive = subscribeProactiveWatcher(session);
  }
  // Cancel the in-flight model call too. Without this, the agent keeps
  // generating tokens for a reply the user is overriding, wastes money on
  // unspoken text, and the agent's next turn ends up "anchored" to a thought
  // they cut off. preemptAgentForUrgentMessage aborts the fetch cleanly
  // without setting stop markers (stopAgent would inject a "[STOPPED BY USER]"
  // marker, which is wrong here, the user isn't stopping, they're redirecting).
  void import('../agent/runtime.js').then((m) => {
    try { m.preemptAgentForUrgentMessage(session.agentId); } catch { /* ignore */ }
  });
  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
}
