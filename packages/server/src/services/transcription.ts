// ════════════════════════════════════════
// services/transcription.ts — audio-to-text dispatch.
//
// Two paths:
//   1. Local engines (local:whisper, local:moonshine) — reuse the
//      existing voice/stt-service.ts engines. Free. Charged $0 in the
//      ledger.
//   2. Cloud — POST /v1/audio/transcriptions (OpenAI-compatible) with
//      a multipart body. Most providers (OpenAI, Groq, OpenRouter)
//      return `duration` in their JSON response so we can record
//      $/minute cost accurately without parsing the audio ourselves.
//
// Audio source resolution lives upstream of this module: the tool
// dispatcher in agent/tools.ts loads bytes from an attachment id or
// fetches an https URL with a 50 MB cap and hands the buffer here.
// ════════════════════════════════════════

import path from 'node:path';
// PHASE-5 T8 Step 3 (RULING P5-R15 ADDENDUM 4(1)) — the transcode mechanism
// moved into the carrying layer WHOLE. Its fs reach was entirely a temp PAIR in
// `os.tmpdir()` under platform-generated names, which no declaration can name;
// what the tool declares is the PROGRAM, carried under branch (B).
import { decodeToWav16kMono, extractAudioFromVideo } from '../agent/effects/transcode.js';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { getEffectiveTranscriptionModel, type LocalTranscriptionEngine } from './transcription-model.js';
import { transcribeBuffer as localTranscribe, isWhisperBinaryAvailable } from '../voice/stt-service.js';
import { DEFAULT_WHISPER } from '../voice/model-manager.js';

// Audio length (in seconds, derived from 16 kHz mono PCM WAV size) beyond
// which we transparently fall back from Moonshine to Whisper for local
// transcription. Moonshine is trained for short-utterance inference and
// falls into a repeat-loop ("I'm going to be a good person." × 80) on
// long-form audio; whisper.cpp does internal 30 s chunking and handles
// long content cleanly. Whisper-base is only marginally slower for short
// clips, so we only swap when the audio genuinely warrants it.
const MOONSHINE_MAX_SECONDS = 30;

const logger = createLogger('transcription');

// 1 GB per fetched URL (matches the chat-upload cap). Single-user local
// install — no abuse vector — only catches obviously-wrong inputs.
const FETCH_MAX_BYTES = 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface TranscribeAudioRequest {
  audio: Buffer;
  mimeType: string;
  filename: string;
  language?: string;
}

export interface TranscribeAudioSuccess {
  ok: true;
  text: string;
  // Best-effort duration of the input audio in seconds. Used by the cost
  // recorder for per-minute pricing. May be null for local engines
  // (charged $0 anyway) or when the cloud provider didn't return it.
  durationSeconds: number | null;
  latencyMs: number;
  // 'local' for Whisper / Moonshine; otherwise the provider id.
  providerId: string;
  apiModelId: string;
  costMode: 'local' | 'cloud';
}

export interface TranscribeAudioError {
  ok: false;
  error: string;
  code: 'NO_MODEL_CONFIGURED' | 'CLOUD_NO_CREDENTIAL' | 'HTTP_ERROR' | 'LOCAL_ENGINE_ERROR' | 'UNKNOWN';
}

export type TranscribeAudioResult = TranscribeAudioSuccess | TranscribeAudioError;

// Resolve an attachment id to the absolute file path on disk. MOVED VERBATIM to
// `services/attachment-resolve.ts` (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM
// mechanic 5) so the executor's gate loop can resolve an id BEFORE it mints the
// call's capability without importing this module's STT engines and subprocess
// spawn. Re-exported here so no consumer moved: ONE resolution point, shared by
// the gate loop and the handler, is what keeps their two answers the same fact.
export { resolveAttachmentPath } from './attachment-resolve.js';

// Fetch an https URL into a buffer with a hard byte cap and timeout.
// Non-https URLs and file:// are rejected. Used when the agent passes
// `url` instead of `attachment_id`.
export async function fetchAudioUrl(url: string): Promise<{ buffer: Buffer; mimeType: string; filename: string } | { error: string }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { error: `Only https URLs are allowed (got ${parsed.protocol}).` };
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { error: `Fetch returned HTTP ${response.status}.` };
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    const capMb = FETCH_MAX_BYTES / (1024 * 1024);
    if (contentLength > FETCH_MAX_BYTES) {
      return { error: `Audio file is too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Limit is ${capMb} MB.` };
    }
    const ab = await response.arrayBuffer();
    if (ab.byteLength > FETCH_MAX_BYTES) {
      return { error: `Audio file is too large after download (${(ab.byteLength / 1024 / 1024).toFixed(1)} MB).` };
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg';
    // Derive a filename from the URL path; fall back to a uuid-ish stem.
    const urlFilename = parsed.pathname.split('/').pop() ?? '';
    const filename = urlFilename || `download-${Date.now()}.mp3`;
    return { buffer: Buffer.from(ab), mimeType, filename };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch URL: ${msg}` };
  }
}

// Translate dojo's local pseudo-engine names into the modelKey the
// stt-service understands. Moonshine ships as 'moonshine-base'. The
// stt-service's parseSttModelKey treats the Whisper key as a raw
// WhisperSize (e.g. 'base.en', 'large-v3-turbo') — passing the literal
// string 'whisper-base' falls through to the unknown-value branch and
// silently routes back to Moonshine. Use DEFAULT_WHISPER so the swap
// actually lands on Whisper.
function localEngineToSttModelKey(engine: LocalTranscriptionEngine): string {
  return engine === 'whisper' ? DEFAULT_WHISPER : 'moonshine-base';
}

// Detect whether a buffer is already a RIFF/WAVE PCM file we can hand
// straight to the local engines. Saves a tmp ffmpeg round-trip for
// the common case of agents uploading a WAV recording.
function isPcmWav(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
}

// Detect a video container by mime/extension. We strip the video track
// before transcription because cloud transcription providers (OpenAI,
// Groq, OpenRouter passthroughs) reject most video MIME types — they
// only formally accept a subset of audio formats. Local engines could
// in principle read video directly via ffmpeg, but for consistency we
// run the same demux for both paths so the local/cloud branches see
// identical inputs.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.3gp', '.m4v', '.wmv', '.flv']);
function isVideoInput(mimeType: string, filename: string): boolean {
  if (mimeType.toLowerCase().startsWith('video/')) return true;
  const ext = path.extname(filename || '').toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

async function transcribeLocal(
  engine: LocalTranscriptionEngine,
  req: TranscribeAudioRequest,
): Promise<TranscribeAudioResult> {
  const start = Date.now();
  try {
    // Local engines expect 16 kHz mono PCM WAV. The phone-mode pipeline
    // bypasses this because Twilio already streams raw PCM, but
    // user-uploaded clips can be anything (mp3, m4a, opus, etc.). Run
    // ffmpeg unless the buffer is already a RIFF/WAVE.
    let audio = req.audio;
    if (!isPcmWav(audio)) {
      const ext = path.extname(req.filename || '').toLowerCase() || '.bin';
      audio = await decodeToWav16kMono(audio, ext);
    }

    // Estimate clip duration from the prepared PCM WAV. 16 kHz mono
    // 16-bit = 32_000 bytes per second of audio. Header is 44 bytes.
    const estimatedSeconds = Math.max(0, (audio.length - 44) / 32_000);

    // Auto-fall-back from Moonshine to Whisper for long clips.
    // Moonshine's repeat-loop failure mode kicks in around the 30 s
    // mark; whisper.cpp chunks internally and handles long-form fine.
    // If Whisper isn't installed, fall through and let Moonshine try
    // anyway — best-effort beats a hard error.
    let effectiveEngine = engine;
    if (engine === 'moonshine' && estimatedSeconds > MOONSHINE_MAX_SECONDS && isWhisperBinaryAvailable()) {
      logger.info('Local STT: auto-falling back to Whisper for long audio', {
        estimatedSeconds: Math.round(estimatedSeconds),
        threshold: MOONSHINE_MAX_SECONDS,
        originalEngine: engine,
      });
      effectiveEngine = 'whisper';
    }

    const result = await localTranscribe(audio, {
      modelKey: localEngineToSttModelKey(effectiveEngine),
      language: req.language,
      mime: 'audio/wav',
    });
    return {
      ok: true,
      text: result.text.trim(),
      durationSeconds: estimatedSeconds || null,
      latencyMs: Date.now() - start,
      providerId: '__local__',
      apiModelId: `local:${effectiveEngine}`,
      costMode: 'local',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Local transcription failed', { engine, error: message });
    return { ok: false, error: `Local ${engine} transcription failed: ${message}`, code: 'LOCAL_ENGINE_ERROR' };
  }
}

interface OpenAiCompatibleTranscriptionResponse {
  text?: string;
  duration?: number;
}

async function transcribeCloud(
  modelId: string,
  providerId: string,
  apiModelId: string,
  req: TranscribeAudioRequest,
): Promise<TranscribeAudioResult> {
  const credential = getProviderCredential(providerId);
  if (!credential) {
    return { ok: false, error: `No credential found for provider ${providerId}.`, code: 'CLOUD_NO_CREDENTIAL' };
  }

  // Resolve provider base URL from the DB so we route to the right host
  // (OpenAI, OpenRouter, Groq, custom).
  const db = getDb();
  const providerRow = db.prepare('SELECT base_url FROM providers WHERE id = ?').get(providerId) as
    | { base_url: string | null }
    | undefined;
  const baseUrl = (providerRow?.base_url ?? 'https://api.openai.com').replace(/\/+$/, '');
  const endpoint = baseUrl.toLowerCase().endsWith('/api')
    ? `${baseUrl}/v1/audio/transcriptions`
    : baseUrl.toLowerCase().endsWith('/api/v1')
      ? `${baseUrl}/audio/transcriptions`
      : `${baseUrl}/v1/audio/transcriptions`;

  const start = Date.now();
  try {
    // The body is assembled from the buffer this function was handed. A tmp copy
    // of the whole audio used to be written here and unlinked in the `finally`
    // below with nothing ever reading it; its comment claimed the multipart
    // helper wanted a file with a stable filename, and the filename is the third
    // argument to `append`. Deleted at PHASE-5 T8 (RULING P5-R15 ADDENDUM 4(2))
    // on positive evidence, held by `__tests__/transcription-cloud-form.test.ts`:
    // the body carries every byte under the field and filename the provider
    // expects, and the cloud path now touches the filesystem zero times.
    const form = new FormData();
    form.append('file', new Blob([req.audio], { type: req.mimeType || 'audio/mpeg' }), req.filename);
    form.append('model', apiModelId);
    if (req.language) form.append('language', req.language);
    // Ask for verbose_json so we get `duration` back (OpenAI / Groq
    // honor this; OpenRouter passes through to the underlying provider).
    form.append('response_format', 'verbose_json');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'HTTP-Referer': 'https://dojo.dev',
      },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Provider returned HTTP ${response.status}: ${errText.slice(0, 300)}`,
        code: 'HTTP_ERROR',
      };
    }

    // Some providers default to text/plain when verbose_json isn't
    // honored; handle that gracefully.
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    let text: string;
    let duration: number | null = null;
    if (contentType.includes('application/json')) {
      const json = (await response.json()) as OpenAiCompatibleTranscriptionResponse;
      text = (json.text ?? '').trim();
      duration = typeof json.duration === 'number' && json.duration >= 0 ? json.duration : null;
    } else {
      text = (await response.text()).trim();
    }

    return {
      ok: true,
      text,
      durationSeconds: duration,
      latencyMs: Date.now() - start,
      providerId,
      apiModelId,
      costMode: 'cloud',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Cloud transcription failed: ${message}`, code: 'HTTP_ERROR' };
  }
}

export async function transcribeAudio(req: TranscribeAudioRequest): Promise<TranscribeAudioResult> {
  const choice = getEffectiveTranscriptionModel();
  if (!choice) {
    return {
      ok: false,
      code: 'NO_MODEL_CONFIGURED',
      error:
        'No transcription model is configured. Go to Settings → Models → Transcription Model and pick either a local engine (Whisper / Moonshine) or a cloud model. Tell the user transcription is unavailable until this is configured — do not retry.',
    };
  }

  // If the input is a video container (mp4, mov, mkv, …), strip the
  // video track and convert the audio to 16 kHz mono PCM WAV via
  // ffmpeg. Cloud providers reject most video MIMEs; local engines
  // can read video but get cleaner results from prepared PCM. Doing
  // this once at the entry point keeps the local/cloud branches simple.
  let workingReq = req;
  if (isVideoInput(req.mimeType, req.filename)) {
    try {
      const ext = path.extname(req.filename || '').toLowerCase() || '.bin';
      const audioWav = await extractAudioFromVideo(req.audio, ext);
      // Rename to .wav so downstream cloud providers see a sane file
      // extension on the multipart upload. Keep the original stem so
      // the agent can still recognize which source it came from.
      const stem = path.basename(req.filename, path.extname(req.filename)) || 'audio';
      workingReq = {
        ...req,
        audio: audioWav,
        mimeType: 'audio/wav',
        filename: `${stem}.wav`,
      };
      logger.info('Demuxed video to audio for transcription', {
        sourceFilename: req.filename,
        sourceMime: req.mimeType,
        sourceBytes: req.audio.length,
        audioBytes: audioWav.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 'LOCAL_ENGINE_ERROR',
        error: `Failed to extract audio from video: ${message}. Make sure the file is a supported video container and ffmpeg is installed.`,
      };
    }
  }

  if (choice.kind === 'local') {
    return transcribeLocal(choice.localEngine, workingReq);
  }
  return transcribeCloud(choice.modelId, choice.providerId, choice.apiModelId, workingReq);
}

// Convenience for the cost recorder: a model id that means "the local
// pseudo-engine". When this is passed to recordCost, the dispatcher
// should record $0 directly rather than looking up a non-existent row.
export const LOCAL_TRANSCRIPTION_MODEL_ID = '__local_stt__';
