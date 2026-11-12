// Audio and music generation dispatch for `tts_create` / `music_create` (not the voice setup in voice/*).
// The OpenRouter audio models are text-in/audio-out chat-completions models: POST {base}/chat/completions with
// modalities ["text","audio"], format "pcm16", stream true. Streamed audio is headerless pcm16, so the base64
// chunks in `delta.audio.data` are reassembled, WAV-wrapped and saved to ~/.dojo/uploads/generated/.
// Voice models are 24kHz mono and music models 48kHz stereo, so sample rate and channels are caller parameters.

import * as effectFs from '../agent/effects/fs.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { openAgentCall, STOPPED_BY_USER, type AgentCallSlot } from '../agent/abortable-call.js';
import { homeDir } from '../home.js';
import { idleStreamDeadline } from './idle-stream-deadline.js';
import { openAiCompatibleUrl } from './openai-compatible-url.js';

const logger = createLogger('audio-generation');

const GENERATED_DIR = path.join(homeDir(), '.dojo', 'uploads', 'generated');
function ensureGeneratedDir(): void {
  if (!effectFs.existsSync(GENERATED_DIR)) {
    effectFs.mkdirSync(GENERATED_DIR, { recursive: true });
    logger.info('Created generated audio directory', { path: GENERATED_DIR });
  }
}

export interface GenerateAudioRequest {
  modelId: string;        // dojo models.id
  /** Voice models: the text to speak. Music models: the music description. */
  prompt: string;
  /** Voice id for voice models (alloy/echo/nova/…). Omit for music models. */
  voice?: string;
  /** Voice models: frame the prompt as a read-aloud instruction. Music models: pass it as the brief. */
  speak: boolean;
  /** WAV sample rate. GPT Audio = 24000, Lyria = 48000. */
  sampleRate: number;
  /** WAV channel count. GPT Audio = 1 (mono), Lyria = 2 (stereo). */
  channels: number;
  // Whose stop cuts this call, as with `GenerateImageRequest.agentId`.
  agentId: string;
}

export interface GenerateAudioSuccess {
  ok: true;
  filePath: string;       // ~/.dojo/uploads/generated/<uuid>.wav
  filename: string;       // just the <uuid>.wav part
  mimeType: string;       // 'audio/wav'
  sizeBytes: number;
  durationSeconds: number | null;
  inputTokens: number;
  outputTokens: number;
  transcript: string | null;
  apiModelId: string;
  providerId: string;
  latencyMs: number;
}

export interface GenerateAudioError {
  ok: false;
  error: string;
  // `STOPPED` is the user's own button, not a provider failure (see image-generation.ts).
  code: 'MODEL_NOT_FOUND' | 'NO_CREDENTIAL' | 'HTTP_ERROR' | 'EMPTY' | 'WRITE_ERROR' | 'STOPPED' | 'UNKNOWN';
}

export type GenerateAudioResult = GenerateAudioSuccess | GenerateAudioError;

interface ProviderRow { id: string; type: string; base_url: string | null; }
interface ModelRow { id: string; api_model_id: string; provider_id: string; }

function resolveChatCompletionsEndpoint(baseUrl: string | null): string {
  return openAiCompatibleUrl(baseUrl, 'chat/completions');
}

/** Wrap raw little-endian PCM16 samples in a canonical 44-byte WAV header. */
function pcm16ToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);             // PCM fmt chunk size
  header.writeUInt16LE(1, 20);              // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Some models ignore the requested `pcm16` and return a finished container (e.g. Lyria MP3 with ID3 and C2PA
 * metadata); WAV-wrapping that plays as static. Sniff the leading bytes: the real extension + MIME for a
 * container, or null for raw PCM16 (the caller then WAV-wraps it).
 */
function sniffAudioContainer(b: Buffer): { ext: string; mime: string } | null {
  if (b.length < 4) return null;
  // MP3 with an ID3v2 tag: "ID3".
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return { ext: '.mp3', mime: 'audio/mpeg' };
  // RIFF/WAVE.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return { ext: '.wav', mime: 'audio/wav' };
  // OGG: "OggS".
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return { ext: '.ogg', mime: 'audio/ogg' };
  // FLAC: "fLaC".
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return { ext: '.flac', mime: 'audio/flac' };
  // Bare MP3 frame sync: a loud PCM sample can also be 0xFFFx, so validate the rest of the header first.
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    const version = (b[1] >> 3) & 0x03;   // 0x01 = reserved
    const layer = (b[1] >> 1) & 0x03;     // 0x00 = reserved
    const bitrate = (b[2] >> 4) & 0x0f;   // 0x00 = free, 0x0F = bad
    const sampleRate = (b[2] >> 2) & 0x03; // 0x03 = reserved
    if (version !== 0x01 && layer !== 0x00 && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03) {
      return { ext: '.mp3', mime: 'audio/mpeg' };
    }
  }
  return null;
}

interface StreamCollect {
  audioB64: string[];
  transcript: string;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

/**
 * Parse the SSE chat-completions audio stream, collecting base64 PCM16. `onChunk` fires on every read that returns
 * bytes, so the caller can bound the gap between chunks rather than the narration's total length.
 */
// The TTS stream's three bounds, each for its own job: first byte, gap between chunks, absolute ceiling.
const TTS_FIRST_BYTE_TIMEOUT_MS = 180_000;
const TTS_CHUNK_IDLE_TIMEOUT_MS = 60_000;
const TTS_CEILING_MS = 60 * 60_000;

async function collectAudioStream(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): Promise<StreamCollect> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out: StreamCollect = { audioB64: [], transcript: '', inputTokens: 0, outputTokens: 0, error: null };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]' || payload === '') return;
    let d: Record<string, unknown>;
    try { d = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    const err = d.error as { message?: string } | undefined;
    if (err) { out.error = err.message ?? JSON.stringify(err); return; }
    const usage = d.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens;
    }
    const choices = (d.choices as Array<{ delta?: { audio?: { data?: string; transcript?: string } } }> | undefined) ?? [];
    for (const ch of choices) {
      const a = ch.delta?.audio;
      if (!a) continue;
      if (a.data) out.audioB64.push(a.data);
      if (a.transcript) out.transcript += a.transcript;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value && value.length > 0) onChunk?.();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.length > 0) handleLine(buf);
  return out;
}

/** The stop door; same shape as `generateImage`'s. */
export async function generateAudio(req: GenerateAudioRequest): Promise<GenerateAudioResult> {
  // `background`: `tts_create` ends its turn after firing the job, so this call outlives the turn and only the
  // owner's stop reaches it.
  const slot = openAgentCall(req.agentId, 'background');
  try {
    if (slot.refused) {
      logger.info('Audio generation refused: the user stopped this agent', { modelId: req.modelId });
      return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    }
    return await dialAudio(req, slot);
  } finally {
    slot.release();
  }
}

async function dialAudio(req: GenerateAudioRequest, slot: AgentCallSlot): Promise<GenerateAudioResult> {
  ensureGeneratedDir();
  const start = Date.now();

  const db = getDb();
  const modelRow = db.prepare('SELECT id, api_model_id, provider_id FROM models WHERE id = ?')
    .get(req.modelId) as ModelRow | undefined;
  if (!modelRow) {
    return { ok: false, error: `Model ${req.modelId} not found.`, code: 'MODEL_NOT_FOUND' };
  }

  const providerRow = db.prepare('SELECT id, type, base_url FROM providers WHERE id = ?')
    .get(modelRow.provider_id) as ProviderRow | undefined;
  if (!providerRow) {
    return { ok: false, error: `Provider ${modelRow.provider_id} not found.`, code: 'MODEL_NOT_FOUND' };
  }

  const credential = getProviderCredential(providerRow.id);
  if (!credential) {
    return {
      ok: false,
      error: `No credential found for provider ${providerRow.id}. Add it in Settings → Providers.`,
      code: 'NO_CREDENTIAL',
    };
  }

  const endpoint = resolveChatCompletionsEndpoint(providerRow.base_url);
  const userContent = req.speak
    ? `Read the following text aloud, verbatim. Do not add words, commentary, or stage directions:\n\n${req.prompt}`
    : req.prompt;

  const audioField: Record<string, unknown> = { format: 'pcm16' };
  if (req.voice) audioField.voice = req.voice;

  const body = {
    model: modelRow.api_model_id,
    modalities: ['text', 'audio'],
    audio: audioField,
    stream: true,
    messages: [{ role: 'user', content: userContent }],
  };

  logger.info('Audio gen: sending request', {
    endpoint, modelId: req.modelId, apiModelId: modelRow.api_model_id,
    chars: req.prompt.length, voice: req.voice ?? '(none)',
    speak: req.speak, sampleRate: req.sampleRate, channels: req.channels,
  });

  const ttsDeadline = idleStreamDeadline({
    firstByteMs: TTS_FIRST_BYTE_TIMEOUT_MS,
    idleMs: TTS_CHUNK_IDLE_TIMEOUT_MS,
    ceilingMs: TTS_CEILING_MS,
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'HTTP-Referer': 'https://example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // The deadline covers the streamed body: armed until the response starts, then re-armed on every chunk, so a
      // long narration streams and a stalled provider is cut. The ceiling never re-arms.
      signal: AbortSignal.any([slot.signal, ttsDeadline.signal]),
    });
  } catch (err) {
    ttsDeadline.done();
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    return { ok: false, error: `Request failed: ${err instanceof Error ? err.message : String(err)}`, code: 'HTTP_ERROR' };
  }

  if (!response.ok) {
    ttsDeadline.done();
    const errText = await response.text().catch(() => '');
    return {
      ok: false,
      error: `Audio provider returned HTTP ${response.status}: ${errText.slice(0, 400)}`,
      code: 'HTTP_ERROR',
    };
  }
  if (!response.body) {
    ttsDeadline.done();
    return { ok: false, error: 'Audio provider returned no response body.', code: 'EMPTY' };
  }

  // The signal covers the streamed body, so a stop mid-narration surfaces here as a read failure, not a provider error.
  let collected: Awaited<ReturnType<typeof collectAudioStream>>;
  try {
    // Every chunk re-arms the bound: audio arriving proves the provider is alive.
    collected = await collectAudioStream(
      response.body as ReadableStream<Uint8Array>,
      () => ttsDeadline.bump(),
    );
  } catch (err) {
    const wentQuiet = ttsDeadline.fired();
    ttsDeadline.done();
    if (slot.cutByStop()) return { ok: false, error: STOPPED_BY_USER, code: 'STOPPED' };
    if (wentQuiet) {
      return {
        ok: false,
        error: `Audio stream stalled: no audio arrived for ${Math.round(TTS_CHUNK_IDLE_TIMEOUT_MS / 1000)}s, so the narration was stopped.`,
        code: 'HTTP_ERROR',
      };
    }
    return { ok: false, error: `Audio stream read failed: ${err instanceof Error ? err.message : String(err)}`, code: 'HTTP_ERROR' };
  }
  ttsDeadline.done();
  if (collected.error) {
    return { ok: false, error: `Audio provider error: ${collected.error.slice(0, 400)}`, code: 'HTTP_ERROR' };
  }
  if (collected.audioB64.length === 0) {
    return { ok: false, error: 'Audio provider returned no audio data.', code: 'EMPTY' };
  }

  const audioBytes = Buffer.from(collected.audioB64.join(''), 'base64');
  if (audioBytes.length === 0) {
    return { ok: false, error: 'Decoded audio was empty.', code: 'EMPTY' };
  }

  // Raw PCM gets WAV-wrapped with the model's rate/channels; an already
  // containerized payload (e.g. Lyria's MP3) is saved verbatim.
  const container = sniffAudioContainer(audioBytes);
  let fileBytes: Buffer;
  let ext: string;
  let mimeType: string;
  let durationSeconds: number | null;
  if (container) {
    fileBytes = audioBytes;
    ext = container.ext;
    mimeType = container.mime;
    // A real container carries its own duration; parsing it cheaply is
    // format-specific, so leave it null and let the player report length.
    durationSeconds = null;
  } else {
    fileBytes = pcm16ToWav(audioBytes, req.sampleRate, req.channels);
    ext = '.wav';
    mimeType = 'audio/wav';
    // PCM16 duration: bytes / 2 (16-bit) / channels / sampleRate.
    durationSeconds = audioBytes.length / 2 / req.channels / req.sampleRate;
  }

  const filename = `${uuidv4()}${ext}`;
  const filePath = path.join(GENERATED_DIR, filename);
  try {
    effectFs.writeFileSync(filePath, fileBytes);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write audio to disk: ${err instanceof Error ? err.message : String(err)}`,
      code: 'WRITE_ERROR',
    };
  }

  const latencyMs = Date.now() - start;

  logger.info('Audio gen: success', {
    apiModelId: modelRow.api_model_id, providerId: providerRow.id, filePath,
    format: ext, sizeBytes: fileBytes.length,
    durationSeconds: durationSeconds === null ? null : Number(durationSeconds.toFixed(2)),
    inputTokens: collected.inputTokens, outputTokens: collected.outputTokens, latencyMs,
  });

  return {
    ok: true,
    filePath,
    filename,
    mimeType,
    sizeBytes: fileBytes.length,
    durationSeconds,
    inputTokens: collected.inputTokens,
    outputTokens: collected.outputTokens,
    transcript: collected.transcript || null,
    apiModelId: modelRow.api_model_id,
    providerId: providerRow.id,
    latencyMs,
  };
}
