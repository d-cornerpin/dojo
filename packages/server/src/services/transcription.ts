// Audio-to-text dispatch. Local engines (local:whisper, local:moonshine) reuse voice/stt-service.ts and
// are charged $0; cloud posts a multipart body to /v1/audio/transcriptions (OpenAI-compatible), whose
// JSON `duration` gives per-minute cost. Audio bytes are resolved upstream by the tool dispatcher.

import path from 'node:path';
import { decodeToWav16kMono, extractAudioFromVideo } from '../agent/effects/transcode.js';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { openAgentCall, STOPPED_BY_USER, type AgentCallSlot } from '../agent/abortable-call.js';
import { getEffectiveTranscriptionModel, type LocalTranscriptionEngine } from './transcription-model.js';
import { transcribeBuffer as localTranscribe, isWhisperBinaryAvailable } from '../voice/stt-service.js';
import { DEFAULT_WHISPER } from '../voice/model-manager.js';
import { phasedTransferDeadline } from './transfer-deadline.js';
import { openAiCompatibleUrl } from './openai-compatible-url.js';

// Local clips longer than this (seconds of 16 kHz mono PCM) fall back from Moonshine, which loops on
// long-form audio, to Whisper, which chunks internally.
const MOONSHINE_MAX_SECONDS = 30;

const logger = createLogger('transcription');

// 1 GB per fetched URL (matches the chat-upload cap).
const FETCH_MAX_BYTES = 1024 * 1024 * 1024;
// Body allowance for the transfer; FETCH_TIMEOUT_MS is the time to first response only.
const FETCH_BODY_BASE_TIMEOUT_MS = 60_000;
const FETCH_BODY_CEILING_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface TranscribeAudioRequest {
  audio: Buffer;
  mimeType: string;
  filename: string;
  language?: string;
  // Whose stop cuts this call; `transcribe_audio` runs synchronously inside the tool executor.
  agentId: string;
}

export interface TranscribeAudioSuccess {
  ok: true;
  text: string;
  // Best-effort input length in seconds for per-minute pricing; null when the provider did not return it.
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
  // STOPPED is the user's own stop button, not a provider failure.
  code: 'NO_MODEL_CONFIGURED' | 'CLOUD_NO_CREDENTIAL' | 'HTTP_ERROR' | 'LOCAL_ENGINE_ERROR' | 'STOPPED' | 'UNKNOWN';
}

export type TranscribeAudioResult = TranscribeAudioSuccess | TranscribeAudioError;

// Re-exported from attachment-resolve.ts so the executor's gate loop and this handler share one resolution point.
export { resolveAttachmentPath } from './attachment-resolve.js';

// Fetch an https URL into a buffer with a hard byte cap and timeout; non-https URLs are rejected.
export async function fetchAudioUrl(agentId: string, url: string): Promise<{ buffer: Buffer; mimeType: string; filename: string } | { error: string; stopped?: true }> {
  // The 'turn' scope: the executor holds the turn open on this synchronous call, so the turn ending cuts it.
  const slot = openAgentCall(agentId, 'turn');
  try {
    if (slot.refused) return { error: STOPPED_BY_USER, stopped: true };
    return await dialAudioUrl(slot, url);
  } finally {
    slot.release();
  }
}

async function dialAudioUrl(slot: AgentCallSlot, url: string): Promise<{ buffer: Buffer; mimeType: string; filename: string } | { error: string; stopped?: true }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { error: `Only https URLs are allowed (got ${parsed.protocol}).` };
    }
    // The server must answer inside the headers window; the body then earns a deadline from its declared
    // size. The over-cap refusal below fires first, so a file past the cap is refused, not downloaded.
    const deadline = phasedTransferDeadline({
      headersMs: FETCH_TIMEOUT_MS,
      bodyBaseMs: FETCH_BODY_BASE_TIMEOUT_MS,
      bodyCeilingMs: FETCH_BODY_CEILING_MS,
      external: slot.signal,
    });
    let response: Response;
    try {
      response = await fetch(url, { signal: deadline.signal });
    } catch (err) {
      deadline.done();
      if (slot.cutByStop()) return { error: STOPPED_BY_USER, stopped: true };
      if (deadline.firedPhase() === 'headers') {
        return { error: `The server did not answer within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s.` };
      }
      throw err;
    }
    if (!response.ok) {
      deadline.done();
      return { error: `Fetch returned HTTP ${response.status}.` };
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    const capMb = FETCH_MAX_BYTES / (1024 * 1024);
    if (contentLength > FETCH_MAX_BYTES) {
      deadline.done();
      return { error: `Audio file is too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Limit is ${capMb} MB.` };
    }
    // Headers are in and the size is inside the cap: the body gets time proportional to it.
    deadline.armBody(contentLength || null);
    let ab: ArrayBuffer;
    try {
      ab = await response.arrayBuffer();
    } catch (err) {
      const stalled = deadline.firedPhase() === 'body';
      const granted = deadline.grantedBodyMs();
      deadline.done();
      if (slot.cutByStop()) return { error: STOPPED_BY_USER, stopped: true };
      if (stalled) {
        return { error: `The audio stopped arriving inside its ${Math.round((granted ?? 0) / 1000)}s transfer window — the download stalled rather than the file being rejected.` };
      }
      throw err;
    }
    deadline.done();
    if (ab.byteLength > FETCH_MAX_BYTES) {
      return { error: `Audio file is too large after download (${(ab.byteLength / 1024 / 1024).toFixed(1)} MB).` };
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg';
    const urlFilename = parsed.pathname.split('/').pop() ?? '';
    const filename = urlFilename || `download-${Date.now()}.mp3`;
    return { buffer: Buffer.from(ab), mimeType, filename };
  } catch (err) {
    if (slot.cutByStop()) return { error: STOPPED_BY_USER, stopped: true };
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch URL: ${msg}` };
  }
}

// Maps the local engine name to the stt-service modelKey. The Whisper key must be a raw WhisperSize
// (DEFAULT_WHISPER); an unknown string silently routes back to Moonshine.
function localEngineToSttModelKey(engine: LocalTranscriptionEngine): string {
  return engine === 'whisper' ? DEFAULT_WHISPER : 'moonshine-base';
}

// True for a WAV already in the engines' format (16 kHz, mono, 16-bit PCM), skipping an ffmpeg pass.
// Any other WAV must be converted; the fmt chunk is found by walking the RIFF chunks.
function isPcmWav(bytes: Buffer): boolean {
  if (bytes.length < 12
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') return false;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = bytes.subarray(pos, pos + 4).toString('ascii');
    const size = bytes.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) return false;
      return bytes.readUInt16LE(body) === 1
        && bytes.readUInt16LE(body + 2) === 1
        && bytes.readUInt32LE(body + 4) === 16000
        && bytes.readUInt16LE(body + 14) === 16;
    }
    pos = body + size + (size % 2);
  }
  return false;
}

// Video containers have their video track stripped first: cloud providers reject most video MIME types.
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
    // Local engines expect 16 kHz mono PCM WAV; ffmpeg converts anything that is not already one.
    let audio = req.audio;
    if (!isPcmWav(audio)) {
      const ext = path.extname(req.filename || '').toLowerCase() || '.bin';
      audio = await decodeToWav16kMono(audio, ext);
    }

    // Clip length from the PCM WAV: 16 kHz mono 16-bit is 32_000 bytes per second, after a 44-byte header.
    const estimatedSeconds = Math.max(0, (audio.length - 44) / 32_000);

    // Long clips swap Moonshine for Whisper; without Whisper installed Moonshine runs anyway.
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
  // The stop door covers the whole cloud leg (request and body read); 'turn' as for the source download.
  const slot = openAgentCall(req.agentId, 'turn');
  try {
    if (slot.refused) return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    return await dialTranscribeCloud(slot, modelId, providerId, apiModelId, req);
  } finally {
    slot.release();
  }
}

async function dialTranscribeCloud(
  slot: AgentCallSlot,
  modelId: string,
  providerId: string,
  apiModelId: string,
  req: TranscribeAudioRequest,
): Promise<TranscribeAudioResult> {
  const credential = getProviderCredential(providerId);
  if (!credential) {
    return { ok: false, error: `No credential found for provider ${providerId}.`, code: 'CLOUD_NO_CREDENTIAL' };
  }

  // The provider's base URL comes from the DB so the request reaches the right host.
  const db = getDb();
  const providerRow = db.prepare('SELECT base_url FROM providers WHERE id = ?').get(providerId) as
    | { base_url: string | null }
    | undefined;
  const endpoint = openAiCompatibleUrl(providerRow?.base_url, 'audio/transcriptions');

  const start = Date.now();
  try {
    // The multipart body is built from the buffer in memory; the cloud path never touches the filesystem.
    const form = new FormData();
    form.append('file', new Blob([req.audio], { type: req.mimeType || 'audio/mpeg' }), req.filename);
    form.append('model', apiModelId);
    if (req.language) form.append('language', req.language);
    // verbose_json makes the provider return `duration`.
    form.append('response_format', 'verbose_json');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'HTTP-Referer': 'https://dojo.dev',
      },
      body: form,
      // Composed with the stop signal; 120s ceiling on the upload.
      signal: AbortSignal.any([slot.signal, AbortSignal.timeout(120_000)]),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Provider returned HTTP ${response.status}: ${errText.slice(0, 300)}`,
        code: 'HTTP_ERROR',
      };
    }

    // Providers that ignore verbose_json answer text/plain.
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
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
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
        'No transcription model is configured. Go to Settings → Models → Transcription Model and pick either a local engine (Whisper / Moonshine) or a cloud model. Tell the person you are talking to transcription is unavailable until this is configured — do not retry.',
    };
  }

  // Video input is demuxed to 16 kHz mono WAV once here, so the local and cloud branches see the same input.
  let workingReq = req;
  if (isVideoInput(req.mimeType, req.filename)) {
    try {
      const ext = path.extname(req.filename || '').toLowerCase() || '.bin';
      const audioWav = await extractAudioFromVideo(req.audio, ext);
      // The .wav extension keeps the upload sane for cloud providers; the stem keeps the source recognizable.
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
