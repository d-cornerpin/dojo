/**
 * Voice settings & model management API.
 *
 *   GET    /api/voice/voices                       — list Kokoro voice presets
 *   GET    /api/voice/models                       — installed STT/TTS models + disk usage
 *   POST   /api/voice/models/:kind/:id             — download (whisper) / preload (kokoro)
 *   DELETE /api/voice/models/:kind/:id             — delete a model file from disk
 *   POST   /api/voice/preview                      — synthesize a short clip in a voice
 *
 * Voice config (preferred voice, playback speed, VAD sensitivity, STT model)
 * lives in the existing `config` table via /api/config/settings/:key — no new
 * routes needed there.
 */

import { Hono } from 'hono';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER,
  ensureWhisperModel,
  ensureKokoroFiles,
  ensureMoonshineFiles,
  listInstalledModels,
  deleteModel,
  totalVoiceDiskBytes,
  freeDiskMb,
  type WhisperSize,
} from './model-manager.js';
import { synthesizeOnce, listVoices, DEFAULT_VOICE, loadKokoro, isKokoroLoaded } from './tts-service.js';
import { DEFAULT_STT_MODEL_KEY, isWhisperBinaryAvailable, ensureSttReady } from './stt-service.js';
import {
  installCustomVoice,
  deleteCustomVoice,
  isValidCustomVoiceId,
  EXPECTED_VOICE_BYTES,
} from './custom-voices.js';
import {
  isHumeConfigured,
  validateHumeKey,
  invalidateHumeClient,
  listHumeVoices,
  synthesizeOnce as humeSynthesizeOnce,
} from './hume-engine.js';
import { setProviderCredential, loadSecrets, saveSecrets } from '../config/loader.js';

const logger = createLogger('voice-routes');

export const voiceRouter = new Hono();

// ── Voice presets ──

voiceRouter.get('/voices', (c) => {
  return c.json({
    ok: true,
    data: {
      voices: listVoices(),
      defaultVoice: DEFAULT_VOICE,
    },
  });
});

// ── Installed models ──

voiceRouter.get('/models', async (c) => {
  const models = listInstalledModels();
  const totalBytes = totalVoiceDiskBytes();
  const freeMb = await freeDiskMb();

  // Annotate each whisper entry with its label + approximate download size,
  // so the dashboard can render "Base (147 MB) — fast, lower quality".
  const whisper = models
    .filter((m) => m.kind === 'whisper')
    .map((m) => {
      const spec = WHISPER_MODELS[m.id as WhisperSize];
      return {
        ...m,
        label: spec?.label ?? m.id,
        approxBytes: spec?.approxBytes ?? null,
      };
    });

  const kokoro = models.find((m) => m.kind === 'kokoro') ?? null;
  const moonshine = models.find((m) => m.kind === 'moonshine') ?? null;

  return c.json({
    ok: true,
    data: {
      whisper,
      kokoro,
      moonshine,
      defaultWhisper: DEFAULT_WHISPER,
      defaultSttModel: DEFAULT_STT_MODEL_KEY,
      // The dashboard greys out the Whisper engine option (and the per-size
      // download buttons) when the local whisper.cpp binary is not present.
      // Moonshine has no native dep, so this flag only gates Whisper UI.
      whisperBinaryAvailable: isWhisperBinaryAvailable(),
      kokoroLoaded: isKokoroLoaded(),
      totalDiskBytes: totalBytes,
      freeDiskMb: freeMb,
    },
  });
});

// ── Download / install ──

// Fire-and-forget install. Whisper-large can take ~2 minutes on a typical home
// connection; Cloudflare's free-tier proxy returns 524 at 100s if we hold the
// HTTP response open. So we kick off the download in the background and let
// the dashboard track completion via the `voice:model_download` WS broadcasts
// (a final tick with bytesDownloaded === bytesTotal signals done; a separate
// `voice:model_install_error` event surfaces failures).
voiceRouter.post('/models/:kind/:id', (c) => {
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  if (kind === 'whisper') {
    if (!(id in WHISPER_MODELS)) {
      return c.json({ ok: false, error: `unknown whisper model: ${id}` }, 400);
    }
    void (async () => {
      try {
        await ensureWhisperModel(id as WhisperSize, (p) => {
          broadcast({
            type: 'voice:model_download',
            data: { kind: 'whisper', modelId: id, bytesDownloaded: p.bytesDownloaded, bytesTotal: p.bytesTotal },
          });
        });
        broadcast({
          type: 'voice:model_download',
          data: { kind: 'whisper', modelId: id, bytesDownloaded: 1, bytesTotal: 1 },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('whisper download failed', { id, error: msg });
        broadcast({ type: 'voice:model_install_error', data: { kind: 'whisper', modelId: id, error: msg } });
      }
    })();
    return c.json({ ok: true, data: { kind, id, started: true } }, 202);
  }
  if (kind === 'kokoro') {
    void (async () => {
      try {
        await ensureKokoroFiles((p) => {
          broadcast({
            type: 'voice:model_download',
            data: { kind: 'kokoro', modelId: id, bytesDownloaded: p.bytesDownloaded, bytesTotal: p.bytesTotal },
          });
        });
        await loadKokoro();
        broadcast({
          type: 'voice:model_download',
          data: { kind: 'kokoro', modelId: id, bytesDownloaded: 1, bytesTotal: 1 },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        logger.error('kokoro install failed', { error: msg, stack });
        broadcast({ type: 'voice:model_install_error', data: { kind: 'kokoro', modelId: id, error: msg } });
      }
    })();
    return c.json({ ok: true, data: { kind, id, started: true } }, 202);
  }
  if (kind === 'moonshine') {
    // Currently a single size ('base'); accept any id so the route's a
    // straight passthrough. The Moonshine engine treats it as a no-op if
    // the files are already present.
    void (async () => {
      try {
        await ensureMoonshineFiles((p) => {
          broadcast({
            type: 'voice:model_download',
            data: { kind: 'moonshine', modelId: id, bytesDownloaded: p.bytesDownloaded, bytesTotal: p.bytesTotal },
          });
        });
        // Warm the engine immediately so a user who clicked "install" can
        // start speaking without paying cold-start on the first utterance.
        await ensureSttReady('moonshine-base');
        broadcast({
          type: 'voice:model_download',
          data: { kind: 'moonshine', modelId: id, bytesDownloaded: 1, bytesTotal: 1 },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('moonshine install failed', { error: msg });
        broadcast({ type: 'voice:model_install_error', data: { kind: 'moonshine', modelId: id, error: msg } });
      }
    })();
    return c.json({ ok: true, data: { kind, id, started: true } }, 202);
  }
  return c.json({ ok: false, error: `unknown model kind: ${kind}` }, 400);
});

// ── Delete ──

voiceRouter.delete('/models/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  if (kind !== 'whisper' && kind !== 'kokoro' && kind !== 'moonshine') {
    return c.json({ ok: false, error: `unknown model kind: ${kind}` }, 400);
  }
  try {
    await deleteModel(kind, id);
    return c.json({ ok: true, data: { kind, id, deleted: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ── Voice preview ──

const DEFAULT_PREVIEW_TEXT = 'Hi, this is your voice for the dojo. How does it sound?';

// ── Custom voice import / delete ──

voiceRouter.post('/custom-voices', async (c) => {
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Could not parse upload: ${msg}` }, 400);
  }
  const file = form.file;
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: 'Missing "file" field (the .bin voicepack)' }, 400);
  }
  if (file.size > EXPECTED_VOICE_BYTES * 2) {
    // Avoid pulling a multi-MB blob into memory only to reject it; the
    // validator will reject anything that isn't exactly EXPECTED_VOICE_BYTES,
    // so cap the upload at 2x that as a defence-in-depth limit.
    return c.json({ ok: false, error: `File too large (${file.size} bytes)` }, 413);
  }

  const id = typeof form.id === 'string' ? form.id.trim().toLowerCase() : '';
  const name = typeof form.name === 'string' ? form.name : '';
  const language = form.language === 'en-gb' ? 'en-gb' : 'en-us';
  const gender = form.gender === 'Female' ? 'Female' : 'Male';

  if (!isValidCustomVoiceId(id)) {
    return c.json(
      { ok: false, error: 'Voice id must look like am_myvoice (a/b = US/GB, f/m = female/male) and not collide with a built-in.' },
      400,
    );
  }
  try {
    const arrayBuffer = await file.arrayBuffer();
    const meta = installCustomVoice({
      id,
      name,
      language: language as 'en-us' | 'en-gb',
      gender: gender as 'Male' | 'Female',
      binary: Buffer.from(arrayBuffer),
    });
    return c.json({ ok: true, data: meta }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 400);
  }
});

voiceRouter.delete('/custom-voices/:id', (c) => {
  const id = c.req.param('id');
  if (!isValidCustomVoiceId(id)) {
    return c.json({ ok: false, error: `Invalid voice id: ${id}` }, 400);
  }
  try {
    deleteCustomVoice(id);
    return c.json({ ok: true, data: { id, deleted: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ── Hume cloud TTS ──

/** Status without exposing the key. Dashboard polls this to render Cloud-tab UI state. */
voiceRouter.get('/hume/status', (c) => {
  return c.json({ ok: true, data: { keySet: isHumeConfigured() } });
});

/** Set + validate the Hume API key. Body: { apiKey: string }. */
voiceRouter.post('/hume/key', async (c) => {
  const body = await c.req.json().catch(() => ({} as { apiKey?: unknown }));
  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!key) {
    return c.json({ ok: false, error: 'apiKey is required' }, 400);
  }
  const v = await validateHumeKey(key);
  if (!v.ok) {
    return c.json({ ok: false, error: v.error }, 400);
  }
  try {
    setProviderCredential('hume', key, 'api_key');
    invalidateHumeClient();
    return c.json({ ok: true, data: { keySet: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** Clear the stored Hume key. Doesn't touch other provider entries. */
voiceRouter.delete('/hume/key', (c) => {
  try {
    const secrets = loadSecrets();
    if (secrets.providers?.hume) {
      delete secrets.providers.hume;
      saveSecrets(secrets);
    }
    invalidateHumeClient();
    return c.json({ ok: true, data: { keySet: false } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** Proxy the Hume voice list (Voice Library + user's custom voices). */
voiceRouter.get('/hume/voices', async (c) => {
  if (!isHumeConfigured()) {
    return c.json({ ok: false, error: 'Hume not configured — set an API key first.' }, 400);
  }
  try {
    const voices = await listHumeVoices();
    return c.json({ ok: true, data: { voices } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Hume voice list failed', { error: msg });
    return c.json({ ok: false, error: msg }, 502);
  }
});

// ── Voice preview ──

voiceRouter.post('/preview', async (c) => {
  const body = await c.req.json().catch(() => ({} as {
    voice?: string; text?: string; speed?: number;
    engine?: string; voiceProvider?: string; description?: string;
  }));
  const text = (typeof body.text === 'string' && body.text.trim().length > 0
    ? body.text
    : DEFAULT_PREVIEW_TEXT).slice(0, 240);
  const speed = typeof body.speed === 'number' && body.speed > 0.5 && body.speed < 2 ? body.speed : 1;
  // Default to local. Cloud dispatch requires explicit engine=cloud +
  // a Hume voice id; the dashboard sends both when previewing from the
  // Cloud tab.
  const engine = body.engine === 'cloud' ? 'cloud' : 'local';

  try {
    if (engine === 'cloud') {
      if (!isHumeConfigured()) {
        return c.json({ ok: false, error: 'Hume not configured — set an API key first.' }, 400);
      }
      const voiceId = typeof body.voice === 'string' && body.voice.length > 0 ? body.voice : '';
      if (!voiceId) {
        return c.json({ ok: false, error: 'Cloud preview requires a voice id.' }, 400);
      }
      const voiceProvider: 'HUME_AI' | 'CUSTOM_VOICE' =
        body.voiceProvider === 'CUSTOM_VOICE' ? 'CUSTOM_VOICE' : 'HUME_AI';
      const description = typeof body.description === 'string' && body.description.trim().length > 0
        ? body.description.trim().slice(0, 500) : undefined;
      const result = await humeSynthesizeOnce(text, voiceId, { description, speed, voiceProvider });
      return new Response(result.wav, {
        status: 200,
        headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
      });
    }
    const voice = typeof body.voice === 'string' && body.voice.length > 0 ? body.voice : DEFAULT_VOICE;
    const result = await synthesizeOnce(text, voice, speed);
    return new Response(result.wav, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Voice preview failed', { engine, error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});
