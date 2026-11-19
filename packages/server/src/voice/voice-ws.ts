/**
 * Per-connection voice session handler, one session per (user, agent) pair, served on the voice WS
 * endpoint wired in gateway/server.ts.
 *   client JSON: config, utterance_start, utterance_canonical, utterance_end, barge_in, close
 *   client binary: Float32 little-endian PCM, 16kHz mono
 *   server: transcribes on utterance_end, posts the user message, pipes the agent reply text into TTS,
 *   and emits binary WAV frames (24kHz Int16 PCM) plus voice:tts_end when the stream is done.
 */

import type { WSContext } from 'hono/ws';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { broadcast, onBroadcast } from '../gateway/ws.js';
import { turnAnswersSpokenRequest } from '../memory/served-ask.js';
import { submitUserMessage } from '../gateway/routes/chat.js';
import { transcribeBuffer, pcmFloatToWav, ensureSttReady } from './stt-service.js';
import { loadVoiceSettings, type VoiceSettings } from './voice-settings.js';
import { synthesizeClauseStream, createClauseQueue, DEFAULT_VOICE, loadKokoro, isKokoroLoaded } from './tts-service.js';
import { recordAtDoor, recordedId } from '../agent/v2/outbound.js';
import { checkCustomVoiceUsable } from './custom-voices.js';
import { StreamingSpeechBuffer } from './text-sanitize.js';
import { HumeStreamSession } from './hume-engine.js';
import { createCueExtractor } from './cue-parser.js';
import { getDb } from '../db/connection.js';
import { markSpokenAloud } from '../memory/message-store.js';
import { KOKORO_MODEL_ID } from './model-manager.js';
import { predictTurnComplete, TURN_COMPLETE_THRESHOLD, warmUpSmartTurn } from './smart-turn.js';
import type { WsEvent } from '@dojo/shared';
import { stripNoReplySentinel } from '@dojo/shared';

const logger = createLogger('voice-ws');

interface VoiceSession {
  ws: WSContext;
  userId: string;
  agentId: string;
  pcmChunks: Float32Array[];
  pcmSampleRate: number;
  unsubscribeChunk: (() => void) | null;
  activeTts: { abort: AbortController; messageId: string } | null;
  splitter: ReturnType<typeof createClauseQueue> | null;
  // Live partials: whisper runs on the in-flight buffer about every second of new audio.
  partialInFlight: boolean;
  partialLastChunkCount: number;
  lastPartialText: string;
  // Wake-word mode: while `passive`, transcripts are dropped until `wakePhrase` is heard; while active,
  // `sleepPhrase` returns to passive without submitting the utterance.
  wakeWordEnabled: boolean;
  wakePhrase: string;
  sleepPhrase: string;
  passive: boolean;
  // Application-level ping so tunnels do not close the socket during silent periods.
  pingInterval: ReturnType<typeof setInterval> | null;
  // Catches proactive agent messages (watchers, pokes) while no TTS is active and starts a TTS burst.
  unsubscribeProactive: (() => void) | null;
  /** Transcript held after a mid-thought utterance; the timer submits it unless a continuation arrives
   *  and merges with it. `speaking` marks a hold stretched because the person started speaking again. */
  pendingTurnExtension: { transcript: string; timer: ReturnType<typeof setTimeout>; speaking: boolean } | null;
  // Set by 'utterance_canonical': the next binary frame is vad-web's canonical buffer (with preroll)
  // and REPLACES pcmChunks, restoring the first word the live frame stream cuts off.
  expectingCanonicalFrame: boolean;
  // Engine-agnostic handle for pushing text into the active TTS burst (set by the running burst, cleared
  // in its teardown); pushVoiceFiller uses it.
  activeBurstPush: ((text: string) => void) | null;
  /** Time (ms) of the last utterance_end processed; drops vad-web's duplicate onSpeechEnd. */
  lastUtteranceEndAt: number;
  // One-shot guard: the cloud-to-local fallback notice is sent at most once per session.
  cloudFallbackNotified: boolean;
  // One-shot guard: the custom-voice-unavailable warning is logged at most once per session.
  customVoiceWarned: boolean;
}

// Mark an assistant message as voice-delivered and broadcast chat:source_updated so dashboards update
// the "via voice" badge in place. Idempotent: markSpokenAloud only updates rows not yet on a channel.
function markAssistantMessageVoiced(agentId: string, messageId: string): void {
  if (!messageId) return;
  try {
    if (markSpokenAloud(messageId) > 0) {
      broadcast({ type: 'chat:source_updated', agentId, messageId, source: 'voice' });
    }
  } catch (err) {
    logger.warn('Failed to mark message as voice-delivered', {
      messageId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Normalizes both sides of a wake-phrase match, since whisper adds punctuation ("Hey, Aria?"). */
function normalizeForPhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Compact American Soundex. Phonetic equivalence catches whisper homophone drift on proper nouns
// (Aria, Arya and Ariya all give A600).
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

// Intro words whisper often drops from a wake phrase; the core word alone still wakes, but only for
// short utterances so incidental name mentions do not trigger.
const WAKE_INTRO_WORDS = new Set(['hey', 'hi', 'yo', 'ok', 'okay', 'hello']);
const SHORT_UTTERANCE_MAX_WORDS = 3;

// Fuzzy wake/sleep phrase matcher, cheapest tolerance first: (1) exact substring after normalization;
// (2) Soundex on each word, then substring; (3) intro-word drop, "hey <core>" matching just <core>,
// only when the utterance has at most SHORT_UTTERANCE_MAX_WORDS words.
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

  // Space-separated soundex so the phrase matches as a substring without crossing word boundaries.
  const transcriptSx = transcriptWords.map(soundex).join(' ');
  const phraseSx = phraseWords.map(soundex).join(' ');

  // 2. Phonetic substring match on the full phrase
  const sxIdx = transcriptSx.indexOf(phraseSx);
  if (sxIdx !== -1) {
    const wordsBefore = transcriptSx.slice(0, sxIdx).trim().split(' ').filter(Boolean).length;
    const remainder = transcriptWords.slice(wordsBefore + phraseWords.length).join(' ');
    return { matched: true, remainder };
  }

  // 3. Intro-word drop: a known intro word, a core word after it, and a short utterance.
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

// Push a filler phrase into the agent's active TTS bursts so the user is not left in silence while a
// voice turn runs tools. Returns false when no voice session of the agent has a burst running.
export function pushVoiceFiller(agentId: string, phrase: string): boolean {
  let pushed = false;
  for (const session of sessions.values()) {
    if (session.agentId !== agentId || !session.activeBurstPush) continue;
    try {
      session.activeBurstPush(phrase);
      pushed = true;
    } catch { /* that burst is closing */ }
  }
  return pushed;
}

// Only a turn answering a spoken request is read aloud: chunks of any other turn never reach speech.
function onSpokenEvent(handler: (event: WsEvent) => void): () => void {
  return onBroadcast((event) => {
    if (event.type === 'chat:chunk' && !turnAnswersSpokenRequest(event.agentId)) return;
    handler(event);
  });
}

function sendJson(ws: WSContext, payload: object): void {
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

function sendBinary(ws: WSContext, buf: Buffer): void {
  try { ws.send(buf as unknown as ArrayBuffer); } catch { /* ignore */ }
}

// Release a voice client when a reply is finished or cannot be spoken: sends the terminal tts_end +
// listening frames (with the tunnel-insurance repeats) so the orb never hangs.
function releaseVoiceClient(session: VoiceSession, messageId: string): void {
  sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
  for (let i = 1; i <= 4; i++) {
    setTimeout(() => {
      try { sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId }); } catch { /* ignore */ }
    }, i * 120);
  }
}

// Frees a finished burst's slots on the session and re-arms the proactive watcher it had paused. A burst
// that is no longer the current one (barge-in, a newer reply) leaves its successor's slots alone.
function retireBurst(session: VoiceSession, abort: AbortController): void {
  if (session.activeTts?.abort !== abort) return;
  session.activeTts = null;
  session.activeBurstPush = null;
  if (session.unsubscribeChunk) {
    session.unsubscribeChunk();
    session.unsubscribeChunk = null;
  }
  if (sessions.has(session.ws) && !session.unsubscribeProactive) {
    session.unsubscribeProactive = subscribeProactiveWatcher(session);
  }
}

// One-shot, per-session voice:notice that a transient cloud-voice failure moved this reply to the local
// voice; the client shows it as an info toast.
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
      // Passive only while wake-word mode is on.
      passive: saved.wakeWordEnabled,
      pingInterval: null,
      unsubscribeProactive: null,
      pendingTurnExtension: null,
      expectingCanonicalFrame: false,
      activeBurstPush: null,
      lastUtteranceEndAt: 0,
      cloudFallbackNotified: false,
      customVoiceWarned: false,
    };
    sessions.set(ws, session);
    // Heartbeat every 25s, under typical tunnel and proxy idle timeouts (Cloudflare, nginx's 30s).
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

    // Pre-warm STT and TTS during the first utterance: first load is slow on both (whisper-server,
    // Kokoro), so waiting for the reply text would miss the whole first response.
    void ensureSttReady(saved.sttModel).catch((err) => {
      logger.warn('STT preload failed', { error: err instanceof Error ? err.message : String(err) });
    });
    if (!isKokoroLoaded()) {
      void loadKokoro().catch((err) => {
        logger.warn('Kokoro preload failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
    // Preload Smart Turn; until ready the turn gate uses the conjunction heuristic.
    void warmUpSmartTurn();
    // A spoken turn with no burst waiting (a continuation, a late answer) is read aloud too.
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
  // Clear a held turn-extension timer so it cannot submit on a closed WS.
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

  if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
    const ab = Buffer.isBuffer(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    const f32 = new Float32Array(ab);
    // After utterance_canonical this frame is the full vad-web buffer (with pre-speech padding): it
    // replaces the live frames and triggers no partial, since utterance_end follows.
    if (session.expectingCanonicalFrame) {
      session.expectingCanonicalFrame = false;
      session.pcmChunks = [f32];
      session.partialLastChunkCount = session.pcmChunks.length;
      return;
    }
    session.pcmChunks.push(f32);
    // Start a partial transcription once enough new audio arrived; it no-ops while one is in flight.
    if (session.pcmChunks.length - session.partialLastChunkCount >= PARTIAL_TRANSCRIBE_EVERY_CHUNKS) {
      void runPartialTranscribe(session);
    }
    return;
  }

  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(data as string);
  } catch {
    logger.warn('Voice WS got invalid JSON', { sample: String(data).slice(0, 80) });
    return;
  }

  switch (msg.type) {
    case 'config': {
      // Voice, speed and engines come from the saved settings (read per reply and utterance), not the page.
      const rate = msg.pcmSampleRate;
      if (typeof rate === 'number' && rate >= 8_000 && rate <= 48_000) session.pcmSampleRate = rate;
      sendJson(ws, { type: 'voice:config_ack', ...loadVoiceSettings(), passive: session.passive });
      return;
    }

    case 'utterance_start': {
      // Speaking again during a mid-thought hold: the held words wait longer for this utterance to end,
      // and still go if it never does (a cough the browser starts and never ends).
      const held = session.pendingTurnExtension;
      if (held) holdTranscript(session, held.transcript, SPEAKING_AGAIN_HOLD_MS, true);
      session.pcmChunks = [];
      session.partialLastChunkCount = 0;
      session.lastPartialText = '';
      session.expectingCanonicalFrame = false;
      sendJson(ws, { type: 'voice:state', agentId: session.agentId, state: 'capturing' });
      return;
    }

    case 'utterance_canonical': {
      // The next binary frame replaces pcmChunks (see expectingCanonicalFrame).
      session.expectingCanonicalFrame = true;
      return;
    }

    case 'utterance_end': {
      const held = session.pendingTurnExtension;
      await handleUtteranceEnd(session);
      // The utterance that stretched a hold brought nothing to merge: the held words go after the usual wait.
      if (held?.speaking && session.pendingTurnExtension === held) holdTranscript(session, held.transcript, TURN_EXTENSION_MS, false);
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

// About one second of new audio (~30 vad-web frames) per partial transcription.
const PARTIAL_TRANSCRIBE_EVERY_CHUNKS = 30;
// Whisper hallucinates on very short audio; skip partials until half a second is buffered.
const PARTIAL_MIN_SAMPLES = 16_000 * 0.5;

// Fire-and-forget partial transcription of the buffer so far. Snapshots without draining, so the final
// pass still sees the whole recording; one in flight per session, later chunks wait for the next tick.
async function runPartialTranscribe(session: VoiceSession): Promise<void> {
  if (session.partialInFlight) return;
  if (session.pcmChunks.length === 0) return;
  session.partialInFlight = true;
  session.partialLastChunkCount = session.pcmChunks.length;
  const utterance = session.pcmChunks;
  try {
    const pcm = concatPcm(utterance); // snapshot, not drain
    if (pcm.length < PARTIAL_MIN_SAMPLES) return;
    const wav = pcmFloatToWav(pcm, session.pcmSampleRate);
    const result = await transcribeBuffer(wav, { modelKey: loadVoiceSettings().sttModel });
    const text = result.text.trim();
    // The utterance ended (its chunks were taken) while this ran: a late partial is not live text.
    if (session.pcmChunks !== utterance || !text || text === session.lastPartialText) return;
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
// Short acknowledgments ("yeah", "mhmm") are not prompts and would preempt the agent. The match is exact:
// "ok do that" passes through, bare "ok" does not.
const BACKCHANNELS = new Set([
  'hm', 'hmm', 'hmmm', 'mhm', 'mhmm', 'mmhm', 'mmhmm', 'mm hmm', 'mm hm',
  'uh huh', 'uhuh', 'uhhuh',
  'yeah', 'yep', 'yup', 'ya', 'yah',
  'ok', 'okay', 'kay', 'k',
  'right', 'sure', 'got it', 'gotcha', 'understood', 'cool', 'nice',
  // Negations (no / nope / nah) are deliberately absent: a bare "no" is usually a real instruction, such
  // as stopping an action the agent just announced, so it always submits.
]);

// Turn-taking fallback: when the final transcript ends on a continuing conjunction, hold it for another
// TURN_EXTENSION_MS so a continuation can merge into one turn. Final transcripts only, never partials,
// whose endings flicker.
const TURN_TAKING_CONJUNCTIONS = new Set(['and', 'but', 'so', 'because', 'or']);
const TURN_EXTENSION_MS = 500;

// vad-web double-fires onSpeechEnd ~10-15 ms apart; end signals inside this window are coalesced.
const DOUBLE_FIRE_GUARD_MS = 250;

// Transcription budget: a cold-engine boot allowance, plus a generous grant per second of audio (a bound
// on a wedge, not a performance target), capped so a wedged engine cannot hold the session forever.
const TRANSCRIBE_BOOT_ALLOWANCE_MS = 30_000;
const TRANSCRIBE_MS_PER_AUDIO_SECOND = 2_000;
const TRANSCRIBE_MAX_MS = 10 * 60_000;

/** How long one recording's transcription may take; exported so its test uses the real arithmetic. */
export function transcribeBudgetMsFor(pcmLength: number, sampleRate: number): number {
  const audioSeconds = sampleRate > 0 ? pcmLength / sampleRate : 0;
  return Math.min(
    TRANSCRIBE_BOOT_ALLOWANCE_MS + Math.ceil(audioSeconds) * TRANSCRIBE_MS_PER_AUDIO_SECOND,
    TRANSCRIBE_MAX_MS,
  );
}

// Smart Turn hold: when the model says the user is mid-thought, wait longer the less confident it is that
// they are done (lower p), within a [min, max] range set by the `voice.vad_sensitivity` patience level. A
// continuation arriving in the hold merges and re-runs the model; otherwise the held transcript submits.
const HOLD_RANGES: Record<'quick' | 'normal' | 'patient', { min: number; max: number }> = {
  quick:   { min: 300,  max: 1000 },
  normal:  { min: 700,  max: 2500 },
  patient: { min: 1200, max: 4000 },
};

function smartTurnHoldMs(pComplete: number, threshold: number, patience: VoiceSettings['turnPatience']): number {
  const { min, max } = HOLD_RANGES[patience];
  // frac = 0 at the threshold (barely incomplete), 1 at p=0 (certain mid-thought).
  const frac = Math.max(0, Math.min(1, (threshold - pComplete) / Math.max(threshold, 1e-6)));
  return Math.round(min + frac * (max - min));
}

// How long held words wait once the person speaks again, for that utterance to end and merge.
const SPEAKING_AGAIN_HOLD_MS = 15_000;

// Hold a transcript for `holdMs`, replacing any earlier hold; the timer submits it unless a continuation
// merges into it first (a continuation clears the hold and moves the words forward).
function holdTranscript(session: VoiceSession, transcript: string, holdMs: number, speaking: boolean): void {
  if (session.pendingTurnExtension) clearTimeout(session.pendingTurnExtension.timer);
  const timer = setTimeout(() => {
    if (session.pendingTurnExtension?.timer !== timer) return;
    session.pendingTurnExtension = null;
    void submitTranscriptAndStartTts(session, transcript);
  }, holdMs);
  session.pendingTurnExtension = { transcript, timer, speaking };
}

// Merge a held transcript with a continuation, collapsing the case where both are the SAME utterance
// (a double-fire past the time guard) so words are not repeated.
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

// Carve-out for the backchannel filter: when the agent's latest owner-lane message from the last 60s ends
// with `?`, a short "yeah" or "ok" is a real answer and is submitted. The window keeps a stale question
// from staying open.
function lastAssistantWasQuestion(agentId: string): boolean {
  try {
    const row = getDb().prepare(`
      SELECT content, datetime(created_at/1000,'unixepoch') AS created_at
      FROM messages
      WHERE agent_id = ?
        AND role = 'assistant'
        -- Only what was said to the owner here counts: not a peer agent, not another channel.
        AND lane = 'owner'
        AND COALESCE(channel, '') IN ('', 'dashboard', 'voice')
        AND content IS NOT NULL
        AND content <> ''
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(agentId) as { content: string; created_at: string } | undefined;
    if (!row?.content) return false;
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
  // vad-web can fire onSpeechEnd twice ~10-15 ms apart for one utterance; coalescing end signals inside a
  // short window stops the same utterance being transcribed and merged onto itself.
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
  session.partialLastChunkCount = 0;
  session.lastPartialText = '';
  if (chunks.length === 0) {
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }
  const pcm = concatPcm(chunks);
  if (pcm.length < session.pcmSampleRate / 4) {
    logger.debug('Dropping tiny utterance', { samples: pcm.length });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }

  // Run semantic end-of-turn detection in parallel with STT; null when the model is unavailable (then the
  // lexical-conjunction heuristic decides).
  const turnCompletePromise = predictTurnComplete(pcm, session.pcmSampleRate);

  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'transcribing' });
  const wav = pcmFloatToWav(pcm, session.pcmSampleRate);

  // The budget scales with the audio: pcmChunks was cleared above, so a timeout would lose the user's
  // fully captured speech.
  const audioSeconds = pcm.length / session.pcmSampleRate;
  const transcribeBudgetMs = transcribeBudgetMsFor(pcm.length, session.pcmSampleRate);
  const settings = loadVoiceSettings();
  const runTranscribe = () => Promise.race([
    transcribeBuffer(wav, { modelKey: settings.sttModel }),
    new Promise<never>((_, reject) =>
      setTimeout(
        // The reason carries both numbers so the bound is visibly sized for the recording.
        () => reject(new Error(
          `transcribe_timeout (${Math.round(transcribeBudgetMs / 1000)}s for `
          + `${Math.round(audioSeconds)}s of audio) — STT engine not ready`,
        )),
        transcribeBudgetMs,
      ),
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
    logger.error('Transcription failed', { error: msg }, session.agentId);
    emitTranscribeError(msg);
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
      const { matched, remainder } = findPhrase(transcript, session.wakePhrase);
      if (!matched) {
        logger.debug('Passive mode, no wake phrase, dropping transcript', { agentId: session.agentId, transcript });
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'passive' });
        return;
      }
      session.passive = false;
      logger.debug('Wake phrase detected', { agentId: session.agentId, phrase: session.wakePhrase, remainder: remainder.slice(0, 80) });
      sendJson(session.ws, {
        type: 'voice:wake_detected', agentId: session.agentId,
        phrase: session.wakePhrase, remainder: remainder || null,
      });
      if (!remainder) {
        // Bare wake call, wait for the user's actual prompt next utterance.
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
        return;
      }
      transcript = remainder;
    } else {
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
        stopSpeaking(session);
        return;
      }
    }
  }

  // Backchannel filter: short acknowledgments are not prompts, so go back to listening with no LLM call.
  // Exception: right after the agent asked a question, a short answer IS the answer.
  if (isBackchannel(transcript) && !lastAssistantWasQuestion(session.agentId)) {
    logger.debug('Backchannel detected, not submitting as prompt', { agentId: session.agentId, transcript });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    return;
  }

  // If a previous utterance is held by the extension timer, merge it with this one and clear the timer,
  // so a mid-thought pause the VAD split into two utterance_ends lands as one turn.
  if (session.pendingTurnExtension) {
    clearTimeout(session.pendingTurnExtension.timer);
    transcript = mergeHeldTranscript(session.pendingTurnExtension.transcript, transcript);
    session.pendingTurnExtension = null;
  }

  // Smart Turn predicts acoustically whether the user finished: it holds mid-thought pauses that do not
  // end on a conjunction and submits at once when the user is done, even after "and". The conjunction
  // heuristic applies only when the model is unavailable (null). The timer submits a held transcript
  // unless a continuation merges into it first.
  const threshold = TURN_COMPLETE_THRESHOLD;
  const turnComplete = await turnCompletePromise;
  const holdForContinuation = turnComplete !== null
    ? turnComplete < threshold
    : endsWithUnfinishedConjunction(transcript);
  const holdMs = turnComplete !== null ? smartTurnHoldMs(turnComplete, threshold, settings.turnPatience) : TURN_EXTENSION_MS;

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
    holdTranscript(session, transcript, holdMs, false);
    return;
  }

  await submitTranscriptAndStartTts(session, transcript);
}

// Submit a final voice transcript through the chat pipeline and start TTS for the agent's reply. Used by
// the normal end-of-turn path and the turn-extension timer.
async function submitTranscriptAndStartTts(session: VoiceSession, transcript: string): Promise<void> {
  // source='voice' so the dashboard shows a mic icon on this user bubble.
  const submit = await submitUserMessage(session.agentId, transcript, undefined, 'voice');
  if (!submit.ok) {
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'error', detail: submit.error });
    return;
  }

  // Tells the client the prompt was submitted (not dropped as a backchannel or wake-only utterance).
  sendJson(session.ws, { type: 'voice:prompt_submitted', agentId: session.agentId });

  startTtsForAgent(session);
}

// Strip engine control markers (such as `[no-reply]`) from TTS text: they are routing signals, and a
// cloud engine would improvise words for a bare one.
function stripEngineControlMarkers(text: string): string {
  if (!text) return text;
  // stripNoReplySentinel is shared with the engine so both agree on what the sentinel looks like.
  // Runs of spaces are collapsed afterwards. The probe letter makes a mark that ends the chunk leave its
  // word-gap space, so the next chunk's first word does not glue to this one's last.
  return stripNoReplySentinel(`${text}x`).slice(0, -1).replace(/ {2,}/g, ' ');
}

// Open a TTS burst for the agent's chat:chunk stream. Called after a voice prompt is submitted, and by
// subscribeProactiveWatcher with the first chunk as `initialContent` (the burst listener only sees later
// broadcasts).
function startTtsForAgent(
  session: VoiceSession,
  initialContent?: string,
  opts?: { forceLocal?: boolean; replayEvents?: WsEvent[] },
): void {
  // Pause the proactive watcher for this burst; its teardown re-subscribes it.
  if (session.unsubscribeProactive) {
    session.unsubscribeProactive();
    session.unsubscribeProactive = null;
  }
  // Close any prior subscription, splitter and TTS stream first; an unclosed splitter's consumer never
  // exits.
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

  // Cloud (Hume) streams differently (one socket per turn, no clause queue) so it has its own handler.
  // forceLocal re-drives THIS burst through local after a transient cloud failure; the next burst reads
  // the saved engine again.
  const settings = loadVoiceSettings();
  if (settings.ttsEngine === 'cloud' && !opts?.forceLocal) {
    startCloudTtsBurst(session, settings, initialContent);
    return;
  }

  // Pre-flight a custom voicepack (and the model-version pin); if unusable, fall back to the default
  // voice for this burst and warn once per session, instead of failing on every clause.
  let effectiveVoice = settings.voice;
  const voiceCheck = checkCustomVoiceUsable(settings.voice, KOKORO_MODEL_ID);
  if (!voiceCheck.ok) {
    effectiveVoice = DEFAULT_VOICE;
    if (!session.customVoiceWarned) {
      session.customVoiceWarned = true;
      logger.warn('Custom voice unavailable, using default voice for this session', {
        agentId: session.agentId,
        requestedVoice: settings.voice,
        fallbackVoice: DEFAULT_VOICE,
        reason: voiceCheck.reason,
      });
    }
  }

  // Clause-level TTS: Kokoro runs one clause at a time so first audio lands within ~30 chars of the
  // reply.
  const splitter = createClauseQueue();
  session.splitter = splitter;
  const sanitizer = new StreamingSpeechBuffer();

  const abort = new AbortController();
  const messageId = `tts-${Date.now()}`;
  session.activeTts = { abort, messageId };

  let started = false;
  // Guards the empty-reply terminal emit: a turn with nothing speakable never starts streaming, so the
  // completion block never releases the client. Emitted once, and only if synthesis never started.
  let terminalEmitted = false;
  let sentenceCount = 0;
  const startStreaming = () => {
    if (started) return;
    started = true;
    // One speech-out delivery row per burst (not per clause), recorded where synthesis starts.
    recordedId(recordAtDoor({
      outcome: 'delivered', channel: 'voice', tool: 'speech-out',
      agentId: session.agentId, recipientId: 'owner', messageId, detail: 'local',
    }), 'voice: local TTS spoke', { agentId: session.agentId, messageId });
    logger.info('TTS streaming started', { agentId: session.agentId, messageId, voice: effectiveVoice });
    if (opts?.forceLocal) notifyCloudVoiceFallbackOnce(session);
    sendJson(session.ws, { type: 'voice:tts_start', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'speaking' });
    void (async () => {
      try {
        for await (const chunk of synthesizeClauseStream(splitter, effectiveVoice, settings.speed, abort.signal)) {
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
          // Cloudflare named tunnels can buffer a trailing small text frame; 4 redundant tts_end copies
          // over ~500ms force a flush (the client handler is idempotent).
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
        // Correct the delivered row rather than leave a delivery claim standing over silence.
        recordedId(recordAtDoor({
          outcome: 'failed', channel: 'voice', tool: 'speech-out',
          agentId: session.agentId, recipientId: 'owner', messageId,
          detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }), 'voice: local TTS failed', { agentId: session.agentId, messageId });
        sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'error', detail: 'tts_failed' });
      } finally {
        cancelQuietTimer();
        if (session.splitter === splitter) session.splitter = null;
        retireBurst(session, abort);
      }
    })();
  };

  // Send the terminal tts_end + listening that the completion block would, only when synthesis never
  // started (empty, marker-only or tool-only reply). The !started guard is load-bearing: once synthesis
  // started the completion block owns the transition. Barge-in aborts first, so abort.signal.aborted
  // short-circuits.
  const emitTerminalIfNeverStarted = (): void => {
    if (started || terminalEmitted || abort.signal.aborted) return;
    terminalEmitted = true;
    logger.info('Voice TTS: empty reply, releasing client (synthesis never started)', {
      agentId: session.agentId, messageId,
    });
    sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
    // Same tunnel insurance as the completion block.
    for (let i = 1; i <= 4; i++) {
      setTimeout(() => {
        if (abort.signal.aborted) return;
        try { sendJson(session.ws, { type: 'voice:tts_end', agentId: session.agentId, messageId }); } catch { /* ignore */ }
      }, i * 120);
    }
  };

  // chat:chunk fires done:true after EVERY model call, so done must not close the splitter:
  //   - content: through StreamingSpeechBuffer (strips markdown, summarizes URLs/paths) into the splitter.
  //   - done: flush the sanitized tail, so audio starts as soon as a bubble completes.
  //   - agent:status idle: close the splitter for good.
  // Safety net: close after QUIET_CLOSE_MS of quiet with no tools in flight (cancelled on chat:tool_call,
  // re-armed after the last chat:tool_result once a done was seen), for when agent:status is dropped.
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
      if (tail) { splitter.push(tail); startStreaming(); }
      try { splitter.close(); } catch { /* ignore */ }
      // Reached with synthesis never started (idle dropped, empty reply): release the waiting client.
      emitTerminalIfNeverStarted();
    }, QUIET_CLOSE_MS);
  };
  const cancelQuietTimer = () => {
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
  };
  const maybeArmQuietTimer = () => {
    // Arm only when the bubble is done and no tools are running.
    if (bubbleDoneSeen && toolsInFlight === 0) armQuietTimer();
  };
  abort.signal.addEventListener('abort', cancelQuietTimer, { once: true });
  // Strip a stray ((deliver: ...)) cue so it is not read aloud (only the cloud path uses it).
  const cueExtractor = createCueExtractor();
  // Holds back text from an unmatched `[` until its `]` arrives: control markers like `[no-reply]` stream
  // in pieces and a per-chunk strip would miss them. Flushed verbatim at stream end.
  let bracketPending = '';
  const pushContent = (raw: string): void => {
    let combined = bracketPending + raw;
    // Hold back from the last unmatched `[` (depth-tracked for nesting) until its `]` arrives.
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
    const { content } = cueExtractor.consume(stripped);
    if (content.length === 0) return;
    const clauses = sanitizer.pushClauses(content);
    if (clauses.length > 0) {
      splitter.push(...clauses);
      startStreaming();
    }
  };
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
  // Engine-agnostic push handle. It must go through pushContent, not splitter.push: only pushContent
  // calls startStreaming, and it also runs the sanitizer and bracket buffer on the filler text.
  session.activeBurstPush = (text: string) => {
    try { pushContent(text); } catch { /* burst already torn down */ }
  };

  // Proactive path: push the watcher's first chunk through the sanitizer and splitter before subscribing,
  // since its live broadcast already fired.
  if (initialContent) {
    bubbleChars += initialContent.length;
    pushContent(initialContent);
  }
  const handleLocalEvent = (event: WsEvent): void => {
    if (abort.signal.aborted) return;
    if (event.type === 'chat:chunk') {
      if (event.agentId !== session.agentId) return;
      // New content is activity: cancel any pending close until the next done.
      cancelQuietTimer();
      if (event.content) {
        bubbleChars += event.content.length;
        bubbleDoneSeen = false;  // new content means this bubble isn't done anymore
        pushContent(event.content);
      }
      if (event.done) {
        bubbleCount++;
        // Stamp the message voice-delivered on `done`, not in the content branch: loop.ts INSERTs the row
        // after streaming completes, so earlier the UPDATE would match nothing.
        markAssistantMessageVoiced(session.agentId, event.messageId);
        // Flush text held back after an unclosed `[` (complete markers were stripped in pushContent).
        flushBracketPending();
        // Release an unclosed ((deliver: ...)) cue as normal speech (it was not a real cue), before the
        // sanitizer flush so it lands in this bubble's tail.
        const cueTail = cueExtractor.flush();
        if (cueTail.content.length > 0) {
          const cueClauses = sanitizer.pushClauses(cueTail.content);
          if (cueClauses.length > 0) {
            splitter.push(...cueClauses);
            startStreaming();
          }
        }
        // Flush the bubble's tail past the last clause boundary so audio starts even without final
        // punctuation.
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
      toolsInFlight++;
      cancelQuietTimer();
      return;
    }
    if (event.type === 'chat:tool_result') {
      if (event.agentId !== session.agentId) return;
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      // Re-arm to cover a post-tool model call that never produces another bubble.
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
        if (tail) { splitter.push(tail); startStreaming(); }
        try { splitter.close(); } catch { /* ignore */ }
        // Releases the client when nothing speakable was produced (no-op once synthesis started).
        emitTerminalIfNeverStarted();
      }
      return;
    }
    if (event.type === 'chat:error') {
      if (event.agentId !== session.agentId) return;
      try { splitter.close(); } catch { /* ignore */ }
      emitTerminalIfNeverStarted();
      return;
    }
  };
  const unsubscribe = onSpokenEvent(handleLocalEvent);
  session.unsubscribeChunk = unsubscribe;
  // Cloud fallback re-drive: replay the chat events the cloud burst buffered during its failed open, in
  // order, so the local burst speaks the whole reply. Synchronous after subscribing, so no live event
  // interleaves.
  if (opts?.replayEvents) {
    for (const e of opts.replayEvents) handleLocalEvent(e);
  }
}

/**
 * Cloud (Hume) TTS burst: same lifecycle as the Kokoro burst (chat:chunk, agent:status idle, quiet-timer
 * fallback) but one HumeStreamSession socket per burst, flushed at sentence boundaries. A leading
 * ((deliver: ...)) cue becomes the turn's description. A failed open or a mid-reply failure re-drives the
 * unspoken rest of the reply through local (the next reply tries cloud again).
 */
function startCloudTtsBurst(session: VoiceSession, settings: VoiceSettings, initialContent?: string): void {
  const abort = new AbortController();
  const messageId = `tts-cloud-${Date.now()}`;
  session.activeTts = { abort, messageId };

  const sanitizer = new StreamingSpeechBuffer();
  const cueExtractor = createCueExtractor();

  const hume = new HumeStreamSession({
    voiceId: settings.cloudVoice,
    voiceProvider: settings.cloudVoiceProvider,
    description: settings.cloudDescription ?? undefined,
    speed: settings.cloudSpeed,
    agentId: session.agentId,
  });
  // Engine-agnostic push handle. Hume is not open for the first 100-300ms and hume.push would drop text,
  // so pre-open pushes (e.g. the loop's filler) are buffered and drained once open() resolves.
  let started = false;
  const startStreaming = (): void => {
    if (started) return;
    started = true;
    // Same speech-out delivery row as the local engine, with detail 'cloud'.
    recordedId(recordAtDoor({
      outcome: 'delivered', channel: 'voice', tool: 'speech-out',
      agentId: session.agentId, recipientId: 'owner', messageId, detail: 'cloud',
    }), 'voice: cloud TTS spoke', { agentId: session.agentId, messageId });
    logger.info('Cloud TTS streaming started', {
      agentId: session.agentId, messageId, voice: settings.cloudVoice,
    });
    sendJson(session.ws, { type: 'voice:tts_start', agentId: session.agentId, messageId });
    sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'speaking' });
  };

  let humeOpened = false;
  const preOpenBuffer: string[] = [];
  session.activeBurstPush = (text: string) => {
    // Also fires startStreaming so the dashboard shows 'speaking' when a filler plays.
    if (!humeOpened) {
      preOpenBuffer.push(text);
      return;
    }
    try {
      say(text);
      startStreaming();
    } catch { /* burst already closing */ }
  };

  // Text pushed to Hume whose audio Hume has not finished; a failure re-drives it through the local voice.
  // Each push is flushed, and Hume reports the text of each snippet it finishes. A snippet that does not
  // match the front of the pending text leaves it in place, so a sentence is re-said rather than skipped.
  let unspoken = '';
  const say = (text: string): void => { unspoken += `${unspoken ? ' ' : ''}${text}`; hume.push(text); hume.flush(); };
  hume.onWav = (wav) => {
    if (abort.signal.aborted) return;
    sendBinary(session.ws, wav);
  };
  hume.onSnippetDone = (text) => {
    const t = text.trim();
    const i = unspoken.indexOf(t);
    if (t && i >= 0 && unspoken.slice(0, i).trim() === '') unspoken = unspoken.slice(i + t.length).trimStart();
  };
  let toolsInFlight = 0;
  let bubbleDoneSeen = false;
  let finishing = false;
  let lastMessageId = '';
  let bracketPending = '';
  // The setup after open is synchronous; a failure inside it waits until every pushed text and buffered
  // event is accounted for, then takes the normal path below.
  const setup: { done: boolean; error: Error | null } = { done: false, error: null };

  // A cloud failure hands the rest of the reply to the local voice, same session: the text Hume has not
  // finished, then the live chunks the local burst hears from here on. Nothing left to say and the reply
  // finished: just release the client.
  hume.onError = (err) => {
    if (abort.signal.aborted) return;
    if (!setup.done) { setup.error = err; return; }
    abort.abort();
    unsubscribe();
    // Held raw text (a word, URL or control mark split across chunks) joins with no separator so the
    // local burst sees it whole once the next chunk arrives.
    // An incomplete opening cue leads, so the local burst's cue extractor still sees it at the start.
    const held = sanitizer.takeRaw() + bracketPending;
    const unsaid = `${cueExtractor.held()}${unspoken ? `${unspoken} ` : ''}${held}`;
    if (!unsaid && finishing) {
      logger.warn('Cloud TTS failed after the reply was spoken', { error: err.message }, session.agentId);
      releaseVoiceClient(session, messageId);
      retireBurst(session, abort);
      return;
    }
    logger.warn('Cloud TTS failed mid-reply, continuing in the local voice', { error: err.message }, session.agentId);
    const replay: WsEvent[] = finishing
      ? [{ type: 'agent:status', agentId: session.agentId, status: 'idle' }]
      : bubbleDoneSeen && toolsInFlight === 0
        ? [{ type: 'chat:chunk', agentId: session.agentId, messageId: lastMessageId, content: '', done: true }] : [];
    startTtsForAgent(session, unsaid || undefined, { forceLocal: true, replayEvents: replay });
  };
  hume.onDrop = hume.onError;

  // Subscribe to chat:chunk synchronously: the proactive watcher unsubscribes when it triggers this
  // burst, so events during the hume.open() handshake would otherwise have no listener.
  const pendingEvents: WsEvent[] = [];
  let handler: ((event: WsEvent) => void) | null = null;
  const unsubscribe = onSpokenEvent((event: WsEvent) => {
    if (handler) handler(event);
    else pendingEvents.push(event);
  });

  void (async () => {
    try {
      await hume.open();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unsubscribe();
      retireBurst(session, abort);
      // Barge-in or session close already tore this burst down; do not re-drive an abandoned turn.
      if (abort.signal.aborted || !sessions.has(session.ws)) {
        logger.info('Cloud TTS open failed after abort/close, not re-driving', { error: msg }, session.agentId);
        return;
      }
      // A transient open failure on a correctly configured cloud voice: re-drive THIS burst through
      // local, replaying the buffered events, and tell the user once. The saved engine is untouched so
      // the next turn retries cloud.
      logger.warn('Cloud TTS open failed, falling back to local voice for this burst', { error: msg }, session.agentId);
      const buffered = pendingEvents.splice(0);
      startTtsForAgent(session, initialContent, { forceLocal: true, replayEvents: buffered });
      return;
    }

    // Hume is open: drain pushes buffered during the handshake; later pushes go straight to hume.push.
    humeOpened = true;
    const hadBuffered = preOpenBuffer.length > 0;
    for (const buffered of preOpenBuffer) {
      try { say(buffered); } catch { /* ignore */ }
    }
    preOpenBuffer.length = 0;
    // Drained pre-open content needs startStreaming so the dashboard leaves 'thinking'.
    if (hadBuffered) startStreaming();
    if (session.activeBurstPush) {
      // Replace the buffering wrapper with a direct passthrough now that the handshake is over.
      session.activeBurstPush = (text: string) => {
        try {
          say(text);
          startStreaming();
        } catch { /* burst already closing */ }
      };
    }

    let bubbleCount = 0;
    let bubbleChars = 0;
    const QUIET_CLOSE_MS = 4000;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

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
        say(tail);
        startStreaming();
      }
      void hume.close().finally(() => {
        // A failure or barge-in already handed the session on; this burst must not touch what replaced it.
        if (abort.signal.aborted) return;
        releaseVoiceClient(session, messageId);
        retireBurst(session, abort);
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
      void hume.close();
    }, { once: true });

    // A ((deliver: ...)) cue overrides Hume's description for this turn; without one the baseline
    // description (voice.cloud_voice_description) stays, even if blank. Same bracket buffer as the local
    // pushContent.
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
      // Whole-sentence buffering: Octave wants complete thoughts, so sanitizer.push releases text only up
      // to the last sentence boundary; bubble-done drains the tail with flushUnsafe.
      const safe = sanitizer.push(content);
      if (safe.length > 0) {
        say(safe);
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
        say(safe);
        startStreaming();
      }
    };

    const handleEvent = (event: WsEvent): void => {
      if (abort.signal.aborted || finishing) return;
      if (event.type === 'chat:chunk') {
        if (event.agentId !== session.agentId) return;
        cancelQuietTimer();
        lastMessageId = event.messageId;
        if (event.content) {
          bubbleChars += event.content.length;
          bubbleDoneSeen = false;
          pushContent(event.content);
        }
        if (event.done) {
          bubbleCount++;
          // Stamp voice-delivered on done: the row is persisted by then.
          markAssistantMessageVoiced(session.agentId, event.messageId);
          // Flush held-back bracket text so it is not dropped at stream end.
          flushBracketPending();
          // Release an unclosed cue as speech, before the sanitizer flush.
          const cueTail = cueExtractor.flush();
          if (cueTail.description) hume.setDescription(cueTail.description);
          if (cueTail.content.length > 0) {
            const safe = sanitizer.push(cueTail.content);
            if (safe.length > 0) {
              say(safe);
              startStreaming();
            }
          }
          const tail = sanitizer.flushUnsafe();
          if (tail) {
            say(tail);
            startStreaming();
          }
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

    // Process the proactive watcher's initial chunk, then the events buffered during hume.open(), then
    // attach the live handler.
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
    setup.done = true;
    if (setup.error) hume.onError?.(setup.error);
  })();
}

// Start a TTS burst for a spoken turn that arrives with no burst running. Unsubscribes itself when it
// triggers one, so the burst's own listener does not double-process the event; the burst teardown
// re-subscribes it.
function subscribeProactiveWatcher(session: VoiceSession): () => void {
  const unsubscribe = onSpokenEvent((event: WsEvent) => {
    if (event.type !== 'chat:chunk') return;
    if (event.agentId !== session.agentId) return;
    if (!event.content) return;        // ignore done-only / empty events
    if (session.activeTts) return;     // burst in flight; its listener handles it
    unsubscribe();
    if (session.unsubscribeProactive === unsubscribe) {
      session.unsubscribeProactive = null;
    }
    logger.info('Voice TTS: starting burst for a spoken turn', {
      agentId: session.agentId, chars: event.content.length,
    });
    startTtsForAgent(session, event.content);
  });
  return unsubscribe;
}

// Cuts the burst in flight (if any) and hands the session back to the proactive watcher.
function stopSpeaking(session: VoiceSession): void {
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
  // Re-arm the proactive watcher: a barge-in before streaming started tears the burst down without the
  // completion path that normally re-subscribes it. Guarded on null so it cannot double-subscribe.
  if (sessions.has(session.ws) && !session.unsubscribeProactive) {
    session.unsubscribeProactive = subscribeProactiveWatcher(session);
  }
}

function bargeIn(session: VoiceSession): void {
  logger.info('Voice barge-in', { agentId: session.agentId });
  stopSpeaking(session);
  // Also cancel the in-flight model call, or the agent keeps generating a reply the user is overriding.
  // preemptAgentForUrgentMessage aborts cleanly; stopAgent would inject a stop marker, wrong for a
  // redirect.
  void import('../agent/runtime.js').then((m) => {
    try { m.preemptAgentForUrgentMessage(session.agentId); } catch { /* ignore */ }
  });
  sendJson(session.ws, { type: 'voice:state', agentId: session.agentId, state: 'listening' });
}
